import React, { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, FileSignature, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';

type RenewalSchedule = { teacher_first_name: string; slots: { day: string; time: string }[] };
type Renewal = {
  student_name: string; school_name: string; term_months: number;
  monthly_fee_cents: number; classes_per_week: number; contract_start: string;
  first_due_date: string; last_due_date: string; service_end_date: string;
  status: 'PENDING_SIGNATURE' | 'SIGNED'; billing_status: string; expired: boolean;
  // Horário que o aluno assina junto (renovação com novas condições). Ausente = mantém a agenda atual.
  schedule?: RenewalSchedule | null;
};
const date = (value: string) => new Date(`${value}T12:00:00`).toLocaleDateString('pt-BR');
const money = (cents: number) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
function parseSchedule(value: unknown): RenewalSchedule | null {
  if (value === null || value === undefined) return null;
  const s = value as Partial<RenewalSchedule>;
  if (typeof s !== 'object' || typeof s.teacher_first_name !== 'string' || !Array.isArray(s.slots) || s.slots.length < 1
    || s.slots.some(slot => !slot || typeof slot.day !== 'string' || typeof slot.time !== 'string' || !/^\d{2}:\d{2}$/.test(slot.time))) {
    throw new Error('invalid_renewal');
  }
  return { teacher_first_name: s.teacher_first_name, slots: s.slots.map(slot => ({ day: slot.day, time: slot.time })) };
}
function parse(value: unknown): Renewal {
  const v = value as Partial<Renewal> | null;
  if (!v || typeof v.student_name !== 'string' || typeof v.school_name !== 'string' || v.term_months !== 6
    || !Number.isSafeInteger(v.monthly_fee_cents) || Number(v.monthly_fee_cents) <= 0
    || !Number.isInteger(v.classes_per_week) || Number(v.classes_per_week) < 1 || Number(v.classes_per_week) > 7
    || !['PENDING_SIGNATURE', 'SIGNED'].includes(String(v.status))
    || [v.contract_start, v.first_due_date, v.last_due_date, v.service_end_date].some(x => typeof x !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(x))) {
    throw new Error('invalid_renewal');
  }
  return { ...(v as Renewal), schedule: parseSchedule(v.schedule) };
}

export default function CourseRenewalSign() {
  const token = new URLSearchParams(window.location.search).get('token') || '';
  const [data, setData] = useState<Renewal | null>(null);
  const [loading, setLoading] = useState(true);
  const [signature, setSignature] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState('');
  const [signing, setSigning] = useState(false);
  useEffect(() => { void (async () => {
    if (!/^[a-f0-9]{64}$/.test(token)) { setError('Link inválido.'); setLoading(false); return; }
    const response = await supabase.rpc('get_student_course_renewal_public', { p_token: token });
    try {
      if (response.error || !response.data?.ok) throw new Error(response.data?.error || 'Não foi possível abrir o contrato.');
      setData(parse(response.data.data));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '';
      setError(message === 'invalid_renewal' ? 'Não foi possível abrir o contrato.' : (message || 'Não foi possível abrir o contrato.'));
    }
    setLoading(false);
  })(); }, [token]);
  const sign = async () => {
    setSigning(true); setError('');
    const response = await supabase.rpc('sign_student_course_renewal', { p_token: token, p_typed_signature: signature });
    setSigning(false);
    if (response.error || !response.data?.ok) { setError(response.data?.error || 'Não foi possível assinar.'); return; }
    setData(current => current ? { ...current, status: 'SIGNED', billing_status: String(response.data.billing_status || current.billing_status) } : current);
  };
  if (loading) return <main className="min-h-screen grid place-items-center bg-slate-100"><Loader2 className="animate-spin text-[#002366]" size={40} aria-label="Carregando" /></main>;
  if (!data) return <main className="min-h-screen grid place-items-center bg-slate-100 p-4"><div role="alert" className="max-w-md rounded-3xl bg-white p-8 text-center shadow"><AlertCircle className="mx-auto mb-3 text-red-500" size={44}/><h1 className="font-black text-slate-800">Não foi possível abrir</h1><p className="mt-2 text-sm text-slate-500">{error}</p></div></main>;
  if (data.status === 'SIGNED') return <main className="min-h-screen grid place-items-center bg-slate-100 p-4"><div className="max-w-md rounded-3xl bg-white p-8 text-center shadow"><CheckCircle2 className="mx-auto mb-3 text-emerald-500" size={48}/><h1 className="text-xl font-black text-slate-800">Renovação assinada</h1><p className="mt-2 text-sm text-slate-500">Recebemos sua assinatura. A situação da cobrança será processada e registrada pela escola.</p></div></main>;
  const schedule = data.schedule;
  return <main className="min-h-screen bg-slate-100 px-4 py-8"><div className="mx-auto max-w-xl space-y-4">
    <header className="text-center"><FileSignature className="mx-auto text-[#002366]"/><h1 className="mt-2 text-2xl font-black text-slate-800">Renovação do curso</h1><p className="text-sm text-slate-500">{data.school_name}</p></header>
    <section className="rounded-3xl bg-white p-6 shadow-sm"><p className="text-sm text-slate-600">Olá, <b>{data.student_name}</b>. Confira as condições aprovadas:</p>
      <dl className="mt-5 grid grid-cols-2 gap-3 text-sm"><div className="rounded-xl bg-slate-50 p-3"><dt className="text-slate-500">Período</dt><dd className="font-black">6 meses</dd></div><div className="rounded-xl bg-slate-50 p-3"><dt className="text-slate-500">Mensalidade</dt><dd className="font-black">{money(data.monthly_fee_cents)}</dd></div><div className="rounded-xl bg-slate-50 p-3"><dt className="text-slate-500">Frequência</dt><dd className="font-black">{data.classes_per_week}x por semana</dd></div><div className="rounded-xl bg-slate-50 p-3"><dt className="text-slate-500">Vigência</dt><dd className="font-black">{date(data.contract_start)} a {date(data.service_end_date)}</dd></div>
        {schedule && <div className="col-span-2 rounded-xl bg-slate-50 p-3"><dt className="text-slate-500">Horário das aulas</dt><dd className="font-black">{schedule.slots.map(slot => `${slot.day} às ${slot.time}`).join(' · ')}</dd><dd className="mt-1 text-xs text-slate-500">com a teacher {schedule.teacher_first_name}</dd></div>}
      </dl>
      <p className="mt-4 text-xs text-slate-500">São 6 parcelas mensais, da competência de {date(data.first_due_date)} até {date(data.last_due_date)}. A última parcela mantém as aulas até {date(data.service_end_date)}.</p>
      <p className="mt-3 text-xs text-slate-500">Esta renovação prorroga o contrato anterior. As demais cláusulas continuam válidas; somente vigência, parcelas, valor{schedule ? ', frequência e horário ficam confirmados' : ' e frequência ficam confirmados'} conforme o resumo acima.</p>
      {data.expired ? <div role="alert" className="mt-5 rounded-xl bg-amber-50 p-4 text-sm font-bold text-amber-700">Este link expirou. Peça um novo à escola.</div> : <><label className="mt-5 flex items-start gap-2 text-xs text-slate-600"><input type="checkbox" checked={accepted} onChange={e=>setAccepted(e.target.checked)} className="mt-0.5"/>Li e concordo com as condições desta renovação.</label><label className="mt-5 block text-xs font-black uppercase text-slate-500">Assine digitando o nome completo</label><input className="mt-2 w-full rounded-xl border p-3" value={signature} onChange={e=>setSignature(e.target.value)} placeholder={data.student_name}/>{error && <p role="alert" className="mt-2 text-xs font-bold text-red-600">{error}</p>}<button type="button" onClick={sign} disabled={signing || !accepted || signature.trim().length<3} className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-[#002366] p-4 text-xs font-black uppercase text-white disabled:opacity-40">{signing && <Loader2 size={14} className="animate-spin"/>}Assinar renovação</button><p className="mt-3 text-center text-[10px] text-slate-400">Registramos data, hora e endereço de rede para a trilha de auditoria.</p></>}
    </section></div></main>;
}
