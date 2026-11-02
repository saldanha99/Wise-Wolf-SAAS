export const HISTORY_CATEGORIES = {
  COMPLETED: 'Aulas realizadas', MAKEUP_COMPLETED: 'Reposições realizadas',
  STUDENT_ABSENCE: 'Faltas dos alunos', TEACHER_ABSENCE: 'Faltas do teacher',
  TEACHER_CANCELLED: 'Cancelamentos pelo teacher', HOLIDAY: 'Feriados',
  UNFINALIZED: 'Registros não finalizados', SCHEDULED: 'Aulas futuras',
  CANCELLED: 'Canceladas (responsável não informado)', EXCLUDED: 'Excluídas da agenda (motivo registrado)',
  REMOVED: 'Lançamentos removidos com trilha', REASSIGNED: 'Lançamentos reatribuídos a outro teacher',
} as const;
export type HistoryCategory = keyof typeof HISTORY_CATEGORIES;
export interface HistoryDispute { id: string; description: string; opened_at: string; opened_by: string | null; resolution: string | null; resolved_at: string | null; resolved_by: string | null; }
export interface HistoryRow {
  key: string; source_type: string; source_id: string; student_id: string | null; student_name: string;
  class_date: string; start_time: string | null; category: HistoryCategory; reason: string | null; notes: string | null;
  created_at: string | null; created_by?: string | null; last_changed_at: string | null; last_changed_by: string | null; version: number;
  class_log_id: string | null; booking_id: string | null; reschedule_id: string | null; appointment_id: string | null;
  disputes: HistoryDispute[];
}
export interface HistoryEvent { id: string; source_type: string; source_id: string; action: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null; actor: string | null; created_at: string; reason: string | null; }
export interface HistoryData {
  teacher_id: string; teacher_name: string; from: string; to: string; all_service: boolean; generated_at: string;
  rows: HistoryRow[]; totals: Partial<Record<HistoryCategory, number>>;
  backlog: { id: string; student_id: string | null; student_name: string | null; date: string | null; time: string | null; fault_type: string | null; created_at: string }[];
  students: { id: string; name: string; currently_linked: boolean; last_activity: string | null }[];
  events: HistoryEvent[];
}
export function historyEventsFor(row: HistoryRow, events: HistoryEvent[]): HistoryEvent[] {
  return events.filter(e => (e.source_type === row.source_type && e.source_id === row.source_id)
    || (['bookings', 'booking_schedule_versions', 'booking_occurrence_exclusions'].includes(e.source_type) && e.source_id === row.booking_id)
    || (e.source_type === 'reschedules' && e.source_id === row.reschedule_id)
    || (e.source_type === 'appointments' && e.source_id === row.appointment_id));
}
export function historyDate(value: string | null, time = false): string {
  if (!value) return 'Não disponível';
  const d = new Date(value.length === 10 ? `${value}T12:00:00-03:00` : value);
  if (!Number.isFinite(d.getTime())) return 'Não disponível';
  return time ? d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}
const escape = (v: unknown) => String(v ?? '—').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export function lessonHistoryReport(data: HistoryData): string {
  const title = data.all_service ? 'Conferência de encerramento da prestação' : 'Histórico de aulas';
  const table = (head: string[], rows: unknown[][]) => `<table><thead><tr>${head.map(h => `<th>${escape(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(v => `<td>${escape(v)}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${head.length}">Sem registros</td></tr>`}</tbody></table>`;
  return `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>${escape(title)} — ${escape(data.teacher_name)}</title><style>body{font:14px Arial,sans-serif;color:#182334;margin:32px}table{border-collapse:collapse;width:100%;margin:16px 0;font-size:12px}td,th{border:1px solid #cbd5e1;padding:8px;text-align:left;white-space:pre-wrap;overflow-wrap:anywhere}th{background:#eef2f6}h2{margin-top:28px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px}article{break-inside:avoid;border:1px solid #cbd5e1;padding:12px;margin:12px 0}@media print{body{margin:12mm}thead{display:table-header-group}}</style><body>
  <h1>${escape(title)}</h1><p>Teacher: ${escape(data.teacher_name)} · ${escape(historyDate(data.from))} a ${escape(historyDate(data.to))}</p>
  <p>Gerado em ${escape(historyDate(data.generated_at, true))}. As aulas são unidades de 30 minutos; uma aula de uma hora pode ter dois registros. Este relatório não conclui o encerramento nem altera remuneração.</p>
  <h2>Totais conferíveis pelas linhas abaixo</h2>${table(['Categoria', 'Quantidade'], Object.entries(HISTORY_CATEGORIES).map(([key, label]) => [label, data.totals[key as HistoryCategory] || 0]))}
  <h2>Alunos vinculados durante a prestação</h2>${table(['Aluno', 'Vínculo atual', 'Última atividade registrada'], data.students.map(s => [s.name, s.currently_linked ? 'Atual' : 'Histórico', historyDate(s.last_activity)]))}
  <h2>Aulas</h2>${table(['Referência', 'Data / horário', 'Aluno', 'Situação', 'Motivo / observações', 'Criação', 'Última alteração / responsável'], data.rows.map(r => [r.key, `${historyDate(r.class_date)} ${r.start_time?.slice(0, 5) || 'Horário não disponível'}`, r.student_name, HISTORY_CATEGORIES[r.category] || r.category, `${r.reason || ''}\n${r.notes || ''}`, `${historyDate(r.created_at, true)} · ${r.created_by || 'Autoria não disponível'}`, `${historyDate(r.last_changed_at, true)} · ${r.last_changed_by || 'Responsável não disponível'}`]))}
  <h2>Reposições pendentes da carteira inteira</h2><p>Passivo atual, inclusive sem data ou de origem anterior ao período. Não somado novamente aos totais de aulas.</p>${table(['Referência', 'Aluno', 'Data / horário', 'Origem da falta'], data.backlog.map(r => [r.id, r.student_name, r.date ? `${historyDate(r.date)} ${r.time || ''}` : 'Falta agendar', r.fault_type || 'Não informada']))}
  <h2>Contestações e resoluções</h2>${data.rows.flatMap(r => r.disputes.map(d => `<article><b>${escape(r.key)}</b><p>${escape(d.description)} · ${escape(d.opened_by)} · ${escape(historyDate(d.opened_at, true))}</p><p>${escape(d.resolution || 'Aguardando resolução')} · ${escape(d.resolved_by)} · ${escape(historyDate(d.resolved_at, true))}</p></article>`)).join('') || '<p>Sem contestações.</p>'}
  <h2>Trilha de alterações</h2><p>A trilha começa na implantação deste módulo. Registros legados não possuem autoria ou alterações anteriores recuperáveis.</p>${data.events.map(e => `<article><b>${escape(e.action)} · ${escape(e.source_type)}:${escape(e.source_id)}</b><p>${escape(historyDate(e.created_at, true))} · ${escape(e.actor || 'Sistema / autoria não disponível')} · ${escape(e.reason)}</p><pre>Anterior: ${escape(JSON.stringify(e.before, null, 2))}\nAtual: ${escape(JSON.stringify(e.after, null, 2))}</pre></article>`).join('') || '<p>Sem alterações disponíveis.</p>'}
  <p>Uso restrito ao teacher e à coordenação autorizada. Arquive em local protegido conforme a política da escola.</p></body></html>`;
}
