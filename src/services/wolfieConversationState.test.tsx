import { describe, expect, it } from "vitest";
import {
  beginRealtimePostTurn,
  finishRealtimePostTurn,
  initialRealtimePostTurnGateState,
  realtimePostTurnGateIsBlocked,
  realtimePostTurnTokenIsCurrent,
  realtimeConversationIdAfterExit,
  realtimePreparationAfterDisconnect,
  realtimeSessionNeedsClassicHandoff,
  reconcileClassicReplayBubble,
  resetRealtimePostTurnGate,
  setRealtimeConfirmationPending,
} from "./wolfieConversationState";

describe("Wolfie conversation UI state", () => {
  it("keeps Realtime blocked until every queued analysis is finished", () => {
    let state = initialRealtimePostTurnGateState();
    const first = beginRealtimePostTurn(state);
    state = first.state;
    const second = beginRealtimePostTurn(state);
    state = second.state;

    state = finishRealtimePostTurn(state, first.token);
    expect(state.pendingAnalyses).toBe(1);
    expect(realtimePostTurnGateIsBlocked(state)).toBe(true);

    state = finishRealtimePostTurn(state, second.token);
    expect(state.pendingAnalyses).toBe(0);
    expect(realtimePostTurnGateIsBlocked(state)).toBe(false);
  });

  it("never releases the gate behind a transcript confirmation", () => {
    let state = initialRealtimePostTurnGateState();
    const transition = beginRealtimePostTurn(state);
    state = setRealtimeConfirmationPending(transition.state, true);
    state = finishRealtimePostTurn(state, transition.token);

    expect(state.pendingAnalyses).toBe(0);
    expect(realtimePostTurnGateIsBlocked(state)).toBe(true);

    state = setRealtimeConfirmationPending(state, false);
    expect(realtimePostTurnGateIsBlocked(state)).toBe(false);
  });

  it("fences completions from an old terminal session", () => {
    let state = initialRealtimePostTurnGateState();
    const transition = beginRealtimePostTurn(state);
    state = resetRealtimePostTurnGate(transition.state);

    expect(realtimePostTurnTokenIsCurrent(state, transition.token)).toBe(false);
    expect(finishRealtimePostTurn(state, transition.token)).toEqual(state);
  });

  it("removes only the duplicate optimistic classic replay bubble", () => {
    const messages = [
      { id: "stable", content: "Same learner turn" },
      { id: "other", content: "Earlier context" },
      { id: "duplicate", content: "Same learner turn" },
    ];

    expect(
      reconcileClassicReplayBubble(messages, "stable", "duplicate"),
    ).toEqual([
      { id: "stable", content: "Same learner turn" },
      { id: "other", content: "Earlier context" },
    ]);
  });

  it("preserves the session id for Realtime-to-classic handoff and clears it only at a terminal exit", () => {
    const conversationId = "conversation-1";

    expect(
      realtimeConversationIdAfterExit(conversationId, "handoff_to_classic"),
    ).toBe(conversationId);
    expect(realtimeConversationIdAfterExit(conversationId, "terminal"))
      .toBeNull();
  });

  it("restores a pending handoff after reload only for an unhanded Realtime session", () => {
    expect(realtimeSessionNeedsClassicHandoff("realtime-turn", null)).toBe(
      true,
    );
    expect(
      realtimeSessionNeedsClassicHandoff(
        "realtime-turn",
        "2026-08-01T12:00:00.000Z",
      ),
    ).toBe(false);
    expect(realtimeSessionNeedsClassicHandoff(null, null)).toBe(false);
  });

  it("keeps preparation through a handoff but forgets it on terminal disconnect", () => {
    const preparation = { conversationId: "conversation-1" };

    expect(realtimePreparationAfterDisconnect(preparation, false)).toBe(
      preparation,
    );
    expect(realtimePreparationAfterDisconnect(preparation, true)).toBeNull();
  });
});
