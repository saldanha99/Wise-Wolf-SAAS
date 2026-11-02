// Regras puras da tela de Alunos (diretor e professor).
//
// A tela é a mesma para os dois papéis, mas o que cada um pode fazer não é:
// a direção vê todos os alunos da escola, o dinheiro e decide pausa/encerramento;
// o professor vê só quem ele atende, edita o pedagógico e troca o horário dos
// próprios alunos. Quem aplica a regra de verdade é o banco (RLS e RPCs); aqui
// a tela só deixa de oferecer o botão que o servidor recusaria.

export type RosterStage = 'active' | 'paused' | 'offboarded';

export type RosterSlot = { day: string; time: string };

export type RosterStudent = {
  id: string;
  name: string;
  levelBadge: string;
  status?: string | null;
  lifecycle_status?: string | null;
  status_financial?: string | null;
  professor_id?: string | null;
  assignedTeacherIds: string[];
  assignedTeachers: string[];
  scheduleSlots: RosterSlot[];
  fixed_schedule?: string | null;
};

export type RosterOverview = {
  risk_level?: string | null;
  risk_reasons?: string[] | null;
  attendance_rate?: number | null;
  days_since_last?: number | null;
  last_class_date?: string | null;
  overdue_count?: number | null;
  overdue_value?: number | null;
  has_activity?: boolean | null;
  attended_90?: number | null;
  absent_90?: number | null;
};

export type RosterRole = 'SCHOOL_ADMIN' | 'SUPER_ADMIN' | 'TEACHER' | string | undefined;

const INACTIVE_STATUS = ['Inativo', 'INACTIVE', 'Inactive', 'Arquivado', 'Cancelado', 'Trancado'];

/** Situação da matrícula: lifecycle_status é a fonte; status legado é o fallback. */
export function rosterStage(student: Pick<RosterStudent, 'status' | 'lifecycle_status' | 'status_financial'>): RosterStage {
  const lifecycle = String(student.lifecycle_status || '').trim().toLowerCase();
  if (lifecycle === 'offboarded') return 'offboarded';
  if (lifecycle === 'suspended') return 'paused';
  if (lifecycle && lifecycle !== 'active') return 'paused';
  if (INACTIVE_STATUS.includes(String(student.status || '')) || student.status_financial === 'ARCHIVED') return 'paused';
  return 'active';
}

export const isDirectorRole = (role: RosterRole) => role === 'SCHOOL_ADMIN' || role === 'SUPER_ADMIN';

/** O professor atende o aluno hoje: agenda viva com ele, ou titular sem agenda nenhuma. */
export function isTeacherOf(student: Pick<RosterStudent, 'assignedTeacherIds' | 'professor_id'>, teacherId?: string | null): boolean {
  if (!teacherId) return false;
  const ids = student.assignedTeacherIds || [];
  return ids.includes(teacherId) || (ids.length === 0 && student.professor_id === teacherId);
}

export type RosterPermissions = {
  /** Abre o formulário de cadastro (o professor só grava o pedagógico). */
  canEdit: boolean;
  /** Pausar, reativar e encerrar: só a direção, pelo fluxo oficial com o Asaas. */
  canManageLifecycle: boolean;
  /** Mensalidade e atraso: só a direção. */
  canSeeMoney: boolean;
  /** Troca de horário do próprio aluno (a direção usa o Mapa de Aulas). */
  canChangeSchedule: boolean;
  /** Criar aluno: create-student-account só aceita a direção. */
  canCreate: boolean;
};

export function rosterPermissions(role: RosterRole, userId: string | undefined, student?: RosterStudent): RosterPermissions {
  const director = isDirectorRole(role);
  const mine = role === 'TEACHER' && !!student && isTeacherOf(student, userId);
  return {
    canEdit: director || mine,
    canManageLifecycle: director,
    canSeeMoney: director,
    canChangeSchedule: mine,
    canCreate: director,
  };
}

export type QuickFilter = 'ACTIVE' | 'ATTENTION' | 'IDLE' | 'OVERDUE' | 'NO_SCHEDULE' | 'PAUSED' | 'OFFBOARDED' | 'ALL';

/** Aluno que pede ação: risco calculado pelo servidor. */
export const needsAttention = (ov?: RosterOverview) => !!ov && !!ov.risk_level && ov.risk_level !== 'LOW';
/** Sem aula lançada há mais de 30 dias. */
export const isIdle = (ov?: RosterOverview) => !!ov && ov.days_since_last != null && ov.days_since_last > 30;

export function matchesQuickFilter(student: RosterStudent, ov: RosterOverview | undefined, filter: QuickFilter): boolean {
  const stage = rosterStage(student);
  switch (filter) {
    case 'ALL': return true;
    case 'ACTIVE': return stage === 'active';
    case 'PAUSED': return stage === 'paused';
    case 'OFFBOARDED': return stage === 'offboarded';
    case 'ATTENTION': return stage === 'active' && needsAttention(ov);
    case 'IDLE': return stage === 'active' && isIdle(ov);
    case 'OVERDUE': return (ov?.overdue_count || 0) > 0;
    case 'NO_SCHEDULE': return stage === 'active' && student.scheduleSlots.length === 0;
  }
}

export type QuickFilterOption = { id: QuickFilter; label: string; hint: string; count: number; tone: 'blue' | 'rose' | 'amber' | 'orange' | 'slate' | 'red' | 'violet' };

/**
 * Os atalhos do topo: cada um é um filtro e mostra quantos alunos cabem nele.
 * Atraso, pausa e encerramento são da direção: o professor nem recebe esses
 * alunos do banco (a leitura de perfis só abre matrícula ativa).
 */
