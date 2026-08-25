import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HUB_VIDEOS, VIDEO_FPS, VIDEO_HEIGHT, VIDEO_WIDTH } from '../content/hub-videos';
import type { HubCommercialRenderReceipt, HubVideoSlug, HubVoiceTrack } from '../types';
import { masterVideoAudio } from './audio-mastering';
import {
  buildCommercialRenderFingerprint,
  buildCommercialRenderReceipt,
  computeCompositionSourceSha256,
  readInstalledRemotionVersion,
  writeCommercialRenderReceiptAtomic,
} from './render-provenance';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outputDirectory = path.join(projectRoot, 'public/assets/hub/videos');
const manifestPath = path.join(projectRoot, 'remotion/generated/hub-voice-manifest.json');
const voiceManifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<HubVideoSlug, HubVoiceTrack>;
const compositionSourceSha256 = await computeCompositionSourceSha256(projectRoot);
const remotionVersion = await readInstalledRemotionVersion(projectRoot);
const receipts: Partial<Record<HubVideoSlug, HubCommercialRenderReceipt>> = {};

for (const content of HUB_VIDEOS) {
  const track = voiceManifest[content.slug];
  if (!track?.ready || track.commercialUseAllowed !== true) {
    throw new Error(`Locução comercial inválida para ${content.slug}.`);
  }

  const video = path.join(outputDirectory, `${content.slug}.mp4`);
  const poster = path.join(outputDirectory, 'posters', `${content.slug}.webp`);
  const captions = path.join(outputDirectory, 'captions', `${content.slug}.pt-BR.vtt`);
  const receiptPath = path.join(outputDirectory, 'receipts', `${content.slug}.json`);
  const mastering = await masterVideoAudio(video);
  const sourceHashAfterMastering = await computeCompositionSourceSha256(projectRoot);
  if (sourceHashAfterMastering !== compositionSourceSha256) {
    throw new Error(`As fontes Remotion mudaram durante a masterização de ${content.slug}.`);
  }

  const fingerprint = await buildCommercialRenderFingerprint({
    projectRoot,
    content,
    track,
    compositionSourceSha256,
    remotionVersion,
    width: VIDEO_WIDTH,
    height: VIDEO_HEIGHT,
    fps: VIDEO_FPS,
  });
  const receipt = await buildCommercialRenderReceipt({
    fingerprint,
    artifacts: { video, poster, captions },
  });
  await writeCommercialRenderReceiptAtomic(receiptPath, receipt);
  receipts[content.slug] = receipt;
  console.log(
    `${content.slug.padEnd(14)} ${mastering.changed ? 'masterizado' : 'já conforme'}  `
    + `${mastering.after.integratedLufs.toFixed(1)} LUFS  ${mastering.after.truePeakDbtp.toFixed(1)} dBTP`,
  );
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
    receipt: `/assets/hub/videos/receipts/${content.slug}.json`,
    renderFingerprintSha256: receipts[content.slug]?.renderFingerprintSha256,
  }])),
};
const publicManifestPath = path.join(outputDirectory, 'manifest.json');
const temporaryManifestPath = `${publicManifestPath}.tmp-${process.pid}-${Date.now()}`;
await writeFile(temporaryManifestPath, `${JSON.stringify(websiteManifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 });
await rename(temporaryManifestPath, publicManifestPath);
console.log('Masters públicos e proveniência comercial atualizados.');
