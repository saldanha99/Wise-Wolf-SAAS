import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  HubCommercialRenderFingerprint,
  HubCommercialRenderReceipt,
  HubVideoContent,
  HubVoiceGateway,
  HubVoiceTrack,
} from '../types';
import { HUB_AUDIO_MASTERING } from './audio-mastering';

type PublicArtifactPaths = {
  video: string;
  poster: string;
  captions: string;
};

type ReceiptValidation = {
  valid: boolean;
  reason?: string;
  receipt?: HubCommercialRenderReceipt;
};

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{6,200}$/u;
const SOURCE_EXTENSIONS = new Set(['.json', '.ts', '.tsx']);
const PUBLIC_AUDIO_DIRECTORY = 'assets/hub/videos/audio';
const EXCLUDED_SOURCE_DIRECTORIES = new Set([
  '.locks',
  '.renders',
  'generated',
  'previews',
  'public',
  'scripts',
]);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasExactKeys = (value: unknown, keys: string[]): boolean =>
  isPlainObject(value)
  && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');

const stableSerialize = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('Valor não serializável no fingerprint comercial.');
  return serialized;
};

export const sha256Value = (value: unknown): string =>
  createHash('sha256').update(stableSerialize(value)).digest('hex');

export const sha256File = async (filePath: string): Promise<string> => {
  const details = await lstat(filePath);
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error(`Artefato de render inválido: ${filePath}`);
  }

  return await new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
};

