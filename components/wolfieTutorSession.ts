export interface WolfieTutorSessionSummary {
  learnerTurns: number;
  sessionCompleted: boolean;
  sessionScore: number | null;
  conversationId: string | null;
}

interface WolfieTutorSessionSummaryInput {
  confirmedLearnerTurns: number;
  processingPending: boolean;
  retryRequired: boolean;
  sessionScore: number | null;
  conversationId: string | null;
}

interface WolfieTutorCloseGuardInput {
  callState: string;
  classicRequestPending: boolean;
  realtimePersistencePending: boolean;
  confirmationPending: boolean;
  transcriptReviewPending: boolean;
}

export function isWolfieTutorCloseBlocked({
  callState,
  classicRequestPending,
  realtimePersistencePending,
  confirmationPending,
  transcriptReviewPending,
}: WolfieTutorCloseGuardInput): boolean {
  return callState === "THINKING" ||
    callState === "LISTENING" ||
    classicRequestPending ||
    realtimePersistencePending ||
    confirmationPending ||
    transcriptReviewPending;
}

export function registerConfirmedWolfieTurn(
  confirmedTurnIds: Set<string>,
  turnId: string,
  substantive: boolean,
): boolean {
  const normalizedTurnId = turnId.trim();
  if (!substantive || !normalizedTurnId || confirmedTurnIds.has(normalizedTurnId)) {
    return false;
  }

  confirmedTurnIds.add(normalizedTurnId);
  return true;
}

export function resolveWolfieTutorSessionSummary({
  confirmedLearnerTurns,
  processingPending,
  retryRequired,
  sessionScore,
  conversationId,
}: WolfieTutorSessionSummaryInput): WolfieTutorSessionSummary {
  const learnerTurns = Number.isFinite(confirmedLearnerTurns)
    ? Math.max(0, Math.floor(confirmedLearnerTurns))
    : 0;
  const normalizedConversationId = typeof conversationId === "string" &&
      conversationId.trim().length > 0
    ? conversationId.trim()
    : null;
  const boundedSessionScore = sessionScore === null || !Number.isFinite(sessionScore)
    ? null
    : Math.max(0, Math.min(100, Math.round(sessionScore)));

  return {
    learnerTurns,
    sessionCompleted: learnerTurns >= 2 &&
      !processingPending &&
      !retryRequired &&
      normalizedConversationId !== null,
    sessionScore: boundedSessionScore,
    conversationId: normalizedConversationId,
  };
}
