import { describe, expect, it } from 'vitest';
import { assertElevenLabsCollectionCapacity } from './elevenlabs-capacity';

describe('ElevenLabs collection capacity', () => {
  it('accepts a collection that fits in the remaining quota', () => {
    expect(() => assertElevenLabsCollectionCapacity({
      characterCount: 1_000,
      characterLimit: 5_000,
      requiredCharacters: 3_500,
    })).not.toThrow();
  });

  it('rejects the whole collection before a partial generation', () => {
    expect(() => assertElevenLabsCollectionCapacity({
      characterCount: 9_622,
      characterLimit: 10_000,
      requiredCharacters: 2_468,
    })).toThrow(/Faltam pelo menos 2090 caracteres/u);
  });

  it('allows a fully cached collection without consuming quota', () => {
    expect(() => assertElevenLabsCollectionCapacity({
      characterCount: 10_000,
      characterLimit: 10_000,
      requiredCharacters: 0,
    })).not.toThrow();
  });

  it('defers to the provider when quota counters are unavailable', () => {
    expect(() => assertElevenLabsCollectionCapacity({
      characterCount: undefined,
      characterLimit: undefined,
      requiredCharacters: 2_468,
    })).not.toThrow();
  });
});