const collectCompositionSources = async (directory: string): Promise<string[]> => {
  const collected: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Fonte Remotion não pode ser link simbólico: ${absolutePath}`);
    if (entry.isDirectory()) {
      if (!EXCLUDED_SOURCE_DIRECTORIES.has(entry.name)) {
        collected.push(...await collectCompositionSources(absolutePath));
      }
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) continue;
    if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) collected.push(absolutePath);
  }

  return collected;
};

const collectCompositionPublicAssets = async (
  publicRoot: string,
  directory = publicRoot,
): Promise<string[]> => {
  const collected: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    const absolutePath = path.join(directory, entry.name);
    const relativePath = path.relative(publicRoot, absolutePath).split(path.sep).join('/');
    if (entry.isSymbolicLink()) {
      throw new Error(`Ativo público Remotion não pode ser link simbólico: ${relativePath}`);
    }
    if (entry.isDirectory()) {
      if (relativePath !== PUBLIC_AUDIO_DIRECTORY) {
        collected.push(...await collectCompositionPublicAssets(publicRoot, absolutePath));
      }
      continue;
    }
    if (entry.isFile()) collected.push(absolutePath);
  }

  return collected;
};

export const computeCompositionSourceSha256 = async (projectRoot: string): Promise<string> => {
  const publicRoot = path.join(projectRoot, 'remotion/public');
  const publicRootDetails = await lstat(publicRoot);
  if (!publicRootDetails.isDirectory() || publicRootDetails.isSymbolicLink()) {
    throw new Error('A raiz pública do Remotion deve ser um diretório regular.');
  }
  const sourceFiles = [
    path.join(projectRoot, 'remotion.config.ts'),
    ...await collectCompositionSources(path.join(projectRoot, 'remotion')),
    ...await collectCompositionPublicAssets(publicRoot),
  ].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const hash = createHash('sha256');

  for (const sourceFile of sourceFiles) {
    const relativePath = path.relative(projectRoot, sourceFile).split(path.sep).join('/');
    const sourceDetails = await lstat(sourceFile);
    if (!sourceDetails.isFile() || sourceDetails.isSymbolicLink()) {
      throw new Error(`Fonte Remotion inválida: ${relativePath}`);
    }
    hash.update(relativePath);
    hash.update('\0');
    hash.update(await readFile(sourceFile));
    hash.update('\0');
  }

  return hash.digest('hex');
};

export const readInstalledRemotionVersion = async (projectRoot: string): Promise<string> => {
  const packages = [
    'remotion',
    '@remotion/captions',
    '@remotion/cli',
    '@remotion/fonts',
    '@remotion/google-fonts',
    '@remotion/media',
    '@remotion/media-utils',
    '@remotion/transitions',
  ];
  const versions = await Promise.all(packages.map(async (packageName) => {
    const packagePath = path.join(projectRoot, 'node_modules', packageName, 'package.json');
    const packageData = JSON.parse(await readFile(packagePath, 'utf8')) as { version?: string };
    return { packageName, version: packageData.version?.trim() };
  }));
  const version = versions.find(({ packageName }) => packageName === 'remotion')?.version;
  if (!version || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u.test(version)) {
    throw new Error('Não foi possível identificar a versão instalada do Remotion.');
  }
  const mismatch = versions.find((item) => item.version !== version);
  if (mismatch) {
    throw new Error(`Versões Remotion incompatíveis: remotion=${version}, ${mismatch.packageName}=${mismatch.version || 'ausente'}.`);
  }
  return version;
};

const resolveVoiceAudioPath = async (projectRoot: string, audioPath: string): Promise<string> => {
  const normalized = audioPath.trim().replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || normalized.includes('..') || !/^[A-Za-z0-9._/-]+$/u.test(normalized)) {
    throw new Error('Caminho da locução comercial inválido.');
  }

  const publicRoot = path.join(projectRoot, 'remotion/public');
  const resolvedPublicRoot = await realpath(publicRoot);
  const candidate = path.join(publicRoot, normalized);
  const candidateDetails = await lstat(candidate);
  if (candidateDetails.isSymbolicLink()) throw new Error('A locução comercial não pode ser um link simbólico.');
  const resolvedCandidate = await realpath(candidate);
  if (!resolvedCandidate.startsWith(`${resolvedPublicRoot}${path.sep}`)) {
    throw new Error('A locução comercial está fora do diretório público do Remotion.');
  }
  const details = await lstat(resolvedCandidate);
  if (!details.isFile() || details.isSymbolicLink()) throw new Error('A locução comercial não é um arquivo regular.');
  return resolvedCandidate;
};

const requireCommercialTrack = (track: HubVoiceTrack): {
  provider: 'elevenlabs' | 'openai';
  gateway: HubVoiceGateway | null;
  scriptHash: string;
  voiceId: string;
  voiceName: string | null;
  voiceLocale: 'pt-BR';
  voiceAccent: string;
  voiceSourceAccent: string;
  voiceNative: boolean;
  voiceLocaleValidation: NonNullable<HubVoiceTrack['voiceLocaleValidation']>;
  modelId: string;
  providerEvidence: HubCommercialRenderFingerprint['providerEvidence'];
  generatedAt: string;
  requestId: string;
} => {
  if (track.ready !== true || track.commercialUseAllowed !== true) {
    throw new Error('A locução não possui autorização comercial registrada.');
  }
  const provider = track.voiceProvider;
  if (provider !== 'openai' && provider !== 'elevenlabs') throw new Error('Provedor comercial da locução ausente ou inválido.');
  if (!track.scriptHash || !SHA256_PATTERN.test(track.scriptHash)) throw new Error('scriptHash comercial ausente ou inválido.');
  if (!track.voiceId?.trim()) throw new Error('voiceId comercial ausente.');
  if (track.voiceLocale !== 'pt-BR') throw new Error('A locução comercial não possui locale PT-BR validado.');
  if (!track.voiceAccent?.trim()) throw new Error('O sotaque de saída registrado está ausente.');
  if (!track.voiceSourceAccent?.trim()) throw new Error('O sotaque de origem registrado está ausente.');
  if (typeof track.voiceNative !== 'boolean') throw new Error('A origem nativa da voz não foi registrada.');
  let providerEvidence: HubCommercialRenderFingerprint['providerEvidence'];
  let gateway: HubVoiceGateway | null = null;
  if (provider === 'openai') {
    gateway = track.voiceGateway;
    if (gateway !== 'openai' && gateway !== 'openrouter') {
      throw new Error('Gateway comercial da locução OpenAI ausente ou inválido.');
    }
    if (track.voiceLocaleValidation !== 'openai_prompted_pt_br') {
      throw new Error('A locução OpenAI precisa registrar instruções explícitas de português brasileiro.');
    }
    const expectedSourceAccent = gateway === 'openrouter' ? 'openai-built-in' : 'english-optimized';
    if (track.voiceNative !== false || track.voiceAccent !== 'brazilian-prompted' || track.voiceSourceAccent !== expectedSourceAccent) {
      throw new Error('A origem dirigida da voz OpenAI não foi registrada corretamente.');
    }
    const expectedModelId = gateway === 'openrouter' ? 'openai/gpt-audio' : 'gpt-4o-mini-tts';
    if (track.modelId !== expectedModelId || track.voiceId !== 'marin') {
      throw new Error('A locução OpenAI não corresponde ao padrão LiveCall aprovado.');
    }
    if (track.subscriptionTier || track.subscriptionStatus) {
      throw new Error('Plano de assinatura ElevenLabs não pode validar uma locução OpenAI.');
    }
    const expectedLicenseBasis = gateway === 'openrouter' ? 'openrouter_terms' : 'openai_api_terms';
    if (track.commercialLicenseBasis !== expectedLicenseBasis) {
      throw new Error('Base de uso comercial do gateway OpenAI ausente ou incompatível.');
    }
    if (!track.commercialLicenseAcknowledgedAt || Number.isNaN(Date.parse(track.commercialLicenseAcknowledgedAt))) {
      throw new Error('Reconhecimento dos termos OpenAI ausente ou inválido.');
    }
    if (!track.ttsInstructionsSha256 || !SHA256_PATTERN.test(track.ttsInstructionsSha256)) {
      throw new Error('Hash das instruções TTS OpenAI ausente ou inválido.');
    }
    if (track.aiDisclosureMode !== 'burned-in') {
      throw new Error('A publicação OpenAI precisa identificar a voz gerada por IA no próprio vídeo.');
    }
    providerEvidence = {
      provider: 'openai',
      gateway,
      licenseBasis: track.commercialLicenseBasis,
      acknowledgedAt: track.commercialLicenseAcknowledgedAt,
      ttsInstructionsSha256: track.ttsInstructionsSha256,
      aiDisclosureMode: track.aiDisclosureMode,
    };
  } else {
    if (track.voiceGateway) throw new Error('Locução ElevenLabs não pode registrar gateway OpenAI.');
    if (!['verified_languages', 'voice_labels', 'multilingual_premade_override'].includes(track.voiceLocaleValidation || '')) {
      throw new Error('A evidência regional PT-BR da locução ElevenLabs está ausente.');
    }
    if (track.voiceLocaleValidation === 'multilingual_premade_override') {
      if (track.voiceNative !== false || !/american|estadunidense/iu.test(track.voiceSourceAccent)) {
        throw new Error('A origem americana da voz premade multilíngue não foi registrada corretamente.');
      }
      if (!['eleven_multilingual_v2', 'eleven_v3'].includes(track.modelId || '')) {
        throw new Error('Modelo incompatível com a exceção de voz premade multilíngue.');
      }
    } else if (track.voiceNative !== true) {
      throw new Error('Uma voz marcada como nativa precisa registrar voiceNative=true.');
    }
    if (!track.subscriptionTier?.trim() || track.subscriptionTier === 'free') throw new Error('Plano comercial da locução ausente.');
    if (!['active', 'trialing'].includes(track.subscriptionStatus || '')) throw new Error('Status comercial ativo da locução ausente.');
    if (track.commercialLicenseBasis || track.commercialLicenseAcknowledgedAt || track.ttsInstructionsSha256 || track.aiDisclosureMode) {
      throw new Error('Evidências comerciais OpenAI não podem validar uma locução ElevenLabs.');
    }
    providerEvidence = {
      provider: 'elevenlabs',
      subscriptionTier: track.subscriptionTier.trim(),
      subscriptionStatus: track.subscriptionStatus as 'active' | 'trialing',
    };
  }
  if (!track.modelId?.trim()) throw new Error('modelId comercial ausente.');
  if (!track.generatedAt || Number.isNaN(Date.parse(track.generatedAt))) throw new Error('Data de geração comercial ausente.');
  if (!track.requestId || !REQUEST_ID_PATTERN.test(track.requestId)) throw new Error('Request ID comercial ausente ou inválido.');
  return {
    provider,
    gateway,
    scriptHash: track.scriptHash,
    voiceId: track.voiceId.trim(),
    voiceName: track.voiceName?.trim() || null,
    voiceLocale: track.voiceLocale,
    voiceAccent: track.voiceAccent.trim(),
    voiceSourceAccent: track.voiceSourceAccent.trim(),
    voiceNative: track.voiceNative,
    voiceLocaleValidation: track.voiceLocaleValidation,
    modelId: track.modelId.trim(),
    providerEvidence,
    generatedAt: track.generatedAt,
    requestId: track.requestId,
  };
};

export const buildCommercialRenderFingerprint = async ({
  projectRoot,
  content,
  track,
  compositionSourceSha256,
  remotionVersion,
  width,
  height,
  fps,
}: {
  projectRoot: string;
  content: HubVideoContent;
  track: HubVoiceTrack;
  compositionSourceSha256: string;
  remotionVersion: string;
  width: number;
  height: number;
  fps: number;
}): Promise<HubCommercialRenderFingerprint> => {
  const commercialTrack = requireCommercialTrack(track);
  if (!SHA256_PATTERN.test(compositionSourceSha256)) throw new Error('Hash das fontes Remotion inválido.');
  const audioFile = await resolveVoiceAudioPath(projectRoot, track.audioPath);

  return {
    schemaVersion: 4,
    slug: content.slug,
    compositionId: content.id,
    scriptHash: commercialTrack.scriptHash,
    audioSha256: await sha256File(audioFile),
    compositionInputSha256: sha256Value({
      durationSeconds: track.durationSeconds,
      durationInFrames: track.durationInFrames,
      audioPath: track.audioPath,
      captions: track.captions,
      scenes: track.scenes,
    }),
    compositionSourceSha256,
    remotionVersion,
    voiceProvider: commercialTrack.provider,
    voiceGateway: commercialTrack.gateway,
    voiceId: commercialTrack.voiceId,
    voiceName: commercialTrack.voiceName,
    voiceLocale: commercialTrack.voiceLocale,
    voiceAccent: commercialTrack.voiceAccent,
    voiceSourceAccent: commercialTrack.voiceSourceAccent,
    voiceNative: commercialTrack.voiceNative,
    voiceLocaleValidation: commercialTrack.voiceLocaleValidation,
    modelId: commercialTrack.modelId,
    providerEvidence: commercialTrack.providerEvidence,
    commercialUseAllowed: true,
    voiceGeneratedAt: commercialTrack.generatedAt,
    providerRequestId: commercialTrack.requestId,
    render: {
      width,
      height,
      fps,
      codec: 'h264',
      pixelFormat: 'yuv420p',
      crf: 22,
      audioBitrate: '128k',
      colorSpace: 'bt709',
      audioMastering: HUB_AUDIO_MASTERING,
    },
  };
};

const artifactSha256 = async (artifactPath: string): Promise<string> => {
  const details = await stat(artifactPath);
  if (!details.isFile() || details.size <= 0) throw new Error(`Artefato comercial ausente: ${artifactPath}`);
  return await sha256File(artifactPath);
};

export const buildCommercialRenderReceipt = async ({
  fingerprint,
  artifacts,
}: {
  fingerprint: HubCommercialRenderFingerprint;
  artifacts: PublicArtifactPaths;
}): Promise<HubCommercialRenderReceipt> => {
  const receiptData = {
    schemaVersion: 1 as const,
    slug: fingerprint.slug,
    generatedAt: new Date().toISOString(),
    language: 'pt-BR' as const,
    compositionId: fingerprint.compositionId,
    commercialUseAllowed: true as const,
    renderFingerprintSha256: sha256Value(fingerprint),
    artifacts: {
      videoSha256: await artifactSha256(artifacts.video),
      posterSha256: await artifactSha256(artifacts.poster),
      captionsSha256: await artifactSha256(artifacts.captions),
    },
  };
  return {
    ...receiptData,
    receiptFingerprintSha256: sha256Value(receiptData),
  };
};

export const writeCommercialRenderReceiptAtomic = async (
  receiptPath: string,
  receipt: HubCommercialRenderReceipt,
): Promise<void> => {
  await mkdir(path.dirname(receiptPath), { recursive: true });
  const temporaryPath = `${receiptPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporaryPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 });
  await rename(temporaryPath, receiptPath);
};

