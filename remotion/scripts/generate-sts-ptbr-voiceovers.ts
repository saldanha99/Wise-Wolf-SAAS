import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { balanceHubCaptions, makeHubVtt } from '../captions';
import { HUB_VIDEOS, VIDEO_FPS } from '../content/hub-videos';
import type {
  HubVideoCaption,
  HubVideoSceneId,
  HubVideoSceneTiming,
  HubVideoSlug,
  HubVoiceTrack,
} from '../types';
import { assertLocalPtBrVoice } from './local-ptbr-voice';

type ElevenLabsSubscription = {
  tier?: string;
  status?: string;
};

type StsVoiceMetadata = {
  provider?: string;
  voiceId?: string;
  sourceVoiceName?: string;
  sourceSpeechRate?: number;
  modelId?: string;
  scriptHash?: string;
  generatedAt?: string;
  requestId?: string;
  audioSha256?: string;
};

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const manifestPath = path.join(projectRoot, 'remotion/generated/hub-voice-manifest.json');
const audioDirectory = path.join(projectRoot, 'remotion/public/assets/hub/videos/audio');
const captionsDirectory = path.join(projectRoot, 'remotion/previews/assets/hub/videos/captions');
const generationDirectory = path.join(projectRoot, 'remotion/generated/voice');
const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
const sourceVoiceName = process.env.VIDEO_STS_SOURCE_VOICE?.trim() || 'Reed (Português (Brasil))';
const sourceSpeechRate = Number(process.env.VIDEO_STS_SOURCE_RATE || 174);
const targetVoiceId = process.env.VIDEO_STS_TARGET_VOICE_ID?.trim() || 'nPczCjzI2devNBz1zQrb';
const targetVoiceName = process.env.VIDEO_STS_TARGET_VOICE_NAME?.trim() || 'Brian';
const forceRegeneration = process.env.VIDEO_FORCE_REGENERATE === '1';
const sceneGapSeconds = 0.18;
const voiceSettings = {
  stability: 0.34,
  similarity_boost: 0.62,
  style: 0.18,
  use_speaker_boost: true,
};

if (!apiKey) throw new Error('ELEVENLABS_API_KEY precisa existir somente no ambiente de geração.');
if (!Number.isFinite(sourceSpeechRate) || sourceSpeechRate < 140 || sourceSpeechRate > 220) {
  throw new Error('VIDEO_STS_SOURCE_RATE precisa ficar entre 140 e 220 palavras por minuto.');
}

assertLocalPtBrVoice({
  voiceName: sourceVoiceName,
  voicesOutput: execFileSync('say', ['-v', '?'], { encoding: 'utf8' }),
});

const fixed = (value: number) => Number(value.toFixed(3));

const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

const readMetadata = async (filePath: string): Promise<StsVoiceMetadata | null> => {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as StsVoiceMetadata;
  } catch {
    return null;
  }
};

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

const requestJson = async <T>(url: string): Promise<T> => {
  const response = await fetch(url, { headers: { 'xi-api-key': apiKey } });
  if (!response.ok) throw new Error(`ElevenLabs recusou a consulta de assinatura: HTTP ${response.status}`);
  return response.json() as Promise<T>;
};

const convertVoice = async ({
  inputPath,
  outputPath,
}: {
  inputPath: string;
  outputPath: string;
}): Promise<string | undefined> => {
  const form = new FormData();
  form.append('audio', new Blob([await readFile(inputPath)], { type: 'audio/wav' }), 'source.wav');
  form.append('model_id', 'eleven_multilingual_sts_v2');
  form.append('voice_settings', JSON.stringify(voiceSettings));
  form.append('remove_background_noise', 'false');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);
  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/speech-to-speech/${targetVoiceId}?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: { Accept: 'audio/mpeg', 'xi-api-key': apiKey },
        body: form,
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      const reason = (await response.text()).slice(0, 500);
      throw new Error(`ElevenLabs recusou a conversão: HTTP ${response.status} ${reason}`);
    }
    await writeFile(outputPath, Buffer.from(await response.arrayBuffer()), { mode: 0o644 });
    return response.headers.get('request-id') || undefined;
  } finally {
    clearTimeout(timeout);
  }
};

