import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MeetingSection,
  TextEvaluationResult,
  WolfieActivitySession,
} from "./types";

const activityMocks = vi.hoisted(() => ({
  submitText: vi.fn(),
  saveMemorization: vi.fn(),
}));

vi.mock("../../services/wolfieActivityService", () => ({
  analyzeWolfieSpeech: vi.fn(),
  createWolfieRequestKey: vi.fn(() => "request-key"),
  generateWolfieActivity: vi.fn(),
  saveWolfieMemorization: (...args: unknown[]) =>
    activityMocks.saveMemorization(...args),
  submitWolfieText: (...args: unknown[]) => activityMocks.submitText(...args),
  validateWolfieMeetingRecall: vi.fn(),
  WolfieActivityError: class WolfieActivityError extends Error {
    constructor(message: string, readonly code = "TEST_ERROR") {
      super(message);
    }
  },
}));

import { WolfieMeetingActivity } from "./WolfieMeetingActivity";

const sectionKeys = [
  "opening",
  "context",
  "data",
  "proposal",
  "next_steps",
  "closing",
] as const;

const sections: MeetingSection[] = sectionKeys.map((key, index) => ({
  key,
  title: `Bloco ${index + 1}`,
  objective: `Objetivo ${index + 1}`,
  coachTipPt: `Dica ${index + 1}`,
  starter: `Starter ${index + 1}`,
}));

const parentAttemptId = "11111111-1111-4111-8111-111111111111";

const successfulEvaluation: TextEvaluationResult = {
  score: 86,
  correctedText: "Corrected complete script",
  naturalVersion: "Natural complete script",
  explanationPt: "O roteiro agora cobre o objetivo.",
  strengths: ["Estrutura clara"],
  priorities: [],
  readinessMessage: "Pronto para memorizar.",
  rubric: { taskCompletion: 86 },
  requiresRetry: false,
};

const retrySession = (): WolfieActivitySession => ({
  id: "session-1",
  tenant_id: "tenant-1",
  student_id: "student-1",
  subject: "global_meetings",
  cefr_level: "B2",
  sector: "technology_ai",
  phase: "construction",
  modality: "text",
  status: "AWAITING_RETRY",
  source_session_id: null,
  activity_content: {
    title: "Steering committee",
    readinessGoal: "Conduzir a decisão com clareza.",
    instructionsPt: "Construa e refine os seis blocos.",
    targetVocabulary: [],
    sections,
    scenario: {
      title: "Pilot decision",
      role: "Product lead",
      company: "Wise Wolf",
      objective: "Approve a limited pilot",
      constraint: "Ten minutes",
      sector: "Technology",
    },
  },
  learner_state: {
    sections: Object.fromEntries(
      sections.map((section) => [
        section.key,
        {
          original: `${section.title} original`,
          corrected: `${section.title} corrected`,
          naturalVersion: `${section.title} natural`,
          score: 80,
          requiresRetry: false,
        },
      ]),
    ),
  },
  report_json: {
    latestAttempt: {
      attemptId: parentAttemptId,
      attemptNumber: 7,
      stepKey: "construction_complete",
      modality: "text",
      score: 58,
      requiresRetry: true,
      retryCompleted: false,
      responsePayload: { text: "Original complete meeting script" },
      feedbackPayload: {
        correctedText: "Corrected complete meeting script",
        naturalVersion: "Natural complete meeting script",
        explanationPt: "O fechamento ainda não define responsável e prazo.",
        strengths: ["Abertura objetiva"],
        priorities: ["Defina responsável, prazo e próximo passo"],
        readinessMessage: "Revise o fechamento.",
        retryPrompt: "Feche a decisão de forma acionável.",
        rubric: { decisionAndActionableClose: 42 },
      },
    },
  },
  reused_terms: [],
  introduced_terms: [],
  score: null,
  xp_earned: 0,
  duration_seconds: 120,
  attempt_count: 7,
  test_fixture: true,
  started_at: "2026-08-01T12:00:00.000Z",
  completed_at: null,
});

describe("WolfieMeetingActivity construction retry", () => {
  beforeEach(() => {
    activityMocks.submitText.mockReset();
    activityMocks.saveMemorization.mockReset();
    activityMocks.saveMemorization.mockResolvedValue({});
  });

  it("restores the final feedback and retries the same logical step without returning to a section", async () => {
    activityMocks.submitText
      .mockRejectedValueOnce(new Error("Falha temporária na consolidação."))
      .mockResolvedValueOnce(successfulEvaluation);

    render(
      <WolfieMeetingActivity
        session={retrySession()}
        onSessionChange={vi.fn()}
        onComplete={vi.fn()}
        onExit={vi.fn()}
        onConversation={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("heading", { name: /revise os seis blocos/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Defina responsável, prazo e próximo passo"),
    ).toBeInTheDocument();

    const script = screen.getByLabelText(/roteiro completo revisado/i);
    expect(script).toHaveValue("Original complete meeting script");
    fireEvent.change(script, {
      target: { value: "Revised script with owner, deadline and next step." },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /enviar roteiro revisado/i }),
    );

    expect(
      await screen.findByText("Falha temporária na consolidação."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /tentar novamente/i }));

    await waitFor(() => expect(activityMocks.submitText).toHaveBeenCalledTimes(2));
    expect(activityMocks.submitText.mock.calls[0]?.[0]?.requestKey).toBe(
      activityMocks.submitText.mock.calls[1]?.[0]?.requestKey,
    );
    expect(activityMocks.submitText).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        text: "Revised script with owner, deadline and next step.",
        stepKey: "final",
        complete: true,
        parentAttemptId,
      }),
    );
    expect(
      await screen.findByRole("heading", {
        name: /memorize a lógica, não cada palavra/i,
      }),
    ).toBeInTheDocument();
  });
});