const receiptArtifactMatches = async (
  artifactPath: string,
  recordedSha256: string,
): Promise<boolean> => {
  if (!SHA256_PATTERN.test(recordedSha256)) return false;
  const details = await stat(artifactPath);
  if (!details.isFile() || details.size <= 0) return false;
  return await sha256File(artifactPath) === recordedSha256;
};

export const validateCommercialRenderReceipt = async ({
  receiptPath,
  expectedFingerprint,
  artifacts,
}: {
  receiptPath: string;
  expectedFingerprint: HubCommercialRenderFingerprint;
  artifacts: PublicArtifactPaths;
}): Promise<ReceiptValidation> => {
  try {
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as HubCommercialRenderReceipt;
    if (!hasExactKeys(receipt, [
      'schemaVersion',
      'slug',
      'generatedAt',
      'language',
      'compositionId',
      'commercialUseAllowed',
      'renderFingerprintSha256',
      'receiptFingerprintSha256',
      'artifacts',
    ])) return { valid: false, reason: 'campos públicos do receipt inválidos' };
    if (!hasExactKeys(receipt.artifacts, ['videoSha256', 'posterSha256', 'captionsSha256'])) return { valid: false, reason: 'lista de artefatos do receipt inválida' };
    if (receipt.schemaVersion !== 1) return { valid: false, reason: 'schema do receipt inválido' };
    if (!receipt.generatedAt || Number.isNaN(Date.parse(receipt.generatedAt))) return { valid: false, reason: 'data do receipt inválida' };
    if (receipt.slug !== expectedFingerprint.slug) return { valid: false, reason: 'slug do receipt divergente' };
    if (receipt.language !== 'pt-BR') return { valid: false, reason: 'idioma do receipt inválido' };
    if (receipt.compositionId !== expectedFingerprint.compositionId) return { valid: false, reason: 'composição do receipt divergente' };
    if (receipt.commercialUseAllowed !== true) return { valid: false, reason: 'licença comercial ausente no receipt' };
    const expectedFingerprintSha256 = sha256Value(expectedFingerprint);
    if (receipt.renderFingerprintSha256 !== expectedFingerprintSha256) return { valid: false, reason: 'fingerprint divergente' };
    const { receiptFingerprintSha256, ...receiptData } = receipt;
    if (receiptFingerprintSha256 !== sha256Value(receiptData)) return { valid: false, reason: 'integridade do receipt inválida' };
    if (!await receiptArtifactMatches(artifacts.video, receipt.artifacts.videoSha256)) return { valid: false, reason: 'vídeo diverge do receipt' };
    if (!await receiptArtifactMatches(artifacts.poster, receipt.artifacts.posterSha256)) return { valid: false, reason: 'pôster diverge do receipt' };
    if (!await receiptArtifactMatches(artifacts.captions, receipt.artifacts.captionsSha256)) return { valid: false, reason: 'legenda diverge do receipt' };
    return { valid: true, receipt };
  } catch (error) {
    return { valid: false, reason: error instanceof Error ? error.message : String(error) };
  }
};
