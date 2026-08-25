import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HUB_PUBLIC_VIDEO_SLUGS = Object.freeze([
  'hub-overview',
  'library',
  'educator-ai',
  'wolfie',
  'school-os',
]);

const HUB_PUBLIC_VIDEO_COMPOSITIONS = Object.freeze({
  'hub-overview': 'HubOverviewPtBr',
  library: 'HubLibraryPtBr',
  'educator-ai': 'HubEducadorIaPtBr',
  wolfie: 'HubWolfiePtBr',
  'school-os': 'HubSchoolOsPtBr',
});

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasExactKeys = (value, keys) =>
  isPlainObject(value)
  && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');

const stableSerialize = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('valor não serializável');
  return serialized;
};

const sha256Value = (value) =>
  createHash('sha256').update(stableSerialize(value)).digest('hex');

const sha256File = (filePath) =>
  createHash('sha256').update(readFileSync(filePath)).digest('hex');

export const isHubPublicVideosEnabled = (value = process.env.VITE_HUB_PUBLIC_VIDEOS) =>
  value?.trim() === 'true';

export const getHubPublicVideoArtifactPaths = (slug) => ({
  video: `assets/hub/videos/${slug}.mp4`,
  poster: `assets/hub/videos/posters/${slug}.webp`,
  captions: `assets/hub/videos/captions/${slug}.pt-BR.vtt`,
  receipt: `assets/hub/videos/receipts/${slug}.json`,
});

const HUB_PUBLIC_VIDEO_MANIFEST_PATH = 'assets/hub/videos/manifest.json';
const HUB_PUBLIC_VIDEO_MANIFEST_KEYS = Object.freeze([
  'video',
  'poster',
  'captions',
  'compositionId',
  'durationSeconds',
  'language',
  'receipt',
  'renderFingerprintSha256',
]);

const resolveInside = (rootDirectory, relativePath) => {
  const resolvedRoot = path.resolve(rootDirectory);
  const resolvedPath = path.resolve(resolvedRoot, relativePath);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`artefato fora da raiz permitida: ${relativePath}`);
  }
  return resolvedPath;
};

const isDisabledPublicArtifact = (relativePath) => {
  const normalizedPath = relativePath.split(path.sep).join('/').toLowerCase();
  const videoRelativePath = path.posix.relative('assets/hub/videos', normalizedPath);
  const segments = videoRelativePath.split('/');
  const extension = path.posix.extname(normalizedPath);

  return extension === '.mp4'
    || (segments[0] === 'posters' && extension === '.webp')
    || (segments[0] === 'receipts' && extension === '.json')
    || path.posix.basename(normalizedPath) === 'manifest.json';
};

const findDisabledPublicArtifacts = (rootDirectory) => {
  const videoRootRelativePath = 'assets/hub/videos';
  const videoRoot = resolveInside(rootDirectory, videoRootRelativePath);
  let rootStats;
  try {
    rootStats = lstatSync(videoRoot);
  } catch {
    return [];
  }

  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    return [`${videoRootRelativePath}: raiz pública inválida`];
  }

  const blocked = [];
  const walk = (directory) => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);

    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(rootDirectory, absolutePath).split(path.sep).join('/');
      if (entry.isSymbolicLink()) {
        blocked.push(`${relativePath}: link simbólico não permitido`);
      } else if (entry.isDirectory()) {
        walk(absolutePath);
      } else if (entry.isFile() && isDisabledPublicArtifact(relativePath)) {
        blocked.push(relativePath);
      }
    }
  };

  walk(videoRoot);
  return blocked;
};

