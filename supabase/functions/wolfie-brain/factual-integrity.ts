export type LearnerFactType =
  | "resides_in"
  | "is_from"
  | "born_in";

export interface LearnerFactAssertion {
  factType: LearnerFactType;
  subjectKey: "student";
  value: string;
  normalizedValue: string;
  negated: boolean;
  evidenceText: string;
}

export interface CorrectionIntegrityResult {
  safe: boolean;
  reasons: string[];
  protectedEntities: string[];
  learnerFacts: LearnerFactAssertion[];
}

export interface MemoryItemForRelevance {
  kind: string;
  content: string;
  status?: string | null;
  confidence?: number | null;
  occurrence_count?: number | null;
  sensitive?: boolean | null;
  consented_at?: string | null;
  next_review_at?: string | null;
}

export interface StoredLearnerFact {
  id: string;
  fact_type: LearnerFactType;
  subject_key: string;
  value: string;
  normalized_value: string;
  status: string;
  verification_status: string;
  confidence: number | null;
  version: number;
  updated_at?: string | null;
}

const ENTITY_STOPWORDS = new Set([
  "A",
  "An",
  "And",
  "But",
  "Currently",
  "Eu",
  "I",
  "I'm",
  "Im",
  "Meu",
  "Minha",
  "My",
  "No",
  "Não",
  "Please",
  "Sim",
  "The",
  "Today",
  "Yes",
  "Yesterday",
]);

const MEMORY_CORE_KINDS = new Set([
  "goal",
  "recommended_strategy",
  "structure_in_progress",
  "structure_mastered",
]);

const SAFE_PEDAGOGICAL_MEMORY_KINDS = new Set([
  "grammar_error",
  "vocabulary_gap",
  "structure_in_progress",
  "structure_mastered",
  "strength",
  "goal",
  "preferred_topic",
  "professional_scenario",
  "completed_simulation",
  "recommended_strategy",
]);

