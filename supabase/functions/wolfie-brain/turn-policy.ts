export type WolfieLearnerTurnKind =
  | "opening"
  | "greeting"
  | "noise"
  | "substantive";

const NOISE_MARKER = "wolfienoisemarker";
const NOISE_WORDS = new Set([
  "uh",
  "um",
  "hmm",
  "hm",
  "ah",
  "er",
  "err",
  NOISE_MARKER,
]);

const GREETING_PHRASES = [
  ["tudo", "bem", "com", "voce"],
  ["como", "voce", "esta"],
  ["how", "are", "you", "doing"],
  ["how", "is", "it", "going"],
  ["good", "afternoon"],
  ["good", "evening"],
  ["good", "morning"],
  ["hello", "there"],
  ["hey", "there"],
  ["hi", "there"],
  ["how", "are", "you"],
  ["how", "s", "it", "going"],
  ["hows", "it", "going"],
  ["what", "s", "up"],
  ["whats", "up"],
  ["boa", "noite"],
  ["boa", "tarde"],
  ["bom", "dia"],
  ["como", "vai"],
  ["tudo", "bem"],
  ["e", "ai"],
  ["hello"],
  ["hey"],
  ["hi"],
  ["oi"],
  ["ola"],
  ["opa"],
] as const;

const GREETING_VOCATIVES = new Set([
  "wolfie",
  "tutor",
  "teacher",
  "professor",
]);

const PORTUGUESE_SOCIAL_MARKERS = new Set([
  "ai",
  "bem",
  "boa",
  "bom",
  "como",
  "dia",
  "esta",
  "noite",
  "oi",
  "ola",
  "opa",
  "tarde",
  "tudo",
  "voce",
]);

const ENGLISH_SOCIAL_MARKERS = new Set([
  "afternoon",
  "are",
  "evening",
  "going",
  "good",
  "hello",
  "hey",
  "hi",
  "how",
  "hows",
  "morning",
  "up",
  "what",
  "whats",
  "you",
]);

function primitiveMessage(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "bigint") return String(value);
  return "";
}

function normalizeWords(value: string): string[] {
  return value
    .normalize("NFKD")
    .replace(/\p{Mark}+/gu, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
}

function noiseWords(value: string): string[] {
  const withMarkers = value
    .replace(/\[\s*noise\s*\]/giu, ` ${NOISE_MARKER} `)
    .replace(/\(\s*inaudible\s*\)/giu, ` ${NOISE_MARKER} `);
  return normalizeWords(withMarkers);
}

function phraseMatchesAt(
  words: string[],
  start: number,
  phrase: readonly string[],
): boolean {
  if (start + phrase.length > words.length) return false;
  return phrase.every((word, offset) => words[start + offset] === word);
}

function isGreetingOnly(words: string[]): boolean {
  if (!words.length) return false;

  let index = 0;
  let greetingCount = 0;

  // Accept a vocative before or after an otherwise complete greeting.
  if (GREETING_VOCATIVES.has(words[index]) && words.length > 1) index += 1;

  while (index < words.length) {
    if (GREETING_VOCATIVES.has(words[index]) && greetingCount > 0) {
      index += 1;
      continue;
    }

    const phrase = GREETING_PHRASES
      .filter((candidate) => phraseMatchesAt(words, index, candidate))
      .reduce<readonly string[] | undefined>(
        (longest, candidate) =>
          !longest || candidate.length > longest.length ? candidate : longest,
        undefined,
      );
    if (!phrase) return false;

    greetingCount += 1;
    index += phrase.length;
  }

  return greetingCount > 0;
}

function withoutEdgeNoise(words: string[]): string[] {
  let start = 0;
  let end = words.length;
  while (start < end && NOISE_WORDS.has(words[start])) start += 1;
  while (end > start && NOISE_WORDS.has(words[end - 1])) end -= 1;
  return words.slice(start, end);
}

export function classifyWolfieLearnerTurn(
  message: unknown,
  hasAudio = false,
): WolfieLearnerTurnKind {
  const text = primitiveMessage(message).trim();
  if (!text) return hasAudio ? "noise" : "opening";

  const wordsWithMarkers = noiseWords(text);
  if (!wordsWithMarkers.length) return "noise";
  if (wordsWithMarkers.every((word) => NOISE_WORDS.has(word))) {
    return "noise";
  }

  return isGreetingOnly(withoutEdgeNoise(wordsWithMarkers))
    ? "greeting"
    : "substantive";
}

export function isPedagogicallySubstantiveTurn(
  kind: WolfieLearnerTurnKind,
  activeTaskContext: unknown = "",
): boolean {
  if (kind === "substantive") return true;
  if (kind !== "greeting") return false;

  const task = normalizeWords(primitiveMessage(activeTaskContext)).join(" ");
  return [
    /\b(?:greet|greeting|greetings|salutation|salutations)\b/u,
    /\b(?:cumpriment\w*|saudacao|saudacoes)\b/u,
    /\b(?:say|practice|practise|use|write) hello\b/u,
  ].some((pattern) => pattern.test(task));
}

export function inferWolfieSocialTurnLanguage(
  message: unknown,
): "pt" | "en" | null {
  const words = normalizeWords(primitiveMessage(message));
  let portugueseScore = 0;
  let englishScore = 0;
  for (const word of words) {
    if (PORTUGUESE_SOCIAL_MARKERS.has(word)) portugueseScore += 1;
    if (ENGLISH_SOCIAL_MARKERS.has(word)) englishScore += 1;
  }
  if (portugueseScore > englishScore) return "pt";
  if (englishScore > portugueseScore) return "en";
  return null;
}

interface WolfiePedagogicalEvidencePayload {
  current_stage: string;
  scenario_status: string;
  correction: unknown | null;
  corrections: unknown[];
  pronunciation?: unknown | null;
  translation: string | null;
  vocabulary: unknown | null;
  quiz: unknown | null;
  new_vocabulary: unknown[];
  student_strengths: string[];
  student_priorities: string[];
  next_action: string;
  profile_updates: object;
  session_score: number | null;
  needs_external_verification: boolean;
  verification_reason: string | null;
  requires_retry: boolean;
  retry_completed: boolean;
}

export function suppressWolfiePedagogicalEvidence<
  T extends WolfiePedagogicalEvidencePayload,
>(
  response: T,
  options: {
    currentStage: string;
    scenarioStatus: string;
    pendingRetry: boolean;
    preserveTranslation?: boolean;
  },
): T {
  return {
    ...response,
    current_stage: options.pendingRetry ? "retry" : options.currentStage,
    scenario_status: options.pendingRetry
      ? "awaiting_retry"
      : options.scenarioStatus,
    correction: null,
    corrections: [],
    pronunciation: null,
    translation: options.preserveTranslation ? response.translation : null,
    vocabulary: null,
    quiz: null,
    new_vocabulary: [],
    student_strengths: [],
    student_priorities: [],
    next_action: "",
    profile_updates: {},
    session_score: null,
    needs_external_verification: false,
    verification_reason: null,
    requires_retry: options.pendingRetry,
    retry_completed: false,
  };
}
