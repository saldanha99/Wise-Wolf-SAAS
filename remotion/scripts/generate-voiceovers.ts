import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HUB_VIDEOS, VIDEO_FPS } from '../content/hub-videos';
import { balanceHubCaptions, makeHubVtt } from '../captions';
import {
  assertPtBrNarrationModel,
  assertPtBrVoice,
  getPtBrNarrationVoiceSettings,
  type ElevenLabsVoiceProfile,
  type PtBrVoiceEvidence,
} from './pt-br-voice';
import type {
  HubVideoCaption,
  HubVideoSceneId,
  HubVideoSceneTiming,
  HubVideoSlug,
  HubVoiceTrack,
} from '../types';

type ElevenLabsAlignment = {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
};

type ElevenLabsSpeechResponse = {
  audio_base64?: string;
  alignment?: ElevenLabsAlignment | null;
  normalized_alignment?: ElevenLabsAlignment | null;
};

type ElevenLabsSubscription = {
  tier?: string;
  status?: string;
  character_count?: number;
  character_limit?: number;
};

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const manifestPath = path.join(projectRoot, 'remotion/generated/hub-voice-manifest.json');
const audioDirectory = path.join(projectRoot, 'remotion/public/assets/hub/videos/audio');
const publicCaptionsDirectory = path.join(projectRoot, 'public/assets/hub/videos/captions');
const previewCaptionsDirectory = path.join(projectRoot, 'remotion/previews/assets/hub/videos/captions');
const generationDirectory = path.join(projectRoot, 'remotion/generated/voice');
const lockDirectory = path.join(projectRoot, 'remotion/.locks');
const modelId = process.env.ELEVENLABS_MODEL_ID?.trim() || 'eleven_v3';
const outputFormat = 'mp3_44100_128';
const forceRegeneration = process.env.VIDEO_FORCE_REGENERATE === '1';
const allowMultilingualPremade = process.env.ELEVENLABS_ALLOW_MULTILINGUAL_PREMADE === '1';

assertPtBrNarrationModel(modelId);

const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
if (!apiKey) {
  throw new Error('ELEVENLABS_API_KEY precisa ser fornecida apenas no ambiente de geração.');
}

