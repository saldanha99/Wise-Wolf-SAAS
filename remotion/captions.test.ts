import { describe, expect, it } from 'vitest';
import { balanceHubCaptions, makeHubVtt } from './captions';
import type { HubVideoCaption } from './types';

const caption = (text: string, startSeconds: number, endSeconds: number): HubVideoCaption => ({
  text,
  startSeconds,
  endSeconds,
  startMs: Math.round(startSeconds * 1000),
  endMs: Math.round(endSeconds * 1000),
  timestampMs: null,
  confidence: null,
});

describe('Hub captions', () => {
  it('merges a short orphan with the previous readable caption', () => {
    const balanced = balanceHubCaptions([
      caption('encontra uma base pronta para', 1, 2.4),
      caption('adaptar.', 2.45, 2.9),
    ]);

    expect(balanced).toEqual([
      expect.objectContaining({
        text: 'encontra uma base pronta para adaptar.',
        startMs: 1000,
        endMs: 2900,
      }),
    ]);
  });

  it('keeps WEBVTT timing aligned after balancing', () => {
    const webVtt = makeHubVtt([
      caption('O contexto vira uma primeira', 0, 1.2),
      caption('versão.', 1.25, 1.8),
    ]);

    expect(webVtt).toContain('00:00:00.000 --> 00:00:01.800');
    expect(webVtt).toContain('O contexto vira uma primeira versão.');
  });

  it('normalizes millisecond carry at timestamp boundaries', () => {
    const source = caption('Virada exata', 1.9996, 2.5);
    source.startMs = 1999.6;
    const webVtt = makeHubVtt([source]);

    expect(webVtt).toContain('00:00:02.000 --> 00:00:02.500');
    expect(webVtt).not.toContain('.1000');
  });

  it('preserves and merges exact word tokens without rounding their boundaries', () => {
    const first = {
      ...caption('Abra o material', 1, 2.4),
      startMs: 1000.125,
      endMs: 2400.375,
      tokens: [
        { text: 'Abra', startMs: 1000.125, endMs: 1320.25 },
        { text: 'o', startMs: 1338.5, endMs: 1440.75 },
        { text: 'material', startMs: 1462.125, endMs: 2400.375 },
      ],
    } satisfies HubVideoCaption;
    const second = {
      ...caption('agora.', 2.45, 2.9),
      startMs: 2450.5,
      endMs: 2900.875,
      tokens: [{ text: 'agora.', startMs: 2450.5, endMs: 2900.875 }],
    } satisfies HubVideoCaption;

    const [balanced] = balanceHubCaptions([first, second]);

    expect(balanced.endMs).toBe(2900.875);
    expect(balanced.tokens).toEqual([...first.tokens, ...second.tokens]);
  });
});
