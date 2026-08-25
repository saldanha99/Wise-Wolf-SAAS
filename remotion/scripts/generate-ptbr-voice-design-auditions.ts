import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type ElevenLabsSubscription = {
  tier?: string;
  status?: string;
  character_count?: number;
  character_limit?: number;
};

type VoiceDesignPreview = {
  audio_base_64?: string;
  generated_voice_id?: string;
  media_type?: string;
  duration_secs?: number;
  language?: string;
};

type VoiceDesignResponse = {
  previews?: VoiceDesignPreview[];
  text?: string;
};

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outputDirectory = path.join(projectRoot, 'remotion/previews/voice-auditions-v2');
const manifestPath = path.join(outputDirectory, 'manifest.json');
const apiKey = process.env.ELEVENLABS_API_KEY?.trim();

if (!apiKey) {
  throw new Error('ELEVENLABS_API_KEY precisa existir apenas no ambiente de geração.');
}

const voiceDescription = [
  'Native Brazilian Portuguese (pt-BR), without European Portuguese traits and without an English accent.',
  'Male, 32–42. Studio-quality broadcast audio.',
  'Persona: credible technology guide. Emotion: warm, confident, genuinely engaged.',
  'Natural Brazilian rhythm and connected speech, with conversational phrasing, subtle melodic intonation, and restrained authority.',
  'Medium-low timbre, clear diction without over-articulation, human micro-pauses, varied sentence endings, and relaxed pacing.',
  'Sounds like an experienced Brazilian product presenter speaking to educators, never like an announcer, synthetic assistant, or dubbed commercial.',
].join(' ');

const previewText = [
  'Sua escola não precisa escolher entre tecnologia e proximidade.',
  'No Hub Wise Wolf, cada solução trabalha junto para transformar planejamento, materiais e prática de conversação em uma jornada simples, viva e realmente útil.',
  'Tudo com a identidade da sua escola e com a clareza que professores e alunos precisam no dia a dia.',
].join(' ');

const designModelId = 'eleven_multilingual_ttv_v2';
const outputFormat = 'mp3_44100_192';
const config = {
  quality: 0.92,
  guidance_scale: 4.2,
  loudness: 0.2,
  seed: 2_408_199,
};

const headers = {
  Accept: 'application/json',
  'Content-Type': 'application/json',
  'xi-api-key': apiKey,
};

const requestJson = async <T>(url: string, init: RequestInit): Promise<{ data: T; response: Response }> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
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
      throw new Error('A solicitação ElevenLabs expirou e não foi repetida para evitar cobrança duplicada.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

const { data: subscription } = await requestJson<ElevenLabsSubscription>(
  'https://api.elevenlabs.io/v1/user/subscription',
  { method: 'GET', headers },
);

const subscriptionTier = (subscription.tier || 'unknown').toLowerCase();
const subscriptionStatus = (subscription.status || 'unknown').toLowerCase();
const commercialUseAllowed = ['starter', 'creator', 'pro', 'scale', 'business', 'enterprise'].includes(subscriptionTier)
  && ['active', 'trialing'].includes(subscriptionStatus);

const { data: design, response } = await requestJson<VoiceDesignResponse>(
  `https://api.elevenlabs.io/v1/text-to-voice/design?output_format=${outputFormat}`,
  {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model_id: designModelId,
      voice_description: voiceDescription,
      text: previewText,
      auto_generate_text: false,
      ...config,
    }),
  },
);

const previews = (design.previews || []).filter((preview) => preview.audio_base_64 && preview.generated_voice_id);
if (previews.length < 2 || previews.length > 3) {
  throw new Error(`A ElevenLabs retornou ${previews.length} audições válidas; eram esperadas de duas a três.`);
}

await mkdir(outputDirectory, { recursive: true });
const generatedAt = new Date().toISOString();
const requestId = response.headers.get('request-id');
const manifestPreviews = [];

for (const [index, preview] of previews.entries()) {
  const audio = Buffer.from(preview.audio_base_64 || '', 'base64');
  if (audio.length < 1_000) throw new Error(`A audição ${index + 1} retornou áudio inválido.`);
  const filename = `wise-wolf-ptbr-designed-${index + 1}.mp3`;
  await writeFile(path.join(outputDirectory, filename), audio, { mode: 0o644 });
  manifestPreviews.push({
    rank: index + 1,
    filename,
    generatedVoiceId: preview.generated_voice_id,
    savedToVoiceLibrary: false,
    mediaType: preview.media_type || 'audio/mpeg',
    durationSeconds: preview.duration_secs ?? null,
    apiLanguage: preview.language || null,
    sha256: createHash('sha256').update(audio).digest('hex'),
  });
}

const manifest = {
  generatedAt,
  provider: 'ElevenLabs',
  purpose: 'PT-BR native-target voice design auditions for Wise Wolf Hub',
  status: 'audition_only',
  modelId: designModelId,
  outputFormat,
  voiceDescription,
  requestedText: previewText,
  returnedText: design.text || previewText,
  config,
  regionalEvidence: {
    targetLocale: 'pt-BR',
    source: 'voice_design_prompt',
    nativeVerified: false,
    note: 'A voz foi projetada para pt-BR, mas não é uma clonagem verificada de um falante brasileiro.',
  },
  licensing: {
    accountTier: subscriptionTier,
    accountStatus: subscriptionStatus,
    commercialUseAllowed,
    publicationAllowed: commercialUseAllowed,
  },
  usage: {
    characterCountBefore: subscription.character_count ?? null,
    characterLimit: subscription.character_limit ?? null,
  },
  requestId,
  previews: manifestPreviews,
};

const temporaryManifestPath = `${manifestPath}.${process.pid}.tmp`;
await writeFile(temporaryManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 });
await rename(temporaryManifestPath, manifestPath);

console.log(`Audições criadas: ${manifestPreviews.length}`);
console.log(`Destino: ${outputDirectory}`);
console.log(`Uso comercial permitido: ${commercialUseAllowed ? 'sim' : 'não'}`);
