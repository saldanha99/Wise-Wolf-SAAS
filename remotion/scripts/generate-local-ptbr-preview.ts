import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { balanceHubCaptions, makeHubVtt } from '../captions';
import { HUB_VIDEOS, VIDEO_FPS } from '../content/hub-videos';
import { assertLocalPtBrVoice } from './local-ptbr-voice';
import type {
  HubVideoCaption,
  HubVideoSceneId,
  HubVideoSceneTiming,
  HubVideoSlug,
  HubVoiceTrack,
} from '../types';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const manifestPath = path.join(projectRoot, 'remotion/generated/hub-voice-manifest.json');
const audioDirectory = path.join(projectRoot, 'remotion/public/assets/hub/videos/audio');
const captionsDirectory = path.join(projectRoot, 'remotion/previews/assets/hub/videos/captions');
const generationDirectory = path.join(projectRoot, 'remotion/generated/voice');
const voiceName = process.env.VIDEO_LOCAL_PTBR_VOICE?.trim() || 'Luciana';
const speechRate = Number(process.env.VIDEO_LOCAL_PTBR_RATE || 182);
const sceneGapSeconds = 0.18;

assertLocalPtBrVoice({
  voiceName,
  voicesOutput: execFileSync('say', ['-v', '?'], { encoding: 'utf8' }),
});

const fixed = (value: number) => Number(value.toFixed(3));

const getDuration = (filePath: string): number => Number(execFileSync(
  'ffprobe',
  ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath],
  { encoding: 'utf8' },
).trim());

const chunkWords = (text: string): string[] => {
  const words = text.trim().split(/\s+/u).filter(Boolean);
  const chunks: string[] = [];
  let current: string[] = [];

  const flush = () => {
    if (current.length === 0) return;
    chunks.push(current.join(' '));
    current = [];
  };

  for (const word of words) {
    const candidate = [...current, word].join(' ');
    if (current.length >= 4 || candidate.length > 30) flush();
    current.push(word);
    if (/[.!?…]$/u.test(word) || (current.length >= 3 && /[,;:]$/u.test(word))) flush();
  }
  flush();
  return chunks;
};

const captionWeight = (text: string): number => {
  const letters = text.replace(/[^\p{L}\p{N}]/gu, '').length;
  const pause = /[.!?…]$/u.test(text) ? 5 : /[,;:]$/u.test(text) ? 2 : 0;
  return Math.max(letters + pause, 1);
};

const buildSceneCaptions = ({
  text,
  startSeconds,
  durationSeconds,
}: {
  text: string;
  startSeconds: number;
  durationSeconds: number;
}): HubVideoCaption[] => {
  const chunks = chunkWords(text);
  const weights = chunks.map(captionWeight);
  const totalWeight = weights.reduce((total, weight) => total + weight, 0) || 1;
  let elapsedWeight = 0;

  return chunks.map((chunk, index) => {
    const captionStart = startSeconds + durationSeconds * (elapsedWeight / totalWeight);
    elapsedWeight += weights[index];
    const captionEnd = startSeconds + durationSeconds * (elapsedWeight / totalWeight);
    return {
      text: chunk,
      startSeconds: fixed(captionStart),
      endSeconds: fixed(captionEnd),
      startMs: Math.round(captionStart * 1000),
      endMs: Math.round(captionEnd * 1000),
      timestampMs: null,
      confidence: null,
    };
  });
};

const synthesizeScene = (text: string, outputPath: string) => {
  execFileSync('say', [
    '-v',
    voiceName,
    '-r',
    String(speechRate),
    '--data-format=BEI16@44100',
    '-o',
    outputPath,
    text,
  ], { stdio: 'ignore' });
};

const concatenateScenes = ({
  scenePaths,
  outputPath,
}: {
  scenePaths: string[];
  outputPath: string;
}) => {
  const inputs = scenePaths.flatMap((scenePath) => ['-i', scenePath]);
  const filters = scenePaths.map((_, index) => {
    const format = `[${index}:a]aformat=sample_rates=44100:channel_layouts=mono`;
    return index === scenePaths.length - 1
      ? `${format}[scene${index}]`
      : `${format},apad=pad_dur=${sceneGapSeconds}[scene${index}]`;
  });
  const labels = scenePaths.map((_, index) => `[scene${index}]`).join('');
  filters.push(`${labels}concat=n=${scenePaths.length}:v=0:a=1[joined]`);
  filters.push('[joined]loudnorm=I=-16:LRA=11:TP=-1.5[out]');

  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    ...inputs,
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[out]',
    '-codec:a',
    'libmp3lame',
    '-b:a',
    '192k',
    '-ar',
    '44100',
    '-ac',
    '1',
    '-f',
    'mp3',
    outputPath,
  ], { stdio: 'ignore' });
};