const LOCATION_PATTERNS: Array<{
  factType: LearnerFactType;
  expression: RegExp;
  negationGroup: number;
  valueGroup: number;
}> = [
  {
    factType: "resides_in",
    expression:
      /\b(?:i\s+)?(?:(do\s+not|don't|dont)\s+)?(?:currently\s+)?(?:live|reside)\s+(?:in|at)\s+([^.!?;,]+?)(?=\s+(?:but|however|although|with|and\s+i)\b|[.!?;,]|$)/giu,
    negationGroup: 1,
    valueGroup: 2,
  },
  {
    factType: "is_from",
    expression:
      /\b(?:i\s+)?(?:(?:am|'m|m)\s+)(not\s+)?from\s+([^.!?;,]+?)(?=\s+(?:but|however|although|and\s+i)\b|[.!?;,]|$)/giu,
    negationGroup: 1,
    valueGroup: 2,
  },
  {
    factType: "born_in",
    expression:
      /\b(?:i\s+)?(?:was\s+)(not\s+)?born\s+in\s+([^.!?;,]+?)(?=\s+(?:but|however|although|and\s+i)\b|[.!?;,]|$)/giu,
    negationGroup: 1,
    valueGroup: 2,
  },
  {
    factType: "resides_in",
    expression:
      /\b(?:eu\s+)?(?:(não|nao)\s+)?moro\s+(?:em|no|na|nos|nas)\s+([^.!?;,]+?)(?=\s+(?:mas|porém|porem|embora|com|e\s+(?:eu\s+)?(?:moro|sou|nasci))\b|[.!?;,]|$)/giu,
    negationGroup: 1,
    valueGroup: 2,
  },
  {
    factType: "is_from",
    expression:
      /\b(?:eu\s+)?(?:(não|nao)\s+)?sou\s+(?:de|da|do|das|dos)\s+([^.!?;,]+?)(?=\s+(?:mas|porém|porem|embora|e\s+(?:eu\s+)?(?:moro|sou|nasci))\b|[.!?;,]|$)/giu,
    negationGroup: 1,
    valueGroup: 2,
  },
  {
    factType: "born_in",
    expression:
      /\b(?:eu\s+)?(?:(não|nao)\s+)?nasci\s+(?:em|no|na|nos|nas)\s+([^.!?;,]+?)(?=\s+(?:mas|porém|porem|embora|e\s+(?:eu\s+)?(?:moro|sou|nasci))\b|[.!?;,]|$)/giu,
    negationGroup: 1,
    valueGroup: 2,
  },
];

export function normalizeFactualText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanFactValue(value: string): string {
  return value
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/gu, "")
    .replace(
      /\s+(?:right\s+now|at\s+the\s+moment|now|currently|agora|atualmente)$/iu,
      "",
    )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);
}

export function extractLearnerFacts(text: string): LearnerFactAssertion[] {
  const assertions: LearnerFactAssertion[] = [];
  const seen = new Set<string>();

  for (const pattern of LOCATION_PATTERNS) {
    pattern.expression.lastIndex = 0;
    for (const match of text.matchAll(pattern.expression)) {
      const value = cleanFactValue(match[pattern.valueGroup] ?? "");
      const normalizedValue = normalizeFactualText(value);
      if (!value || normalizedValue.length < 2) continue;
      const negated = Boolean((match[pattern.negationGroup] ?? "").trim());
      const key = `${pattern.factType}:${normalizedValue}:${negated}`;
      if (seen.has(key)) continue;
      seen.add(key);
      assertions.push({
        factType: pattern.factType,
        subjectKey: "student",
        value,
        normalizedValue,
        negated,
        evidenceText: (match[0] ?? value).trim().slice(0, 1000),
      });
    }
  }

  return assertions.slice(0, 8);
}

export function extractProtectedEntities(text: string): string[] {
  const entities: string[] = [];
  const seen = new Set<string>();
  const expression =
    /\b[\p{Lu}][\p{L}\p{M}'’-]*(?:\s+(?:(?:de|da|do|dos|das|of|the)\s+)?[\p{Lu}][\p{L}\p{M}'’-]*)*/gu;

  for (const match of text.matchAll(expression)) {
    const entity = match[0].trim();
    if (!entity || ENTITY_STOPWORDS.has(entity)) continue;
    const normalized = normalizeFactualText(entity);
    if (normalized.length < 2 || seen.has(normalized)) continue;
    seen.add(normalized);
    entities.push(entity);
  }

  for (const fact of extractLearnerFacts(text)) {
    if (seen.has(fact.normalizedValue)) continue;
    seen.add(fact.normalizedValue);
    entities.push(fact.value);
  }

  return entities.slice(0, 12);
}

function extractNumericTokens(text: string): string[] {
  return (text.match(/\b(?:\d+(?:[.,]\d+)*|[\p{L}]+\d+[\p{L}\d-]*)\b/giu) ??
    [])
    .map((item) => normalizeFactualText(item))
    .sort();
}

function hasNegation(text: string): boolean {
  return /\b(?:not|never|no|não|nao|nunca|jamais)\b|n't\b/iu.test(text);
}

function comparableContains(haystack: string, needle: string): boolean {
  const normalizedHaystack = ` ${normalizeFactualText(haystack)} `;
  const normalizedNeedle = normalizeFactualText(needle);
  return Boolean(
    normalizedNeedle && normalizedHaystack.includes(` ${normalizedNeedle} `),
  );
}

function correctedExpressesFactType(
  corrected: string,
  factType: LearnerFactType,
): boolean {
  const normalized = normalizeFactualText(corrected);
  if (factType === "resides_in") {
    return /\b(?:live|lives|lived|living|reside|resides|resided|residing)\s+(?:in|at)\b/u
      .test(normalized) ||
      /\b(?:moro|morei|morava|resido|residi|vivo)\s+(?:em|no|na|nos|nas)\b/u
        .test(normalized);
  }
  if (factType === "is_from") {
    return /\b(?:am|m|come)\s+from\b/u.test(normalized) ||
      /\bsou\s+(?:de|da|do|das|dos)\b/u.test(normalized);
  }
  return /\b(?:was\s+)?born\s+in\b/u.test(normalized) ||
    /\bnasci\s+(?:em|no|na|nos|nas)\b/u.test(normalized);
}

export function correctionPreservesFactualIntegrity(
  learnerInput: string,
  original: string,
  corrected: string,
): CorrectionIntegrityResult {
  const reasons: string[] = [];
  const protectedEntities = extractProtectedEntities(original);
  const learnerFacts = extractLearnerFacts(original);

  if (!comparableContains(learnerInput, original)) {
    reasons.push("original_not_in_learner_input");
  }

  for (const entity of protectedEntities) {
    if (!comparableContains(corrected, entity)) {
      reasons.push(`entity_changed:${normalizeFactualText(entity)}`);
    }
  }

  const originalNumbers = extractNumericTokens(original);
  const correctedNumbers = extractNumericTokens(corrected);
  if (JSON.stringify(originalNumbers) !== JSON.stringify(correctedNumbers)) {
    reasons.push("numbers_changed");
  }

  if (hasNegation(original) !== hasNegation(corrected)) {
    reasons.push("negation_changed");
  }

  const correctedFacts = extractLearnerFacts(corrected);
  for (const originalFact of learnerFacts) {
    const preserved = correctedFacts.some((candidate) =>
      candidate.factType === originalFact.factType &&
      candidate.normalizedValue === originalFact.normalizedValue &&
      candidate.negated === originalFact.negated
    ) ||
      (
        comparableContains(corrected, originalFact.value) &&
        correctedExpressesFactType(corrected, originalFact.factType)
      );
    if (!preserved) {
      reasons.push(
        `fact_changed:${originalFact.factType}:${originalFact.normalizedValue}`,
      );
    }
  }

  return {
    safe: reasons.length === 0,
    reasons: [...new Set(reasons)],
    protectedEntities,
    learnerFacts,
  };
}

// ---------------------------------------------------------------------------
// Transcript confirmation (24/11/2026)
//
// Confidence tiers come from the ASR itself: realtime = exp(mean logprob) of
// the transcription; classic = the provider's confidence. They are
// uncalibrated, so the tiers are conservative.
//   high   >= 0.86  → send as heard (unless it carries personal data)
//   medium 0.70–0.86 → send as heard; with a name/number, show the review and
//                      send by itself after 5 s if the learner does nothing
//   low    <  0.70  → show the review (never auto-send) when the turn has a
//                      name/number or 4+ words; short social turns pass
// Personal data (a biographical claim, e-mail, phone, document) always waits
// for an explicit confirmation: it may become memory.
// ---------------------------------------------------------------------------

export const TRANSCRIPT_CONFIDENCE_HIGH = 0.86;
export const TRANSCRIPT_CONFIDENCE_LOW = 0.7;
export const TRANSCRIPT_AUTO_CONFIRM_MS = 5_000;
export const TRANSCRIPT_LOW_CONFIDENCE_MIN_WORDS = 4;

export type TranscriptConfirmationReason =
  | "personal_fact"
  | "personal_data"
  | "unreliable_transcript"
  | "low_confidence"
  | "uncertain_detail";

export interface TranscriptConfirmationDecision {
  required: boolean;
  reason: TranscriptConfirmationReason | null;
  /** Null = wait for the learner. A number = send by itself after it. */
  autoConfirmAfterMs: number | null;
}

// Words that open a turn ("Ok, vamos lá", "Well, I think…") are capitalized
// only because they start the sentence. They are not names.
const CONVERSATIONAL_WORDS = new Set([
  "ok",
  "okay",
  "hi",
  "hello",
  "hey",
  "well",
  "so",
  "yeah",
  "yep",
  "sure",
  "thanks",
  "thank",
  "lets",
  "let's",
  "sorry",
  "good",
  "great",
  "nice",
  "oi",
  "ola",
  "olá",
  "vamos",
  "bom",
  "boa",
  "beleza",
  "certo",
  "tudo",
  "obrigado",
  "obrigada",
  "entao",
  "então",
  "tipo",
  "english",
  "portuguese",
  "spanish",
  "ingles",
  "inglês",
  "portugues",
  "português",
]);

const PERSONAL_DATA_PATTERNS = [
  /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/u, // e-mail
  /(?:\+?\d[\s().-]*){8,}/u, // phone or long id
  /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/u, // CPF
];

// The realtime ASR sometimes "hears" its own prompt in silence/noise.
const ASR_PROMPT_ECHO_PATTERNS = [
  /english tutoring with brazilian portuguese code[- ]switching/i,
  /preserve brazilian names,? cities/i,
  /mark uncertainty instead of guessing/i,
];

export function transcriptEchoesAsrPrompt(text: string): boolean {
  return ASR_PROMPT_ECHO_PATTERNS.some((pattern) => pattern.test(text));
}

export function transcriptHasPersonalData(text: string): boolean {
  return PERSONAL_DATA_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Names and numbers that a mishearing could change. A single capitalized word
 * that only opens a sentence ("Ok", "Today", "We") is not counted.
 */
export function transcriptSensitiveDetails(text: string): string[] {
  const details: string[] = [];
  const expression =
    /\b[\p{Lu}][\p{L}\p{M}'’-]*(?:\s+(?:(?:de|da|do|dos|das|of|the)\s+)?[\p{Lu}][\p{L}\p{M}'’-]*)*/gu;
  for (const match of text.matchAll(expression)) {
    const entity = match[0].trim();
    if (!entity || ENTITY_STOPWORDS.has(entity)) continue;
    const before = text.slice(0, match.index ?? 0).trimEnd();
    let opensSentence = before === "" || /[.!?…:;"“(]$/u.test(before);
    // Drop leading words that are capitalized only by position or are
    // pronouns/fillers ("Yesterday I met…", "Ok I live…").
    const words = entity.split(/\s+/);
    while (words.length > 0) {
      const lowered = words[0].toLocaleLowerCase("pt-BR").replace(/[’]/g, "'");
      const filler = ENTITY_STOPWORDS.has(words[0]) ||
        CONVERSATIONAL_WORDS.has(lowered);
      if (!filler && !(opensSentence && words.length === 1)) break;
      if (!filler && opensSentence && words.length > 1) break;
      words.shift();
      opensSentence = false;
    }
    if (words.length === 0) continue;
    if (opensSentence && words.length === 1) continue;
    details.push(words.join(" "));
  }
  details.push(...extractNumericTokens(text));
  for (const fact of extractLearnerFacts(text)) details.push(fact.value);
  return [...new Set(details)].slice(0, 12);
}

export function transcriptConfirmationDecision(
  text: string,
  confidence: number | null | undefined,
  alternatives: string[] = [],
): TranscriptConfirmationDecision {
  const none: TranscriptConfirmationDecision = {
    required: false,
    reason: null,
    autoConfirmAfterMs: null,
  };
  if (!text.trim()) return none;
  if (transcriptEchoesAsrPrompt(text)) {
    return {
      required: true,
      reason: "unreliable_transcript",
      autoConfirmAfterMs: null,
    };
  }
  // Biographical assertions always need an explicit review when they came
  // from speech. A high ASR confidence score is not proof that a place or
  // other personal value was heard correctly.
  if (extractLearnerFacts(text).length > 0) {
    return {
      required: true,
      reason: "personal_fact",
      autoConfirmAfterMs: null,
    };
  }
  if (transcriptHasPersonalData(text)) {
    return {
      required: true,
      reason: "personal_data",
      autoConfirmAfterMs: null,
    };
  }

  const normalizedText = normalizeFactualText(text);
  const alternativesDisagree = alternatives.some((alternative) =>
    normalizeFactualText(alternative) !== normalizedText
  );
  const known = typeof confidence === "number" && confidence > 0;
  if (!known || confidence! >= TRANSCRIPT_CONFIDENCE_HIGH) {
    return none;
  }
  const hasDetails = transcriptSensitiveDetails(text).length > 0;
  if (confidence! < TRANSCRIPT_CONFIDENCE_LOW) {
    // Short social turns ("Ok.", "Hello!", "Let's go!") carry nothing a
    // mishearing could distort into memory or an unfair correction.
    const words = text.trim().split(/\s+/u).filter(Boolean).length;
    if (!hasDetails && words < TRANSCRIPT_LOW_CONFIDENCE_MIN_WORDS) return none;
    return {
      required: true,
      reason: "low_confidence",
      autoConfirmAfterMs: null,
    };
  }
  if (!hasDetails) return none;
  return {
    required: true,
    reason: "uncertain_detail",
    autoConfirmAfterMs: alternativesDisagree
      ? null
      : TRANSCRIPT_AUTO_CONFIRM_MS,
  };
}

export function transcriptionNeedsFactConfirmation(
  text: string,
  confidence: number | null | undefined,
  alternatives: string[] = [],
): boolean {
  return transcriptConfirmationDecision(text, confidence, alternatives)
    .required;
}

export function correctionLocksRetry(
  status: string | null | undefined,
  requiresRetry: boolean | null | undefined,
  retryCompleted: boolean | null | undefined,
): boolean {
  return status === "active" && requiresRetry === true &&
    retryCompleted !== true;
}

export function selectCanonicalRetryIndex(
  corrections: Array<{ priority: string | null | undefined }>,
  retrySlotAvailable: boolean,
  correctionMode: string,
): number {
  if (
    !retrySlotAvailable ||
    correctionMode === "end" ||
    correctionMode === "examiner"
  ) {
    return -1;
  }
  const highPriorityIndex = corrections.findIndex((correction) =>
    correction.priority === "high"
  );
  if (highPriorityIndex >= 0) return highPriorityIndex;
  return corrections.findIndex((correction) =>
    correction.priority === "medium"
  );
}

export function factsShareSlot(
  left: Pick<LearnerFactAssertion, "factType" | "subjectKey">,
  right: Pick<LearnerFactAssertion, "factType" | "subjectKey">,
): boolean {
  return left.factType === right.factType &&
    left.subjectKey === right.subjectKey;
}

export function factsConflict(
  left: Pick<
    LearnerFactAssertion,
    "factType" | "subjectKey" | "normalizedValue" | "negated"
  >,
  right: Pick<
    LearnerFactAssertion,
    "factType" | "subjectKey" | "normalizedValue" | "negated"
  >,
): boolean {
  return factsShareSlot(left, right) &&
    (
      left.normalizedValue !== right.normalizedValue ||
      left.negated !== right.negated
    );
}

function queryTerms(value: string): Set<string> {
  return new Set(
    normalizeFactualText(value)
      .split(" ")
      .filter((term) => term.length >= 3)
      .slice(0, 80),
  );
}

export function selectRelevantMemoryItems<T extends MemoryItemForRelevance>(
  items: T[],
  query: string,
  limit = 12,
): T[] {
  const terms = queryTerms(query);
  const now = Date.now();

  return items
    .filter((item) => {
      if (!SAFE_PEDAGOGICAL_MEMORY_KINDS.has(item.kind)) return false;
      const status = item.status ?? "active";
      const usableStatus = status === "active" ||
        (status === "mastered" &&
          (item.kind === "structure_mastered" ||
            item.kind === "completed_simulation"));
      return usableStatus &&
        (!item.sensitive || Boolean(item.consented_at));
    })
    .map((item, index) => {
      const contentTerms = queryTerms(item.content);
      let overlap = 0;
      for (const term of terms) {
        if (contentTerms.has(term)) overlap += 1;
      }
      const confidence = Number.isFinite(item.confidence)
        ? Number(item.confidence)
        : 0.5;
      const occurrences = Number.isFinite(item.occurrence_count)
        ? Math.min(5, Number(item.occurrence_count))
        : 0;
      const reviewDue = item.next_review_at &&
          Date.parse(item.next_review_at) <= now
        ? 1
        : 0;
      const core = MEMORY_CORE_KINDS.has(item.kind) ? 1 : 0;
      return {
        item,
        index,
        score: overlap * 4 + core * 2 + reviewDue + confidence +
          occurrences * 0.1,
      };
    })
    .filter((candidate) =>
      candidate.score > 0 || MEMORY_CORE_KINDS.has(candidate.item.kind)
    )
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, Math.max(1, Math.min(30, limit)))
    .map((candidate) => candidate.item);
}
