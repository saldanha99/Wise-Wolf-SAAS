export interface RealtimePostTurnGateState {
  epoch: number;
  pendingAnalyses: number;
  confirmationPending: boolean;
}

export interface RealtimePostTurnGateToken {
  epoch: number;
}

export const initialRealtimePostTurnGateState = (
  epoch = 0,
): RealtimePostTurnGateState => ({
  epoch,
  pendingAnalyses: 0,
  confirmationPending: false,
});

export const realtimePostTurnGateIsBlocked = (
  state: RealtimePostTurnGateState,
): boolean => state.pendingAnalyses > 0 || state.confirmationPending;

export function beginRealtimePostTurn(
  state: RealtimePostTurnGateState,
): {
  state: RealtimePostTurnGateState;
  token: RealtimePostTurnGateToken;
} {
  return {
    state: {
      ...state,
      pendingAnalyses: state.pendingAnalyses + 1,
    },
    token: { epoch: state.epoch },
  };
}

export function finishRealtimePostTurn(
  state: RealtimePostTurnGateState,
  token: RealtimePostTurnGateToken,
): RealtimePostTurnGateState {
  if (token.epoch !== state.epoch) return state;
  return {
    ...state,
    pendingAnalyses: Math.max(0, state.pendingAnalyses - 1),
  };
}

export function setRealtimeConfirmationPending(
  state: RealtimePostTurnGateState,
  pending: boolean,
): RealtimePostTurnGateState {
  return { ...state, confirmationPending: pending };
}

export function resetRealtimePostTurnGate(
  state: RealtimePostTurnGateState,
): RealtimePostTurnGateState {
  return initialRealtimePostTurnGateState(state.epoch + 1);
}

export function realtimePostTurnTokenIsCurrent(
  state: RealtimePostTurnGateState,
  token: RealtimePostTurnGateToken,
): boolean {
  return state.epoch === token.epoch;
}

export type RealtimeConversationExit = "handoff_to_classic" | "terminal";

/**
 * A transport fallback is not the end of the pedagogical session. Keeping the
 * id lets the classic transport resume the same server checkpoint. Only a
 * completed/abandoned session may discard it.
 */
export function realtimeConversationIdAfterExit(
  conversationId: string | null,
  exit: RealtimeConversationExit,
): string | null {
  return exit === "terminal" ? null : conversationId;
}

export function realtimeSessionNeedsClassicHandoff(
  realtimeFirstClientTurnId: unknown,
  classicHandoffAt: unknown,
): boolean {
  return typeof realtimeFirstClientTurnId === "string" &&
    realtimeFirstClientTurnId.length > 0 &&
    !(typeof classicHandoffAt === "string" && classicHandoffAt.length > 0);
}

export function realtimePreparationAfterDisconnect<T>(
  preparation: T | null,
  forgetPreparedSession: boolean,
): T | null {
  return forgetPreparedSession ? null : preparation;
}

/**
 * A retry after an ambiguous classic response creates a temporary second
 * optimistic bubble before the stable request UUID is recovered. Remove only
 * that duplicate bubble; the original learner turn remains the visual anchor.
 */
export function reconcileClassicReplayBubble<T extends { id: string }>(
  messages: T[],
  stableMessageId: string,
  duplicateMessageId: string,
): T[] {
  if (
    !stableMessageId ||
    !duplicateMessageId ||
    stableMessageId === duplicateMessageId
  ) {
    return messages;
  }
  const stableExists = messages.some((message) => message.id === stableMessageId);
  if (!stableExists) return messages;
  return messages.filter((message) => message.id !== duplicateMessageId);
}
