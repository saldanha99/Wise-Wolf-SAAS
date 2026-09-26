import React, { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Loader2, ShieldCheck, XCircle } from 'lucide-react';
import { supabase } from '../lib/supabase';
import {
  asDecision,
  consentErrorMessage,
  DECISION_LABEL,
  isFullName,
  normalizeSignerName,
  type RecordingDecision,
} from '../lib/lessonRecordingConsent';

// Página pública do termo de registro das aulas (aluno ou responsável, sem
// login). Fica no SPA, como a troca de plano e a confirmação de presença.

interface ConsentPublic {
  found: boolean;
  expired?: boolean;
  school_name?: string | null;
  student_first_name?: string | null;
  requires_guardian?: boolean;
  term_version?: string;
  term_body?: string;
  current_decision?: string;
}

export default function LessonRecordingConsentPage() {
  const token = new URLSearchParams(window.location.search).get('token') || '';
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<ConsentPublic | null>(null);
  const [relation, setRelation] = useState<'SELF' | 'GUARDIAN' | ''>('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<RecordingDecision | null>(null);

  useEffect(() => {
    if (!/^[a-f0-9]{64}$/.test(token)) {
      setData({ found: false });
      setLoading(false);
      return;
    }
    (async () => {
      const { data: result, error: rpcError } = await supabase.rpc('get_lesson_recording_consent_public', { p_token: token });
      if (rpcError || !result) setData({ found: false });
      else {
        setData(result as ConsentPublic);
        if ((result as ConsentPublic).requires_guardian) setRelation('GUARDIAN');
      }
      setLoading(false);
    })();
  }, [token]);

  async function decide(accept: boolean) {
    setError('');
    if (!relation) { setError('Escolha se você é o aluno ou o responsável.'); return; }
    if (!isFullName(name)) { setError('Digite nome e sobrenome.'); return; }
    setBusy(true);
    const { data: result, error: rpcError } = await supabase.rpc('decide_lesson_recording_consent_public', {
      p_token: token,
      p_signer_name: normalizeSignerName(name),
      p_relation: relation,
      p_accept: accept,
    });
    setBusy(false);
    if (rpcError || !result?.ok) {
      setError(consentErrorMessage(rpcError?.message));
      return;
    }
    setDone(asDecision(result.decision));
  }

  if (loading) {
    return <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-100">
      <Loader2 className="animate-spin text-[#002366]" size={40} />
      <p className="text-[11px] font-bold uppercase tracking-widest text-slate-500">Carregando…</p>
    </div>;
  }

  if (!data?.found) {
    return <div className="flex min-h-screen items-center justify-center bg-slate-100 p-4">
      <div className="w-full max-w-md rounded-3xl bg-white p-8 text-center shadow-xl">
        <AlertCircle size={44} className="mx-auto mb-4 text-amber-500" />
        <h1 className="mb-2 text-lg font-black text-slate-800">Link indisponível</h1>
        <p className="text-sm text-slate-500">
          {data?.expired ? 'Este link expirou ou foi substituído por um mais novo.' : 'Não encontramos este link.'} Peça um novo à escola pelo WhatsApp.
        </p>
      </div>
    </div>;
  }

  if (done) {
    const accepted = done === 'ACCEPTED';
    return <div className="flex min-h-screen items-center justify-center bg-slate-100 p-4">
      <div className="w-full max-w-md rounded-3xl bg-white p-8 text-center shadow-xl">
        {accepted
          ? <CheckCircle2 size={48} className="mx-auto mb-4 text-emerald-500" />
          : <XCircle size={48} className="mx-auto mb-4 text-slate-400" />}
        <h1 className="mb-2 text-xl font-black text-slate-800">{accepted ? 'Autorização registrada' : 'Resposta registrada'}</h1>
        <p className="text-sm text-slate-500">
          {accepted
            ? 'Obrigado! As próximas aulas passam a ser transcritas para registrar o que foi trabalhado.'
            : 'As aulas continuam normalmente, sem transcrição.'} Se mudar de ideia, é só abrir este mesmo link de novo.
        </p>
      </div>
    </div>;
  }

  const current = asDecision(data.current_decision);
  const firstName = data.student_first_name?.trim() || 'o aluno';

  return <div className="min-h-screen bg-slate-100 px-4 py-8">
    <div className="mx-auto max-w-lg space-y-4">
      <div className="text-center">
        <ShieldCheck size={32} className="mx-auto mb-2 text-[#002366]" />
        <h1 className="text-xl font-black text-slate-800">Registro das aulas</h1>
        <p className="mt-1 text-xs font-medium text-slate-500">{data.school_name || 'Wise Wolf'} · termo {data.term_version}</p>
      </div>

      <div className="space-y-5 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-sm text-slate-600">
          Este termo é sobre as aulas de <b className="text-slate-800">{firstName}</b>. Leia com calma e responda abaixo.
        </p>
        {current !== 'NONE' && <p className="rounded-2xl bg-slate-50 p-3 text-xs text-slate-600">
          Situação atual: <b>{DECISION_LABEL[current]}</b>. Você pode responder de novo; vale a resposta mais recente.
        </p>}

        <div className="max-h-[50vh] overflow-y-auto whitespace-pre-line rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm leading-relaxed text-slate-700">
          {data.term_body}
        </div>

        {data.requires_guardian
          ? <p className="rounded-2xl bg-amber-50 p-3 text-xs font-semibold text-amber-800">
              Como {firstName} é menor de idade, quem responde é o responsável legal.
            </p>
          : <fieldset className="space-y-2">
              <legend className="mb-1 text-[10px] font-black uppercase tracking-widest text-slate-500">Quem está respondendo</legend>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input type="radio" name="relation" checked={relation === 'SELF'} onChange={() => setRelation('SELF')} />
                Sou o aluno
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input type="radio" name="relation" checked={relation === 'GUARDIAN'} onChange={() => setRelation('GUARDIAN')} />
                Sou o responsável
              </label>
            </fieldset>}

        <label className="block">
          <span className="mb-2 block text-[10px] font-black uppercase tracking-widest text-slate-500">Seu nome completo</span>
          <input
            value={name}
            onChange={event => setName(event.target.value)}
            autoComplete="name"
            className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3.5 text-base text-slate-800 outline-none focus:border-[#002366] focus:ring-2 focus:ring-[#002366]/30"
          />
        </label>

        {error && <p role="alert" className="text-xs font-bold text-red-600">{error}</p>}

        <div className="grid gap-3 sm:grid-cols-2">
          <button type="button" disabled={busy} onClick={() => void decide(true)}
            className="flex items-center justify-center gap-2 rounded-2xl bg-[#002366] py-4 text-[11px] font-black uppercase tracking-widest text-white hover:bg-blue-900 disabled:opacity-40">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />} Autorizo
          </button>
          <button type="button" disabled={busy} onClick={() => void decide(false)}
            className="rounded-2xl border border-slate-300 py-4 text-[11px] font-black uppercase tracking-widest text-slate-600 hover:bg-slate-50 disabled:opacity-40">
            Não autorizo
          </button>
        </div>
        <p className="text-center text-[10px] leading-relaxed text-slate-400">
          Registramos o nome digitado, a data e a hora da resposta e o endereço de conexão (IP).
        </p>
      </div>
    </div>
  </div>;
}
