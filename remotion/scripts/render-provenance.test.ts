import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HUB_VIDEOS } from '../content/hub-videos';
import type { HubCommercialRenderFingerprint, HubVoiceTrack } from '../types';
import {
  buildCommercialRenderFingerprint,
  buildCommercialRenderReceipt,
  computeCompositionSourceSha256,
  validateCommercialRenderReceipt,
  writeCommercialRenderReceiptAtomic,
} from './render-provenance';

const fingerprint: HubCommercialRenderFingerprint = {
  schemaVersion: 4,
  slug: 'hub-overview',
  compositionId: 'HubOverviewPtBr',
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
};

const openAiTrack = (overrides: Partial<HubVoiceTrack> = {}): HubVoiceTrack => ({
  ready: true,
  durationSeconds: 10,
  durationInFrames: 300,
  audioPath: 'assets/hub/videos/audio/hub-overview.mp3',
  voiceProvider: 'openai',
  voiceGateway: 'openai',
  voiceId: 'marin',
  voiceName: 'OpenAI Marin · LiveCall',
  voiceLocale: 'pt-BR',
  voiceAccent: 'brazilian-prompted',
  voiceSourceAccent: 'english-optimized',
  voiceNative: false,
  voiceLocaleValidation: 'openai_prompted_pt_br',
  modelId: 'gpt-4o-mini-tts',
  scriptHash: 'a'.repeat(64),
  commercialUseAllowed: true,
  commercialLicenseBasis: 'openai_api_terms',
  commercialLicenseAcknowledgedAt: '2026-08-23T00:00:00.000Z',
  ttsInstructionsSha256: 'b'.repeat(64),
  aiDisclosureMode: 'burned-in',
  generatedAt: '2026-08-23T00:00:00.000Z',
  requestId: 'req_openai_123456789',
  captions: [],
  scenes: {
    hook: { startSeconds: 0, endSeconds: 2 },
    problem: { startSeconds: 2, endSeconds: 4 },
    product: { startSeconds: 4, endSeconds: 6 },
    proof: { startSeconds: 6, endSeconds: 8 },
    cta: { startSeconds: 8, endSeconds: 10 },
  },
  ...overrides,
});

