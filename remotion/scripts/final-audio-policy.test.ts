import { describe, expect, it } from 'vitest';
import type { HubVoiceTrack } from '../types';
import {
  assertHubFinalAudioTrack,
  isFinalAudioStrictModeEnabled,
} from './final-audio-policy';

const finalTrack = (overrides: Partial<HubVoiceTrack> = {}): HubVoiceTrack => ({
  ready: true,
  durationSeconds: 3,
  durationInFrames: 90,
  audioPath: 'assets/hub/videos/audio/hub-overview.mp3',
  voiceProvider: 'elevenlabs',
  voiceId: 'native-male-pt-br',
  voiceName: 'Wolfie PT-BR',
  voiceLocale: 'pt-BR',
  voiceAccent: 'brazilian',
  voiceSourceAccent: 'brazilian',
  voiceNative: true,
  voiceGender: 'male',
  voiceLocaleValidation: 'verified_languages',
  narrationTake: 'single_continuous',
  narrationRequestCount: 1,
  captionTimingSource: 'provider_alignment',
  modelId: 'eleven_v3',
  scriptHash: 'a'.repeat(64),
  subscriptionTier: 'creator',
  subscriptionStatus: 'active',
  commercialUseAllowed: true,
  generatedAt: '2026-08-25T00:00:00.000Z',
  requestId: 'request-123456',
  captions: [{
    text: 'Conheça o Hub.',
    startSeconds: 0.2,
    endSeconds: 1.4,
    startMs: 200,
    endMs: 1400,
    timestampMs: null,
    confidence: null,
    tokens: [
      { text: 'Conheça', startMs: 200, endMs: 720 },
      { text: 'o', startMs: 760, endMs: 850 },
      { text: 'Hub.', startMs: 900, endMs: 1400 },
    ],
  }],
  scenes: {
    hook: { startSeconds: 0, endSeconds: 0.6 },
    problem: { startSeconds: 0.6, endSeconds: 1.2 },
    product: { startSeconds: 1.2, endSeconds: 1.8 },
    proof: { startSeconds: 1.8, endSeconds: 2.4 },
    cta: { startSeconds: 2.4, endSeconds: 3 },
  },
  ...overrides,
});

describe('final audio publication policy', () => {
  it('accepts only a licensed single-take native male PT-BR track with real alignment', () => {
    expect(assertHubFinalAudioTrack(finalTrack())).toMatchObject({
      policyVersion: 1,
      voiceProvider: 'elevenlabs',
      voiceNative: true,
      voiceGender: 'male',
      narrationRequestCount: 1,
      captionTimingSource: 'provider_alignment',
      tokenCount: 3,
    });
  });

  it.each([
    ['voz não nativa', { voiceNative: false }],
    ['voz feminina', { voiceGender: 'female' as const }],
    ['take segmentado', { narrationTake: 'segmented' as const, narrationRequestCount: 5 }],
    ['tempo estimado', { captionTimingSource: 'estimated' as const }],
    ['sem palavras alinhadas', { captions: [{ ...finalTrack().captions[0], tokens: undefined }] }],
  ])('rejects %s', (_label, overrides) => {
    expect(() => assertHubFinalAudioTrack(finalTrack(overrides))).toThrow();
  });

  it('keeps strict mode fail-closed unless legacy compatibility is explicit', () => {
    expect(isFinalAudioStrictModeEnabled(undefined)).toBe(true);
    expect(isFinalAudioStrictModeEnabled('true')).toBe(true);
    expect(isFinalAudioStrictModeEnabled('1')).toBe(true);
    expect(isFinalAudioStrictModeEnabled('0')).toBe(false);
  });
});
