import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  SpeechEvaluationResult,
  WolfieActivitySession,
} from "./types";
import { WolfieActivitySummary } from "./WolfieActivitySummary";

const session: WolfieActivitySession = {
  id: "session-voice",
  tenant_id: "tenant-1",
  student_id: "student-1",
  subject: "global_meetings",
  cefr_level: "B2",
  sector: "technology_ai",
  phase: "readaptation",
  modality: "voice",
  status: "AWAITING_RETRY",
  source_session_id: "source-1",
  activity_content: {
    title: "Global meeting rehearsal",
    readinessGoal: "Conduzir uma decisão acionável.",
    instructionsPt: "Faça a readaptação por voz.",
    targetVocabulary: [],
  },
  learner_state: {},
  reused_terms: [],
  introduced_terms: [],
  score: 61,
  xp_earned: 0,
  duration_seconds: 90,
  attempt_count: 1,
  test_fixture: true,
  started_at: "2026-08-01T12:00:00.000Z",
  completed_at: null,
};

const speechResult: SpeechEvaluationResult = {
  score: 61,
  transcript: "We should proceed with the pilot.",
  correctedTranscript: "We should proceed with a limited pilot.",
  pronunciation: {
    score: 82,
    observations: ["Boa articulação"],
    tipPt: "Sustente as consoantes finais.",
  },
  intonation: {
    score: 78,
    observations: ["Boa ênfase"],
    tipPt: "Marque a decisão no fechamento.",
  },
  naturalness: {
    score: 75,
    observations: ["Ritmo consistente"],
    tipPt: "Use uma pausa antes do pedido.",
  },
  rubric: {
    taskCompletion: 70,
    decisionAndActionableClose: 45,
  },
  contentScore: 58,
  failedGates: ["decisionAndActionableClose"],
  strengths: ["Contextualizou o risco com clareza"],
  priorities: ["Nomeie o responsável e o prazo"],
  explanationPt: "A entrega foi clara, mas o fechamento não ficou acionável.",
  readinessMessage: "Faça mais uma tentativa.",
  retryPrompt: "Feche com responsável, prazo e próximo passo.",
  requiresRetry: true,
};

describe("WolfieActivitySummary speech feedback", () => {
  it("shows the complete pedagogical assessment in addition to acoustic delivery", () => {
    render(
      <WolfieActivitySummary
        session={session}
        result={speechResult}
        onRetry={vi.fn()}
        onNewActivity={vi.fn()}
        onOpenRepertoire={vi.fn()}
        onConversation={vi.fn()}
      />,
    );

    expect(screen.getByText("Conteúdo: 58/100")).toBeInTheDocument();
    expect(
      screen.getByText(
        "A entrega foi clara, mas o fechamento não ficou acionável.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Contextualizou o risco com clareza"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Nomeie o responsável e o prazo"),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Decisão e fechamento acionável").length)
      .toBeGreaterThanOrEqual(2);
    expect(
      screen.getByText("Feche com responsável, prazo e próximo passo."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /entrega acústica/i }),
    ).toBeInTheDocument();
  });
});
