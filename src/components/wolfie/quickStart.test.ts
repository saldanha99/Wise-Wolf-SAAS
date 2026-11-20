import { describe, expect, it } from "vitest";
import { buildQuickStartPlan, quickStartRoute } from "./quickStart";
import type { WolfieOverview } from "./types";

const emptyOverview = {
  recentSessions: [],
  resumableSessions: [],
} as unknown as WolfieOverview;

describe("quickStartRoute", () => {
  it("opens the conversation tutor for a student with no history", () => {
    const plan = buildQuickStartPlan({ module: "B1" }, emptyOverview);
    expect(plan.selection.subject).toBe("conversation");
    expect(quickStartRoute(plan.selection)).toBe("conversation");
  });

  it("opens the conversation tutor for a teacher assignment, keeping the topic", () => {
    const plan = buildQuickStartPlan({ module: "A2" }, emptyOverview, undefined, {
      id: "a-1",
      topic: "Present Simple in your daily routine",
      note: "Use 5 verbos",
      teacher_name: "Gabriela Lopes",
    });
    expect(quickStartRoute(plan.selection)).toBe("conversation");
    expect(plan.selection.experienceTitle).toBe("Present Simple in your daily routine");
    expect(plan.selection.experienceContext).toContain("Tarefa do professor: Present Simple in your daily routine.");
    expect(plan.selection.experienceContext).toContain("Use 5 verbos");
  });

  it("generates an activity when the last session was a generated subject", () => {
    const overview = {
      recentSessions: [{ subject: "grammar", cefr_level: "B1", sector: null }],
      resumableSessions: [],
    } as unknown as WolfieOverview;
    const plan = buildQuickStartPlan({ module: "B1" }, overview);
    expect(quickStartRoute(plan.selection)).toBe("activity");
  });
});
