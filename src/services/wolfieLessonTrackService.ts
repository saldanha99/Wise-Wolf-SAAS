import { supabase } from "../../lib/supabase";

/**
 * Trilha da aula do Wolfie: cliente da função `wolfie-lesson-track`.
 * O gabarito nunca vem para o navegador; cada resposta é corrigida no servidor.
 */

export interface LessonTrackCard {
  id: string | null;
  classDate: string;
  status: "PENDING" | "GENERATING" | "READY" | "FAILED";
  topic: string;
  answered?: number;
  total?: number;
  completed?: boolean;
  score?: number | null;
  hasRoleplayFeedback?: boolean;
}

export interface LessonReviewCard {
  id: string;
  step: "D1" | "D3" | "D7" | "D14" | "D30" | "CHECKIN";
  dueOn: string;
  topic: string;
}

export interface LessonTrackHome {
  track: LessonTrackCard | null;
  reviews: LessonReviewCard[];
}

export type PracticeKind = "recognize" | "complete" | "transform" | "produce";

export interface LessonTrackContent {
  topic: string;
  topicEn: string;
  grammar: { explanationPt: string; pattern: string; examples: { en: string; pt: string }[] };
  warmup: { id: string; pt: string }[];
  mistakes: { id: string; said: string; fromClass: boolean }[];
  practice: { id: string; kind: PracticeKind; topic: "current" | "previous"; prompt: string; options: string[] }[];
  vocabulary: { term: string; meaningPt: string; sentence: string }[];
  speaking: { id: string; question: string; targetPt: string };
  roleplay: {
    titlePt: string;
    scenario: string;
    character: string;
    openingLine: string;
    objectives: string[];
    closing: string;
  };
}

export interface AnsweredItem {
  correct: boolean;
  attempts: number;
  answer: string;
  expected: string;
  whyPt: string;
  native: string;
  hintPt: string;
  canRetry: boolean;
}

export interface RoleplayFeedback {
  objectivesDone: boolean[];
  strengths: string[];
  corrections: { said: string; correct: string; rulePt: string; native: string; onTopic: boolean }[];
  modelSentence: string;
  priorityPt: string;
}

export interface LessonTrackDetail {
  id: string;
  classDate: string;
  topic: string;
  completed: boolean;
  score: number | null;
  content: LessonTrackContent;
  answered: Record<string, AnsweredItem>;
  roleplay: { topic: string; scenario: string; studentGoal: string; targetSkill: string };
  roleplayFeedback: RoleplayFeedback | null;
}

export interface AnswerResult {
  correct: boolean;
  attempts?: number;
  hintPt?: string;
  expected: string;
  corrected?: string;
  whyPt: string;
  native?: string;
  canRetry?: boolean;
}

export interface LessonReviewDetail {
  id: string;
  step: LessonReviewCard["step"];
  dueOn: string;
  topic: string;
  classDate: string;
  status: "PENDING" | "DONE";
  items: { id: string; kind: "recognize" | "complete"; prompt: string; options: string[]; older: boolean }[];
  answers: Record<string, { correct: boolean; answer: string }>;
}

export class LessonTrackError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
  }
}

const MESSAGES: Record<string, string> = {
  PAYMENT_REQUIRED: "A trilha volta assim que a mensalidade estiver em dia.",
  TRACK_NOT_READY: "A trilha ainda está sendo preparada.",
  REVIEW_LOCKED: "Esta revisão abre depois que você for bem na anterior.",
  AI_PROVIDER_UNAVAILABLE: "O Wolfie não conseguiu corrigir agora. Tente de novo em instantes.",
  FEEDBACK_UNAVAILABLE: "Não deu para montar os cartões desta conversa. Tente de novo.",
  FEEDBACK_IN_PROGRESS: "Os cartões desta conversa já estão sendo montados. Aguarde um instante.",
  TRACK_BUSY: "Outra resposta estava sendo salva. Toque em Verificar de novo.",
};

async function errorCode(error: unknown): Promise<string> {
  const context = (error as { context?: { json?: () => Promise<unknown> } })?.context;
  if (context?.json) {
    try {
      const body = await context.json() as { error?: unknown };
      if (typeof body?.error === "string") return body.error;
    } catch {
      // resposta sem JSON: segue com o código genérico
    }
  }
  return "LESSON_TRACK_FAILED";
}

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke("wolfie-lesson-track", { body });
  if (error) {
    const code = await errorCode(error);
    throw new LessonTrackError(MESSAGES[code] ?? "Algo falhou na trilha. Tente de novo.", code);
  }
  if (!data || typeof data !== "object") {
    throw new LessonTrackError("Resposta inesperada do Wolfie.", "INVALID_RESPONSE");
  }
  return data as T;
}

export const getLessonTrackHome = () => call<LessonTrackHome>({ action: "home" });
export const prepareLessonTrack = () => call<{ track: LessonTrackCard | null }>({ action: "prepare" });
export const getLessonTrack = (trackId: string) =>
  call<{ track: LessonTrackDetail }>({ action: "get", trackId });
export const answerLessonTrackItem = (trackId: string, itemId: string, answer: string | number) =>
  call<AnswerResult>({ action: "answer", trackId, itemId, answer });
export const completeLessonTrack = (trackId: string) =>
  call<{ score: number; completed: boolean }>({ action: "complete", trackId });
export const getRoleplayFeedback = (trackId: string, conversationId: string) =>
  call<{ feedback: RoleplayFeedback | null; reason?: string }>({
    action: "roleplay_feedback",
    trackId,
    conversationId,
  });
export const getLessonReview = (reviewId: string) =>
  call<{ review: LessonReviewDetail }>({ action: "review_get", reviewId });
export const answerLessonReviewItem = (reviewId: string, itemId: string, answer: string | number) =>
  call<{ correct: boolean; expected: string; whyPt: string }>({
    action: "review_answer",
    reviewId,
    itemId,
    answer,
  });
export const completeLessonReview = (reviewId: string) =>
  call<{ score: number }>({ action: "review_complete", reviewId });

/** "Sua aula de sexta" — o dia da semana em pt-BR, sem fuso surpresa. */
export function lessonDayLabel(isoDate: string): string {
  const date = new Date(`${isoDate}T12:00:00`);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("pt-BR", { weekday: "long" }).replace("-feira", "");
}

export const REVIEW_LABEL: Record<LessonReviewCard["step"], string> = {
  D1: "Revisão de 1 dia",
  D3: "Revisão de 3 dias",
  D7: "Revisão de 1 semana",
  D14: "Revisão de 2 semanas",
  D30: "Revisão de 1 mês",
  CHECKIN: "Check-in antes da aula",
};