const inspectArtifact = (rootDirectory, slug, kind, relativePath) => {
  const artifactPath = resolveInside(rootDirectory, relativePath);
  let stats;
  try {
    stats = lstatSync(artifactPath);
  } catch {
    return `${relativePath}: ausente`;
  }

  if (stats.isSymbolicLink() || !stats.isFile()) return `${relativePath}: não é um arquivo regular`;
  if (stats.size === 0) return `${relativePath}: arquivo vazio`;

  if (kind === 'captions') {
    const captions = readFileSync(artifactPath, 'utf8');
    if (!captions.startsWith('WEBVTT')) return `${relativePath}: legenda WebVTT inválida`;
  }

  if (kind === 'receipt') {
    try {
      const receipt = JSON.parse(readFileSync(artifactPath, 'utf8'));
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
      ])) return `${relativePath}: campos públicos do receipt inválidos`;
      if (!hasExactKeys(receipt.artifacts, ['videoSha256', 'posterSha256', 'captionsSha256'])) {
        return `${relativePath}: lista de artefatos inválida`;
      }
      if (receipt.schemaVersion !== 1 || receipt.slug !== slug) {
        return `${relativePath}: receipt não corresponde a ${slug}`;
      }
      if (receipt.language !== 'pt-BR'
        || receipt.compositionId !== HUB_PUBLIC_VIDEO_COMPOSITIONS[slug]) {
        return `${relativePath}: composição ou idioma inválido`;
      }
      if (receipt.commercialUseAllowed !== true) {
        return `${relativePath}: licença comercial ausente`;
      }
      if (!receipt.generatedAt || Number.isNaN(Date.parse(receipt.generatedAt))) {
        return `${relativePath}: data de geração inválida`;
      }
      if (!SHA256_PATTERN.test(receipt.renderFingerprintSha256)
        || !SHA256_PATTERN.test(receipt.receiptFingerprintSha256)) {
        return `${relativePath}: fingerprint inválido`;
      }
      const { receiptFingerprintSha256, ...receiptData } = receipt;
      if (sha256Value(receiptData) !== receiptFingerprintSha256) {
        return `${relativePath}: integridade do receipt inválida`;
      }

      const expectedArtifacts = getHubPublicVideoArtifactPaths(slug);
      for (const [artifactKind, receiptKey] of [
        ['video', 'videoSha256'],
        ['poster', 'posterSha256'],
        ['captions', 'captionsSha256'],
      ]) {
        const recordedSha256 = receipt.artifacts[receiptKey];
        const expectedPath = resolveInside(rootDirectory, expectedArtifacts[artifactKind]);
        if (!SHA256_PATTERN.test(recordedSha256)
          || sha256File(expectedPath) !== recordedSha256) {
          return `${relativePath}: ${artifactKind} diverge do receipt`;
        }
      }
    } catch {
      return `${relativePath}: receipt JSON inválido`;
    }
  }

  return null;
};