const headers = {
  Accept: 'application/json',
  'Content-Type': 'application/json',
  'xi-api-key': apiKey,
};

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const requestJson = async <T>(url: string, init: RequestInit, retryCount = 0): Promise<{ data: T; response: Response }> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      const retriable = (init.method || 'GET').toUpperCase() === 'GET' && [429, 500, 503].includes(response.status);
      if (retriable && retryCount < 3) {
        const waitMilliseconds = Math.round((2 ** retryCount * 1400) + Math.random() * 700);
        await sleep(waitMilliseconds);
        return requestJson<T>(url, init, retryCount + 1);
      }
      let reason = `HTTP ${response.status}`;
      try {
        const errorBody = await response.json() as { detail?: { message?: string } | string; message?: string };
        const detail = typeof errorBody.detail === 'string' ? errorBody.detail : errorBody.detail?.message;
        reason = detail || errorBody.message || reason;
      } catch {}
      throw new Error(`ElevenLabs recusou a solicitação: ${reason}`);
    }
    return { data: await response.json() as T, response };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('A solicitação ElevenLabs expirou. A geração não foi repetida automaticamente para evitar cobrança duplicada.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

const getVoice = async (): Promise<{ voice: ElevenLabsVoiceProfile; evidence: PtBrVoiceEvidence }> => {
  const configuredVoiceId = process.env.ELEVENLABS_VOICE_ID?.trim();
  if (!configuredVoiceId) {
    throw new Error(
      'ELEVENLABS_VOICE_ID é obrigatório. Escolha e aprove uma voz nativa Portuguese (Brazil) no Voice Library; '
      + 'o gerador não usa mais seleção automática nem voz fallback.',
    );
  }

  const { data: voice } = await requestJson<ElevenLabsVoiceProfile>(
    `https://api.elevenlabs.io/v1/voices/${encodeURIComponent(configuredVoiceId)}`,
    { method: 'GET', headers },
  );
  if (voice.voice_id !== configuredVoiceId) {
    throw new Error('A ElevenLabs retornou uma voz diferente do ELEVENLABS_VOICE_ID aprovado.');
  }
  return {
    voice,
    evidence: assertPtBrVoice(voice, { allowMultilingualPremade, modelId }),
  };
};

const fixed = (value: number) => Number(value.toFixed(3));
const milliseconds = (seconds: number) => Number((seconds * 1000).toFixed(3));

const buildCaptions = (alignment: ElevenLabsAlignment): HubVideoCaption[] => {
  const fullText = alignment.characters.join('');
  const words = [...fullText.matchAll(/\S+/gu)].map((match) => {
    const startIndex = match.index || 0;
    const endIndex = startIndex + match[0].length - 1;
    return {
      text: match[0],
      startSeconds: alignment.character_start_times_seconds[startIndex] ?? 0,
      endSeconds: alignment.character_end_times_seconds[endIndex]
        ?? alignment.character_start_times_seconds[endIndex]
        ?? 0,
    };
  });

  const captions: HubVideoCaption[] = [];
  let group: typeof words = [];
  const flush = () => {
    if (group.length === 0) return;
    const tokens = group.map((word) => ({
      text: word.text,
      startMs: milliseconds(word.startSeconds),
      endMs: milliseconds(word.endSeconds),
    }));
    captions.push({
      text: group.map((word) => word.text).join(' '),
      startSeconds: fixed(group[0].startSeconds),
      endSeconds: fixed(group[group.length - 1].endSeconds),
      startMs: tokens[0].startMs,
      endMs: tokens[tokens.length - 1].endMs,
      timestampMs: null,
      confidence: null,
      tokens,
    });
    group = [];
  };

  for (const word of words) {
    const nextText = [...group, word].map((item) => item.text).join(' ');
    if (group.length >= 6 || nextText.length > 42) flush();
    group.push(word);
    if (/[.!?]$/u.test(word.text) || (group.length >= 4 && /[,;:]$/u.test(word.text))) flush();
  }
  flush();
  return balanceHubCaptions(captions);
};

const buildSceneTimings = (
  narrationParts: Array<{ scene: HubVideoSceneId; text: string }>,
  alignment: ElevenLabsAlignment,
  durationSeconds: number,
): Record<HubVideoSceneId, HubVideoSceneTiming> => {
  const joinedText = alignment.characters.join('');
  const timings = {} as Record<HubVideoSceneId, HubVideoSceneTiming>;
  let cursor = 0;

  for (const part of narrationParts) {
    let startIndex = joinedText.indexOf(part.text, cursor);
    if (startIndex < 0) startIndex = cursor;
    const endIndex = Math.min(startIndex + part.text.length - 1, alignment.characters.length - 1);
    timings[part.scene] = {
      startSeconds: fixed(alignment.character_start_times_seconds[startIndex] || 0),
      endSeconds: fixed(alignment.character_end_times_seconds[endIndex] || alignment.character_start_times_seconds[endIndex] || 0),
    };
    cursor = endIndex + 1;
  }

  timings.hook.startSeconds = 0;
  for (let index = 0; index < narrationParts.length - 1; index += 1) {
    const currentScene = narrationParts[index].scene;
    const nextScene = narrationParts[index + 1].scene;
    timings[currentScene].endSeconds = Math.max(timings[currentScene].endSeconds, timings[nextScene].startSeconds);
  }
  timings.cta.endSeconds = durationSeconds;
  return timings;
};

const exists = async (filePath: string): Promise<boolean> => {
  try {
    const details = await stat(filePath);
    return details.isFile() && details.size > 0;
  } catch {
    return false;
  }
};

const getVoiceSettings = (): Record<string, number | boolean> => getPtBrNarrationVoiceSettings(modelId);

const createScriptHash = (text: string, voiceId: string, evidence: PtBrVoiceEvidence, seed: number): string => createHash('sha256')
  .update(JSON.stringify({
    text,
    voiceId,
    voiceLocale: evidence.locale,
    voiceAccent: evidence.accent,
    voiceSourceAccent: evidence.sourceAccent,
    voiceNative: evidence.native,
    voiceLocaleValidation: evidence.source,
    voiceValidationVersion: 2,
    captionAlignmentVersion: 2,
    modelId,
    outputFormat,
    seed,
    voiceSettings: getVoiceSettings(),
    languageCode: modelId === 'eleven_v3' ? 'pt' : null,
    normalization: 'on',
  }))
  .digest('hex');

const synthesize = async (text: string, voiceId: string, seed: number): Promise<{ response: ElevenLabsSpeechResponse; requestId: string | null }> => {
  const requestBody: Record<string, unknown> = {
    text,
    model_id: modelId,
    voice_settings: getVoiceSettings(),
    seed,
    apply_text_normalization: 'on',
  };
  if (modelId === 'eleven_v3') requestBody.language_code = 'pt';

  const { data, response } = await requestJson<ElevenLabsSpeechResponse>(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps?output_format=${outputFormat}`,
    { method: 'POST', headers, body: JSON.stringify(requestBody) },
  );
  return { response: data, requestId: response.headers.get('request-id') };
};

await mkdir(audioDirectory, { recursive: true });
await mkdir(generationDirectory, { recursive: true });
await mkdir(lockDirectory, { recursive: true });

let manifest: Partial<Record<HubVideoSlug, HubVoiceTrack>> = {};
try {
  manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Partial<Record<HubVideoSlug, HubVoiceTrack>>;
} catch {}

const persistManifest = async () => {
  const orderedManifest = Object.fromEntries(HUB_VIDEOS.map((content) => [content.slug, manifest[content.slug]]));
  const temporaryManifestPath = `${manifestPath}.${process.pid}.tmp`;
  await writeFile(temporaryManifestPath, `${JSON.stringify(orderedManifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 });
  await rename(temporaryManifestPath, manifestPath);
};

const { data: subscription } = await requestJson<ElevenLabsSubscription>(
  'https://api.elevenlabs.io/v1/user/subscription',
  { method: 'GET', headers },
);
const subscriptionTier = (subscription.tier || 'unknown').toLowerCase();
const subscriptionStatus = (subscription.status || 'unknown').toLowerCase();
const commercialUseAllowed = ['starter', 'creator', 'pro', 'scale', 'business', 'enterprise'].includes(subscriptionTier)
  && ['active', 'trialing'].includes(subscriptionStatus);
const captionsDirectory = commercialUseAllowed ? publicCaptionsDirectory : previewCaptionsDirectory;
await mkdir(captionsDirectory, { recursive: true });
const { voice, evidence: voiceEvidence } = await getVoice();
console.log(`Voz selecionada: ${voice.name || 'voz sem nome'} (${voice.voice_id})`);
console.log(`Validação regional: ${voiceEvidence.locale} via ${voiceEvidence.source}`);
console.log(`Origem da voz: sotaque=${voiceEvidence.sourceAccent}; nativa=${voiceEvidence.native ? 'sim' : 'não'}`);

for (const [index, content] of HUB_VIDEOS.entries()) {
  const narrationText = content.narration.map((part) => part.text.trim()).join(' ');
  const seed = 184_734_221 + index * 7_919;
  const scriptHash = createScriptHash(narrationText, voice.voice_id, voiceEvidence, seed);
  const audioPath = path.join(audioDirectory, `${content.slug}.mp3`);
  const vttPath = path.join(captionsDirectory, `${content.slug}.pt-BR.vtt`);
  const metadataPath = path.join(generationDirectory, `${content.slug}.json`);
  const cached = manifest[content.slug];

  const cachedVoiceIsValidated = cached?.voiceProvider === 'elevenlabs'
    && cached.voiceLocale === 'pt-BR'
    && cached.voiceLocaleValidation === voiceEvidence.source
    && cached.voiceAccent === voiceEvidence.accent
    && cached.voiceSourceAccent === voiceEvidence.sourceAccent
    && cached.voiceNative === voiceEvidence.native;
  if (!forceRegeneration && cached?.ready && cachedVoiceIsValidated && cached.scriptHash === scriptHash && await exists(audioPath) && await exists(vttPath)) {
    manifest[content.slug] = cached;
    if (commercialUseAllowed && cached.commercialUseAllowed !== true) {
      console.warn(`A locução ${content.slug} foi criada sem licença comercial. Use VIDEO_FORCE_REGENERATE=1 para gerar outra no plano pago.`);
    }
    console.log(`Reutilizando locução: ${content.slug}`);
    continue;
  }

  const lockPath = path.join(lockDirectory, `${scriptHash}.lock`);
  let lockHandle;
  try {
    lockHandle = await open(lockPath, 'wx', 0o600);
  } catch {
    throw new Error(`Já existe uma geração em andamento para ${content.slug}.`);
  }

  try {
    console.log(`Gerando locução: ${content.slug}`);
    const { response, requestId } = await synthesize(narrationText, voice.voice_id, seed);
    if (!response.audio_base64) throw new Error(`A ElevenLabs não retornou áudio para ${content.slug}.`);
    if (commercialUseAllowed && !requestId) {
      throw new Error(`A ElevenLabs não retornou um request ID para a locução comercial ${content.slug}. Nada foi publicado.`);
    }
    const alignment = response.alignment || response.normalized_alignment;
    if (!alignment || alignment.characters.length === 0) throw new Error(`A ElevenLabs não retornou timestamps para ${content.slug}.`);

    const audioBuffer = Buffer.from(response.audio_base64, 'base64');
    const audioEnd = alignment.character_end_times_seconds.at(-1) || alignment.character_start_times_seconds.at(-1) || 0;
    const durationSeconds = fixed(audioEnd + 1.4);
    const durationInFrames = Math.ceil(durationSeconds * VIDEO_FPS);
    const captions = buildCaptions(alignment);
    const scenes = buildSceneTimings(content.narration, alignment, durationSeconds);
    const generatedAt = new Date().toISOString();
    const track: HubVoiceTrack = {
      ready: true,
      durationSeconds,
      durationInFrames,
      audioPath: `assets/hub/videos/audio/${content.slug}.mp3`,
      voiceProvider: 'elevenlabs',
      voiceId: voice.voice_id,
      voiceName: voice.name,
      voiceLocale: voiceEvidence.locale,
      voiceAccent: voiceEvidence.accent,
      voiceSourceAccent: voiceEvidence.sourceAccent,
      voiceNative: voiceEvidence.native,
      voiceLocaleValidation: voiceEvidence.source,
      modelId,
      scriptHash,
      subscriptionTier,
      subscriptionStatus,
      commercialUseAllowed,
      generatedAt,
      requestId: requestId || undefined,
      captions,
      scenes,
    };

    const audioTemporaryPath = `${audioPath}.tmp`;
    const vttTemporaryPath = `${vttPath}.tmp`;
    await writeFile(audioTemporaryPath, audioBuffer, { mode: 0o644 });
    await writeFile(vttTemporaryPath, makeHubVtt(captions), { encoding: 'utf8', mode: 0o644 });
    await rename(audioTemporaryPath, audioPath);
    await rename(vttTemporaryPath, vttPath);
    await writeFile(metadataPath, `${JSON.stringify({ slug: content.slug, requestId, generatedAt, voiceId: voice.voice_id, voiceName: voice.name, voiceLocale: voiceEvidence.locale, voiceAccent: voiceEvidence.accent, voiceSourceAccent: voiceEvidence.sourceAccent, voiceNative: voiceEvidence.native, voiceLocaleValidation: voiceEvidence.source, modelId, scriptHash, subscriptionTier, subscriptionStatus, commercialUseAllowed, durationSeconds, characterCount: narrationText.length }, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 });
    manifest[content.slug] = track;
    await persistManifest();
  } finally {
    await lockHandle.close();
    await rm(lockPath, { force: true });
  }
}

await persistManifest();
console.log('Locuções e legendas PT-BR concluídas.');
