import type { HubVideoCaption, HubVideoCaptionToken } from './types';
import { balanceHubCaptions } from './captions';

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

const cleanWords = (text: string) => text.trim().split(/\s+/u).filter(Boolean);

const wordWeight = (word: string) => {
  const spokenCharacters = word.replace(/[^\p{L}\p{N}]/gu, '').length;
  const punctuationPause = /[.!?…]$/u.test(word) ? 1.25 : /[,;:]$/u.test(word) ? 0.6 : 0;
  return Math.max(2.2, Math.sqrt(Math.max(spokenCharacters, 1)) * 1.8 + punctuationPause);
};

const mean = (values: number[]) => (
  values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length
);

const normalizedAmplitude = (value: number) => (
  Math.log1p(clamp01(value) * 8) / Math.log(9)
);

const bandMean = (frequencies: number[], startRatio: number, endRatio: number) => {
  const start = Math.floor(frequencies.length * startRatio);
  const end = Math.max(start + 1, Math.ceil(frequencies.length * endRatio));
  return mean(frequencies.slice(start, end).map(normalizedAmplitude));
};

const hashText = (text: string) => {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

export type KineticCaptionToken = HubVideoCaptionToken;

export type KineticCaptionPage = {
  text: string;
  startMs: number;
  endMs: number;
  seed: number;
  tokens: KineticCaptionToken[];
};

export type VoiceMotion = {
  source: 'audio' | 'fallback';
  energy: number;
  bass: number;
  presence: number;
  air: number;
  bars: number[];
};

export const createKineticCaptionPages = (captions: HubVideoCaption[]): KineticCaptionPage[] => (
  balanceHubCaptions(captions).map((caption) => {
    const words = cleanWords(caption.text);
    const weights = words.map(wordWeight);
    const totalWeight = weights.reduce((total, weight) => total + weight, 0) || 1;
    const durationMs = Math.max(caption.endMs - caption.startMs, words.length);
    let elapsedWeight = 0;

    const estimatedTokens = words.map((word, index) => {
      const startMs = caption.startMs + Math.round((elapsedWeight / totalWeight) * durationMs);
      elapsedWeight += weights[index];
      const endMs = index === words.length - 1
        ? caption.endMs
        : caption.startMs + Math.round((elapsedWeight / totalWeight) * durationMs);

      return {
        text: word,
        startMs,
        endMs: Math.max(startMs + 1, endMs),
      };
    });
    const tokens = caption.tokens?.length
      ? caption.tokens.map((token) => ({ ...token }))
      : estimatedTokens;

    return {
      text: caption.text.trim(),
      startMs: caption.startMs,
      endMs: caption.endMs,
      seed: hashText(`${caption.startMs}:${caption.text}`),
      tokens,
    };
  })
);

export const findActiveCaptionPage = (pages: KineticCaptionPage[], timeMs: number) => (
  pages.find((page) => timeMs >= page.startMs && timeMs < page.endMs) ?? null
);

export const findActiveCaptionToken = (page: KineticCaptionPage, timeMs: number) => {
  const activeIndex = page.tokens.findIndex((token) => timeMs >= token.startMs && timeMs < token.endMs);
  if (activeIndex >= 0) return activeIndex;
  if (timeMs >= page.endMs) return Math.max(page.tokens.length - 1, 0);
  let latestStartedIndex = -1;
  for (let index = page.tokens.length - 1; index >= 0; index -= 1) {
    if (page.tokens[index].startMs <= timeMs) {
      latestStartedIndex = index;
      break;
    }
  }
  return Math.max(latestStartedIndex, 0);
};

export const createDeterministicVoiceSpectrum = ({
  frame,
  fps,
  seed,
  active,
  numberOfSamples = 64,
}: {
  frame: number;
  fps: number;
  seed: number;
  active: boolean;
  numberOfSamples?: number;
}) => {
  const seconds = frame / fps;
  const seedPhase = (seed % 997) / 997 * Math.PI * 2;
  const speechEnvelope = active
    ? 0.52 + Math.sin(seconds * 13.7 + seedPhase) * 0.13 + Math.sin(seconds * 23.1 + seedPhase * 0.7) * 0.08
    : 0.035;

  return Array.from({ length: numberOfSamples }, (_, index) => {
    const ratio = index / Math.max(numberOfSamples - 1, 1);
    const voiceShape = Math.exp(-ratio * 2.35) * 0.82 + Math.exp(-Math.pow((ratio - 0.38) / 0.2, 2)) * 0.34;
    const microVariation = 0.72
      + Math.sin(seconds * (8.4 + ratio * 4.2) + seedPhase + index * 0.63) * 0.16
      + Math.sin(seconds * 3.1 + index * 1.17) * 0.08;
    return clamp01(speechEnvelope * voiceShape * microVariation);
  });
};

export const summarizeVoiceMotion = ({
  frequencies,
  frame,
  fps,
  seed,
  active,
  barCount = 24,
}: {
  frequencies: number[] | null;
  frame: number;
  fps: number;
  seed: number;
  active: boolean;
  barCount?: number;
}): VoiceMotion => {
  const sourceFrequencies = frequencies ?? createDeterministicVoiceSpectrum({ frame, fps, seed, active });
  const source = frequencies === null ? 'fallback' : 'audio';
  const bass = bandMean(sourceFrequencies, 0, 0.2);
  const presence = bandMean(sourceFrequencies, 0.2, 0.62);
  const air = bandMean(sourceFrequencies, 0.62, 1);
  const energy = clamp01(bass * 0.34 + presence * 0.5 + air * 0.16);
  const bars = Array.from({ length: barCount }, (_, index) => {
    const sourceIndex = Math.min(
      sourceFrequencies.length - 1,
      Math.floor((index / Math.max(barCount - 1, 1)) * sourceFrequencies.length),
    );
    return normalizedAmplitude(sourceFrequencies[Math.max(sourceIndex, 0)] ?? 0);
  });

  return { source, energy, bass, presence, air, bars };
};