const withOpenAiAudio = async (run: (projectRoot: string) => Promise<void>) => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'wise-wolf-openai-track-'));
  const audioPath = path.join(projectRoot, 'remotion/public/assets/hub/videos/audio/hub-overview.mp3');
  try {
    await mkdir(path.dirname(audioPath), { recursive: true });
    await writeFile(audioPath, 'audio-openai');
    await run(projectRoot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
};

describe('commercial render provenance', () => {
  it('accepts only the approved OpenAI LiveCall evidence', async () => {
    await withOpenAiAudio(async (projectRoot) => {
      const result = await buildCommercialRenderFingerprint({
        projectRoot,
        content: HUB_VIDEOS[0],
        track: openAiTrack(),
        compositionSourceSha256: 'c'.repeat(64),
        remotionVersion: '4.0.515',
        width: 1920,
        height: 1080,
        fps: 30,
      });
      expect(result).toMatchObject({
        schemaVersion: 4,
        voiceProvider: 'openai',
        voiceGateway: 'openai',
        voiceId: 'marin',
        modelId: 'gpt-4o-mini-tts',
        providerEvidence: {
          provider: 'openai',
          gateway: 'openai',
          licenseBasis: 'openai_api_terms',
          aiDisclosureMode: 'burned-in',
        },
      });
    });
  });

  it('records an OpenAI voice routed through OpenRouter without conflating gateways', async () => {
    await withOpenAiAudio(async (projectRoot) => {
      const result = await buildCommercialRenderFingerprint({
        projectRoot,
        content: HUB_VIDEOS[0],
        track: openAiTrack({
          voiceGateway: 'openrouter',
          voiceName: 'OpenAI Marin via OpenRouter · LiveCall PT-BR',
          voiceSourceAccent: 'openai-built-in',
          modelId: 'openai/gpt-audio',
          commercialLicenseBasis: 'openrouter_terms',
          requestId: 'gen-openrouter-123456789',
        }),
        compositionSourceSha256: 'c'.repeat(64),
        remotionVersion: '4.0.515',
        width: 1920,
        height: 1080,
        fps: 30,
      });

      expect(result).toMatchObject({
        schemaVersion: 4,
        voiceProvider: 'openai',
        voiceGateway: 'openrouter',
        voiceId: 'marin',
        modelId: 'openai/gpt-audio',
        providerEvidence: {
          provider: 'openai',
          gateway: 'openrouter',
          licenseBasis: 'openrouter_terms',
          aiDisclosureMode: 'burned-in',
        },
      });
    });
  });

  it.each([
    ['provider', { voiceProvider: undefined }],
    ['gateway', { voiceGateway: undefined }],
    ['voice', { voiceId: 'cedar' }],
    ['model', { modelId: 'tts-1' }],
    ['native claim', { voiceNative: true }],
    ['locale evidence', { voiceLocaleValidation: 'verified_languages' as const }],
    ['license', { commercialLicenseBasis: undefined }],
    ['instructions', { ttsInstructionsSha256: undefined }],
    ['disclosure', { aiDisclosureMode: undefined }],
  ])('rejects invalid OpenAI evidence: %s', async (_label, overrides) => {
    await withOpenAiAudio(async (projectRoot) => {
      await expect(buildCommercialRenderFingerprint({
        projectRoot,
        content: HUB_VIDEOS[0],
        track: openAiTrack(overrides),
        compositionSourceSha256: 'c'.repeat(64),
        remotionVersion: '4.0.515',
        width: 1920,
        height: 1080,
        fps: 30,
      })).rejects.toThrow();
    });
  });

  it('hashes public visual assets while excluding per-track voice audio', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'wise-wolf-source-hash-'));
    const visualAsset = path.join(projectRoot, 'remotion/public/assets/visual.webp');
    const audioAsset = path.join(projectRoot, 'remotion/public/assets/hub/videos/audio/voice.mp3');

    try {
      await mkdir(path.dirname(visualAsset), { recursive: true });
      await mkdir(path.dirname(audioAsset), { recursive: true });
      await writeFile(path.join(projectRoot, 'remotion.config.ts'), 'export default {};');
      await writeFile(path.join(projectRoot, 'remotion/Root.tsx'), 'export const Root = () => null;');
      await writeFile(visualAsset, 'visual-original');
      await writeFile(audioAsset, 'audio-original');

      const originalHash = await computeCompositionSourceSha256(projectRoot);
      await writeFile(visualAsset, 'visual-alterado');
      const visualHash = await computeCompositionSourceSha256(projectRoot);
      expect(visualHash).not.toBe(originalHash);

      await writeFile(audioAsset, 'audio-alterado');
      await expect(computeCompositionSourceSha256(projectRoot)).resolves.toBe(visualHash);

      const renamedVisualAsset = path.join(projectRoot, 'remotion/public/assets/visual-renomeado.webp');
      await rename(visualAsset, renamedVisualAsset);
      await expect(computeCompositionSourceSha256(projectRoot)).resolves.not.toBe(visualHash);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('accepts only matching fingerprints and artifacts', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'wise-wolf-receipt-'));
    const video = path.join(projectRoot, 'public/video.mp4');
    const poster = path.join(projectRoot, 'public/poster.webp');
    const captions = path.join(projectRoot, 'public/captions.vtt');
    const receiptPath = path.join(projectRoot, 'public/receipts/hub-overview.json');

    try {
      await mkdir(path.dirname(video), { recursive: true });
      await writeFile(video, 'video-original');
      await writeFile(poster, 'poster-original');
      await writeFile(captions, 'WEBVTT\n\nlegenda-original');
      const receipt = await buildCommercialRenderReceipt({
        fingerprint,
        artifacts: { video, poster, captions },
      });
      await writeCommercialRenderReceiptAtomic(receiptPath, receipt);

      await expect(validateCommercialRenderReceipt({
        receiptPath,
        expectedFingerprint: fingerprint,
        artifacts: { video, poster, captions },
      })).resolves.toMatchObject({ valid: true });
      await expect(readdir(path.dirname(receiptPath))).resolves.toEqual(['hub-overview.json']);
      const publicReceipt = JSON.parse(await readFile(receiptPath, 'utf8')) as Record<string, unknown>;
      expect(publicReceipt).toMatchObject({
        schemaVersion: 1,
        slug: 'hub-overview',
        language: 'pt-BR',
        compositionId: 'HubOverviewPtBr',
        commercialUseAllowed: true,
      });
      expect(publicReceipt).not.toHaveProperty('fingerprint');
      expect(JSON.stringify(publicReceipt)).not.toMatch(/request|subscription|tier|voice/iu);

      await writeFile(video, 'video-alterado');
      await expect(validateCommercialRenderReceipt({
        receiptPath,
        expectedFingerprint: fingerprint,
        artifacts: { video, poster, captions },
      })).resolves.toMatchObject({ valid: false, reason: 'vídeo diverge do receipt' });

      await writeFile(video, 'video-original');
      await expect(validateCommercialRenderReceipt({
        receiptPath,
        expectedFingerprint: { ...fingerprint, scriptHash: '5'.repeat(64) },
        artifacts: { video, poster, captions },
      })).resolves.toMatchObject({ valid: false, reason: 'fingerprint divergente' });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