const inspectManifest = (rootDirectory) => {
  const manifestPath = resolveInside(rootDirectory, HUB_PUBLIC_VIDEO_MANIFEST_PATH);
  let stats;
  try {
    stats = lstatSync(manifestPath);
  } catch {
    return `${HUB_PUBLIC_VIDEO_MANIFEST_PATH}: ausente`;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    return `${HUB_PUBLIC_VIDEO_MANIFEST_PATH}: não é um arquivo regular`;
  }
  if (stats.size === 0) return `${HUB_PUBLIC_VIDEO_MANIFEST_PATH}: arquivo vazio`;

  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (!hasExactKeys(manifest, ['generatedAt', 'videos'])
      || !manifest.generatedAt
      || Number.isNaN(Date.parse(manifest.generatedAt))) {
      return `${HUB_PUBLIC_VIDEO_MANIFEST_PATH}: cabeçalho inválido`;
    }
    if (!hasExactKeys(manifest.videos, HUB_PUBLIC_VIDEO_SLUGS)) {
      return `${HUB_PUBLIC_VIDEO_MANIFEST_PATH}: coleção de vídeos inválida`;
    }

    for (const slug of HUB_PUBLIC_VIDEO_SLUGS) {
      const entry = manifest.videos[slug];
      if (!hasExactKeys(entry, HUB_PUBLIC_VIDEO_MANIFEST_KEYS)) {
        return `${HUB_PUBLIC_VIDEO_MANIFEST_PATH}: campos inválidos para ${slug}`;
      }
      const artifacts = getHubPublicVideoArtifactPaths(slug);
      if (entry.video !== `/${artifacts.video}`
        || entry.poster !== `/${artifacts.poster}`
        || entry.captions !== `/${artifacts.captions}`
        || entry.receipt !== `/${artifacts.receipt}`
        || entry.compositionId !== HUB_PUBLIC_VIDEO_COMPOSITIONS[slug]
        || entry.language !== 'pt-BR'
        || !Number.isFinite(entry.durationSeconds)
        || entry.durationSeconds <= 0
        || !SHA256_PATTERN.test(entry.renderFingerprintSha256)) {
        return `${HUB_PUBLIC_VIDEO_MANIFEST_PATH}: metadados inválidos para ${slug}`;
      }

      const receipt = JSON.parse(readFileSync(resolveInside(rootDirectory, artifacts.receipt), 'utf8'));
      if (entry.renderFingerprintSha256 !== receipt.renderFingerprintSha256) {
        return `${HUB_PUBLIC_VIDEO_MANIFEST_PATH}: fingerprint diverge do receipt de ${slug}`;
      }
    }
  } catch {
    return `${HUB_PUBLIC_VIDEO_MANIFEST_PATH}: JSON ou referência inválida`;
  }

  return null;
};

/**
 * @typedef {object} HubPublicVideoVerificationOptions
 * @property {string} rootDirectory
 * @property {boolean} [enabled]
 */

/**
 * @param {HubPublicVideoVerificationOptions} options
 */
export const verifyHubPublicVideoAssets = ({
  rootDirectory,
  enabled = isHubPublicVideosEnabled(),
}) => {
  if (!rootDirectory) throw new Error('rootDirectory é obrigatório');
  if (!enabled) {
    const blockedArtifacts = findDisabledPublicArtifacts(rootDirectory);
    if (blockedArtifacts.length > 0) {
      throw new Error(
        `[Publicação dos vídeos do Hub bloqueada]\n${blockedArtifacts.map((artifact) => `- ${artifact}: artefato público presente com VITE_HUB_PUBLIC_VIDEOS=false`).join('\n')}`,
      );
    }
    return { enabled: false, checked: 0, rootDirectory: path.resolve(rootDirectory) };
  }

  const failures = [];
  let checked = 0;
  for (const slug of HUB_PUBLIC_VIDEO_SLUGS) {
    const artifacts = getHubPublicVideoArtifactPaths(slug);
    for (const [kind, relativePath] of Object.entries(artifacts)) {
      checked += 1;
      const failure = inspectArtifact(rootDirectory, slug, kind, relativePath);
      if (failure) failures.push(failure);
    }
  }
  checked += 1;
  const manifestFailure = inspectManifest(rootDirectory);
  if (manifestFailure) failures.push(manifestFailure);

  if (failures.length > 0) {
    throw new Error(
      `[Publicação dos vídeos do Hub bloqueada]\n${failures.map((failure) => `- ${failure}`).join('\n')}`,
    );
  }

  return { enabled: true, checked, rootDirectory: path.resolve(rootDirectory) };
};

const isDirectExecution = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf('--root');
  const enabledIndex = args.indexOf('--enabled');
  const rootDirectory = rootIndex >= 0 ? args[rootIndex + 1] : 'public';
  const enabled = enabledIndex >= 0
    ? isHubPublicVideosEnabled(args[enabledIndex + 1])
    : isHubPublicVideosEnabled();

  try {
    const result = verifyHubPublicVideoAssets({ rootDirectory, enabled });
    if (result.enabled) {
      console.log(`Vídeos públicos do Hub validados: ${result.checked} artefatos em ${result.rootDirectory}`);
    } else {
      console.log('Vídeos públicos do Hub desativados; os mockups permanecem ativos.');
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
