import { beforeEach, describe, expect, it } from "vitest";
import type { CompleteQuizAnswers } from "./quizModel";
import {
  PUBLIC_QUIZ_RESULT_KEY,
  clearQuizResult,
  createStoredQuizResult,
  markQuizLeadSent,
  parseStoredQuizResult,
  readQuizResult,
  wasQuizLeadSent,
} from "./quizSession";

const requestId = "019c1234-5678-4abc-9def-0123456789ab";
const answers: CompleteQuizAnswers = {
  goal: "global_meeting",
  context: "technology",
  participation: "lead",
  declaredAbility: "routine_conversations",
  obstacle: "thinking_time",
  modality: "voice",
  urgency: "next_7_days",
  practiceMinutes: "10",
};

describe("sessão anônima do resultado Wolfie", () => {
  beforeEach(() => sessionStorage.clear());

  it("preserva uma chave UUID v4 de idempotência no resultado", () => {
    const stored = createStoredQuizResult(answers, requestId);
    expect(parseStoredQuizResult(JSON.stringify(stored))).toEqual(stored);
  });

  it("rejeita resultados antigos ou manipulados sem uma chave válida", () => {
    const stored = createStoredQuizResult(answers, requestId);
    expect(parseStoredQuizResult(JSON.stringify({ ...stored, leadRequestId: "x" })))
      .toBeNull();
    const { leadRequestId: _removed, ...legacy } = stored;
    expect(parseStoredQuizResult(JSON.stringify(legacy))).toBeNull();
  });

  it("mantém o estado de envio no reload e limpa tudo ao refazer", () => {
    const stored = createStoredQuizResult(answers, requestId);
    sessionStorage.setItem(PUBLIC_QUIZ_RESULT_KEY, JSON.stringify(stored));
    markQuizLeadSent(requestId);

    expect(readQuizResult()).toEqual(stored);
    expect(wasQuizLeadSent(requestId)).toBe(true);

    clearQuizResult();
    expect(readQuizResult()).toBeNull();
    expect(wasQuizLeadSent(requestId)).toBe(false);
  });
});
