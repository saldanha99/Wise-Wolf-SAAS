import { balanceHubCaptions } from '../captions';
import type {
  HubVideoCaption,
  HubVideoSceneId,
  HubVideoSceneTiming,
} from '../types';

export type ProviderCharacterAlignment = {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
};

type AlignedWord = {
  text: string;
  startSeconds: number;
  endSeconds: number;
};

const TARGET_MIN_DURATION_SECONDS = 0.58;
const TARGET_MAX_DURATION_SECONDS = 0.95;
const MAX_WORDS_PER_CAPTION = 4;
const MAX_CHARACTERS_PER_CAPTION = 34;

const fixed = (value: number): number => Number(value.toFixed(3));
const milliseconds = (seconds: number): number => Number((seconds * 1000).toFixed(3));

const normalizedText = (value: string): string => value.normalize('NFC');

export const assertProviderCharacterAlignment = (
  narrationText: string,
  alignment: ProviderCharacterAlignment,
): void => {
  const characterCount = alignment.characters.length;
  if (characterCount === 0) throw new Error('O provedor não retornou caracteres alinhados.');
  if (
    alignment.character_start_times_seconds.length !== characterCount
    || alignment.character_end_times_seconds.length !== characterCount
  ) {
    throw new Error('O alinhamento do provedor possui vetores de tamanhos incompatíveis.');
  }
  if (normalizedText(alignment.characters.join('')) !== normalizedText(narrationText)) {
    throw new Error('O texto alinhado pelo provedor diverge do roteiro enviado.');
  }

  let previousStart = -1;
  let previousEnd = -1;
  for (let index = 0; index < characterCount; index += 1) {
    const start = alignment.character_start_times_seconds[index];
    const end = alignment.character_end_times_seconds[index];
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
      throw new Error(`Timestamp inválido no caractere ${index} do alinhamento do provedor.`);
    }
    if (start < previousStart || end < previousEnd) {
      throw new Error(`Timestamps fora de ordem no caractere ${index} do alinhamento do provedor.`);
    }
    previousStart = start;
    previousEnd = end;
  }
};

const alignedWords = (
  narrationText: string,
  alignment: ProviderCharacterAlignment,
): AlignedWord[] => [...narrationText.matchAll(/\S+/gu)].map((match) => {
  const startIndex = match.index ?? 0;
  const endIndex = startIndex + match[0].length - 1;
  return {
    text: match[0],
    startSeconds: alignment.character_start_times_seconds[startIndex],
    endSeconds: alignment.character_end_times_seconds[endIndex],
  };
});

const makeCaption = (words: AlignedWord[]): HubVideoCaption => {
  const tokens = words.map((word) => ({
    text: word.text,
    startMs: milliseconds(word.startSeconds),
    endMs: milliseconds(word.endSeconds),
  }));
  return {
    text: words.map((word) => word.text).join(' '),
    startSeconds: fixed(words[0].startSeconds),
    endSeconds: fixed(words.at(-1)!.endSeconds),
    startMs: tokens[0].startMs,
    endMs: tokens.at(-1)!.endMs,
    timestampMs: null,
    confidence: null,
    tokens,
  };
};

export const buildProviderAlignedCaptions = (
  narrationText: string,
  alignment: ProviderCharacterAlignment,
): HubVideoCaption[] => {
  assertProviderCharacterAlignment(narrationText, alignment);
  const words = alignedWords(narrationText, alignment);
  const captions: HubVideoCaption[] = [];
  let group: AlignedWord[] = [];

  const flush = () => {
    if (group.length === 0) return;
    captions.push(makeCaption(group));
    group = [];
  };

  for (const word of words) {
    if (group.length > 0) {
      const prospectiveText = [...group, word].map((item) => item.text).join(' ');
      const currentDuration = group.at(-1)!.endSeconds - group[0].startSeconds;
      const prospectiveDuration = word.endSeconds - group[0].startSeconds;
      if (
        group.length >= MAX_WORDS_PER_CAPTION
        || prospectiveText.length > MAX_CHARACTERS_PER_CAPTION
        || (currentDuration >= TARGET_MIN_DURATION_SECONDS && prospectiveDuration > TARGET_MAX_DURATION_SECONDS)
      ) {
        flush();
      }
    }

    group.push(word);
    const duration = group.at(-1)!.endSeconds - group[0].startSeconds;
    if (
      duration >= TARGET_MAX_DURATION_SECONDS
      || (duration >= TARGET_MIN_DURATION_SECONDS && /[.!?,;:…]$/u.test(word.text))
    ) {
      flush();
    }
  }
  flush();

  return balanceHubCaptions(captions);
};

export const buildProviderAlignedSceneTimings = (
  narrationParts: Array<{ scene: HubVideoSceneId; text: string }>,
  narrationText: string,
  alignment: ProviderCharacterAlignment,
  durationSeconds: number,
): Record<HubVideoSceneId, HubVideoSceneTiming> => {
  assertProviderCharacterAlignment(narrationText, alignment);
  const timings = {} as Record<HubVideoSceneId, HubVideoSceneTiming>;
  let cursor = 0;

  for (const part of narrationParts) {
    const startIndex = narrationText.indexOf(part.text, cursor);
    if (startIndex < 0) {
      throw new Error(`O trecho da cena ${part.scene} não foi localizado no take contínuo.`);
    }
    const endIndex = startIndex + part.text.length - 1;
    timings[part.scene] = {
      startSeconds: fixed(alignment.character_start_times_seconds[startIndex]),
      endSeconds: fixed(alignment.character_end_times_seconds[endIndex]),
    };
    cursor = endIndex + 1;
  }

  timings.hook.startSeconds = 0;
  for (let index = 0; index < narrationParts.length - 1; index += 1) {
    const currentScene = narrationParts[index].scene;
    const nextScene = narrationParts[index + 1].scene;
    timings[currentScene].endSeconds = Math.max(
      timings[currentScene].endSeconds,
      timings[nextScene].startSeconds,
    );
  }
  timings.cta.endSeconds = durationSeconds;
  return timings;
};
