import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import ContactQualityManager from './ContactQualityManager';

type Request = { id: string; student_id: string; teacher_id: string; old_day: string; old_time: string; new_day: string; new_time: string; scope: string; effective_from: string; original_date: string | null; proposed_date: string | null; reason: string; status: string; initiated_by: string; history: { action: string; at: string; note?: string }[] };
type Contact = { id: string; student_id: string; name: string; phone: string };
const statuses: Record<string, string> = { PENDING_FAMILY: 'Aguardando família', ACCEPTED: 'Família aceitou · revisar', REJECTED: 'Família recusou', APPLIED: 'Aplicado', CANCELLED: 'Cancelado pela escola' };
const dateLabel = (value: string) => new Date(`${value}T12:00:00`).toLocaleDateString('pt-BR');
export default function ScheduleChangeRequests({ tenantId, studentId }: { tenantId?: string; studentId?: string }) {
  const [requests, setRequests] = useState<Request[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [links, setLinks] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [contactStudent, setContactStudent] = useState<string | null>(null);
  const load = useCallback(async () => {
    let query = supabase.from('schedule_change_requests').select('id,student_id,teacher_id,old_day,old_time,new_day,new_time,scope,effective_from,original_date,proposed_date,reason,status,initiated_by,history').order('created_at', { ascending: false }).limit(100);
    if (tenantId) query = query.eq('tenant_id', tenantId);
    if (studentId) query = query.eq('student_id', studentId);
    const result = await query;
    if (result.error) { setError('Não foi possível carregar as solicitações.'); return; }
    const rows = (result.data || []) as Request[]; setRequests(rows);
    const ids = [...new Set(rows.flatMap(r => [r.student_id, r.teacher_id]))];
    if (ids.length) {
      const [people, cs] = await Promise.all([supabase.from('profiles').select('id,full_name').in('id', ids), supabase.from('student_quality_contacts').select('id,student_id,name,phone').in('student_id', ids).eq('active', true).not('verified_at', 'is', null)]);
      setNames(Object.fromEntries((people.data || []).map(p => [p.id, p.full_name]))); setContacts(cs.data || []);
      if (people.error || cs.error) setError('Parte dos contatos não pôde ser carregada. Atualize antes de gerar um link.');
    }
  }, [tenantId, studentId]);
  useEffect(() => { void load(); }, [load]);
  const link = async (r: Request) => {
    setBusy(true); setError('');
    const result = await supabase.rpc('issue_schedule_change_link', { p_request_id: r.id, p_contact_id: selected[r.id] || '' });
    if (result.error || result.data?.ok === false) setError('Selecione um contato verificado desta família.');
    else setLinks(current => ({ ...current, [r.id]: `${window.location.origin}/confirmar-alteracao?token=${encodeURIComponent(result.data.token)}` }));
    setBusy(false);
  };
  const enqueue = async (r: Request) => {
    setBusy(true); setError(''); setNotice('');
    const result = await supabase.rpc('enqueue_schedule_change_acceptance', { p_request_id: r.id, p_contact_id: selected[r.id] || '' });
    if (result.error || result.data?.ok === false) setError('Confira o contato verificado, a vigência e se as notificações da escola estão habilitadas.');
    else setNotice(result.data?.suppressed ? 'Envio suprimido: participante de teste ou inativo.' : result.data?.already ? 'Esta solicitação já foi encaminhada à fila da escola. Nenhuma mensagem duplicada foi criada.' : 'Aceite encaminhado à fila do WhatsApp central da escola. A entrega será verificada.');
    setBusy(false);
  };
  const review = async (r: Request, apply: boolean) => {
    setBusy(true); setError('');
    const result = await supabase.rpc('review_booking_schedule_change', { p_request_id: r.id, p_apply: apply, p_note: notes[r.id] || '' });
    if (result.error || result.data?.ok === false) {
      const msg = result.error?.message || '';
      setError(/conflict|available/.test(msg) ? 'O horário está indisponível ou passou a ter conflito. Revise a proposta.' : /expired/.test(msg) ? 'A vigência expirou. Cancele e crie uma nova proposta.' : 'A mudança exige aceite da família, contato ativo e motivo de revisão (mínimo de 8 caracteres).');
    } else await load();
    setBusy(false);
  };
  return <section className="space-y-4" aria-label="Mudanças de agenda">
    <div className="flex items-center justify-between"><div><h2 className="text-xl font-bold text-brand-text">Mudanças de agenda</h2><p className="text-sm text-brand-muted">Proposta, resposta da família e decisão da escola com histórico.</p></div><button type="button" disabled={busy} onClick={() => void load()} className="rounded-xl border border-brand-border p-3">Atualizar</button></div>
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    {notice && <p role="status" className="text-sm text-emerald-600">{notice}</p>}
    {contactStudent && <ContactQualityManager studentId={contactStudent} studentName={names[contactStudent]} manager onChanged={() => void load()} />}
    {requests.length === 0 && <p className="text-sm text-brand-muted">Nenhuma solicitação encontrada.</p>}
    {requests.map(r => <article key={r.id} className="space-y-3 rounded-2xl border border-brand-border bg-brand-surface p-5">
      <h3 className="font-bold">{names[r.student_id] || 'Aluno'} · {names[r.teacher_id] || 'Professor'}</h3><p className="text-sm">{statuses[r.status]} · iniciador informado pelo solicitante: {({ TEACHER: 'professor', STUDENT: 'aluno', GUARDIAN: 'responsável', SCHOOL: 'escola' } as Record<string, string>)[r.initiated_by]}</p>
      <p className="text-sm">{r.old_day}, {r.old_time} → {r.new_day}, {r.new_time} · {r.scope === 'ONE_OFF' ? `${dateLabel(r.original_date!)} para ${dateLabel(r.proposed_date!)}` : `permanente a partir de ${dateLabel(r.effective_from)}`}</p><p className="text-sm text-brand-muted">Motivo: {r.reason}</p>
      {r.status === 'PENDING_FAMILY' && <div className="space-y-2">
        <label className="block text-xs">Destinatário verificado<select aria-label={`Contato para ${names[r.student_id] || 'aluno'}`} value={selected[r.id] || ''} onChange={e => setSelected(s => ({ ...s, [r.id]: e.target.value }))} className="mt-1 w-full rounded-xl border border-brand-border bg-brand-surface p-3"><option value="">Selecione o aluno ou responsável</option>{contacts.filter(c => c.student_id === r.student_id).map(c => <option key={c.id} value={c.id}>{c.name} · {c.phone}</option>)}</select></label>
        <div className="flex flex-wrap gap-3">
          <button type="button" disabled={busy || !selected[r.id]} onClick={() => void enqueue(r)} className="rounded-xl bg-brand-accent p-3 text-xs font-bold text-white disabled:opacity-40">Enviar aceite pelo WhatsApp da escola</button>
          <button type="button" disabled={busy || !selected[r.id]} onClick={() => void link(r)} className="rounded-xl border border-brand-border p-3 text-xs disabled:opacity-40">Gerar link alternativo</button>
          <button type="button" onClick={() => setContactStudent(r.student_id)} className="text-xs underline">Gerenciar contatos da família</button>
        </div>
        {links[r.id] && <div className="rounded-xl bg-brand-surface-2 p-3"><p className="text-xs mb-2">Envie este link ao contato selecionado pelo atendimento da escola. Este link substitui qualquer link anterior ainda pendente.</p><input readOnly aria-label="Link de aceite da família" value={links[r.id]} className="w-full rounded border border-brand-border bg-brand-surface p-2 text-xs" onFocus={e => e.target.select()} /></div>}
      </div>}
      {['PENDING_FAMILY', 'ACCEPTED'].includes(r.status) && <div className="space-y-2"><label className="block text-xs">Justificativa da revisão<textarea maxLength={1000} value={notes[r.id] || ''} onChange={e => setNotes(n => ({ ...n, [r.id]: e.target.value }))} className="mt-1 w-full rounded-xl border border-brand-border bg-brand-surface p-3" /></label><div className="flex gap-3">{r.status === 'ACCEPTED' && <button type="button" disabled={busy || (notes[r.id] || '').trim().length < 8} onClick={() => void review(r, true)} className="rounded-xl bg-emerald-600 p-3 text-sm text-white disabled:opacity-40">Aplicar na vigência</button>}<button type="button" disabled={busy || (notes[r.id] || '').trim().length < 8} onClick={() => void review(r, false)} className="p-3 text-sm text-red-600 disabled:opacity-40">Cancelar pedido</button></div></div>}
      <details className="text-xs text-brand-muted"><summary>Histórico de decisões</summary>{r.history.map((event, i) => <p key={i} className="mt-2">{new Date(event.at).toLocaleString('pt-BR')} · {event.action}{event.note ? ` · ${event.note}` : ''}</p>)}</details>
    </article>)}
  </section>;
}
