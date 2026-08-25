import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HUB_VIDEOS, VIDEO_FPS, VIDEO_HEIGHT, VIDEO_WIDTH } from '../content/hub-videos';
import { makeHubVtt } from '../captions';
import type {
  HubCommercialRenderFingerprint,
  HubCommercialRenderReceipt,
  HubVideoSlug,
  HubVoiceTrack,
} from '../types';
import {
  buildCommercialRenderFingerprint,
  buildCommercialRenderReceipt,
  computeCompositionSourceSha256,
  readInstalledRemotionVersion,
  validateCommercialRenderReceipt,
  writeCommercialRenderReceiptAtomic,
} from './render-provenance';
import { masterVideoAudio } from './audio-mastering';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const entryPoint = path.join(projectRoot, 'remotion/index.ts');
const cliPath = path.join(projectRoot, 'node_modules/@remotion/cli/remotion-cli.js');
const manifestPath = path.join(projectRoot, 'remotion/generated/hub-voice-manifest.json');
const voiceManifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<HubVideoSlug, HubVoiceTrack>;
const forceRender = process.env.VIDEO_FORCE_RENDER === '1';
const reusePreview = process.env.VIDEO_REUSE_PREVIEW === '1';
const renderConcurrency = Number(process.env.VIDEO_RENDER_CONCURRENCY || 4);
if (!Number.isInteger(renderConcurrency) || renderConcurrency < 1 || renderConcurrency > 8) {
  throw new Error('VIDEO_RENDER_CONCURRENCY precisa ser um inteiro entre 1 e 8.');
}
const commercialUseAllowed = HUB_VIDEOS.every((content) => voiceManifest[content.slug]?.commercialUseAllowed === true);
const outputDirectory = commercialUseAllowed
  ? path.join(projectRoot, 'public/assets/hub/videos')
  : path.join(projectRoot, 'remotion/previews/assets/hub/videos');
const posterDirectory = path.join(outputDirectory, 'posters');
const captionOutputDirectory = path.join(outputDirectory, 'captions');
const receiptDirectory = path.join(outputDirectory, 'receipts');
const temporaryDirectory = path.join(projectRoot, 'remotion/.renders');
const sanitizedChildEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/iu.test(key)),
);

const run = (command: string, args: string[]) => {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    env: { ...sanitizedChildEnvironment, NODE_ENV: 'production' },
  });
  if (result.status !== 0) {
    throw new Error(`Falha ao executar ${path.basename(command)} ${args.slice(0, 3).join(' ')}`);
  }
};

await mkdir(outputDirectory, { recursive: true });
await mkdir(posterDirectory, { recursive: true });
await mkdir(captionOutputDirectory, { recursive: true });
await mkdir(temporaryDirectory, { recursive: true });
if (commercialUseAllowed) await mkdir(receiptDirectory, { recursive: true });

if (!commercialUseAllowed) {
  console.warn('Locução sem licença comercial validada: os vídeos serão renderizados somente em remotion/previews.');
}

const compositionSourceSha256 = commercialUseAllowed
  ? await computeCompositionSourceSha256(projectRoot)
  : null;
const remotionVersion = commercialUseAllowed
  ? await readInstalledRemotionVersion(projectRoot)
  : null;
const commercialReceipts: Partial<Record<HubVideoSlug, HubCommercialRenderReceipt>> = {};