export function quickFilterOptions(
  students: RosterStudent[],
  overviewMap: Record<string, RosterOverview | undefined>,
  forDirection: boolean,
): QuickFilterOption[] {
  const count = (f: QuickFilter) => students.filter(s => matchesQuickFilter(s, overviewMap[s.id], f)).length;
  const options: QuickFilterOption[] = [
    { id: 'ACTIVE', label: 'Ativos', hint: 'Matrícula em andamento', count: count('ACTIVE'), tone: 'blue' },
    { id: 'ATTENTION', label: 'Precisam de atenção', hint: 'Faltas seguidas, frequência baixa ou saída pedida', count: count('ATTENTION'), tone: 'rose' },
    { id: 'IDLE', label: 'Sem aula há 30+ dias', hint: 'Nenhuma aula lançada no último mês', count: count('IDLE'), tone: 'orange' },
    { id: 'NO_SCHEDULE', label: 'Sem horário fixo', hint: 'Ativos sem aula na agenda', count: count('NO_SCHEDULE'), tone: 'violet' },
  ];
  if (!forDirection) return options;
  options.push(
    { id: 'OVERDUE', label: 'Com atraso', hint: 'Mensalidade vencida', count: count('OVERDUE'), tone: 'red' },
    { id: 'PAUSED', label: 'Em pausa', hint: 'Pausa temporária e reversível', count: count('PAUSED'), tone: 'amber' },
    { id: 'OFFBOARDED', label: 'Encerrados', hint: 'Saída definitiva; histórico preservado', count: count('OFFBOARDED'), tone: 'slate' },
  );
  return options;
}

/**
 * Motivos legíveis do alerta. Professor não recebe o motivo financeiro — o
 * servidor já não manda, e a tela também não repete.
 */
export function attentionReasons(ov: RosterOverview | undefined, canSeeMoney: boolean): string[] {
  if (!ov) return [];
  const reasons = (ov.risk_reasons || []).filter(Boolean);
  return canSeeMoney ? reasons : reasons.filter(r => !/pagamento|atraso|mensalidade/i.test(r));
}

export type RosterSort = 'PRIORITY' | 'NAME' | 'LAST_CLASS';

const RISK_WEIGHT: Record<string, number> = { HIGH: 2, MEDIUM: 1 };

export function sortRoster(
  students: RosterStudent[],
  overviewMap: Record<string, RosterOverview | undefined>,
  sort: RosterSort,
): RosterStudent[] {
  const byName = (a: RosterStudent, b: RosterStudent) => a.name.localeCompare(b.name, 'pt-BR');
  const stageWeight: Record<RosterStage, number> = { active: 0, paused: 1, offboarded: 2 };
  return [...students].sort((a, b) => {
    const stage = stageWeight[rosterStage(a)] - stageWeight[rosterStage(b)];
    if (stage !== 0) return stage;
    const oa = overviewMap[a.id];
    const ob = overviewMap[b.id];
    if (sort === 'PRIORITY') {
      const risk = (RISK_WEIGHT[ob?.risk_level || ''] || 0) - (RISK_WEIGHT[oa?.risk_level || ''] || 0);
      if (risk !== 0) return risk;
    }
    if (sort !== 'NAME') {
      // Mais tempo sem aula primeiro; aluno sem aula nenhuma vai para o fim.
      const da = oa?.days_since_last ?? -1;
      const db = ob?.days_since_last ?? -1;
      if (da !== db) return db - da;
    }
    return byName(a, b);
  });
}

const DAY_ORDER = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];
const DAY_SHORT: Record<string, string> = {
  Segunda: 'Seg', 'Terça': 'Ter', Terca: 'Ter', Quarta: 'Qua', Quinta: 'Qui',
  Sexta: 'Sex', 'Sábado': 'Sáb', Sabado: 'Sáb', Domingo: 'Dom',
};

/** Agenda fixa a partir dos agendamentos vivos: um chip por dia e horário, sem repetição. */
export function scheduleSlotsFromBookings(bookings: Array<{ day_of_week?: string | null; time_slot?: string | null }>): RosterSlot[] {
  const seen = new Set<string>();
  const slots: RosterSlot[] = [];
  for (const booking of bookings) {
    const day = DAY_SHORT[String(booking.day_of_week || '').trim()];
    const time = String(booking.time_slot || '').slice(0, 5);
    if (!day || !time) continue;
    const key = `${day} ${time}`;
    if (seen.has(key)) continue;
    seen.add(key);
    slots.push({ day, time });
  }
  return slots.sort((a, b) => DAY_ORDER.indexOf(a.day) - DAY_ORDER.indexOf(b.day) || a.time.localeCompare(b.time));
}

/** "Seg/Qua · 10:00" quando o horário é o mesmo; senão "Seg 10:00 · Qua 19:00". */
export function scheduleLabel(slots: RosterSlot[]): string {
  if (slots.length === 0) return '';
  const times = Array.from(new Set(slots.map(s => s.time)));
  if (times.length === 1) return `${Array.from(new Set(slots.map(s => s.day))).join('/')} · ${times[0]}`;
  return slots.map(s => `${s.day} ${s.time}`).join(' · ');
}

/** "há 3 dias", "ontem", "hoje" — texto do último contato em aula. */
export function lastClassLabel(days: number | null | undefined): string {
  if (days == null) return 'Sem aula lançada';
  if (days <= 0) return 'Aula hoje';
  if (days === 1) return 'Última aula ontem';
  return `Última aula há ${days} dias`;
}

export const initialsOf = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0]?.toUpperCase() || '').join('') || '?';
