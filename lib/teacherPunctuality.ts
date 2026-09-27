// Extrato de pontualidade do professor (migration 20260928120000). Puro, sem
// Supabase: a aba da Central de Qualidade, o cartão do professor e os testes
// usam direto.
//
// Regra da direção e do termo v3 do professor: sem nota, sem ranking e sem
// comparação entre professores; não altera o pagamento. Nada aqui soma, ordena
// ou compara professores — é o extrato de UM professor num mês.

export type PunctualityStatus = 'FOUND' | 'NOT_FOUND' | 'UNPARSED' | 'NO_CONFERENCE' | 'NO_ROOM';

export interface PunctualityLesson {
  class_date: string;
  scheduled_start_at: string;
  scheduled_minutes: number;
  first_join_at: string | null;
  late_minutes: number | null;
  minutes_in_room: number | null;
  left_early_minutes: number | null;
  status: PunctualityStatus | string;
}

export interface PunctualitySummary {
  planned: number;
  in_school_room: number;
  measured: number;
  on_time: number;
  late_5: number;
  late_10: number;
  not_in_report: number;
  joined_after_end: number;
  minutes_in_room: number;
  scheduled_minutes: number;
  left_early: number;
  not_measured: Partial<Record<Exclude<PunctualityStatus, 'FOUND'>, number>>;
}

export interface PunctualityExtract {
  month: string;
  summary: PunctualitySummary;
  lessons: PunctualityLesson[];
}

/** Resposta de get_my_punctuality_extract: desligado não traz mais nada. */
export type MyPunctualityResponse =
  | { ok: true; enabled: false }
  | ({ ok: true; enabled: true } & PunctualityExtract);

/** Resposta de get_teacher_punctuality_extract (direção e coordenação). */
export type TeacherPunctualityResponse =
  | { ok: true; enabled: false }
  | {
    ok: true;
    enabled: true;
    enabled_at: string;
    teachers: { id: string; name: string | null }[];
    teacher_id: string | null;
    extract: PunctualityExtract | null;
  };

/** Por que a aula ficou sem medição (o professor e a direção leem o motivo). */
export const NOT_MEASURED_LABELS: Record<Exclude<PunctualityStatus, 'FOUND'>, string> = {
  NOT_FOUND: 'Relatório de presença não encontrado',
  UNPARSED: 'Relatório de presença ilegível',
  NO_CONFERENCE: 'A sala da escola não foi aberta',
  NO_ROOM: 'Aula sem sala da escola (link de sempre)',
};

const timeBr = (iso: string) =>
  new Date(iso).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });

const dateBr = (isoDate: string) => {
  const [year, month, day] = isoDate.slice(0, 10).split('-');
  return year && month && day ? `${day}/${month}` : isoDate;
};

const minutes = (value: number) => (value === 1 ? '1 min' : `${value} min`);

/** "set/2026" → para o cabeçalho do extrato. */
export function monthLabel(month: string): string {
  const [year, monthNumber] = month.split('-').map(Number);
  if (!year || !monthNumber) return month;
  return new Date(Date.UTC(year, monthNumber - 1, 15)).toLocaleDateString('pt-BR', {
    timeZone: 'UTC', month: 'long', year: 'numeric',
  });
}

/** Mês atual (fuso da escola) no formato do <input type="month">. */
export function currentMonthInput(now: Date = new Date()): string {
  return now.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }).slice(0, 7);
}

/** "2026-09" → "2026-09-01", o que a RPC recebe. */
export function monthParam(monthInput: string): string | null {
  return /^\d{4}-\d{2}$/.test(monthInput) ? `${monthInput}-01` : null;
}

/**
 * Uma linha da aula, só com o horário do professor. `viewer` muda só a pessoa
 * do verbo ("você" no painel do professor, "o professor" na Central).
 */
