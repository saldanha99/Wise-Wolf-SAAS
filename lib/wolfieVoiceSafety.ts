import {
  transcriptConfirmationDecision,
  type TranscriptConfirmationDecision,
} from "../supabase/functions/wolfie-brain/factual-integrity.ts";

export interface VoiceTranscriptAssessment {
  transcript: string;
  alternatives?: string[];
  confidence?: number | null;
}

const PERSONAL_FACT_PATTERNS = [
  /\bi\s+(?:currently\s+)?live(?:\s+in|\s+at)\b/i,
  /\bi(?:'m|\s+am)\s+from\b/i,
  /\bi\s+was\s+born(?:\s+in|\s+at)\b/i,
  /\bi\s+(?:currently\s+)?work(?:\s+in|\s+at|\s+for)\b/i,
  /\bi\s+(?:currently\s+)?study(?:\s+in|\s+at)\b/i,
  /\beu\s+moro(?:\s+em|\s+no|\s+na)\b/i,
  /\beu\s+sou\s+d[eoas]\b/i,
  /\beu\s+nasci(?:\s+em|\s+no|\s+na)\b/i,
  /\beu\s+trabalho(?:\s+em|\s+no|\s+na|\s+para)\b/i,
  /\beu\s+estudo(?:\s+em|\s+no|\s+na)\b/i,
];

const normalizeForComparison = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const tokenSet = (value: string): Set<string> =>
  new Set(normalizeForComparison(value).split(" ").filter(Boolean));

export const transcriptSimilarity = (left: string, right: string): number => {
  const leftTokens = tokenSet(left);
  const rightTokens = tokenSet(right);
  if (!leftTokens.size && !rightTokens.size) return 1;
  if (!leftTokens.size || !rightTokens.size) return 0;

  let intersection = 0;
  leftTokens.forEach((token) => {
    if (rightTokens.has(token)) intersection += 1;
  });
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union ? intersection / union : 0;
};

export const containsPersonalFactClaim = (transcript: string): boolean =>
  PERSONAL_FACT_PATTERNS.some((pattern) => pattern.test(transcript));

export const uniqueTranscriptAlternatives = (
  transcript: string,
  alternatives: string[] = [],
): string[] => {
  const seen = new Set<string>();
  const primary = normalizeForComparison(transcript);

  return alternatives
    .map((candidate) => candidate.trim())
    .filter(Boolean)
    .filter((candidate) => {
      const normalized = normalizeForComparison(candidate);
      if (!normalized || normalized === primary || seen.has(normalized)) {
        return false;
      }
      seen.add(normalized);
      return true;
    })
    .slice(0, 4);
};

/**
 * One rule for classic and live voice (see `transcriptConfirmationDecision`
 * in the wolfie-brain): personal data waits for the learner, low confidence
 * on a real sentence waits, a name/number at medium confidence goes by itself
 * after 5 s, everything else is sent as heard. Alternatives from the ASR that
 * disagree strongly also open the review (no auto-send).
 */
export const voiceTranscriptReviewDecision = ({
  transcript,
  alternatives = [],
  confidence,
}: VoiceTranscriptAssessment): TranscriptConfirmationDecision => {
  if (!transcript.trim()) {
    return { required: false, reason: null, autoConfirmAfterMs: null };
  }
  const decision = transcriptConfirmationDecision(
    transcript,
    confidence,
    alternatives,
  );
  if (decision.required) return decision;
  if (containsPersonalFactClaim(transcript)) {
    return { required: true, reason: "personal_fact", autoConfirmAfterMs: null };
  }
  const divergent = uniqueTranscriptAlternatives(transcript, alternatives).some(
    (candidate) => transcriptSimilarity(transcript, candidate) < 0.64,
  );
  return divergent
    ? { required: true, reason: "low_confidence", autoConfirmAfterMs: null }
    : decision;
};

export const shouldConfirmVoiceTranscript = (
  assessment: VoiceTranscriptAssessment,
): boolean => voiceTranscriptReviewDecision(assessment).required;
