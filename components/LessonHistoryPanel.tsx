import React, { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { localMonth } from '../lib/dateUtils';
import { HISTORY_CATEGORIES, historyDate, historyEventsFor, lessonHistoryReport, type HistoryCategory, type HistoryData, type HistoryRow } from '../lib/lessonHistory';

interface Props { user: { id: string; role?: string }; initialStudentId?: string; teacherId?: string; }
const field = 'rounded-xl border border-brand-border bg-brand-surface px-3 py-2 text-brand-text min-w-0';
const button = 'rounded-xl border border-brand-border px-3 py-2 text-sm font-bold disabled:opacity-40';
const monthBounds = (m: string) => { const [y, n] = m.split('-').map(Number); return { from: `${m}-01`, to: `${m}-${new Date(y, n, 0).getDate()}` }; };
const failure = (e: unknown) => {
  const m = e && typeof e === 'object' && 'message' in e ? String(e.message) : '';
  if (m.includes('history_version_conflict')) return 'Outra pessoa corrigiu este registro. Atualize e confira antes de salvar novamente.';
  if (m.includes('history_one_open') || m.includes('duplicate key')) return 'Já existe uma contestação aberta para esta aula.';
  return 'Não foi possível concluir. Confira o acesso, o período e os dados e tente novamente.';
};

export default function LessonHistoryPanel({ user, initialStudentId, teacherId }: Props) {
  const manager = user.role === 'SCHOOL_ADMIN' || user.role === 'COORDINATOR';
  const [teachers, setTeachers] = useState<{ id: string; name: string; lifecycle: string }[]>([]);
  const [teacher, setTeacher] = useState(teacherId || (manager ? '' : user.id));
  const [month, setMonth] = useState(localMonth());
  const [period, setPeriod] = useState<'month' | 'custom' | 'all'>('month');
  const [dates, setDates] = useState(monthBounds(localMonth()));
  const [student, setStudent] = useState(initialStudentId || '');
  const [category, setCategory] = useState<HistoryCategory | ''>('');
  const [data, setData] = useState<HistoryData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<HistoryRow | null>(null);
  const [action, setAction] = useState<'correction' | 'dispute' | 'resolve' | null>(null);
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [classification, setClassification] = useState('');
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  useEffect(() => {
    if (!manager || teacherId) return;
    let active = true;
    supabase.rpc('list_lesson_history_teachers').then(({ data: roster, error: err }) => {
      if (!active) return;
      if (err) { setError('Não foi possível consultar os teachers.'); return; }
      const list = (roster || []) as typeof teachers;
      setTeachers(list); setTeacher(list[0]?.id || '');
    });
    return () => { active = false; };
  }, [manager, teacherId]);
  useEffect(() => {
    const token = ++request.current;
    setData(null); setSelected(null); setAction(null); setError('');
    if (!teacher) return;
    const range = period === 'month' ? monthBounds(month) : dates;
    if (period !== 'all' && (!range.from || !range.to || range.to < range.from)) { setError('Informe um intervalo válido.'); return; }
    setLoading(true);
    supabase.rpc('get_teacher_lesson_history', { p_teacher: teacher, p_from: period === 'all' ? null : range.from, p_to: period === 'all' ? null : range.to, p_student: initialStudentId || null }).then(({ data: result, error: err }) => {
      if (token !== request.current) return;
      setLoading(false);
      if (err || !result || result.error) setError(failure(err));
      else setData(result as HistoryData);
    });
    return () => { request.current++; };
  }, [teacher, month, dates.from, dates.to, period, revision, initialStudentId]);
  const rows = (data?.rows || []).filter(r => (!student || r.student_id === student) && (!category || r.category === category));
  const totals = (data?.rows || []).filter(r => !student || r.student_id === student).reduce<Partial<Record<HistoryCategory, number>>>((acc, r) => { acc[r.category] = (acc[r.category] || 0) + 1; return acc; }, {});
  const filteredReport = (): HistoryData | null => data ? { ...data, rows, totals: rows.reduce<Partial<Record<HistoryCategory, number>>>((acc, r) => { acc[r.category] = (acc[r.category] || 0) + 1; return acc; }, {}), students: data.students.filter(s => !student || s.id === student), backlog: data.backlog.filter(r => !student || r.student_id === student), events: data.events.filter(e => (e.action === 'DELETE' && (!student || e.before?.student_id === student)) || rows.some(r => historyEventsFor(r, [e]).length) || (e.source_type === 'reschedules' && data.backlog.some(r => (!student || r.student_id === student) && r.id === e.source_id))) } : null;
  const report = (print: boolean) => {
    const result = filteredReport(); if (!result) return;
    const html = lessonHistoryReport(result);
    if (!print) {
      const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
      const a = document.createElement('a'); a.href = url; a.download = `historico-aulas-${teacher}-${result.from}-${result.to}.html`; a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000); return;
    }
    const frame = document.createElement('iframe'); frame.title = 'Relatório de histórico de aulas'; frame.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0'; document.body.appendChild(frame);
    if (!frame.contentDocument || !frame.contentWindow) { frame.remove(); setError('Não foi possível preparar a impressão.'); return; }
    const win = frame.contentWindow; win.onafterprint = () => frame.remove(); frame.contentDocument.open(); frame.contentDocument.write(html); frame.contentDocument.close();
    window.setTimeout(() => { try { win.focus(); win.print(); } catch { setError('Não foi possível abrir a impressão. Baixe o relatório.'); } window.setTimeout(() => frame.remove(), 60000); }, 100);
  };
  const startAction = (value: typeof action) => { setAction(value); setReason(''); setNotes(selected?.notes || ''); setClassification(['HOLIDAY', 'TEACHER_CANCELLED'].includes(selected?.category || '') ? selected!.category : ''); };
  const submit = async () => {
    if (!selected || reason.trim().length < 10) return;
    setBusy(true); setError('');
    try {
      let err;
      if (action === 'correction') ({ error: err } = await supabase.rpc('correct_lesson_history', { p_teacher: teacher, p_source_type: selected.source_type, p_source_id: selected.source_id, p_date: selected.class_date, p_expected_version: selected.version, p_notes: notes, p_reason: reason, p_classification: classification || null }));
      else if (action === 'resolve') ({ error: err } = await supabase.rpc('resolve_lesson_history_dispute', { p_id: selected.disputes.find(d => !d.resolved_at)?.id, p_resolution: reason }));
      else ({ error: err } = await supabase.rpc('open_lesson_history_dispute', { p_teacher: teacher, p_source_type: selected.source_type, p_source_id: selected.source_id, p_date: selected.class_date, p_description: reason }));
      if (err) throw err;
      setAction(null); setSelected(null); setRevision(n => n + 1);
    } catch (err) { setError(failure(err)); } finally { setBusy(false); }
  };
  return <section className="space-y-4 text-brand-text" data-tour="lesson-history-panel">
    <div><h2 className="text-xl font-bold">Histórico de aulas</h2><p className="text-sm text-brand-muted">Consulta da prestação, totais por categoria e trilha de alterações. Cada registro corresponde a uma unidade de 30 minutos.</p></div>
    <div className="flex flex-wrap gap-2" data-tour="lesson-history-filters">
      {manager && !teacherId && <label className="flex flex-col text-xs gap-1">Teacher<select aria-label="Teacher" className={field} value={teacher} onChange={e => { setTeacher(e.target.value); setStudent(initialStudentId || ''); }}><option value="">Selecione</option>{teachers.map(t => <option key={t.id} value={t.id}>{t.name}{t.lifecycle === 'offboarded' ? ' (encerrado)' : ''}</option>)}</select></label>}
      <label className="flex flex-col text-xs gap-1">Período<select aria-label="Período" className={field} value={period} onChange={e => setPeriod(e.target.value as typeof period)}><option value="month">Por mês</option><option value="custom">Intervalo de datas</option><option value="all">Toda a prestação / encerramento</option></select></label>
      {period === 'month' && <label className="flex flex-col text-xs gap-1">Mês<input aria-label="Mês" className={field} type="month" value={month} onChange={e => setMonth(e.target.value)} /></label>}
      {period === 'custom' && <><label className="flex flex-col text-xs gap-1">De<input aria-label="De" type="date" className={field} value={dates.from} onChange={e => setDates({ ...dates, from: e.target.value })} /></label><label className="flex flex-col text-xs gap-1">Até<input aria-label="Até" type="date" className={field} value={dates.to} onChange={e => setDates({ ...dates, to: e.target.value })} /></label></>}
      {!initialStudentId && <label className="flex flex-col text-xs gap-1">Aluno<select aria-label="Aluno" className={field} value={student} onChange={e => { setStudent(e.target.value); setSelected(null); setAction(null); }}><option value="">Todos os alunos</option>{data?.students.map(s => <option value={s.id} key={s.id}>{s.name}{!s.currently_linked ? ' (vínculo histórico)' : ''}</option>)}</select></label>}
      <button className={button} disabled={loading} onClick={() => setRevision(n => n + 1)}>Atualizar</button>
    </div>
    {error && <p role="alert" className="text-red-600">{error}</p>}
    {loading && <p role="status">Consultando histórico…</p>}
    {!loading && !teacher && <p>Selecione um teacher para consultar.</p>}
    {data && <>
      {period === 'all' && <p className="rounded-xl bg-brand-surface-2 p-3 text-sm">Conferência de encerramento: inclui toda a prestação registrada, pendências e agenda até {historyDate(data.to)}. A consulta não conclui o encerramento.</p>}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-2">{Object.entries(HISTORY_CATEGORIES).map(([key, label]) => <button key={key} aria-pressed={category === key} className={`${button} text-left ${category === key ? 'bg-brand-surface-2 ring-2 ring-brand-accent' : ''}`} onClick={() => setCategory(category === key ? '' : key as HistoryCategory)}><b className="block text-xl">{totals[key as HistoryCategory] || 0}</b>{label}</button>)}</div>
      {category && <button className={button} onClick={() => setCategory('')}>Ver todas as categorias</button>}
      <a href="/historico-prestacao" className="text-sm underline">Acesso ao próprio histórico após encerramento</a>
      <div className="flex flex-wrap gap-2" data-tour="lesson-history-report"><button className={button} onClick={() => report(false)}>Baixar relatório para arquivamento</button><button className={button} onClick={() => report(true)}>Imprimir / salvar PDF</button><span className="text-xs text-brand-muted self-center">O relatório respeita os filtros atuais.</span></div>
      {period === 'all' && <div className="rounded-xl border border-brand-border p-3"><h3 className="font-bold">Última atividade por aluno</h3>{data.students.filter(s => !student || student === s.id).map(s => <p key={s.id}>{s.name} · {s.currently_linked ? 'Vínculo atual' : 'Vínculo histórico'} · {historyDate(s.last_activity)}</p>)}</div>}
      <p className="text-xs text-brand-muted">A trilha começa na implantação deste módulo. Criação e autoria antigas não disponíveis são identificadas como tal.</p>
      <div className="space-y-2">{rows.length === 0 ? <p>Sem aulas para estes filtros.</p> : rows.map(r => <article key={r.key} className="rounded-xl border border-brand-border p-3 space-y-1">
        <div className="flex flex-wrap justify-between gap-2"><b>{historyDate(r.class_date)} · {r.start_time?.slice(0, 5) || 'Horário não disponível'} · {r.student_name}</b><span>{HISTORY_CATEGORIES[r.category] || r.category}</span></div>
        {r.reason && <p className="text-sm">Motivo: {r.reason}</p>}{r.notes && <p className="text-sm whitespace-pre-wrap">Observações: {r.notes}</p>}
        <p className="text-xs text-brand-muted">Criação: {historyDate(r.created_at, true)} · {r.created_by || 'Autoria não disponível'} · Última alteração: {historyDate(r.last_changed_at, true)} · {r.last_changed_by || 'Responsável não disponível'}</p>
        {r.disputes.some(d => !d.resolved_at) && <p className="text-amber-600 text-sm">Contestação aguardando resolução</p>}
        <button className={button} onClick={() => { setSelected(selected?.key === r.key ? null : r); setAction(null); }}>Detalhes e alterações</button>
        {selected?.key === r.key && <div className="bg-brand-surface-2 rounded-xl p-3 space-y-3">
          <p className="text-xs break-all">Referência: {r.key}</p>
          {historyEventsFor(r, data.events).map(e => <details key={e.id} className="text-sm"><summary>{historyDate(e.created_at, true)} · {e.action} · {e.actor || 'Sistema / autoria não disponível'}</summary><p>{e.reason || 'Justificativa não informada na origem'}</p><pre className="text-xs whitespace-pre-wrap break-all">{JSON.stringify({ anterior: e.before, atualizado: e.after }, null, 2)}</pre></details>)}
          {historyEventsFor(r, data.events).length === 0 && <p className="text-sm">Nenhuma alteração disponível.</p>}
          {r.disputes.map(d => <div key={d.id} className="border border-brand-border rounded-lg p-2 text-sm"><p>{d.description} · {d.opened_by || 'Autoria não disponível'} · {historyDate(d.opened_at, true)}</p><p>{d.resolution || 'Aguardando resolução'}{d.resolved_at ? ` · ${d.resolved_by} · ${historyDate(d.resolved_at, true)}` : ''}</p></div>)}
          <div className="flex flex-wrap gap-2">{manager && <button className={button} onClick={() => startAction('correction')}>Registrar correção</button>}{!r.disputes.some(d => !d.resolved_at) && <button className={button} onClick={() => startAction('dispute')}>Contestar registro</button>}{manager && r.disputes.some(d => !d.resolved_at) && <button className={button} onClick={() => startAction('resolve')}>Resolver contestação</button>}</div>
          {action && <div className="space-y-2">
            {action === 'correction' && <><p className="text-sm">A correção preserva o lançamento original. Divergências de presença e pagamento seguem pela Central de Qualidade.</p><label className="block text-sm">Observações operacionais<textarea aria-label="Observações operacionais" className={`${field} block w-full`} maxLength={1000} value={notes} onChange={e => setNotes(e.target.value)} /></label>{r.source_type === 'bookings' && !r.class_log_id && <label className="block text-sm">Classificação<select aria-label="Classificação" className={`${field} block w-full`} value={classification} onChange={e => setClassification(e.target.value)}><option value="">{['HOLIDAY', 'TEACHER_CANCELLED'].includes(r.category) ? 'Reabrir esta ocorrência na agenda' : 'Preservar situação da agenda'}</option><option value="HOLIDAY">Feriado sem aula</option><option value="TEACHER_CANCELLED">Cancelamento pelo teacher</option></select></label>}<p className="text-xs">Feriado ou cancelamento exclui somente esta ocorrência da agenda. Não altera aulas já lançadas.</p></>}
            <label className="block text-sm">{action === 'resolve' ? 'Resolução' : action === 'dispute' ? 'Descrição da contestação' : 'Justificativa da correção'}<textarea aria-label="Justificativa" className={`${field} block w-full`} minLength={10} maxLength={1000} value={reason} onChange={e => setReason(e.target.value)} placeholder="Descreva os fatos (mínimo 10 caracteres), sem dados sensíveis." /></label>
            <button className={button} disabled={busy || reason.trim().length < 10} onClick={submit}>{busy ? 'Salvando…' : 'Salvar registro'}</button><button className={button} disabled={busy} onClick={() => setAction(null)}>Cancelar</button>
          </div>}
        </div>}
      </article>)}</div>
      <div className="rounded-xl border border-brand-border p-3"><h3 className="font-bold">Reposições pendentes da carteira inteira</h3><p className="text-xs text-brand-muted">Inclui passivo sem data e anterior ao período. Não é somado novamente às categorias de aulas.</p>{data.backlog.filter(r => !student || r.student_id === student).map(r => <div key={r.id} className="text-sm py-2 border-b border-brand-border"><p>{r.student_name || 'Aluno não disponível'} · {r.date ? `${historyDate(r.date)} ${r.time || ''}` : 'Falta agendar'} · Origem: {r.fault_type === 'TEACHER' ? 'Falta do teacher' : r.fault_type === 'STUDENT' ? 'Falta do aluno' : 'Não informada'}</p><details><summary className="cursor-pointer underline">Alterações da reposição</summary>{data.events.filter(e => e.source_type === 'reschedules' && e.source_id === r.id).map(e => <p key={e.id}>{historyDate(e.created_at, true)} · {e.action} · {e.actor || 'Autoria não disponível'} · {e.reason || 'Sem motivo informado na origem'}<span className="block break-all text-xs">Anterior: {JSON.stringify(e.before)} · Atual: {JSON.stringify(e.after)}</span></p>)}</details></div>)}{data.backlog.length === 0 && <p>Sem reposições pendentes.</p>}</div>
      <details className="rounded-xl border border-brand-border p-3"><summary className="cursor-pointer font-bold">Remoções sem ocorrência atual</summary>{data.events.filter(e => e.action === 'DELETE' && (!student || e.before?.student_id === student) && !data.rows.some(r => historyEventsFor(r, [e]).length) && !data.backlog.some(r => e.source_type === 'reschedules' && e.source_id === r.id)).map(e => <div key={e.id} className="py-2 text-sm"><p>{historyDate(e.created_at, true)} · {e.source_type}:{e.source_id} · {e.actor || 'Autoria não disponível'}</p><p>{e.reason || 'Motivo não fornecido pela origem'}</p><pre className="whitespace-pre-wrap break-all text-xs">{JSON.stringify(e.before, null, 2)}</pre></div>)}</details>
    </>}
  </section>;
}
