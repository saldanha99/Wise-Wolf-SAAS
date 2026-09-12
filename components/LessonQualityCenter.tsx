import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import StudentHandover from './StudentHandover';

type QualityCase = { id: string; student_id: string; student_name: string; teacher_name: string; category: string; status: string; description: string; assigned_to: string | null; created_at: string; events: { id: string; event_type: string; created_at: string; details: Record<string, unknown> }[] };
const categories: Record<string, string> = { LATE_START: 'Atraso relatado', EARLY_END: 'Término antecipado', SCHEDULE_CHANGE: 'Mudança de horário', DID_NOT_HAPPEN: 'Aula não realizada', OTHER: 'Relato da família', MISSING_LOG: 'Lançamento pendente', DELIVERY_FAILURE: 'Falha de entrega' };
const statuses: Record<string, string> = { OPEN: 'Aberto', IN_REVIEW: 'Em análise', WAITING: 'Aguardando retorno', RESOLVED: 'Resolvido', FOLLOWUP: 'Acompanhamento' };
const dateOnly = (daysAgo: number) => { const date = new Date(); date.setDate(date.getDate() - daysAgo); return date.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }); };
export default function LessonQualityCenter() {
  const [from, setFrom] = useState(dateOnly(7));
  const [to, setTo] = useState(dateOnly(0));
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [cases, setCases] = useState<QualityCase[]>([]);
  const [reviewers, setReviewers] = useState<{ id: string; name: string }[]>([]);
  const [selected, setSelected] = useState<QualityCase | null>(null);
  const [status, setStatus] = useState('IN_REVIEW');
  const [assigned, setAssigned] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [handover, setHandover] = useState<string | null>(null);
  const load = useCallback(async () => {
    setBusy(true); setError('');
    try {
      const result = await supabase.rpc('get_lesson_quality_dashboard', { p_from: from, p_to: to });
      if (result.error || result.data?.ok !== true) throw new Error('load');
      setCounts(result.data.counts || {}); setCases(result.data.cases || []); setReviewers(result.data.reviewers || []);
    } catch { setError('Não foi possível carregar a qualidade. Use um intervalo de até 32 dias e verifique sua permissão.'); }
    finally { setBusy(false); }
  }, [from, to]);
  useEffect(() => { void load(); }, [load]);
  async function review(event: React.FormEvent) {
    event.preventDefault(); if (!selected) return;
    setBusy(true); setError('');
    const result = await supabase.rpc('review_lesson_quality_case', { p_case_id: selected.id, p_status: status, p_note: note, p_assigned_to: assigned || null });
    if (result.error || result.data?.ok !== true) setError('Não foi possível salvar. Informe a análise e um responsável válido.');
    else { setSelected(null); setNote(''); await load(); }
    setBusy(false);
  }
  const metrics = [['planned', 'Sessões previstas'], ['eligible', 'Auditorias criadas'], ['sent', 'Enviadas'], ['delivered', 'Entregues'], ['read', 'Lidas'], ['responded', 'Com retorno'], ['unknown', 'Não acompanhadas'], ['failed', 'Falhas / incertas'], ['missing_log', 'Sem lançamento há 24h'], ['unverified_contact', 'Contato não verificado']];
  return <div className="space-y-5 text-slate-800 dark:text-slate-100">
    <header><h1 className="text-2xl font-bold">Central de qualidade</h1><p className="mt-2 text-sm text-slate-500">Relatos da família e registros operacionais para análise humana. Silêncio não significa satisfação; dados do Meet não são usados para avaliar professores ou calcular pagamento.</p></header>
    <div className="flex flex-wrap items-end gap-3">
      <label className="text-sm">De<input aria-label="Data inicial" type="date" value={from} onChange={e => setFrom(e.target.value)} className="ml-2 rounded-lg border bg-white p-2 text-slate-900" /></label>
      <label className="text-sm">Até<input aria-label="Data final" type="date" value={to} onChange={e => setTo(e.target.value)} className="ml-2 rounded-lg border bg-white p-2 text-slate-900" /></label>
      <button disabled={busy} onClick={() => void load()} className="rounded-lg border px-4 py-2 text-sm">{busy ? 'Atualizando…' : 'Atualizar'}</button>
    </div>
    {error && <p role="alert" className="text-red-600">{error}</p>}
    <div className="grid grid-cols-2 gap-3 md:grid-cols-5">{metrics.map(([key, label]) => <div key={key} className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900"><p className="text-2xl font-bold">{counts[key] ?? '—'}</p><p className="mt-1 text-xs text-slate-500">{label}</p></div>)}</div>
    <p className="text-xs text-slate-500">Entregue/lida dependem dos recibos do WhatsApp. Auditorias agrupam os blocos da mesma aula. Casos abertos aparecem independentemente do período; até 200 mais recentes.</p>
    <h2 className="text-lg font-semibold">Fila de acompanhamento ({cases.filter(c => c.status !== 'RESOLVED').length} em aberto)</h2>
    {!cases.length && !busy && <p className="rounded-xl border p-5 text-slate-500">Nenhum caso na fila. Confira também os indicadores de entrega e ausência de retorno.</p>}
    <div className="space-y-3">{cases.map(c => <article key={c.id} className="rounded-xl border border-slate-200 p-4 dark:border-slate-700">
      <div className="flex flex-wrap justify-between gap-2"><h3 className="font-semibold">{categories[c.category] || c.category} · {c.student_name}</h3><span className="text-xs text-slate-500">{statuses[c.status]} · {new Date(c.created_at).toLocaleDateString('pt-BR')}</span></div>
      <p className="mt-1 text-xs text-slate-500">Professor: {c.teacher_name || 'Não identificado'}</p><p className="mt-2 whitespace-pre-wrap text-sm">{c.description}</p>
      <div className="mt-3 flex gap-4 text-sm"><button className="font-semibold text-blue-600" onClick={() => { setSelected(c); setStatus(c.status === 'OPEN' ? 'IN_REVIEW' : c.status); setAssigned(c.assigned_to || ''); setNote(''); }}>Analisar e registrar decisão</button><button className="text-blue-600" onClick={() => setHandover(c.student_id)}>Dossiê pedagógico</button></div>
    </article>)}</div>
    {selected && <form onSubmit={review} className="space-y-3 rounded-xl border border-blue-300 bg-blue-50 p-5 dark:bg-slate-900">
      <h3 className="font-semibold">Análise de {selected.student_name}</h3>
      <label className="block text-sm">Situação<select value={status} onChange={e => setStatus(e.target.value)} className="ml-3 rounded border bg-white p-2 text-slate-900">{Object.entries(statuses).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
      <label className="block text-sm">Responsável<select value={assigned} onChange={e => setAssigned(e.target.value)} className="ml-3 rounded border bg-white p-2 text-slate-900"><option value="">Não atribuído</option>{reviewers.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
      <label className="block text-sm">Análise, providência e próximo contato<textarea required minLength={5} maxLength={4000} value={note} onChange={e => setNote(e.target.value)} className="mt-1 w-full rounded border bg-white p-3 text-slate-900" rows={4} /></label>
      <p className="text-xs text-slate-500">Esta decisão não altera o repasse. Divergências financeiras seguem o fluxo de presença existente.</p>
      <div className="flex gap-3"><button disabled={busy} className="rounded-lg bg-blue-700 px-4 py-2 text-sm font-semibold text-white">Salvar análise</button><button type="button" onClick={() => setSelected(null)} className="text-sm underline">Fechar</button></div>
      <details><summary className="cursor-pointer text-sm">Histórico de evidências e decisões</summary>{selected.events.map(e => <div key={e.id} className="mt-2 border-t py-2 text-xs"><p>{e.event_type} · {new Date(e.created_at).toLocaleString('pt-BR')}</p><pre className="whitespace-pre-wrap break-words font-sans">{JSON.stringify(e.details, null, 2)}</pre></div>)}</details>
    </form>}
    {handover && <div className="rounded-xl border p-5"><button className="mb-3 text-sm underline" onClick={() => setHandover(null)}>Fechar dossiê</button><StudentHandover studentId={handover} /></div>}
  </div>;
}
