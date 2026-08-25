import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HUB_VIDEOS, VIDEO_FPS, VIDEO_HEIGHT, VIDEO_WIDTH } from '../content/hub-videos';
import type { HubVideoSlug, HubVoiceTrack } from '../types';
import {
  buildCommercialRenderFingerprint,
  computeCompositionSourceSha256,
  readInstalledRemotionVersion,
  validateCommercialRenderReceipt,
} from './render-provenance';
import { isAudioWithinMasteringSpec, measureAudioLoudness } from './audio-mastering';

type ProbeStream = {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
};

type ProbeOutput = {
  streams?: ProbeStream[];
  format?: {
    duration?: string;
    size?: string;
  };
};

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const modeArgument = process.argv.slice(2);
if (modeArgument.length !== 1 || !['--preview', '--public'].includes(modeArgument[0])) {
  console.error('Uso: npm run video:validate -- --preview | --public');
  process.exit(2);
}
const validationMode = modeArgument[0] === '--public' ? 'public' : 'preview';
const manifestPath = path.join(projectRoot, 'remotion/generated/hub-voice-manifest.json');
const voiceManifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<HubVideoSlug, HubVoiceTrack>;
const outputDirectory = validationMode === 'public'
  ? path.join(projectRoot, 'public/assets/hub/videos')
  : path.join(projectRoot, 'remotion/previews/assets/hub/videos');
const failures: string[] = [];
const compositionSourceSha256 = validationMode === 'public'
  ? await computeCompositionSourceSha256(projectRoot)
  : null;
const remotionVersion = validationMode === 'public'
  ? await readInstalledRemotionVersion(projectRoot)
  : null;

if (validationMode === 'public' && !HUB_VIDEOS.every((content) => voiceManifest[content.slug]?.commercialUseAllowed === true)) {
  failures.push('coleção pública: há locuções sem licença comercial registrada');
}

const probe = (filePath: string): ProbeOutput => {
  const result = spawnSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate:format=duration,size',
    '-of', 'json',
    filePath,
  ], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`ffprobe falhou para ${filePath}`);
  return JSON.parse(result.stdout) as ProbeOutput;
};

for (const content of HUB_VIDEOS) {
  const mp4Path = path.join(outputDirectory, `${content.slug}.mp4`);
  const posterPath = path.join(outputDirectory, 'posters', `${content.slug}.webp`);
  const captionsPath = path.join(outputDirectory, 'captions', `${content.slug}.pt-BR.vtt`);
  const receiptPath = path.join(outputDirectory, 'receipts', `${content.slug}.json`);
  const track = voiceManifest[content.slug];
  try {
    if (!track?.ready) throw new Error('locução ausente ou incompleta');

    if (validationMode === 'public') {
      if (!compositionSourceSha256 || !remotionVersion) throw new Error('proveniência pública não foi inicializada');
      const expectedFingerprint = await buildCommercialRenderFingerprint({
        projectRoot,
        content,
        track,
        compositionSourceSha256,
        remotionVersion,
        width: VIDEO_WIDTH,
        height: VIDEO_HEIGHT,
        fps: VIDEO_FPS,
      });
      const receiptValidation = await validateCommercialRenderReceipt({
        receiptPath,
        expectedFingerprint,
        artifacts: {
          video: mp4Path,
          poster: posterPath,
          captions: captionsPath,
        },
      });
      if (!receiptValidation.valid) failures.push(`${content.slug}: receipt comercial inválido (${receiptValidation.reason || 'motivo desconhecido'})`);
    }

    const mp4Stats = await stat(mp4Path);
    const posterStats = await stat(posterPath);
    const captions = await readFile(captionsPath, 'utf8');
    const details = probe(mp4Path);
    const videoStream = details.streams?.find((stream) => stream.codec_type === 'video');
    const audioStream = details.streams?.find((stream) => stream.codec_type === 'audio');
    const duration = Number(details.format?.duration || 0);

    if (videoStream?.codec_name !== 'h264') failures.push(`${content.slug}: codec de vídeo não é H.264`);
    if (videoStream?.width !== VIDEO_WIDTH || videoStream?.height !== VIDEO_HEIGHT) failures.push(`${content.slug}: resolução inesperada`);
    if (videoStream?.r_frame_rate !== `${VIDEO_FPS}/1`) failures.push(`${content.slug}: taxa de quadros inesperada`);
    if (audioStream?.codec_name !== 'aac') failures.push(`${content.slug}: faixa de áudio AAC ausente`);
    if (Math.abs(duration - track.durationSeconds) > 0.9) failures.push(`${content.slug}: duração diverge da locução`);
    if (mp4Stats.size > 30 * 1024 * 1024) failures.push(`${content.slug}: arquivo supera 30 MB`);
    if (posterStats.size < 10 * 1024) failures.push(`${content.slug}: pôster parece inválido`);
    if (!captions.startsWith('WEBVTT') || captions.length < 120) failures.push(`${content.slug}: legenda WebVTT inválida`);

    let masteringSummary = '';
    if (validationMode === 'public') {
      const loudness = measureAudioLoudness(mp4Path);
      masteringSummary = `  ${loudness.integratedLufs.toFixed(1)} LUFS/${loudness.truePeakDbtp.toFixed(1)} dBTP`;
      if (!isAudioWithinMasteringSpec(loudness)) {
        failures.push(`${content.slug}: master fora do padrão (${loudness.integratedLufs.toFixed(1)} LUFS / ${loudness.truePeakDbtp.toFixed(1)} dBTP)`);
      }
    }

    console.log(`${content.slug.padEnd(14)} ${duration.toFixed(1).padStart(5)}s  ${(mp4Stats.size / 1024 / 1024).toFixed(1).padStart(5)} MB  H.264/AAC  1080p${masteringSummary}`);
  } catch (error) {
    failures.push(`${content.slug}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Todos os vídeos, pôsteres e arquivos de legenda do modo ${validationMode} foram validados.`);
}
