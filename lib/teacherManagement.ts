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
