import React, { useState } from 'react';
import { supabase } from '../lib/supabase';

export default function LessonQualityFeedback({ token, confirmationId }: { token?: string; confirmationId?: string }) {
  const [happened, setHappened] = useState('UNKNOWN');
  const [punctuality, setPunctuality] = useState('UNKNOWN');
  const [endedEarly, setEndedEarly] = useState('UNKNOWN');
  const [rescheduleBy, setRescheduleBy] = useState('UNKNOWN');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  // Public confirmation has a fixed white card even when the app's stored
  // preference sets dark on <html>. Its text must keep light-surface contrast.
  const labelColor = token ? 'text-slate-700' : 'text-slate-700 dark:text-slate-200';
  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const payload = { happened, punctuality, ended_early: endedEarly, reschedule_by: rescheduleBy, comment };
      const { data, error: rpcError } = token
        ? await supabase.rpc('submit_lesson_quality_feedback', { p_token: token, p_payload: payload })
        : await supabase.rpc('submit_my_lesson_quality_feedback', { p_confirmation_id: confirmationId, p_payload: payload });
      if (rpcError || data?.ok !== true) throw new Error(data?.error || rpcError?.message || 'falha');
      setSaved(true);
    } catch (err) {
      setError(/prazo|expirad/.test(String(err)) ? 'O prazo terminou. Entre em contato com a escola.' : 'Não foi possível salvar. Tente novamente.');
    } finally { setBusy(false); }
  }
  const select = (label: string, value: string, update: (v: string) => void, options: [string, string][]) => (
    <label className={`block text-sm font-medium ${labelColor}`}>{label}
      <select value={value} onChange={e => update(e.target.value)} disabled={busy} className="mt-1 w-full rounded-lg border border-slate-300 bg-white p-2 text-slate-900">
        {options.map(([id, text]) => <option key={id} value={id}>{text}</option>)}
      </select>
    </label>
  );
  if (saved) return <div className="my-4 rounded-xl bg-emerald-50 p-4 text-sm text-emerald-900" role="status">
    Retorno enviado à equipe de qualidade. Não acompanhar a aula não confirma presença nem falta.
    <button type="button" onClick={() => setSaved(false)} className="mt-2 block underline">Corrigir meu retorno (até 30 minutos)</button>
  </div>;
  return <details className="my-4 rounded-xl border border-slate-200 p-3 text-left">
    <summary className={`cursor-pointer text-sm font-bold ${labelColor}`}>Relatar atraso, mudança de horário ou que não acompanhei</summary>
    <form onSubmit={save} className="mt-4 space-y-3">
      <p className="text-xs text-slate-500">Seu retorno será analisado pela escola. Não é enviado diretamente ao professor.</p>
      {select('Você sabe se a aula aconteceu?', happened, setHappened, [['UNKNOWN', 'Não acompanhei / não sei'], ['YES', 'Sim'], ['NO', 'Não']])}
      {select('O professor iniciou no horário combinado?', punctuality, setPunctuality, [['UNKNOWN', 'Não sei'], ['ON_TIME', 'Sim'], ['LATE', 'Houve atraso']])}
      {select('A aula terminou antes do horário combinado?', endedEarly, setEndedEarly, [['UNKNOWN', 'Não sei'], ['NO', 'Não'], ['YES', 'Sim']])}
      {select('Alguém pediu para mudar o horário?', rescheduleBy, setRescheduleBy, [['UNKNOWN', 'Não sei'], ['NONE', 'Não'], ['TEACHER', 'O professor'], ['FAMILY', 'Aluno ou responsável'], ['SCHOOL', 'A escola']])}
      <label className={`block text-sm ${labelColor}`}>Quer contar algo mais? (opcional)
        <textarea value={comment} onChange={e => setComment(e.target.value)} maxLength={2000} rows={3} className="mt-1 w-full rounded-lg border border-slate-300 bg-white p-2 text-slate-900" />
      </label>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <button disabled={busy} className="rounded-lg bg-blue-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy ? 'Enviando…' : 'Enviar para a qualidade'}</button>
    </form>
  </details>;
}
