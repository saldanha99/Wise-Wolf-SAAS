import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, ShieldCheck } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { asDecision, consentErrorMessage, DECISION_LABEL, formatDecisionDate } from '../lib/lessonRecordingConsent';

type MyConsent = { applies: boolean; decision?: string; decided_at?: string | null; term_version?: string; term_body?: string };

// Aceite do professor ao termo de registro das aulas. Sem ele, nenhuma aula
// dele é transcrita, mesmo que o aluno tenha autorizado.
export default function LessonRecordingTeacherCard() {
  const [data, setData] = useState<MyConsent | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    const { data: result, error: rpcError } = await supabase.rpc('get_my_lesson_recording_consent');
    if (!rpcError && result) setData(result as MyConsent);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function decide(accept: boolean) {
    setBusy(true); setError('');
    const { data: result, error: rpcError } = await supabase.rpc('set_my_lesson_recording_consent', { p_accept: accept });
    setBusy(false);
    if (rpcError || result?.ok !== true) { setError(consentErrorMessage(rpcError?.message)); return; }
    setOpen(false);
    await load();
  }

  if (!data?.applies) return null;
  const decision = asDecision(data.decision);
  const accepted = decision === 'ACCEPTED';

  return <section data-tour="recording-teacher-consent" className={`rounded-2xl border p-4 ${accepted ? 'border-emerald-200 bg-emerald-50 dark:bg-slate-900' : 'border-amber-200 bg-amber-50 dark:bg-slate-900'}`}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="flex items-center gap-2 font-bold text-slate-800 dark:text-slate-100"><ShieldCheck size={18} /> Registro das suas aulas</h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
          {accepted
            ? `Você autorizou em ${formatDecisionDate(data.decided_at)}. As aulas dos alunos que também autorizaram passam a ser transcritas.`
            : decision === 'NONE'
              ? 'As aulas na sala da escola podem ser transcritas para registrar o que foi trabalhado. Leia o termo e responda.'
              : `Situação: ${DECISION_LABEL[decision]}. Suas aulas não são transcritas.`}
        </p>
      </div>
      <button type="button" onClick={() => setOpen(value => !value)} className="text-sm font-semibold text-blue-700 dark:text-blue-300">
        {open ? 'Fechar termo' : accepted ? 'Ver termo' : 'Ler e responder'}
      </button>
    </div>
    {open && <div className="mt-3 space-y-3">
      <div className="max-h-72 overflow-y-auto whitespace-pre-line rounded-xl border border-slate-200 bg-white p-4 text-sm leading-relaxed text-slate-700 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200">
        {data.term_body}
      </div>
      {error && <p role="alert" className="text-sm font-semibold text-red-600">{error}</p>}
      <div className="flex flex-wrap gap-3">
        {!accepted && <button type="button" disabled={busy} onClick={() => void decide(true)} className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-bold text-white disabled:opacity-40">
          {busy && <Loader2 size={14} className="animate-spin" />} Li e autorizo
        </button>}
        <button type="button" disabled={busy} onClick={() => void decide(false)} className="rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-bold text-slate-700 disabled:opacity-40 dark:text-slate-200">
          {accepted ? 'Revogar autorização' : 'Não autorizo'}
        </button>
      </div>
      <p className="text-xs text-slate-500">Termo {data.term_version}. Nada disso muda o seu pagamento automaticamente.</p>
    </div>}
  </section>;
}
