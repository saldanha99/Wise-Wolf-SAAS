import {
  PUBLIC_QUIZ_VERSION,
  isQuizComplete,
  recommendQuizExperience,
  sanitizeQuizAnswers,
  type CompleteQuizAnswers,
  type QuizRecommendation,
} from "./quizModel";

export const PUBLIC_QUIZ_RESULT_KEY =
  `wolfie.public-result.v${PUBLIC_QUIZ_VERSION}` as const;

export interface StoredQuizResult {
  version: typeof PUBLIC_QUIZ_VERSION;
  leadRequestId: string;
  answers: CompleteQuizAnswers;
  recommendation: QuizRecommendation;
}

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const leadSentKey = (requestId: string) =>
  `${PUBLIC_QUIZ_RESULT_KEY}.lead-sent.${requestId}`;

export const createStoredQuizResult = (
  answers: CompleteQuizAnswers,
  leadRequestId: string,
): StoredQuizResult => ({
  version: PUBLIC_QUIZ_VERSION,
  leadRequestId,
  answers,
  recommendation: recommendQuizExperience(answers),
});

export const parseStoredQuizResult = (
  serialized: string | null | undefined,
): StoredQuizResult | null => {
  if (!serialized) return null;
  try {
    const raw = JSON.parse(serialized) as Record<string, unknown>;
    if (raw.version !== PUBLIC_QUIZ_VERSION) return null;
    if (
      typeof raw.leadRequestId !== "string" ||
      !UUID_V4_PATTERN.test(raw.leadRequestId)
    ) return null;
    const answers = sanitizeQuizAnswers(raw.answers);
    if (!isQuizComplete(answers)) return null;
    return createStoredQuizResult(answers, raw.leadRequestId);
  } catch {
    return null;
  }
};

export const saveQuizResult = (answers: CompleteQuizAnswers) => {
  const result = createStoredQuizResult(answers, crypto.randomUUID());
  sessionStorage.setItem(PUBLIC_QUIZ_RESULT_KEY, JSON.stringify(result));
  return result;
};

export const readQuizResult = () =>
  parseStoredQuizResult(sessionStorage.getItem(PUBLIC_QUIZ_RESULT_KEY));

export const wasQuizLeadSent = (requestId: string) =>
  sessionStorage.getItem(leadSentKey(requestId)) === "1";

export const markQuizLeadSent = (requestId: string) => {
  if (!UUID_V4_PATTERN.test(requestId)) return;
  sessionStorage.setItem(leadSentKey(requestId), "1");
};

export const clearQuizResult = () => {
  const current = readQuizResult();
  sessionStorage.removeItem(PUBLIC_QUIZ_RESULT_KEY);
  if (current) sessionStorage.removeItem(leadSentKey(current.leadRequestId));
};
