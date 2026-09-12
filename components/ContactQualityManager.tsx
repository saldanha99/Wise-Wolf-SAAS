import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

type Contact = { id: string; student_id: string; name: string; phone: string; relationship: string; active: boolean; verified_at: string | null };
type Request = { id: string; student_id: string; name: string; phone: string; relationship: string; reason: string; status: string; review_note: string | null };
export default function ContactQualityManager({ studentId, studentName, manager = false, onChanged }: { studentId?: string; studentName?: string; manager?: boolean; onChanged?: () => void }) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [requests, setRequests] = useState<Request[]>([]);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [relationship, setRelationship] = useState('GUARDIAN');
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [studentNames, setStudentNames] = useState<Record<string, string>>({});
  const load = useCallback(async () => {
    let requestQuery = supabase.from('student_contact_change_requests').select('id,student_id,name,phone,relationship,reason,status,review_note').order('created_at', { ascending: false }).limit(60);
    if (studentId) requestQuery = requestQuery.eq('student_id', studentId);
    else requestQuery = requestQuery.eq('status', 'PENDING');
    const { data, error: e } = await requestQuery;
    if (e) { setError('Não foi possível carregar as solicitações de contato.'); return; }
    setRequests(data || []);
    const relatedStudents = new Set<string>((data || []).map(item => item.student_id));
    if (manager || studentId) {
      let query = supabase.from('student_quality_contacts').select('id,student_id,name,phone,relationship,active,verified_at').eq('active', true).order('verified_at', { ascending: false }).limit(100);
      if (studentId) query = query.eq('student_id', studentId);
      const result = await query;
      if (result.error) setError('Não foi possível carregar os contatos verificados.');
      else { setContacts(result.data || []); for (const item of result.data || []) relatedStudents.add(item.student_id); }
    }
    if (relatedStudents.size > 0) {
      const people = await supabase.from('profiles').select('id,full_name').in('id', [...relatedStudents]);
      if (!people.error) setStudentNames(Object.fromEntries((people.data || []).map(p => [p.id, p.full_name])));
    }
  }, [studentId, manager]);
  useEffect(() => { void load(); }, [load]);
  const request = async () => {
    if (!studentId) return;
    setBusy(true); setError(''); setSuccess('');
    const result = await supabase.rpc('request_student_contact_change', { p_student_id: studentId, p_name: name, p_phone: phone, p_relationship: relationship, p_reason: reason });
    if (result.error || result.data?.ok === false) setError('Confira o nome, WhatsApp e motivo (mínimo de 8 caracteres).');
    else { setSuccess('Solicitação registrada. A escola vai confirmar o contato antes de ativá-lo.'); setName(''); setPhone(''); setReason(''); await load(); }
    setBusy(false);
  };
  const review = async (id: string, approve: boolean) => {
    setBusy(true); setError('');
    const result = await supabase.rpc('review_student_contact_change', { p_request_id: id, p_approve: approve, p_note: notes[id] || '' });
    if (result.error || result.data?.ok === false) setError('Registre como a identidade e o vínculo foram conferidos (mínimo de 8 caracteres).');
    else { setSuccess(approve ? 'Contato verificado e ativado com histórico.' : 'Solicitação recusada com histórico.'); await load(); onChanged?.(); }
    setBusy(false);
  };
  const deactivate = async (contact: Contact) => {
    const note = window.prompt(`Motivo para desativar o contato de ${contact.name} (mínimo de 8 caracteres):`);
    if (!note) return;
    setBusy(true); setError('');
    const result = await supabase.rpc('deactivate_student_quality_contact', { p_contact_id: contact.id, p_note: note });
    if (result.error) setError('Não foi possível desativar. Confira o motivo e tente novamente.');
    else { await load(); onChanged?.(); }
    setBusy(false);
  };
  const field = 'w-full rounded-xl border border-brand-border bg-brand-surface p-3 text-sm text-brand-text';
  return <section className="space-y-3 rounded-2xl border border-brand-border p-4" aria-label="Contatos de qualidade">
    <h3 className="font-bold text-brand-text">Contato independente de qualidade{studentName ? ` · ${studentName}` : ''}</h3>
    <p className="text-xs text-brand-muted">A escola confirma quem pode responder pelo aluno. Um responsável pode acompanhar mais de um filho. Cada vínculo é verificado separadamente.</p>
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    {success && <p role="status" className="text-sm text-emerald-600">{success}</p>}
    {contacts.map(contact => <div key={contact.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-brand-surface-2 p-3 text-sm">
      <span>{contact.name} · {contact.relationship === 'GUARDIAN' ? 'Responsável' : 'Aluno'} · {contact.phone}<small className="block text-brand-muted">Aluno: {studentName || studentNames[contact.student_id] || 'Carregando identificação'} · {contact.verified_at ? 'Verificado pela escola' : 'Aguardando verificação'}</small></span>
      {manager && <button type="button" disabled={busy} onClick={() => void deactivate(contact)} className="text-xs text-red-600">Desativar</button>}
    </div>)}
    {studentId && <div className="grid gap-3 sm:grid-cols-2">
      <label className="text-xs">Nome do contato<input className={field} value={name} maxLength={120} onChange={e => setName(e.target.value)} /></label>
      <label className="text-xs">WhatsApp com DDD<input className={field} value={phone} maxLength={20} inputMode="tel" onChange={e => setPhone(e.target.value)} /></label>
      <label className="text-xs">Vínculo<select className={field} value={relationship} onChange={e => setRelationship(e.target.value)}><option value="GUARDIAN">Responsável pelo aluno</option><option value="STUDENT">Próprio aluno</option></select></label>
      <label className="text-xs">Motivo da inclusão/correção<textarea className={field} value={reason} minLength={8} maxLength={1000} onChange={e => setReason(e.target.value)} /></label>
      <button type="button" disabled={busy || name.trim().length < 2 || phone.replace(/\D/g, '').length < 10 || reason.trim().length < 8} onClick={() => void request()} className="rounded-xl bg-brand-accent p-3 text-sm font-bold text-white disabled:opacity-40 sm:col-span-2">Solicitar confirmação do contato</button>
    </div>}
    {requests.map(item => <article key={item.id} className="space-y-2 border-t border-brand-border pt-3">
      <p className="text-sm font-bold">{item.name} · {item.phone} · {({ PENDING: 'Aguardando escola', APPROVED: 'Aprovado', REJECTED: 'Recusado' } as Record<string, string>)[item.status]}</p>
      <p className="text-xs font-bold">Aluno: {studentName || studentNames[item.student_id] || 'Carregando identificação'}</p>
      <p className="text-xs text-brand-muted">{item.reason}</p>
      {item.review_note && <p className="text-xs">Revisão: {item.review_note}</p>}
      {manager && item.status === 'PENDING' && <>
        <label className="block text-xs">Como conferiu a identidade e o vínculo? (ou motivo da recusa)<textarea className={field} value={notes[item.id] || ''} maxLength={1000} onChange={e => setNotes(n => ({ ...n, [item.id]: e.target.value }))} /></label>
        <div className="flex gap-3"><button type="button" disabled={busy || (notes[item.id] || '').trim().length < 8} onClick={() => void review(item.id, true)} className="rounded-lg bg-emerald-600 p-2 text-sm text-white disabled:opacity-40">Confirmei a identidade e o vínculo</button><button type="button" disabled={busy || (notes[item.id] || '').trim().length < 8} onClick={() => void review(item.id, false)} className="p-2 text-sm text-red-600 disabled:opacity-40">Recusar</button></div>
      </>}
    </article>)}
  </section>;
}
