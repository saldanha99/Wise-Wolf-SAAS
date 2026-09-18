/**
 * Cobertura e reposição na agenda do professor.
 *
 * Até 18/09/2026 a cobertura confirmada só aparecia em "Lançar Aula", depois
 * do horário — o substituto abria o Início e a Agenda e via tudo vazio (caso
 * da Teacher Bruna com três coberturas do Flávio). Estas funções são puras:
 * recebem as linhas que o navegador lê de `class_coverages` (com os joins de
 * aluno, agendamento e professores) e de `reschedules`, e devolvem itens
 * prontos para o "Aulas de Hoje" e para a grade semanal.
 *
 * ⚠️ A cobertura fica amarrada ao SLOT do agendamento (é o que identifica a
 * aula para o pagamento); o horário combinado com a família, quando diferente,
 * vai no motivo. Aqui ele é extraído só para exibição.
 */

export interface CoverageStudentRow {
  id: string;
  full_name: string | null;
  phone?: string | null;
  avatar_url?: string | null;
  module?: string | null;
  meeting_link?: string | null;
}

export interface CoverageAgendaRow {
  id: string;
  booking_id: string | null;
  class_date: string;
  class_time: string | null;
  status: string | null;
  notes: string | null;
  original_teacher_id: string;
  cover_teacher_id: string;
  student: CoverageStudentRow | null;
  original_teacher?: { full_name: string | null } | null;
  cover_teacher?: { full_name: string | null } | null;
}

export interface CoverageAgendaItem {
  coverageId: string;
  bookingId: string | null;
  classDate: string;
  /** Horário do slot do agendamento (HH:MM) — o da folha. */
  time: string;
  papel: 'assumida' | 'cedida';
  studentId: string | null;
  studentName: string;
  studentPhone: string | null;
  studentAvatar: string | null;
  studentModule: string | null;
  studentMeetingLink: string | null;
  /** Quem cedeu (para o substituto) ou quem assumiu (para quem cedeu). */
  otherTeacherName: string;
  notes: string | null;
  /** Horário combinado citado no motivo, quando difere do slot. */
  combinedTime: string | null;
}

export interface RescheduleAgendaRow {
  id: string;
  date: string | null;
  time: string | null;
  fault_type?: string | null;
  used_at?: string | null;
  student: CoverageStudentRow | null;
}

export interface RescheduleAgendaItem {
  rescheduleId: string;
  classDate: string;
  time: string;
  faultType: string | null;
  studentId: string | null;
  studentName: string;
  studentPhone: string | null;
  studentAvatar: string | null;
  studentModule: string | null;
  studentMeetingLink: string | null;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d/;

export const normalizeHHMM = (value: string | null | undefined): string | null => {
  const text = (value ?? '').trim();
  const m = HHMM.exec(text);
  return m ? text.slice(0, 5) : null;
};

/**
 * Primeiro horário citado no texto livre do motivo ("aula combinada para as
 * 18:00", "aula dada às 10h30"). Devolve null quando não há horário ou quando
 * ele é o próprio slot — aí não há nada a destacar.
 */
export const combinedTimeFromNotes = (notes: string | null | undefined, slotTime: string | null): string | null => {
  if (!notes) return null;
  const m = /(?<!\d)([01]?\d|2[0-3])\s*[:h]\s*([0-5]\d)(?!\d)/i.exec(notes);
  if (!m) return null;
  const found = `${m[1].padStart(2, '0')}:${m[2]}`;
  return found === slotTime ? null : found;
};

const avatarFor = (name: string): string => `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}`;

/** Itens de cobertura confirmada do professor, em ordem de data e slot. */
export function coverageAgendaItems(rows: CoverageAgendaRow[], teacherId: string): CoverageAgendaItem[] {
  const items: CoverageAgendaItem[] = [];
  for (const row of rows) {
    if ((row.status ?? '').toLowerCase() !== 'confirmed') continue;
    const time = normalizeHHMM(row.class_time);
    if (!time || !row.class_date) continue;
    const papel: 'assumida' | 'cedida' = row.original_teacher_id === teacherId ? 'cedida' : 'assumida';
    if (papel === 'assumida' && row.cover_teacher_id !== teacherId) continue;
    const other = papel === 'cedida' ? row.cover_teacher?.full_name : row.original_teacher?.full_name;
    const studentName = row.student?.full_name?.trim() || 'Aluno';
    items.push({
      coverageId: row.id,
      bookingId: row.booking_id,
      classDate: row.class_date,
      time,
      papel,
      studentId: row.student?.id ?? null,
      studentName,
      studentPhone: row.student?.phone ?? null,
      studentAvatar: row.student?.avatar_url || avatarFor(studentName),
      studentModule: row.student?.module ?? null,
      studentMeetingLink: row.student?.meeting_link ?? null,
      otherTeacherName: (other ?? '').trim(),
      notes: row.notes ?? null,
      combinedTime: combinedTimeFromNotes(row.notes, time),
    });
  }
  return items.sort((a, b) => `${a.classDate} ${a.time}`.localeCompare(`${b.classDate} ${b.time}`));
}

/** Reposições atribuídas ao professor com data e hora válidas (as "Pendente" ficam de fora). */
export function rescheduleAgendaItems(rows: RescheduleAgendaRow[]): RescheduleAgendaItem[] {
  const items: RescheduleAgendaItem[] = [];
  for (const row of rows) {
    if (row.used_at) continue;
    const time = normalizeHHMM(row.time);
    const date = (row.date ?? '').trim();
    if (!time || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const studentName = row.student?.full_name?.trim() || 'Reposição';
    items.push({
      rescheduleId: row.id,
      classDate: date,
      time,
      faultType: row.fault_type ?? null,
      studentId: row.student?.id ?? null,
      studentName,
      studentPhone: row.student?.phone ?? null,
      studentAvatar: row.student?.avatar_url || avatarFor(studentName),
      studentModule: row.student?.module ?? null,
      studentMeetingLink: row.student?.meeting_link ?? null,
    });
  }
  return items.sort((a, b) => `${a.classDate} ${a.time}`.localeCompare(`${b.classDate} ${b.time}`));
}

/**
 * Cobertura do dia ainda por acontecer: vale o horário combinado quando existe
 * (a aula das 16:30 na folha pode ter sido dada às 18:00), senão o slot.
 */
export const coverageDisplayTime = (item: Pick<CoverageAgendaItem, 'time' | 'combinedTime'>): string =>
  item.combinedTime ?? item.time;

/** Rótulo curto para a linha da aula: quem cedeu e o horário combinado, se houver. */
export const coverageCaption = (item: Pick<CoverageAgendaItem, 'otherTeacherName' | 'combinedTime' | 'time'>): string => {
  const parts: string[] = [];
  parts.push(item.otherTeacherName ? `Cobertura · aula de ${item.otherTeacherName.split(' ')[0]}` : 'Cobertura');
  if (item.combinedTime) parts.push(`combinado ${item.combinedTime} (slot ${item.time})`);
  return parts.join(' · ');
};

/** Datas (YYYY-MM-DD) a partir de `from`, inclusive, por `days` dias — só para janelas curtas. */
export function dateWindow(from: string, days: number): string[] {
  const [y, m, d] = from.split('-').map(Number);
  const out: string[] = [];
  for (let i = 0; i < days; i++) {
    const dt = new Date(y, m - 1, d + i);
    out.push(`${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`);
  }
  return out;
}
