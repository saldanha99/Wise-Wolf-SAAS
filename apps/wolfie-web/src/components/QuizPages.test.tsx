import { act, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PUBLIC_QUIZ_STORAGE_KEY,
  createQuizSnapshot,
  parseQuizSnapshot,
  serializeQuizSnapshot,
  type QuizAnswers,
} from "../funnel/quizModel";
import { PUBLIC_QUIZ_RESULT_KEY, readQuizResult } from "../funnel/quizSession";
import { QuizPage } from "./QuizPages";

vi.mock("../funnel/leadIntake", () => ({ submitWolfieLead: vi.fn() }));

const requestId = "019c1234-5678-4abc-9def-0123456789ab";
const almostComplete: QuizAnswers = {
  goal: "global_meeting",
  context: "technology",
  participation: "lead",
  declaredAbility: "routine_conversations",
  obstacle: "thinking_time",
  modality: "voice",
  urgency: "next_7_days",
};

describe("experiência visual do quiz público", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    sessionStorage.clear();
    window.history.replaceState({}, "", "/quiz");
    Object.defineProperty(window, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    localStorage.setItem(
      PUBLIC_QUIZ_STORAGE_KEY,
      serializeQuizSnapshot(createQuizSnapshot(almostComplete, "practiceMinutes")),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("confirma a última escolha, salva uma vez e mostra o cálculo antes do resultado", () => {
    const uuid = vi.spyOn(crypto, "randomUUID").mockReturnValue(requestId);
    render(<StrictMode><QuizPage /></StrictMode>);

    const progress = screen.getByRole("progressbar", {
      name: "Respostas concluídas no diagnóstico",
    });
    expect(progress).toHaveAttribute("aria-valuenow", "7");

    const finalChoice = screen.getByRole("button", { name: "5 minutos" });
    fireEvent.click(finalChoice);
    fireEvent.click(finalChoice);

    expect(uuid).toHaveBeenCalledTimes(1);
    expect(readQuizResult()?.leadRequestId).toBe(requestId);
    expect(sessionStorage.getItem(PUBLIC_QUIZ_RESULT_KEY)).not.toBeNull();
    expect(parseQuizSnapshot(localStorage.getItem(PUBLIC_QUIZ_STORAGE_KEY))?.answers.practiceMinutes).toBe("5");
    expect(window.location.pathname).toBe("/quiz");

    act(() => vi.advanceTimersByTime(320));

    expect(screen.getByRole("heading", { name: "Calculando seu diagnóstico" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("somente as oito escolhas");
    expect(screen.getByRole("progressbar", { name: "Preparação do diagnóstico" })).toHaveAttribute("aria-valuenow", "24");
    expect(window.location.pathname).toBe("/quiz");

    act(() => vi.advanceTimersByTime(2_450));
    expect(window.location.pathname).toBe("/quiz/resultado");
  });
});
