export type TeacherLifecycle = 'active' | 'suspended' | 'offboarded';
export type TeacherListView = 'active' | 'inactive';

export interface TeacherListItem {
  id: string;
  name: string;
  email: string;
  status?: string;
  lifecycle_status?: TeacherLifecycle;
}

export const getTeacherLifecycle = (
  teacher: TeacherListItem,
  override?: string,
): TeacherLifecycle => {
  if (override === 'active' || override === 'suspended' || override === 'offboarded') {
    return override;
  }
  if (teacher.lifecycle_status) return teacher.lifecycle_status;
  return ['Inativo', 'INACTIVE', 'Inactive'].includes(teacher.status || '')
    ? 'suspended'
    : 'active';
};

export const filterTeachersByView = <T extends TeacherListItem>(
  teachers: T[],
  view: TeacherListView,
  searchTerm: string,
  lifecycleById: Record<string, string> = {},
): T[] => {
  const query = searchTerm.trim().toLocaleLowerCase('pt-BR');
  return teachers.filter((teacher) => {
    const lifecycle = getTeacherLifecycle(teacher, lifecycleById[teacher.id]);
    const belongsToView = view === 'active'
      ? lifecycle === 'active'
      : lifecycle === 'suspended' || lifecycle === 'offboarded';
    if (!belongsToView) return false;
    if (!query) return true;
    return teacher.name.toLocaleLowerCase('pt-BR').includes(query)
      || teacher.email.toLocaleLowerCase('pt-BR').includes(query);
  });
};

const DAY_MS = 86_400_000;

export const calculateDaysWithoutAbsence = (
  createdAt?: string | null,
  lastAbsenceAt?: string | null,
  now: Date = new Date(),
): number | null => {
  const baseline = lastAbsenceAt || createdAt;
  if (!baseline) return null;
  const baselineDate = new Date(baseline);
  if (Number.isNaN(baselineDate.getTime())) return null;
  const utcToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const utcBaseline = Date.UTC(
    baselineDate.getUTCFullYear(),
    baselineDate.getUTCMonth(),
    baselineDate.getUTCDate(),
  );
  return Math.max(0, Math.floor((utcToday - utcBaseline) / DAY_MS));
};

export interface TeacherStreakDetails {
  consecutiveDays: number;
  isEligibleForTurbo: boolean;
  daysRemainingForTurbo: number;
  turboProgressPct: number;
  hasAbsenceReset: boolean;
}

export interface TeacherTurboStatusInput {
  studentsActive: number;
  studentsRequired?: number;
  studentsMissing?: number;
  turboActive?: boolean | null;
  blockedBy?: string | null;
  streak: TeacherStreakDetails;
}

export type TeacherTurboStatusKind = 'active' | 'portfolio' | 'blocked' | 'unavailable';

export interface TeacherTurboStatus {
  kind: TeacherTurboStatusKind;
  label: string;
  reason: string;
}

const TURBO_BLOCK_REASONS: Record<string, string> = {
  falta_neste_mes: 'Falta registrada neste mês',
  falta_mes_passado: 'Falta registrada no mês passado',
  conflito: 'Há conflito de lançamento pendente',
  sem_aula_lancada_no_mes: 'Sem aula lançada neste mês',
};

export const getTeacherTurboStatus = ({
  studentsActive,
  studentsRequired = 10,
  studentsMissing,
  turboActive,
  blockedBy,
}: TeacherTurboStatusInput): TeacherTurboStatus => {
  if (turboActive === true) {
    return {
      kind: 'active',
      label: 'Ligado',
      reason: `${studentsActive} ${studentsActive === 1 ? 'aluno ativo' : 'alunos ativos'}`,
    };
  }

  const missing = studentsMissing ?? Math.max(0, studentsRequired - studentsActive);
  if (studentsActive < studentsRequired || blockedBy === 'carteira') {
    return {
      kind: 'portfolio',
      label: 'Carteira insuficiente',
      reason: `Faltam ${missing} ${missing === 1 ? 'aluno' : 'alunos'} para ativar`,
    };
  }

  if (turboActive === false) {
    return {
      kind: 'blocked',
      label: 'Desligado',
      reason: blockedBy ? (TURBO_BLOCK_REASONS[blockedBy] || `Bloqueio: ${blockedBy}`) : 'Aguardando os critérios do mês',
    };
  }

  return {
    kind: 'unavailable',
    label: 'Não verificado',
    reason: 'Status autoritativo indisponível',
  };
};

export const calculateTeacherStreak = (
  createdAt?: string | null,
  lastAbsenceAt?: string | null,
  now: Date = new Date(),
  targetDays = 30,
): TeacherStreakDetails => {
  const days = calculateDaysWithoutAbsence(createdAt, lastAbsenceAt, now) ?? 0;
  const hasAbsenceReset = Boolean(lastAbsenceAt);
  const isEligibleForTurbo = days >= targetDays;
  const daysRemainingForTurbo = Math.max(0, targetDays - days);
  const turboProgressPct = Math.min(100, Math.round((days / targetDays) * 100));

  return {
    consecutiveDays: days,
    isEligibleForTurbo,
    daysRemainingForTurbo,
    turboProgressPct,
    hasAbsenceReset,
  };
};
