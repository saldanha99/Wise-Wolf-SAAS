import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

type Change = { found: boolean; status: string; scope: string; old_day: string; old_time: string; new_day: string; new_time: string; original_date?: string; proposed_date?: string; effective_from: string; reason: string; student_name: string; teacher_name: string; reported_initiator?: string; recorded_by_role?: string };
const dateLabel = (value?: string) => value ? new Date(`${value}T12:00:00`).toLocaleDateString('pt-BR') : '';
export default function FamilyScheduleChangeConfirmation() {
  const token = new URLSearchParams(window.location.search).get('token') || '';
  const [change, setChange] = useState<Change | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { let live = true; void supabase.rpc('get_schedule_change_public', { p_token: token }).then(({ data, error: e }) => { if (!live) return; if (e || !data?.found) setError('Este link é inválido, expirou ou foi substituído. Fale com a escola.'); else setChange(data); }); return () => { live = false; }; }, [token]);
  const respond = async (accept: boolean) => {
    setBusy(true); setError('');
    const { data, error: e } = await supabase.rpc('respond_schedule_change_public', { p_token: token, p_accept: accept });
    if (e || data?.ok === false) setError('Não foi possível registrar. O link pode ter expirado; fale com a escola.');
    else setChange(previous => previous ? { ...previous, status: data.status } : previous);
    setBusy(false);
  };
  return <main className="min-h-screen bg-slate-950 p-5 flex items-center justify-center"><section className="w-full max-w-lg rounded-3xl bg-white p-7 space-y-5 text-slate-900">
    <h1 className="text-xl font-bold">Solicitação de mudança de aula</h1>
    {error && <p role="alert" className="text-red-700">{error}</p>}
    {!change && !error && <p>Carregando solicitação…</p>}
    {change && <>
      <p>{change.student_name} · {change.teacher_name}</p>
      <div className="rounded-xl bg-slate-100 p-4 space-y-2"><p>Atual: {change.old_day}, {change.old_time}{change.original_date ? ` · ${dateLabel(change.original_date)}` : ''}</p><p className="font-bold">Proposta: {change.new_day}, {change.new_time}{change.proposed_date ? ` · ${dateLabel(change.proposed_date)}` : ''}</p><p className="text-sm">{change.scope === 'ONE_OFF' ? 'Mudança somente desta aula. As demais aulas mantêm a agenda.' : `Mudança permanente a partir de ${dateLabel(change.effective_from)}.`}</p></div>
      <p className="text-sm">Motivo informado: {change.reason}</p>
      {change.reported_initiator && <p className="text-xs text-slate-600">Quem registrou informou que a proposta partiu {({ TEACHER: 'do professor', STUDENT: 'do aluno', GUARDIAN: 'do responsável', SCHOOL: 'da escola' } as Record<string, string>)[change.reported_initiator]}. Se essa informação estiver incorreta, avise a escola; ela permanece identificada como relato do solicitante.</p>}
      {change.status === 'PENDING_FAMILY' ? <><p className="text-sm">Você pode aceitar ou recusar. O horário só será alterado após a escola revisar e aplicar o pedido.</p><div className="grid grid-cols-2 gap-3"><button disabled={busy} onClick={() => void respond(true)} className="rounded-xl bg-emerald-600 p-4 font-bold text-white disabled:opacity-40">Aceitar proposta</button><button disabled={busy} onClick={() => void respond(false)} className="rounded-xl border border-slate-300 p-4 font-bold disabled:opacity-40">Manter horário atual</button></div></> : <p role="status" className="rounded-xl bg-emerald-50 p-4">{change.status === 'ACCEPTED' ? 'Seu aceite foi registrado. A escola ainda precisa confirmar a aplicação.' : change.status === 'APPLIED' ? 'A escola confirmou a mudança na vigência indicada.' : 'Este pedido foi encerrado. O horário não foi alterado por este pedido.'}</p>}
      <p className="text-xs text-slate-500">Sua resposta e o horário do registro ficam disponíveis para a equipe autorizada da escola.</p>
    </>}
  </section></main>;
}
