import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCommercialRenderReceipt } from '../remotion/scripts/render-provenance';
import type { HubCommercialRenderFingerprint, HubVideoSlug } from '../remotion/types';
import {
  getHubPublicStoryVideoArtifactPaths,
  HUB_PUBLIC_STORY_VIDEO_SLUGS,
  verifyHubPublicStoryVideoAssets,
} from '../scripts/verify-hub-public-story-videos.mjs';

const temporaryDirectories: string[] = [];

const makeTemporaryRoot = () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wisewolf-hub-story-gate-'));
  temporaryDirectories.push(directory);
  return directory;
};

const writeArtifact = (rootDirectory: string, relativePath: string, content: string) => {
  const target = path.join(rootDirectory, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
};

const COMPOSITION_IDS: Record<HubVideoSlug, string> = {
  'hub-overview': 'HubOverviewPtBrStory',
  library: 'HubLibraryPtBrStory',
  'educator-ai': 'HubEducadorIaPtBrStory',
  wolfie: 'HubWolfiePtBrStory',
  'school-os': 'HubSchoolOsPtBrStory',
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
    width: 1080,
    height: 1920,
    fps: 30,
    codec: 'h264',
    pixelFormat: 'yuv420p',
    crf: 18,
    audioBitrate: '192k',
    colorSpace: 'bt709',
    audioMastering: {
      algorithm: 'ffmpeg-loudnorm',
      targetIntegratedLufs: -16,
      targetLraLu: 11,
      targetTruePeakDbtp: -1.5,
      maxTruePeakDbtp: -1,
      audioCodec: 'aac',
      audioBitrate: '192k',
      sampleRateHz: 48000,
    },
  },
});

const writeCompleteCollection = async (rootDirectory: string) => {
  const manifest: Record<string, unknown> = {
    generatedAt: '2026-08-25T00:00:00.000Z',
    format: 'story',
    width: 1080,
    height: 1920,
    aspectRatio: '9:16',
    videos: {},
  };
  for (const slug of HUB_PUBLIC_STORY_VIDEO_SLUGS as readonly HubVideoSlug[]) {
    const artifacts = getHubPublicStoryVideoArtifactPaths(slug);
    writeArtifact(rootDirectory, artifacts.video, `mp4-story-${slug}`);
    writeArtifact(rootDirectory, artifacts.poster, `webp-story-${slug}`);
    writeArtifact(rootDirectory, artifacts.captions, `WEBVTT\n\n00:00.000 --> 00:01.000\n${slug}`);
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
  writeArtifact(rootDirectory, 'assets/hub/videos/social/manifest.json', JSON.stringify(manifest));
};

describe('Hub public Story video publication gate', () => {
  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('allows the disabled mode when no Story artifact exists', () => {
    const rootDirectory = makeTemporaryRoot();
    expect(verifyHubPublicStoryVideoAssets({ rootDirectory, enabled: false })).toMatchObject({
      enabled: false,
      checked: 0,
    });
  });

  it.each([
    'assets/hub/videos/social/library.mp4',
    'assets/hub/videos/social/posters/library.webp',
    'assets/hub/videos/social/receipts/library.json',
    'assets/hub/videos/social/manifest.json',
  ])('blocks %s while public Stories are disabled', (relativePath) => {
    const rootDirectory = makeTemporaryRoot();
    writeArtifact(rootDirectory, relativePath, 'artefato não publicável');
    expect(() => verifyHubPublicStoryVideoAssets({ rootDirectory, enabled: false })).toThrow(
      `${relativePath}: artefato público presente`,
    );
  });

  it('accepts only the complete five-Story collection', async () => {
    const rootDirectory = makeTemporaryRoot();
    await writeCompleteCollection(rootDirectory);
    expect(verifyHubPublicStoryVideoAssets({ rootDirectory, enabled: true })).toMatchObject({
      enabled: true,
      checked: 21,
    });
  });

  it('rejects a horizontal composition receipt inside the Story collection', async () => {
    const rootDirectory = makeTemporaryRoot();
    await writeCompleteCollection(rootDirectory);
    const receipt = getHubPublicStoryVideoArtifactPaths('wolfie').receipt;
    const receiptData = JSON.parse(readFileSync(path.join(rootDirectory, receipt), 'utf8')) as Record<string, unknown>;
    receiptData.compositionId = 'HubWolfiePtBr';
    writeArtifact(rootDirectory, receipt, JSON.stringify(receiptData));
    expect(() => verifyHubPublicStoryVideoAssets({ rootDirectory, enabled: true })).toThrow(
      'composição Story ou idioma inválido',
    );
  });

  it('rejects a Story changed after its receipt was issued', async () => {
    const rootDirectory = makeTemporaryRoot();
    await writeCompleteCollection(rootDirectory);
    const video = getHubPublicStoryVideoArtifactPaths('educator-ai').video;
    writeArtifact(rootDirectory, video, 'mp4-story-alterado');
    expect(() => verifyHubPublicStoryVideoAssets({ rootDirectory, enabled: true })).toThrow(
      'video diverge do receipt',
    );
  });
});
