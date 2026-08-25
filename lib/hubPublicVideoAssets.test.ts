import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCommercialRenderReceipt } from '../remotion/scripts/render-provenance';
import type { HubCommercialRenderFingerprint, HubVideoSlug } from '../remotion/types';
import {
  getHubPublicVideoArtifactPaths,
  HUB_PUBLIC_VIDEO_SLUGS,
  verifyHubPublicVideoAssets,
} from '../scripts/verify-hub-public-videos.mjs';

const temporaryDirectories: string[] = [];

const makeTemporaryRoot = () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wisewolf-hub-video-gate-'));
  temporaryDirectories.push(directory);
  return directory;
};

const writeArtifact = (rootDirectory: string, relativePath: string, content: string) => {
  const target = path.join(rootDirectory, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
};

const COMPOSITION_IDS: Record<HubVideoSlug, string> = {
  'hub-overview': 'HubOverviewPtBr',
  library: 'HubLibraryPtBr',
  'educator-ai': 'HubEducadorIaPtBr',
  wolfie: 'HubWolfiePtBr',
  'school-os': 'HubSchoolOsPtBr',
};

const makeFingerprint = (slug: HubVideoSlug): HubCommercialRenderFingerprint => ({
  schemaVersion: 4,
  slug,
  compositionId: COMPOSITION_IDS[slug],
  scriptHash: '1'.repeat(64),
  audioSha256: '2'.repeat(64),
  compositionInputSha256: '3'.repeat(64),
  compositionSourceSha256: '4'.repeat(64),
  remotionVersion: '4.0.515',
  voiceProvider: 'elevenlabs',
  voiceGateway: null,
  voiceId: 'voice-pt-br',
  voiceName: 'Voz PT-BR',
  voiceLocale: 'pt-BR',
  voiceAccent: 'brazilian',
  voiceSourceAccent: 'brazilian',
  voiceNative: true,
  voiceLocaleValidation: 'verified_languages',
  modelId: 'eleven_v3',
  providerEvidence: {
    provider: 'elevenlabs',
    subscriptionTier: 'creator',
    subscriptionStatus: 'active',
  },
  commercialUseAllowed: true,
  voiceGeneratedAt: '2026-08-23T00:00:00.000Z',
  providerRequestId: 'request-123456',
  render: {
    width: 1920,
    height: 1080,
    fps: 30,
    codec: 'h264',
    pixelFormat: 'yuv420p',
    crf: 22,
    audioBitrate: '128k',
    colorSpace: 'bt709',
    audioMastering: {
      algorithm: 'ffmpeg-loudnorm',
      targetIntegratedLufs: -16,
      targetLraLu: 11,
      targetTruePeakDbtp: -1.5,
      maxTruePeakDbtp: -1,
      audioCodec: 'aac',
      audioBitrate: '128k',
      sampleRateHz: 48000,
    },
  },
});

const writeCompleteCollection = async (rootDirectory: string) => {
  const manifest: Record<string, unknown> = {
    generatedAt: '2026-08-24T00:00:00.000Z',
    videos: {},
  };
  for (const slug of HUB_PUBLIC_VIDEO_SLUGS as readonly HubVideoSlug[]) {
    const artifacts = getHubPublicVideoArtifactPaths(slug);
    const contents = {
      video: `mp4-${slug}`,
      poster: `webp-${slug}`,
      captions: `WEBVTT\n\n00:00.000 --> 00:01.000\n${slug}`,
    };
    writeArtifact(rootDirectory, artifacts.video, contents.video);
    writeArtifact(rootDirectory, artifacts.poster, contents.poster);
    writeArtifact(rootDirectory, artifacts.captions, contents.captions);
    const receipt = await buildCommercialRenderReceipt({
      fingerprint: makeFingerprint(slug),
      artifacts: {
        video: path.join(rootDirectory, artifacts.video),
        poster: path.join(rootDirectory, artifacts.poster),
        captions: path.join(rootDirectory, artifacts.captions),
      },
    });
    writeArtifact(rootDirectory, artifacts.receipt, JSON.stringify(receipt));
    (manifest.videos as Record<string, unknown>)[slug] = {
      video: `/${artifacts.video}`,
      poster: `/${artifacts.poster}`,
      captions: `/${artifacts.captions}`,
      compositionId: COMPOSITION_IDS[slug],
      durationSeconds: 30,
      language: 'pt-BR',
      receipt: `/${artifacts.receipt}`,
      renderFingerprintSha256: receipt.renderFingerprintSha256,
    };
  }
  writeArtifact(rootDirectory, 'assets/hub/videos/manifest.json', JSON.stringify(manifest));
};

describe('Hub public video publication gate', () => {
  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps mockup mode permissive when public videos are disabled and no publishable artifact exists', () => {
    const rootDirectory = makeTemporaryRoot();
    writeArtifact(rootDirectory, 'assets/hub/videos/captions/library.pt-BR.vtt', 'WEBVTT\n');
    expect(verifyHubPublicVideoAssets({ rootDirectory, enabled: false })).toMatchObject({
      enabled: false,
      checked: 0,
    });
  });

  it.each([
    'assets/hub/videos/library.mp4',
    'assets/hub/videos/posters/library.webp',
    'assets/hub/videos/receipts/library.json',
    'assets/hub/videos/manifest.json',
  ])('blocks %s while public videos are disabled', (relativePath) => {
    const rootDirectory = makeTemporaryRoot();
    writeArtifact(rootDirectory, relativePath, 'artefato não publicável');

    expect(() => verifyHubPublicVideoAssets({ rootDirectory, enabled: false })).toThrow(
      `${relativePath}: artefato público presente`,
    );
  });

  it('blocks publication when any required artifact is missing', () => {
    const rootDirectory = makeTemporaryRoot();
    expect(() => verifyHubPublicVideoAssets({ rootDirectory, enabled: true })).toThrow(
      'assets/hub/videos/hub-overview.mp4: ausente',
    );
  });

  it('accepts only the complete five-video collection', async () => {
    const rootDirectory = makeTemporaryRoot();
    await writeCompleteCollection(rootDirectory);

    expect(verifyHubPublicVideoAssets({ rootDirectory, enabled: true })).toMatchObject({
      enabled: true,
      checked: 21,
    });
  });

  it('rejects a collection without its public manifest', async () => {
    const rootDirectory = makeTemporaryRoot();
    await writeCompleteCollection(rootDirectory);
    rmSync(path.join(rootDirectory, 'assets/hub/videos/manifest.json'));

    expect(() => verifyHubPublicVideoAssets({ rootDirectory, enabled: true })).toThrow(
      'assets/hub/videos/manifest.json: ausente',
    );
  });

  it('rejects a manifest whose render fingerprint diverges from the receipt', async () => {
    const rootDirectory = makeTemporaryRoot();
    await writeCompleteCollection(rootDirectory);
    const manifestPath = path.join(rootDirectory, 'assets/hub/videos/manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      videos: Record<string, { renderFingerprintSha256: string }>;
    };
    manifest.videos.library.renderFingerprintSha256 = '9'.repeat(64);
    writeArtifact(rootDirectory, 'assets/hub/videos/manifest.json', JSON.stringify(manifest));

    expect(() => verifyHubPublicVideoAssets({ rootDirectory, enabled: true })).toThrow(
      'fingerprint diverge do receipt de library',
    );
  });

  it('rejects a receipt that belongs to another video', async () => {
    const rootDirectory = makeTemporaryRoot();
    await writeCompleteCollection(rootDirectory);
    const receipt = getHubPublicVideoArtifactPaths('wolfie').receipt;
    const receiptPath = path.join(rootDirectory, receipt);
    const receiptData = JSON.parse(readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
    receiptData.slug = 'library';
    writeArtifact(rootDirectory, receipt, JSON.stringify(receiptData));

    expect(() => verifyHubPublicVideoAssets({ rootDirectory, enabled: true })).toThrow(
      'receipt não corresponde a wolfie',
    );
  });

  it('rejects a collection without explicit commercial rights', async () => {
    const rootDirectory = makeTemporaryRoot();
    await writeCompleteCollection(rootDirectory);
    const receipt = getHubPublicVideoArtifactPaths('library').receipt;
    const receiptPath = path.join(rootDirectory, receipt);
    const receiptData = JSON.parse(readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
    receiptData.commercialUseAllowed = false;
    writeArtifact(rootDirectory, receipt, JSON.stringify(receiptData));

    expect(() => verifyHubPublicVideoAssets({ rootDirectory, enabled: true })).toThrow(
      'licença comercial ausente',
    );
  });

  it('rejects an artifact changed after its receipt was issued', async () => {
    const rootDirectory = makeTemporaryRoot();
    await writeCompleteCollection(rootDirectory);
    const video = getHubPublicVideoArtifactPaths('educator-ai').video;
    writeArtifact(rootDirectory, video, 'mp4-alterado');

    expect(() => verifyHubPublicVideoAssets({ rootDirectory, enabled: true })).toThrow(
      'video diverge do receipt',
    );
  });
});