const synthesizeScene = (text: string, outputPath: string) => {
  execFileSync('say', [
    '-v',
    sourceVoiceName,
    '-r',
    String(sourceSpeechRate),
    '--data-format=BEI16@44100',
    '-o',
    outputPath,
    text,
  ], { stdio: 'ignore' });
};

const concatenateScenes = ({ scenePaths, outputPath }: { scenePaths: string[]; outputPath: string }) => {
  const inputs = scenePaths.flatMap((scenePath) => ['-i', scenePath]);
  const filters = scenePaths.map((_, index) => {
    const format = `[${index}:a]aformat=sample_rates=44100:channel_layouts=mono`;
    return index === scenePaths.length - 1
      ? `${format}[scene${index}]`
      : `${format},apad=pad_dur=${sceneGapSeconds}[scene${index}]`;
  });
  const labels = scenePaths.map((_, index) => `[scene${index}]`).join('');
  filters.push(`${labels}concat=n=${scenePaths.length}:v=0:a=1[joined]`);
  filters.push('[joined]highpass=f=65,lowpass=f=14500,loudnorm=I=-20:LRA=8:TP=-2[out]');

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
    'pcm_s16le',
    '-ar',
    '44100',
    '-ac',
    '1',
    outputPath,
  ], { stdio: 'ignore' });
};

await mkdir(audioDirectory, { recursive: true });
await mkdir(captionsDirectory, { recursive: true });
await mkdir(generationDirectory, { recursive: true });

const subscription = await requestJson<ElevenLabsSubscription>('https://api.elevenlabs.io/v1/user/subscription');
const manifest = {} as Record<HubVideoSlug, HubVoiceTrack>;

