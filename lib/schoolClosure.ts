/**
 * Escola fechada (feriado nacional ou recesso): a aula que estava na agenda é
 * lançada pelo SISTEMA como remunerada (migration
 * `20261124120000_feriados_e_recesso_remunerados`).
 *
 * - `presence = 'SCHOOL_HOLIDAY'`, `subtype = 'FERIADO' | 'RECESSO'`.
 * - Conta no pagamento do professor e como aula do período do aluno (sem
 *   reposição nem abatimento), mas NÃO é aula dada de verdade: relatórios,
 *   pedagógico e Coordenação mostram a marca própria, nunca "Realizada" nem
 *   "Falta".
 */
export const SCHOOL_HOLIDAY_PRESENCE = 'SCHOOL_HOLIDAY';

export function isSchoolClosedLog(presence: string | null | undefined): boolean {
  return presence === SCHOOL_HOLIDAY_PRESENCE;
}

/** "Feriado (remunerada)" ou "Recesso (remunerada)". */
export function schoolClosedLabel(subtype: string | null | undefined): string {
  if (subtype === 'RECESSO') return 'Recesso (remunerada)';
  if (subtype === 'FERIADO') return 'Feriado (remunerada)';
  return 'Feriado ou recesso (remunerada)';
}

/** Cor dos selos: neutra, distinta de realizada (verde) e de falta (laranja/vermelho). */
export const SCHOOL_CLOSED_BADGE_CLASS = 'bg-violet-50 text-violet-700 dark:bg-violet-900/20 dark:text-violet-300';
