/**
 * Aulas aprovadas — o Planner parte dos resumos das aulas no Google Meet que o
 * PROFESSOR revisou e aprovou (student_learning_memories com source_type
 * MEET_SESSION e verification_status VERIFIED; é o que google_meet_backend
 * grava quando o resumo passa pela revisão humana).
 *
 * Regras (decisão da direção, 27/09/2026):
 *   - memória do aluno só entra com resumo aprovado: resumo PROPOSED/REJECTED
 *     do Meet não chega ao modelo, nem como hipótese;
 *   - o plano diz de quais aulas saiu ("baseado nas aulas de 20/09 e 23/09") —
 *     a base é calculada AQUI, pelo código, e não pedida ao modelo;
 *   - o plano continua do recommended_next_step aprovado mais recente, e a
 *     lição (modo homework) ataca os erros recorrentes aprovados;
 *   - só campos pedagógicos: nada de metadata, notes_to_verify, source_ref ou
 *     quem revisou. Dado pessoal do aluno só entra pelo cartão revisado
 *     (teacher-card.ts), nunca por aqui.
 */

import {
  boundedStringArray,
  boundedText,
  isRecord,
  redactDirectIdentifiers,
} from "./core.ts";
import { saoPauloTodayIso } from "./teacher-card.ts";
import {
  type PlannerTaskMode,
  WISE_WOLF_PROMPT_VERSION,
} from "./wise-wolf-training-engine.ts";

/** Quantas aulas aprovadas, no máximo, entram no plano (as mais recentes). */
export const MEET_APPROVED_LESSON_LIMIT = 6;

/**
 * As ÚNICAS colunas lidas de student_learning_memories para as aulas
 * aprovadas. source_type/verification_status/occurred_at servem ao filtro e à
 * data; o resto é pedagógico.
 */
export const APPROVED_LESSON_COLUMNS = [
  "source_type",
  "verification_status",
  "occurred_at",
  "lesson_objective",
  "content_practiced",
  "new_vocabulary",
  "recurring_errors",
  "corrections_mastered",
  "strengths_observed",
  "homework_assigned",
  "recommended_next_step",
] as const;

/** Versão registrada em planner_ai_runs.prompt_version. */
export const LESSON_PLANNER_PROMPT_VERSION =
  `${WISE_WOLF_PROMPT_VERSION}+aulas-aprovadas-2026-09-27`;

export interface ApprovedLesson {
  /** AAAA-MM-DD no fuso da escola. */
  lessonDate: string;
  lessonObjective: string;
  contentPracticed: string[];
  newVocabulary: string[];
  recurringErrors: string[];
  correctionsMastered: string[];
  strengthsObserved: string[];
  homeworkAssigned: string;
  recommendedNextStep: string;
}

export interface PlannerLessonBasis {
  source: "MEET_APPROVED_SUMMARIES";
  /** Datas das aulas usadas, sem repetição, da mais antiga para a mais nova. */
  lesson_dates: string[];
  /** "Baseado nas aulas de 20/09 e 23/09". */
  label: string;
  /** O próximo passo aprovado de onde o plano continua. */
  continued_from: { lesson_date: string; recommended_next_step: string } | null;
  /** Só no modo homework: os erros recorrentes que a lição ataca. */
  homework_targets: string[];
}

export type ApprovedLessonsTaskFocus =
  | "none"
  | "continue_from_recommended_next_step"
  | "homework_attacks_recurring_errors"
  | "use_as_evidence";

const TEXT_LIMIT = 700;
const LIST_ITEMS = 15;
const LIST_ITEM_LENGTH = 300;
const HOMEWORK_TARGET_LIMIT = 6;

/** Modos que avaliam o que já aconteceu: usam as aulas como evidência. */
const EVIDENCE_TASK_MODES: readonly PlannerTaskMode[] = [
  "student_feedback",
  "progress_report",
];

const cleanText = (value: unknown, maxLength = TEXT_LIMIT): string =>
  redactDirectIdentifiers(boundedText(value, maxLength));

const cleanList = (value: unknown): string[] =>
  boundedStringArray(value, LIST_ITEMS, LIST_ITEM_LENGTH)
    .map((item) => redactDirectIdentifiers(item));

