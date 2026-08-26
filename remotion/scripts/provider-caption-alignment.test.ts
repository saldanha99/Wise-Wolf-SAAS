import { describe, expect, it } from 'vitest';
import {
  assertProviderCharacterAlignment,
  buildProviderAlignedCaptions,
  buildProviderAlignedSceneTimings,
  type ProviderCharacterAlignment,
} from './provider-caption-alignment';

const makeAlignment = (text: string): ProviderCharacterAlignment => ({
  characters: [...text],
  character_start_times_seconds: [...text].map((_, index) => index * 0.055),
  character_end_times_seconds: [...text].map((_, index) => (index + 1) * 0.055),
});

describe('provider caption alignment', () => {
  it('preserves literal text and real word boundaries', () => {
    const text = 'Ensine com calma, clareza e intenção.';
    const captions = buildProviderAlignedCaptions(text, makeAlignment(text));
    const tokens = captions.flatMap((caption) => caption.tokens || []);

    expect(captions.length).toBeGreaterThan(1);
    expect(tokens.map((token) => token.text).join(' ')).toBe(text);
    expect(tokens[0].startMs).toBe(0);
    expect(tokens.every((token) => token.endMs > token.startMs)).toBe(true);
    expect(captions.every((caption) => caption.tokens?.length && caption.tokens.length <= 6)).toBe(true);
  });

  it('rejects normalized or malformed provider transcripts', () => {
    const text = 'Português do Brasil.';
    const mismatched = makeAlignment('Portugues do Brasil.');
    expect(() => assertProviderCharacterAlignment(text, mismatched)).toThrow(/diverge do roteiro/u);

    const malformed = makeAlignment(text);
    malformed.character_end_times_seconds.pop();
    expect(() => assertProviderCharacterAlignment(text, malformed)).toThrow(/tamanhos incompatíveis/u);
  });

  it('derives every scene boundary from the continuous take', () => {
    const parts = [
      { scene: 'hook' as const, text: 'Comece agora.' },
      { scene: 'problem' as const, text: 'Pare de improvisar.' },
      { scene: 'product' as const, text: 'Abra a plataforma.' },
      { scene: 'proof' as const, text: 'Veja o fluxo real.' },
      { scene: 'cta' as const, text: 'Conheça o Hub.' },
    ];
    const text = parts.map((part) => part.text).join(' ');
    const durationSeconds = [...text].length * 0.055 + 1.4;
    const timings = buildProviderAlignedSceneTimings(parts, text, makeAlignment(text), durationSeconds);

    expect(timings.hook.startSeconds).toBe(0);
    expect(timings.problem.startSeconds).toBeGreaterThan(timings.hook.startSeconds);
    expect(timings.cta.endSeconds).toBe(durationSeconds);
  });
});