for (const content of HUB_VIDEOS) {
  const voiceTrack = voiceManifest[content.slug];
  if (!voiceTrack?.ready) throw new Error(`A locução ${content.slug} ainda não foi gerada.`);

  const outputPath = path.join(outputDirectory, `${content.slug}.mp4`);
  const temporaryPosterPath = path.join(temporaryDirectory, `${content.slug}.png`);
  const posterPath = path.join(posterDirectory, `${content.slug}.webp`);
  const captionOutputPath = path.join(captionOutputDirectory, `${content.slug}.pt-BR.vtt`);
  const receiptPath = path.join(receiptDirectory, `${content.slug}.json`);
  const artifacts = {
    video: outputPath,
    poster: posterPath,
    captions: captionOutputPath,
  };
  const productTiming = voiceTrack.scenes.product;
  const posterFrame = Math.min(
    voiceTrack.durationInFrames - 1,
    Math.max(1, Math.floor((productTiming.startSeconds + Math.min(2.4, (productTiming.endSeconds - productTiming.startSeconds) / 2)) * VIDEO_FPS)),
  );

  let reuseVideo = false;
  let commercialFingerprint: HubCommercialRenderFingerprint | null = null;
  if (commercialUseAllowed) {
    if (!compositionSourceSha256 || !remotionVersion) throw new Error('Proveniência comercial não foi inicializada.');
    commercialFingerprint = await buildCommercialRenderFingerprint({
      projectRoot,
      content,
      track: voiceTrack,
      compositionSourceSha256,
      remotionVersion,
      width: VIDEO_WIDTH,
      height: VIDEO_HEIGHT,
      fps: VIDEO_FPS,
    });
    if (!forceRender) {
      const validation = await validateCommercialRenderReceipt({
        receiptPath,
        expectedFingerprint: commercialFingerprint,
        artifacts,
      });
      reuseVideo = validation.valid;
      if (validation.receipt) commercialReceipts[content.slug] = validation.receipt;
      if (!validation.valid) console.warn(`Cache público rejeitado para ${content.slug}: ${validation.reason || 'receipt inválido'}.`);
    }
  } else {
    try {
      reuseVideo = reusePreview && !forceRender && (await stat(outputPath)).size > 100_000;
    } catch {}
  }

  if (reuseVideo) {
    console.log(`Reutilizando ${commercialUseAllowed ? 'pacote comercial validado' : 'render de prévia'}: ${content.slug}.mp4`);
  } else {
    console.log(`Renderizando ${content.id}...`);
    run(process.execPath, [
      cliPath,
      'render',
      entryPoint,
      content.id,
      outputPath,
      '--codec=h264',
      '--pixel-format=yuv420p',
      '--crf=22',
      '--audio-bitrate=128k',
      '--color-space=bt709',
      `--concurrency=${renderConcurrency}`,
      '--overwrite',
    ]);
    const mastering = await masterVideoAudio(outputPath);
    console.log(
      `Masterização: ${content.slug} ${mastering.after.integratedLufs.toFixed(1)} LUFS / ${mastering.after.truePeakDbtp.toFixed(1)} dBTP`,
    );
  }

  if (!(commercialUseAllowed && reuseVideo)) {
    run(process.execPath, [
      cliPath,
      'still',
      entryPoint,
      content.id,
      temporaryPosterPath,
      `--frame=${posterFrame}`,
      '--image-format=png',
      '--overwrite',
    ]);

    run('cwebp', [
      '-quiet',
      '-q',
      '84',
      '-resize',
      '1600',
      '900',
      temporaryPosterPath,
      '-o',
      posterPath,
    ]);

    await writeFile(captionOutputPath, makeHubVtt(voiceTrack.captions), 'utf8');
  }

  if (commercialUseAllowed && !reuseVideo) {
    if (!commercialFingerprint || !compositionSourceSha256) throw new Error('Fingerprint comercial não foi criado.');
    const sourceHashAfterRender = await computeCompositionSourceSha256(projectRoot);
    if (sourceHashAfterRender !== compositionSourceSha256) {
      throw new Error(`As fontes Remotion mudaram durante o render de ${content.slug}; nenhum receipt foi emitido.`);
    }
    const receipt = await buildCommercialRenderReceipt({ fingerprint: commercialFingerprint, artifacts });
    await writeCommercialRenderReceiptAtomic(receiptPath, receipt);
    commercialReceipts[content.slug] = receipt;
  }

  const outputStats = await stat(outputPath);
  console.log(`Concluído: ${content.slug}.mp4 (${(outputStats.size / 1024 / 1024).toFixed(1)} MB)`);
}

const websiteManifest = {
  generatedAt: new Date().toISOString(),
  videos: Object.fromEntries(HUB_VIDEOS.map((content) => [content.slug, {
    video: `/assets/hub/videos/${content.slug}.mp4`,
    poster: `/assets/hub/videos/posters/${content.slug}.webp`,
    captions: `/assets/hub/videos/captions/${content.slug}.pt-BR.vtt`,
    compositionId: content.id,
    durationSeconds: voiceManifest[content.slug].durationSeconds,
    language: 'pt-BR',
    ...(commercialUseAllowed ? {
      receipt: `/assets/hub/videos/receipts/${content.slug}.json`,
      renderFingerprintSha256: commercialReceipts[content.slug]?.renderFingerprintSha256,
    } : {}),
  }])),
};
await writeFile(path.join(outputDirectory, 'manifest.json'), `${JSON.stringify(websiteManifest, null, 2)}\n`, 'utf8');
await rm(temporaryDirectory, { recursive: true, force: true });
console.log('Coleção audiovisual Wise Wolf Hub concluída.');
