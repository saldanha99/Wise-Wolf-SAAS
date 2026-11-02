/**
 * Lista de alunos do Planner IA para o professor — RPC `my_planner_students`
 * (migration 20260927130000). É a MESMA regra que a edge lesson-planner aplica
 * antes de gerar: agenda viva, segundo professor, titular sem agenda e — do
 * dia anterior ao seguinte da aula — cobertura confirmada e reposição com data.
 * Antes a tela listava só a agenda do professor, e o botão "Planejar" da aula
 * coberta abria o Planner sem o aluno na lista.
 */

import { plannerDayMonth } from './plannerLessonBasis';

export type PlannerAccessReason =
  | 'BOOKING'
  | 'SECOND_TEACHER'
  | 'PRIMARY_TEACHER'
  | 'COVERAGE'
  | 'RESCHEDULE';

export interface PlannerStudentOption {
  id: string;
  full_name: string | null;
  module: string | null;
  access_reason?: PlannerAccessReason | null;
  /** AAAA-MM-DD: último dia em que o acesso vale (cobertura e reposição). */
  valid_until?: string | null;
}

const REASONS: readonly PlannerAccessReason[] = [
  'BOOKING',
  'SECOND_TEACHER',
  'PRIMARY_TEACHER',
  'COVERAGE',
  'RESCHEDULE',
];

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const textOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value : null;

/** Linhas da RPC → opções do seletor, sem repetir aluno. */
export function parsePlannerStudentRows(rows: unknown): PlannerStudentOption[] {
  if (!Array.isArray(rows)) return [];
  const byId = new Map<string, PlannerStudentOption>();
  for (const row of rows) {
    if (!isRecord(row) || typeof row.id !== 'string' || !row.id) continue;
    if (byId.has(row.id)) continue;
    const reason = typeof row.access_reason === 'string'
      && (REASONS as readonly string[]).includes(row.access_reason)
      ? row.access_reason as PlannerAccessReason
      : null;
    const validUntil = typeof row.valid_until === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.valid_until)
      ? row.valid_until
      : null;
    byId.set(row.id, {
      id: row.id,
      full_name: textOrNull(row.full_name),
      module: textOrNull(row.module),
      access_reason: reason,
      valid_until: validUntil,
    });
  }
  return [...byId.values()]
    .sort((left, right) => (left.full_name || '').localeCompare(right.full_name || '', 'pt-BR'));
}

/**
 * O que aparece ao lado do nome quando o aluno não é da agenda do professor:
 * "cobertura até 28/09", "reposição até 28/09", "2º professor".
 */
export function plannerAccessNote(option: Pick<PlannerStudentOption, 'access_reason' | 'valid_until'>): string {
  const until = option.valid_until ? ` até ${plannerDayMonth(option.valid_until)}` : '';
  switch (option.access_reason) {
    case 'COVERAGE':
      return `cobertura${until}`;
    case 'RESCHEDULE':
      return `reposição${until}`;
    case 'SECOND_TEACHER':
      return '2º professor';
    default:
      return '';
  }
}
