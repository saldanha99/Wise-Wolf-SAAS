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

export const shouldConfirmVoiceTranscript = ({
  transcript,
  alternatives = [],
  confidence,
}: VoiceTranscriptAssessment): boolean => {
  if (!transcript.trim()) return false;
  if (containsPersonalFactClaim(transcript)) return true;
  if (typeof confidence === "number" && confidence > 0 && confidence < 0.72) {
    return true;
  }

  return uniqueTranscriptAlternatives(transcript, alternatives).some(
    (candidate) => transcriptSimilarity(transcript, candidate) < 0.64,
  );
};
