import { describe, expect, it } from 'vitest';
import {
  createDeterministicVoiceSpectrum,
  createKineticCaptionPages,
  findActiveCaptionPage,
  findActiveCaptionToken,
  summarizeVoiceMotion,
} from './caption-motion';
import type { HubVideoCaption } from './types';

const caption = (text: string, startMs: number, endMs: number): HubVideoCaption => ({
  text,
  startMs,
  endMs,
  startSeconds: startMs / 1000,
  endSeconds: endMs / 1000,
  timestampMs: null,
  confidence: null,
});

describe('kinetic caption timing', () => {
  it('covers the whole caption with stable word-level timing', () => {
    const [page] = createKineticCaptionPages([
      caption('Abra materiais, adapte e ensine.', 1200, 4200),
    ]);

    expect(page.tokens.map((token) => token.text)).toEqual([
      'Abra',
      'materiais,',
      'adapte',
      'e',
      'ensine.',
    ]);
    expect(page.tokens[0].startMs).toBe(1200);
    expect(page.tokens.at(-1)?.endMs).toBe(4200);
    expect(page.tokens.every((token, index) => (
      token.endMs > token.startMs
      && (index === 0 || token.startMs === page.tokens[index - 1].endMs)
    ))).toBe(true);
  });

  it('selects page and active word at deterministic boundaries', () => {
    const pages = createKineticCaptionPages([caption('Tour pela plataforma', 1000, 2500)]);
    const page = findActiveCaptionPage(pages, 1000);

    expect(page).not.toBeNull();
    expect(findActiveCaptionPage(pages, 2500)).toBeNull();
    expect(findActiveCaptionToken(page!, page!.tokens[1].startMs)).toBe(1);
  });

  it('uses exact provider word timings instead of estimating them again', () => {
    const source = {
      ...caption('Tour real agora', 1000, 2600),
      tokens: [
        { text: 'Tour', startMs: 1012.5, endMs: 1324.75 },
        { text: 'real', startMs: 1408.25, endMs: 1812.5 },
        { text: 'agora', startMs: 1950.125, endMs: 2588.875 },
      ],
    } satisfies HubVideoCaption;

    const [page] = createKineticCaptionPages([source]);

    expect(page.tokens).toEqual(source.tokens);
    expect(findActiveCaptionToken(page, 1408.25)).toBe(1);
    expect(findActiveCaptionToken(page, 1360)).toBe(0);
    expect(findActiveCaptionToken(page, 1900)).toBe(1);
  });
});

describe('voice reactive caption motion', () => {
  it('creates a deterministic but frame-reactive fallback spectrum', () => {
    const first = createDeterministicVoiceSpectrum({ frame: 42, fps: 30, seed: 81, active: true });
    const repeated = createDeterministicVoiceSpectrum({ frame: 42, fps: 30, seed: 81, active: true });
    const nextFrame = createDeterministicVoiceSpectrum({ frame: 43, fps: 30, seed: 81, active: true });

    expect(first).toEqual(repeated);
    expect(nextFrame).not.toEqual(first);
    expect(first).toHaveLength(64);
    expect(first.every((value) => value >= 0 && value <= 1)).toBe(true);
  });

  it('keeps true silence when real audio data is available', () => {
    const motion = summarizeVoiceMotion({
      frequencies: Array.from({ length: 64 }, () => 0),
      frame: 20,
      fps: 30,
      seed: 12,
      active: true,
    });

    expect(motion.source).toBe('audio');
    expect(motion.energy).toBe(0);
    expect(motion.bars.every((bar) => bar === 0)).toBe(true);
  });

  it('separates vocal frequency bands for distinct kinetic responses', () => {
    const frequencies = Array.from({ length: 64 }, (_, index) => (
      index < 13 ? 0.8 : index < 40 ? 0.42 : 0.08
    ));
    const motion = summarizeVoiceMotion({
      frequencies,
      frame: 20,
      fps: 30,
      seed: 12,
      active: true,
    });

    expect(motion.source).toBe('audio');
    expect(motion.bass).toBeGreaterThan(motion.presence);
    expect(motion.presence).toBeGreaterThan(motion.air);
    expect(motion.energy).toBeGreaterThan(0.4);
    expect(motion.bars).toHaveLength(24);
  });
});