const timestampOf = (value: unknown): number | null => {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Linhas de student_learning_memories → aulas aprovadas, da mais recente para
 * a mais antiga, no máximo MEET_APPROVED_LESSON_LIMIT. O filtro de origem e de
 * aprovação é repetido aqui de propósito: consulta errada não pode pôr resumo
 * não aprovado no plano.
 */
export function normalizeApprovedMeetLessons(rows: unknown): ApprovedLesson[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter(isRecord)
    .filter((row) =>
      row.source_type === "MEET_SESSION" &&
      row.verification_status === "VERIFIED"
    )
    .map((row) => ({ row, at: timestampOf(row.occurred_at) }))
    .filter((item): item is { row: Record<string, unknown>; at: number } =>
      item.at !== null
    )
    .sort((left, right) => right.at - left.at)
    .slice(0, MEET_APPROVED_LESSON_LIMIT)
    .map(({ row, at }) => ({
      lessonDate: saoPauloTodayIso(new Date(at)),
      lessonObjective: cleanText(row.lesson_objective),
      contentPracticed: cleanList(row.content_practiced),
      newVocabulary: cleanList(row.new_vocabulary),
      recurringErrors: cleanList(row.recurring_errors),
      correctionsMastered: cleanList(row.corrections_mastered),
      strengthsObserved: cleanList(row.strengths_observed),
      homeworkAssigned: cleanText(row.homework_assigned),
      recommendedNextStep: cleanText(row.recommended_next_step),
    }));
}

/** "2026-09-20" → "20/09". */
export function dayMonth(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  return match ? `${match[3]}/${match[2]}` : isoDate;
}

/** ["a"] → "a"; ["a","b"] → "a e b"; ["a","b","c"] → "a, b e c". */
export function joinPtBr(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} e ${items[items.length - 1]}`;
}

/** Datas das aulas, sem repetição (aula de 1 h partida é um dia só), em ordem. */
export function approvedLessonDates(lessons: ApprovedLesson[]): string[] {
  return [...new Set(lessons.map((lesson) => lesson.lessonDate))].sort();
}

export function lessonBasisLabel(dates: string[]): string {
  if (!dates.length) return "";
  const days = dates.map(dayMonth);
  return days.length === 1
    ? `Baseado na aula de ${days[0]}`
    : `Baseado nas aulas de ${joinPtBr(days)}`;
}

/** O próximo passo aprovado mais recente (a aula aprovada sempre tem um). */
export function continueFrom(
  lessons: ApprovedLesson[],
): { lesson_date: string; recommended_next_step: string } | null {
  const lesson = lessons.find((item) => item.recommendedNextStep);
  return lesson
    ? {
      lesson_date: lesson.lessonDate,
      recommended_next_step: lesson.recommendedNextStep,
    }
    : null;
}

const errorKey = (value: string): string =>
  value.normalize("NFD").replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ").trim().toLocaleLowerCase("pt-BR");

/**
 * Erros recorrentes aprovados, sem repetição: primeiro os que voltaram em mais
 * aulas; empate, o mais recente. Guarda o texto da aula mais recente.
 */
export function recurringErrorsToTarget(
  lessons: ApprovedLesson[],
  limit = HOMEWORK_TARGET_LIMIT,
): string[] {
  const seen = new Map<
    string,
    { text: string; count: number; firstIndex: number }
  >();
  let order = 0;
  for (const lesson of lessons) {
    const inThisLesson = new Set<string>();
    for (const error of lesson.recurringErrors) {
      const key = errorKey(error);
      if (!key || inThisLesson.has(key)) continue;
      inThisLesson.add(key);
      const current = seen.get(key);
      if (current) current.count += 1;
      else seen.set(key, { text: error, count: 1, firstIndex: order++ });
    }
  }
  return [...seen.values()]
    .sort((left, right) =>
      right.count - left.count || left.firstIndex - right.firstIndex
    )
    .slice(0, limit)
    .map((item) => item.text);
}

export function approvedLessonsTaskFocus(
  lessons: ApprovedLesson[],
  taskMode: PlannerTaskMode,
): ApprovedLessonsTaskFocus {
  if (!lessons.length) return "none";
  if (taskMode === "homework") return "homework_attacks_recurring_errors";
  if (EVIDENCE_TASK_MODES.includes(taskMode)) return "use_as_evidence";
  return "continue_from_recommended_next_step";
}

/** A base que o plano devolve e que a tela mostra — nula sem aula aprovada. */
export function approvedLessonBasis(
  lessons: ApprovedLesson[],
  taskMode: PlannerTaskMode,
): PlannerLessonBasis | null {
  const dates = approvedLessonDates(lessons);
  if (!dates.length) return null;
  return {
    source: "MEET_APPROVED_SUMMARIES",
    lesson_dates: dates,
    label: lessonBasisLabel(dates),
    continued_from: continueFrom(lessons),
    homework_targets: taskMode === "homework"
      ? recurringErrorsToTarget(lessons)
      : [],
  };
}

/** O bloco approved_lessons da entrada do modelo. */
export function approvedLessonsPromptBlock(
  lessons: ApprovedLesson[],
  taskMode: PlannerTaskMode,
) {
  return {
    source:
      "Resumos das aulas no Google Meet revisados e aprovados pelo professor.",
    basis_label: lessonBasisLabel(approvedLessonDates(lessons)),
    task_focus: approvedLessonsTaskFocus(lessons, taskMode),
    continue_from: continueFrom(lessons),
    recurring_errors_to_target: recurringErrorsToTarget(lessons),
    // Mais recente primeiro. Só campos pedagógicos.
    lessons: lessons.map((lesson) => ({
      lesson_date: lesson.lessonDate,
      lesson_objective: lesson.lessonObjective,
      content_practiced: lesson.contentPracticed,
      new_vocabulary: lesson.newVocabulary,
      recurring_errors: lesson.recurringErrors,
      corrections_mastered: lesson.correctionsMastered,
      strengths_observed: lesson.strengthsObserved,
      homework_assigned: lesson.homeworkAssigned,
      recommended_next_step: lesson.recommendedNextStep,
    })),
  };
}

/** Linha "Baseado nas aulas de …" no topo do texto salvo em lesson_plans. */
export function legacyContentWithBasis(
  basis: PlannerLessonBasis | null,
  legacyContent: string,
): string {
  return basis ? `${basis.label}.\n\n${legacyContent}` : legacyContent;
}

/**
 * Regra de uso das aulas aprovadas. Vai numa mensagem de sistema própria do
 * lesson-planner — o prompt base é compartilhado com o planner do Hub, que não
 * tem aulas do Meet.
 */
export const APPROVED_LESSONS_SYSTEM_PROMPT = `
AULAS APROVADAS (approved_lessons)
- approved_lessons.lessons traz os resumos das últimas aulas do aluno no Google Meet que o professor revisou e aprovou, cada um com lesson_date, da mais recente para a mais antiga. São evidências verificadas: valem mais que wolf_intelligence, recent_lesson_memory e os relatórios do Wolfie.
- task_focus = "continue_from_recommended_next_step": o artefato continua de approved_lessons.continue_from.recommended_next_step. Retome no aquecimento o que foi praticado na aula mais recente e não repita como novidade o que já foi dominado.
- task_focus = "homework_attacks_recurring_errors": a tarefa de casa (homework) ataca approved_lessons.recurring_errors_to_target — cada erro vira prática concreta (reescrever, completar, gravar um áudio curto usando a forma certa). expected_corrections trata esses mesmos erros, que são evidência aprovada; não invente erro fora da lista.
- task_focus = "use_as_evidence": use as aulas aprovadas como evidência do que o aluno fez e de como evoluiu.
- Quando approved_lessons.basis_label não estiver vazio, comece overview com ele (ex.: "Baseado nas aulas de 20/09 e 23/09.").
- Quando approved_lessons.lessons estiver vazio, não diga que houve aula aprovada nem cite datas de aula.
- approved_lessons só traz campos pedagógicos. Não deduza nem registre fato pessoal do aluno (saúde, religião, política, família, dinheiro) a partir deles.
`.trim();
