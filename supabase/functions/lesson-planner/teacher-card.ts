/**
 * Cartão do aluno — preenchido pelo professor, sem IA (migration
 * 20260926220000, tabela public.student_learning_cards).
 *
 * No Planner, o que o professor revisou VENCE o que o Wolfie inferiu das
 * conversas (wolf_intelligence) e as colunas antigas de profiles. Campo vazio
 * no cartão não apaga nada: cai no que já existia.
 *
 * Quem é menor de idade decide o BANCO: o Planner lê o cartão pela RPC
 * public.student_learning_card_for_planner, que aplica a régua do termo de
 * registro das aulas + responsável cadastrado e já entrega o cartão de menor
 * só com objetivo e temas. A régua local (isMinorStudent) é só um cinto a mais:
 * se ela OU o banco disserem "menor", os campos pessoais caem.
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

/** O que o Planner lê de profiles para a régua local de menor. */
export interface MinorSignals {
  studentId?: string | null;
  isKids: unknown;
  birthDate: unknown;
  guardianId?: unknown;
  guardianName?: unknown;
}

/**
 * Régua local, só para endurecer a do banco (nunca para afrouxar): is_kids,
 * data de nascimento posterior a "hoje menos 18 anos", ou responsável
 * cadastrado (guardian_id de outro perfil ou guardian_name preenchido) — o
 * mesmo sinal de responsável de private.student_learning_card_minor_reason.
 * Quem faz 18 hoje já é adulto; quem faz amanhã ainda é menor. Idade não
 * cadastrada quem decide é o banco (régua do termo).
 */
export function isMinorStudent(
  signals: MinorSignals,
  todayIso: string,
): boolean {
  if (signals.isKids === true) return true;
  if (
    typeof signals.guardianId === "string" &&
    signals.guardianId.trim() !== "" &&
    signals.guardianId !== signals.studentId
  ) {
    return true;
  }
  if (
    typeof signals.guardianName === "string" &&
    signals.guardianName.trim() !== ""
  ) {
    return true;
  }
  if (typeof signals.birthDate !== "string") return false;
  const birth = /^(\d{4})-(\d{2})-(\d{2})/.exec(signals.birthDate);
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

/** Colunas de profiles que o Planner usa para o que já sabia do aluno. */
export interface PlannerStudentFacts {
  id?: string | null;
  is_kids: boolean | null;
  birth_date: string | null;
  guardian_id?: string | null;
  guardian_name?: string | null;
  english_for: string | null;
  learning_objective: string | null;
  short_term_goal: string | null;
  interests: unknown;
  preferred_topics: unknown;
  avoided_topics: unknown;
}

const plannerList = (value: unknown): string[] =>
  boundedStringArray(value, 15, 300);

/** O que o Wolfie inferiu (wolf_intelligence) e o que a ficha já trazia. */
export function inferStudentSignals(
  student: PlannerStudentFacts,
  intelligence: unknown,
): InferredStudentSignals {
  const wolfie: Record<string, unknown> = isRecord(intelligence)
    ? intelligence
    : {};
  return {
    primaryGoal: boundedText(
      wolfie.primary_goal ??
        student.short_term_goal ??
        student.english_for ??
        student.learning_objective,
      800,
    ),
    preferredTopics: plannerList(
      wolfie.interests ?? student.preferred_topics ?? student.interests,
    ),
    topicsToAvoid: plannerList(student.avoided_topics),
    preferredCorrectionMode: boundedText(
      wolfie.preferred_correction_mode,
      60,
    ),
  };
}

/**
 * Lê a resposta de student_learning_card_for_planner. O banco decide quem é
 * menor; sem a marca explícita "is_minor: false", o cartão é tratado como de
 * menor (resposta estranha não pode liberar nota pessoal para a IA).
 */
export function readPlannerCardPayload(
  payload: unknown,
  locallyMinor: boolean,
): TeacherLearningCard | null {
  if (!isRecord(payload)) return null;
  const isMinor = payload.is_minor !== false || locallyMinor;
  return normalizeTeacherCard(payload.card, isMinor);
}

/**
 * O student_profile do Planner a partir de (ficha, Wolfie, cartão): é a conta
 * que buildRetrievalQuery e buildModelInput usam — o cartão vence.
 */
export function plannerSignalsFor(
  student: PlannerStudentFacts,
  intelligence: unknown,
  cardPayload: unknown,
  todayIso: string,
): ResolvedStudentSignals {
  const locallyMinor = isMinorStudent({
    studentId: student.id ?? null,
    isKids: student.is_kids,
    birthDate: student.birth_date,
    guardianId: student.guardian_id,
    guardianName: student.guardian_name,
  }, todayIso);
  return resolveStudentSignals(
    inferStudentSignals(student, intelligence),
    readPlannerCardPayload(cardPayload, locallyMinor),
  );
}

/** Os campos do student_profile que vêm do cartão (ou, sem ele, do inferido). */
export function studentProfileSignalFields(signals: ResolvedStudentSignals) {
  return {
    primary_goal: signals.primaryGoal,
    preferred_topics: signals.preferredTopics,
    topics_to_avoid: signals.topicsToAvoid,
    preferred_correction_mode: signals.preferredCorrectionMode,
    // Observação do professor no cartão do aluno (vazia para menor de idade).
    teacher_card_notes: signals.teacherNotes,
    // Campos que vieram do cartão revisado pelo professor: são fato dado por
    // quem dá a aula, não inferência do Wolfie.
    teacher_reviewed_fields: signals.teacherReviewedFields,
  };
}