await mkdir(audioDirectory, { recursive: true });
await mkdir(captionsDirectory, { recursive: true });
await mkdir(generationDirectory, { recursive: true });

let manifest: Partial<Record<HubVideoSlug, HubVoiceTrack>> = {};
try {
  manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Partial<Record<HubVideoSlug, HubVoiceTrack>>;
} catch {}

for (const content of HUB_VIDEOS) {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), `wise-wolf-${content.slug}-`));
  try {
    const scenePaths: string[] = [];
    const sceneDurations: number[] = [];

    for (const [index, narration] of content.narration.entries()) {
      const scenePath = path.join(temporaryDirectory, `${index}-${narration.scene}.aiff`);
      synthesizeScene(narration.text, scenePath);
      scenePaths.push(scenePath);
      sceneDurations.push(getDuration(scenePath));
    }

    const temporaryAudioPath = path.join(temporaryDirectory, `${content.slug}.mp3`);
    concatenateScenes({ scenePaths, outputPath: temporaryAudioPath });
    const durationSeconds = fixed(getDuration(temporaryAudioPath) + 0.35);
    const scenes = {} as Record<HubVideoSceneId, HubVideoSceneTiming>;
    const captions: HubVideoCaption[] = [];
    let sceneStart = 0;

    content.narration.forEach((narration, index) => {
      const sceneDuration = sceneDurations[index];
      const sceneEnd = index === content.narration.length - 1
        ? durationSeconds
        : sceneStart + sceneDuration + sceneGapSeconds;
      scenes[narration.scene] = {
        startSeconds: fixed(sceneStart),
        endSeconds: fixed(sceneEnd),
      };
      captions.push(...buildSceneCaptions({
        text: narration.text,
        startSeconds: sceneStart,
        durationSeconds: Math.max(sceneDuration - 0.05, 0.1),
      }));
      sceneStart = sceneEnd;
    });

    const narrationText = content.narration.map((narration) => narration.text).join(' ');
    const scriptHash = createHash('sha256').update(JSON.stringify({
      narrationText,
      voiceName,
      speechRate,
      locale: 'pt-BR',
      previewGeneratorVersion: 1,
    })).digest('hex');
    const audioPath = path.join(audioDirectory, `${content.slug}.mp3`);
    const captionPath = path.join(captionsDirectory, `${content.slug}.pt-BR.vtt`);
    const metadataPath = path.join(generationDirectory, `${content.slug}.json`);
    const balancedCaptions = balanceHubCaptions(captions);
    const generatedAt = new Date().toISOString();

    await rename(temporaryAudioPath, audioPath);
    await writeFile(captionPath, makeHubVtt(balancedCaptions), 'utf8');
    await writeFile(metadataPath, `${JSON.stringify({
      slug: content.slug,
      generatedAt,
      voiceId: `macos-${voiceName.toLowerCase()}`,
      voiceName: `${voiceName} · prévia local pt-BR`,
      voiceLocale: 'pt-BR',
      voiceAccent: 'brazilian',
      voiceSourceAccent: 'brazilian',
      voiceNative: true,
      modelId: 'macos-say-preview',
      scriptHash,
      subscriptionTier: 'local-preview',
      subscriptionStatus: 'local-preview',
      commercialUseAllowed: false,
      durationSeconds,
      characterCount: narrationText.length,
    }, null, 2)}\n`, 'utf8');

    manifest[content.slug] = {
      ready: true,
      durationSeconds,
      durationInFrames: Math.ceil(durationSeconds * VIDEO_FPS),
      audioPath: `assets/hub/videos/audio/${content.slug}.mp3`,
      voiceProvider: 'local-preview',
      voiceId: `macos-${voiceName.toLowerCase()}`,
      voiceName: `${voiceName} · prévia local pt-BR`,
      voiceLocale: 'pt-BR',
      voiceAccent: 'brazilian',
      voiceSourceAccent: 'brazilian',
      voiceNative: true,
      modelId: 'macos-say-preview',
      scriptHash,
      subscriptionTier: 'local-preview',
      subscriptionStatus: 'local-preview',
      commercialUseAllowed: false,
      generatedAt,
      captions: balancedCaptions,
      scenes,
    };
    console.log(`Prévia pt-BR gerada: ${content.slug} (${durationSeconds}s)`);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

const orderedManifest = Object.fromEntries(HUB_VIDEOS.map((content) => [content.slug, manifest[content.slug]]));
await writeFile(manifestPath, `${JSON.stringify(orderedManifest, null, 2)}\n`, 'utf8');
console.log(`Locuções locais pt-BR concluídas com a voz ${voiceName}. Uso restrito à prévia.`);
