/**
 * Base do plano do Planner IA: de quais aulas aprovadas ele saiu.
 *
 * Quem calcula é a edge lesson-planner (approved-lessons.ts), a partir dos
 * resumos das aulas no Google Meet que o professor APROVOU — não é o modelo
 * quem diz. A tela só lê e mostra: "Baseado nas aulas de 20/09 e 23/09", o
 * próximo passo aprovado de onde o plano continua e, na tarefa de casa, os
 * erros recorrentes que ela ataca.
 *
 * Se houve aula lançada DEPOIS da última aula aprovada (o Meet é piloto), a
 * aprovada vira histórico: o servidor manda `newer_logged_lesson_date`, sem
 * próximo passo nem alvos, e a tela diz isso em vez de "continua de 23/09".
 */

export interface PlannerLessonBasis {
  lessonDates: string[];
  label: string;
  continuedFrom: { lessonDate: string; recommendedNextStep: string } | null;
  homeworkTargets: string[];
  /** AAAA-MM-DD da aula lançada depois da última aprovada, ou null. */
  newerLoggedLessonDate: string | null;
}

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const stringList = (value: unknown, max: number): string[] =>
  Array.isArray(value)
    ? value
      .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
      .map((item) => item.trim())
      .slice(0, max)
    : [];

/** "2026-09-20" → "20/09". */
export const plannerDayMonth = (isoDate: string): string => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  return match ? `${match[3]}/${match[2]}` : isoDate;
};

/**
 * Lê `lesson_basis` da resposta do Planner (no topo ou dentro do plano).
 * Qualquer coisa fora do formato vira "sem base" — a tela nunca inventa aula.
 */
export function parsePlannerLessonBasis(response: unknown): PlannerLessonBasis | null {
  if (!isRecord(response)) return null;
  const raw = isRecord(response.lesson_basis)
    ? response.lesson_basis
    : isRecord(response.plan) && isRecord(response.plan.lesson_basis)
      ? response.plan.lesson_basis
      : null;
  if (!raw || raw.source !== 'MEET_APPROVED_SUMMARIES') return null;

  const lessonDates = stringList(raw.lesson_dates, 12).filter((date) => ISO_DATE.test(date));
  const label = typeof raw.label === 'string' ? raw.label.trim() : '';
  if (!lessonDates.length || !label) return null;

  const continued = isRecord(raw.continued_from) ? raw.continued_from : null;
  const continuedFrom = continued
    && typeof continued.lesson_date === 'string'
    && ISO_DATE.test(continued.lesson_date)
    && typeof continued.recommended_next_step === 'string'
    && continued.recommended_next_step.trim()
    ? {
      lessonDate: continued.lesson_date,
      recommendedNextStep: continued.recommended_next_step.trim(),
    }
    : null;

  const newerLoggedLessonDate = typeof raw.newer_logged_lesson_date === 'string'
    && ISO_DATE.test(raw.newer_logged_lesson_date)
    ? raw.newer_logged_lesson_date
    : null;

  return {
    lessonDates,
    label,
    // Com aula lançada depois, a tela nunca diz "continua de" nem mostra alvo
    // antigo — mesmo que a resposta os traga.
    continuedFrom: newerLoggedLessonDate ? null : continuedFrom,
    homeworkTargets: newerLoggedLessonDate ? [] : stringList(raw.homework_targets, 6),
    newerLoggedLessonDate,
  };
}