for (const content of HUB_VIDEOS) {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), `wise-wolf-sts-${content.slug}-`));
  try {
    const scenePaths: string[] = [];
    const sceneDurations: number[] = [];

    for (const [index, narration] of content.narration.entries()) {
      const scenePath = path.join(temporaryDirectory, `${index}-${narration.scene}.aiff`);
      synthesizeScene(narration.text, scenePath);
      scenePaths.push(scenePath);
      sceneDurations.push(getDuration(scenePath));
    }

    const sourceAudioPath = path.join(temporaryDirectory, `${content.slug}-source.wav`);
    const convertedAudioPath = path.join(temporaryDirectory, `${content.slug}.mp3`);
    concatenateScenes({ scenePaths, outputPath: sourceAudioPath });
    const sourceDurationSeconds = getDuration(sourceAudioPath);
    const narrationText = content.narration.map((narration) => narration.text).join(' ');
    const scriptHash = sha256(JSON.stringify({
      narrationText,
      sourceVoiceName,
      sourceSpeechRate,
      targetVoiceId,
      modelId: 'eleven_multilingual_sts_v2',
      voiceSettings,
      generatorVersion: 1,
    }));
    const audioPath = path.join(audioDirectory, `${content.slug}.mp3`);
    const captionPath = path.join(captionsDirectory, `${content.slug}.pt-BR.vtt`);
    const metadataPath = path.join(generationDirectory, `${content.slug}.json`);
    const cachedMetadata = await readMetadata(metadataPath);
    let audioBuffer: Buffer | null = null;
    try {
      audioBuffer = await readFile(audioPath);
    } catch {}
    const reuseCachedAudio = !forceRegeneration
      && cachedMetadata?.provider === 'ElevenLabs Voice Changer'
      && cachedMetadata.voiceId === targetVoiceId
      && cachedMetadata.sourceVoiceName === sourceVoiceName
      && cachedMetadata.sourceSpeechRate === sourceSpeechRate
      && cachedMetadata.modelId === 'eleven_multilingual_sts_v2'
      && cachedMetadata.scriptHash === scriptHash
      && cachedMetadata.audioSha256 === (audioBuffer ? sha256(audioBuffer) : null)
      && Boolean(cachedMetadata.requestId)
      && Boolean(cachedMetadata.generatedAt);
    let requestId = cachedMetadata?.requestId;
    let generatedAt = cachedMetadata?.generatedAt || new Date().toISOString();

    if (reuseCachedAudio) {
      console.log(`Reutilizando locução STS validada: ${content.slug}`);
    } else {
      requestId = await convertVoice({ inputPath: sourceAudioPath, outputPath: convertedAudioPath });
      generatedAt = new Date().toISOString();
      audioBuffer = await readFile(convertedAudioPath);
      const temporaryAudioPath = `${audioPath}.tmp-${process.pid}`;
      await writeFile(temporaryAudioPath, audioBuffer, { mode: 0o644 });
      await rename(temporaryAudioPath, audioPath);
      console.log(`Nova locução STS gerada: ${content.slug}`);
    }

    if (!audioBuffer) throw new Error(`Áudio STS ausente para ${content.slug}.`);
    const convertedDurationSeconds = getDuration(audioPath);
    const durationRatio = convertedDurationSeconds / sourceDurationSeconds;
    const durationSeconds = fixed(convertedDurationSeconds + 0.35);
    const scenes = {} as Record<HubVideoSceneId, HubVideoSceneTiming>;
    const captions: HubVideoCaption[] = [];
    let sourceSceneStart = 0;

    content.narration.forEach((narration, index) => {
      const sourceSceneDuration = sceneDurations[index];
      const sourceSceneEnd = index === content.narration.length - 1
        ? sourceDurationSeconds
        : sourceSceneStart + sourceSceneDuration + sceneGapSeconds;
      const sceneStart = sourceSceneStart * durationRatio;
      const sceneEnd = index === content.narration.length - 1
        ? durationSeconds
        : sourceSceneEnd * durationRatio;
      scenes[narration.scene] = {
        startSeconds: fixed(sceneStart),
        endSeconds: fixed(sceneEnd),
      };
      captions.push(...buildSceneCaptions({
        text: narration.text,
        startSeconds: sceneStart,
        durationSeconds: Math.max(sourceSceneDuration * durationRatio - 0.05, 0.1),
      }));
      sourceSceneStart = sourceSceneEnd;
    });

    const balancedCaptions = balanceHubCaptions(captions);

    await writeFile(captionPath, makeHubVtt(balancedCaptions), 'utf8');
    await writeFile(metadataPath, `${JSON.stringify({
      slug: content.slug,
      generatedAt,
      provider: 'ElevenLabs Voice Changer',
      voiceId: targetVoiceId,
      voiceName: `${targetVoiceName} · prosódia-base pt-BR`,
      voiceLocale: 'pt-BR',
      voiceAccent: 'brazilian-transferred',
      voiceSourceAccent: 'brazilian',
      voiceNative: false,
      sourceVoiceName,
      sourceSpeechRate,
      modelId: 'eleven_multilingual_sts_v2',
      scriptHash,
      subscriptionTier: subscription.tier || 'unknown',
      subscriptionStatus: subscription.status || 'unknown',
      commercialUseAllowed: false,
      publicationAllowed: false,
      durationSeconds,
      characterCount: narrationText.length,
      requestId,
      audioSha256: sha256(audioBuffer),
    }, null, 2)}\n`, 'utf8');

    manifest[content.slug] = {
      ready: true,
      durationSeconds,
      durationInFrames: Math.ceil(durationSeconds * VIDEO_FPS),
      audioPath: `assets/hub/videos/audio/${content.slug}.mp3`,
      voiceProvider: 'elevenlabs',
      voiceId: targetVoiceId,
      voiceName: `${targetVoiceName} · prosódia-base pt-BR`,
      voiceLocale: 'pt-BR',
      voiceAccent: 'brazilian-transferred',
      voiceSourceAccent: 'brazilian',
      voiceNative: false,
      modelId: 'eleven_multilingual_sts_v2',
      scriptHash,
      subscriptionTier: subscription.tier || 'unknown',
      subscriptionStatus: subscription.status || 'unknown',
      commercialUseAllowed: false,
      generatedAt,
      requestId,
      captions: balancedCaptions,
      scenes,
    };
    console.log(`Locução STS pt-BR pronta: ${content.slug} (${durationSeconds}s)`);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

const orderedManifest = Object.fromEntries(HUB_VIDEOS.map((content) => [content.slug, manifest[content.slug]]));
await writeFile(manifestPath, `${JSON.stringify(orderedManifest, null, 2)}\n`, 'utf8');
console.log(`Locuções híbridas concluídas com ${sourceVoiceName} → ${targetVoiceName}. Uso restrito à prévia.`);