export function lessonLine(
  lesson: PunctualityLesson,
  viewer: 'teacher' | 'school' = 'teacher',
): { when: string; detail: string } {
  const when = `${dateBr(lesson.class_date)} · ${timeBr(lesson.scheduled_start_at)} (${minutes(lesson.scheduled_minutes)})`;
  if (lesson.status !== 'FOUND') {
    return { when, detail: NOT_MEASURED_LABELS[lesson.status as Exclude<PunctualityStatus, 'FOUND'>] || 'Sem medição' };
  }
  if (!lesson.first_join_at) {
    return {
      when,
      detail: viewer === 'teacher'
        ? 'Você não aparece no relatório de presença desta aula'
        : 'O professor não aparece no relatório de presença desta aula',
    };
  }
  const joined = `Entrou às ${timeBr(lesson.first_join_at)}`;
  const inRoom = lesson.minutes_in_room != null ? ` · ${minutes(lesson.minutes_in_room)} na sala` : '';
  if (lesson.late_minutes == null) {
    return { when, detail: `${joined}, depois do fim previsto (aula remarcada no dia?)${inRoom}` };
  }
  const late = lesson.late_minutes < 1 ? 'no horário' : lesson.late_minutes < 5
    ? `${minutes(lesson.late_minutes)} depois do início`
    : `${minutes(lesson.late_minutes)} de atraso`;
  const leftEarly = lesson.left_early_minutes && lesson.left_early_minutes >= 5
    ? ` · saiu ${minutes(lesson.left_early_minutes)} antes do fim`
    : '';
  return { when, detail: `${joined} (${late})${inRoom}${leftEarly}` };
}

/** Quadro do resumo, na ordem em que a tela mostra. Sem nota nem média. */
export function summaryItems(summary: PunctualitySummary): { key: string; label: string; value: string }[] {
  return [
    { key: 'planned', label: 'Aulas no mês', value: String(summary.planned) },
    { key: 'in_school_room', label: 'Na sala da escola', value: String(summary.in_school_room) },
    { key: 'measured', label: 'Com horário medido', value: String(summary.measured) },
    { key: 'on_time', label: 'Entrou no horário (até 4 min)', value: String(summary.on_time) },
    { key: 'late_5', label: 'Entrou 5 min ou mais depois', value: String(summary.late_5) },
    { key: 'late_10', label: 'Entrou 10 min ou mais depois', value: String(summary.late_10) },
    {
      key: 'minutes',
      label: 'Minutos na sala / previstos (aulas medidas)',
      value: `${summary.minutes_in_room} / ${summary.scheduled_minutes}`,
    },
    { key: 'left_early', label: 'Saiu 5 min ou mais antes do fim', value: String(summary.left_early) },
  ];
}

/** Aulas sem horário medido, com o motivo; zero não aparece. */
export function notMeasuredItems(summary: PunctualitySummary): { status: string; label: string; count: number }[] {
  const items: { status: string; label: string; count: number }[] =
    (Object.keys(NOT_MEASURED_LABELS) as Exclude<PunctualityStatus, 'FOUND'>[])
      .map(status => ({ status, label: NOT_MEASURED_LABELS[status], count: Number(summary.not_measured?.[status] || 0) }));
  if (summary.not_in_report) {
    items.push({ status: 'NOT_IN_REPORT', label: 'Relatório lido, sem o professor nele', count: summary.not_in_report });
  }
  if (summary.joined_after_end) {
    items.push({ status: 'JOINED_AFTER_END', label: 'Entrou depois do fim previsto (não conta como atraso)', count: summary.joined_after_end });
  }
  return items.filter(item => item.count > 0);
}

/**
 * Rótulo do caso na Central de Qualidade. LATE_START aberto pelo sistema vem do
 * relatório de presença do Meet — não é relato da família.
 */
export function qualityCaseLabel(category: string, source: string | null | undefined, labels: Record<string, string>): string {
  if (category === 'LATE_START' && source === 'SYSTEM') return 'Atraso detectado pelo Meet';
  return labels[category] || category;
}
