import type { Teacher } from '../types';

export type TeacherLifecycle = NonNullable<Teacher['lifecycle_status']>;
export type TeacherListView = 'active' | 'inactive';

export type TeacherOrganizationSnapshot = {
  enabled: boolean;
  currentStreak: number;
};

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonNegativeInteger = (value: unknown): number | null => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : null;
};

export const effectiveTeacherLifecycle = (
  teacher: Pick<Teacher, 'lifecycle_status'>,
  optimisticLifecycle?: TeacherLifecycle,
): TeacherLifecycle => optimisticLifecycle ?? teacher.lifecycle_status ?? 'active';

export const teacherMatchesListView = (
  teacher: Pick<Teacher, 'lifecycle_status'>,
  view: TeacherListView,
  optimisticLifecycle?: TeacherLifecycle,
): boolean => {
  const lifecycle = effectiveTeacherLifecycle(teacher, optimisticLifecycle);
  return view === 'active' ? lifecycle === 'active' : lifecycle !== 'active';
};

export const parseTeacherOrganizationSnapshot = (
  data: unknown,
): TeacherOrganizationSnapshot | null => {
  const candidate = Array.isArray(data) ? data[0] : data;
  if (!isRecord(candidate) || typeof candidate.active !== 'boolean') return null;

  // `current_streak` é o contrato novo. `days_clean` mantém a tela compatível
  // durante a janela entre o frontend e a migration chegarem ao ambiente.
  const currentStreak = nonNegativeInteger(
    candidate.current_streak ?? candidate.days_clean,
  );
  if (currentStreak === null) return null;

  return {
    enabled: candidate.active,
    currentStreak,
  };
};
