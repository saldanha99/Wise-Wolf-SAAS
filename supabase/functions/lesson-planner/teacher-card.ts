/**
 * Cartão do aluno — preenchido pelo professor, sem IA (migration
 * 20260926220000, tabela public.student_learning_cards).
 *
 * No Planner, o que o professor revisou VENCE o que o Wolfie inferiu das
 * conversas (wolf_intelligence) e as colunas antigas de profiles. Campo vazio
 * no cartão não apaga nada: cai no que já existia.
 *
 * Menor de idade (is_kids ou nascido há menos de 18 anos): o cartão só carrega
 * objetivo e temas. Estilo de correção, "o que evitar" e notas do cartão são
 * descartados aqui também — o banco já recusa gravá-los, mas um cartão escrito
 * antes de a data de nascimento chegar ainda pode tê-los.
 */

import { boundedStringArray, boundedText, isRecord } from "./core.ts";

export const TEACHER_CARD_CORRECTION_STYLES = [
  "immediate",
  "end",
  "selective",
  "examiner",
] as const;

export type TeacherCardCorrectionStyle =
  typeof TEACHER_CARD_CORRECTION_STYLES[number];

/** Os mesmos limites de private.student_learning_card_limits(). */
export const TEACHER_CARD_LIMITS = {
  realGoal: 300,
  topic: 60,
  engagingTopics: 8,
  avoidTopics: 6,
  notes: 400,
} as const;

export interface TeacherLearningCard {
  realGoal: string;
  engagingTopics: string[];
  correctionStyle: TeacherCardCorrectionStyle | null;
  avoidTopics: string[];
  notes: string;
  updatedAt: string | null;
}

/** O que o Planner já sabia antes do cartão (Wolfie + profiles). */
export interface InferredStudentSignals {
  primaryGoal: string;
  preferredTopics: string[];
  topicsToAvoid: string[];
  preferredCorrectionMode: string;
}

export type TeacherReviewedField =
  | "primary_goal"
  | "preferred_topics"
  | "topics_to_avoid"
  | "preferred_correction_mode"
  | "teacher_notes";

export interface ResolvedStudentSignals extends InferredStudentSignals {
  teacherNotes: string;
  /** Campos que vieram do cartão do professor (e venceram a inferência). */
  teacherReviewedFields: TeacherReviewedField[];
  teacherCardUpdatedAt: string | null;
}

const isCorrectionStyle = (
  value: unknown,
): value is TeacherCardCorrectionStyle =>
  typeof value === "string" &&
  (TEACHER_CARD_CORRECTION_STYLES as readonly string[]).includes(value);

/** Data de hoje no fuso da escola, como AAAA-MM-DD. */
export function saoPauloTodayIso(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * Mesma régua do banco (private.student_learning_card_minor): is_kids, ou
 * data de nascimento posterior a "hoje menos 18 anos". Quem faz 18 hoje já é
 * adulto; quem faz amanhã ainda é menor.
 */
export function isMinorStudent(
  isKids: unknown,
  birthDate: unknown,
  todayIso: string,
): boolean {
  if (isKids === true) return true;
  if (typeof birthDate !== "string") return false;
  const birth = /^(\d{4})-(\d{2})-(\d{2})/.exec(birthDate);
  const today = /^(\d{4})-(\d{2})-(\d{2})$/.exec(todayIso);
  if (!birth || !today) return false;
  const eighteenthBirthday = `${
    String(Number(birth[1]) + 18).padStart(4, "0")
  }-${birth[2]}-${birth[3]}`;
  // Comparação de texto AAAA-MM-DD equivale à de datas. Nascido em 29/02: o
  // aniversário "29/02" de ano não bissexto fica depois de 28/02 e antes de
  // 01/03, o mesmo que o Postgres faz com "- interval '18 years'".
  return eighteenthBirthday > todayIso;
}

/**
 * Lê a linha da tabela e devolve o cartão já limpo e limitado — ou null quando
 * não há nada útil. Para menor, só objetivo e temas sobrevivem.
 */
export function normalizeTeacherCard(
  row: unknown,
  isMinor: boolean,
): TeacherLearningCard | null {
  if (!isRecord(row)) return null;
  const card: TeacherLearningCard = {
    realGoal: boundedText(row.real_goal, TEACHER_CARD_LIMITS.realGoal),
    engagingTopics: boundedStringArray(
      row.engaging_topics,
      TEACHER_CARD_LIMITS.engagingTopics,
      TEACHER_CARD_LIMITS.topic,
    ),
    correctionStyle: !isMinor && isCorrectionStyle(row.correction_style)
      ? row.correction_style
      : null,
    avoidTopics: isMinor ? [] : boundedStringArray(
      row.avoid_topics,
      TEACHER_CARD_LIMITS.avoidTopics,
      TEACHER_CARD_LIMITS.topic,
    ),
    notes: isMinor ? "" : boundedText(row.notes, TEACHER_CARD_LIMITS.notes),
    updatedAt: typeof row.updated_at === "string" ? row.updated_at : null,
  };
  const hasContent = card.realGoal !== "" ||
    card.engagingTopics.length > 0 ||
    card.correctionStyle !== null ||
    card.avoidTopics.length > 0 ||
    card.notes !== "";
  return hasContent ? card : null;
}

/**
 * Junta o que foi inferido com o cartão. Campo preenchido no cartão substitui
 * o inferido por inteiro (não soma): se o professor tirou um tema da lista, é
 * porque ele não engaja mais.
 */
export function resolveStudentSignals(
  inferred: InferredStudentSignals,
  card: TeacherLearningCard | null,
): ResolvedStudentSignals {
  const reviewed: TeacherReviewedField[] = [];
  const pick = <T>(
    field: TeacherReviewedField,
    fromCard: T,
    hasCardValue: boolean,
    fallback: T,
  ): T => {
    if (!hasCardValue) return fallback;
    reviewed.push(field);
    return fromCard;
  };

  const primaryGoal = pick(
    "primary_goal",
    card?.realGoal ?? "",
    Boolean(card?.realGoal),
    inferred.primaryGoal,
  );
  const preferredTopics = pick(
    "preferred_topics",
    card?.engagingTopics ?? [],
    (card?.engagingTopics.length ?? 0) > 0,
    inferred.preferredTopics,
  );
  const topicsToAvoid = pick(
    "topics_to_avoid",
    card?.avoidTopics ?? [],
    (card?.avoidTopics.length ?? 0) > 0,
    inferred.topicsToAvoid,
  );
  const preferredCorrectionMode = pick(
    "preferred_correction_mode",
    card?.correctionStyle ?? "",
    Boolean(card?.correctionStyle),
    inferred.preferredCorrectionMode,
  );
  const teacherNotes = pick(
    "teacher_notes",
    card?.notes ?? "",
    Boolean(card?.notes),
    "",
  );

  return {
    primaryGoal,
    preferredTopics,
    topicsToAvoid,
    preferredCorrectionMode,
    teacherNotes,
    teacherReviewedFields: reviewed,
    teacherCardUpdatedAt: card?.updatedAt ?? null,
  };
}
