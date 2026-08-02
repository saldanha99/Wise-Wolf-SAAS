import { describe, expect, it } from "vitest";
import {
  MEETING_STAGE_ORDER,
  resolveMeetingVisualState,
} from "./visualStateResolver";

describe("resolveMeetingVisualState", () => {
  it("covers the twelve canonical meeting stages in their pedagogical order", () => {
    expect(MEETING_STAGE_ORDER).toEqual([
      "discovery",
      "briefing",
      "guided_build",
      "practice",
      "feedback",
      "retry",
      "simulation",
      "readaptation",
      "improvisation",
      "assessment",
      "report",
      "completed",
    ]);

    MEETING_STAGE_ORDER.forEach((stage, index) => {
      const state = resolveMeetingVisualState({ stage });
      expect(state.stage).toBe(stage);
      expect(state.stageRecognized).toBe(true);
      expect(state.stageIndex).toBe(index);
      expect(state.stageMeta.label).not.toBe("");
    });
  });

  it("pauses coaching intents without losing the active checkpoint", () => {
    const state = resolveMeetingVisualState({
      stage: "simulation",
      scenarioStatus: "active",
      learnerIntent: "ask_doubt",
      counterpart: "Regional Operations Director",
      pendingQuestion: "What evidence supports the new deadline?",
      pendingDecision: "Approve a two-week extension",
    });

    expect(state).toEqual(
      expect.objectContaining({
        scenarioStatus: "paused",
        mode: "coach",
        showCoachSheet: true,
        freezesProgression: true,
        preservesCheckpoint: true,
        counterpart: "Regional Operations Director",
        pendingQuestion: "What evidence supports the new deadline?",
        pendingDecision: "Approve a two-week extension",
      }),
    );
  });

  it("gives retry precedence over a coaching pause and keeps it non-terminal", () => {
    const state = resolveMeetingVisualState({
      stage: "feedback",
      learnerIntent: "request_feedback",
      requiresRetry: true,
    });

    expect(state.scenarioStatus).toBe("awaiting_retry");
    expect(state.mode).toBe("retry");
    expect(state.showCoachSheet).toBe(false);
    expect(state.isTerminal).toBe(false);
  });

  it("gives completion precedence over retry flags", () => {
    const state = resolveMeetingVisualState({
      stage: "completed",
      scenarioStatus: "awaiting_retry",
      requiresRetry: true,
    });

    expect(state.scenarioStatus).toBe("completed");
    expect(state.mode).toBe("debrief");
    expect(state.progressValue).toBe(100);
    expect(state.isTerminal).toBe(true);
  });

  it("falls back safely for unknown stages and bounds untrusted checkpoint text", () => {
    const state = resolveMeetingVisualState({
      stage: "not-a-stage",
      learnerIntent: "not-an-intent",
      counterpart: `  ${"a".repeat(200)}  `,
      pendingQuestion: "  What   changed?  ",
    });

    expect(state.stage).toBe("simulation");
    expect(state.stageRecognized).toBe(false);
    expect(state.learnerIntent).toBe("perform");
    expect(state.counterpart).toHaveLength(160);
    expect(state.pendingQuestion).toBe("What changed?");
  });

  it("maps structured activity aliases without creating extra visual stages", () => {
    expect(resolveMeetingVisualState({ stage: "construction" }).stage).toBe(
      "guided_build",
    );
    expect(resolveMeetingVisualState({ stage: "memorization" }).stage).toBe(
      "practice",
    );
  });
});
