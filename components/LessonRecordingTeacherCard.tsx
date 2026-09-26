import React, { useCallback, useEffect, useState } from 'react';
import { ExternalLink, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { googleMeetAction } from '../lib/googleMeet';
import {
  asDecision,
  consentErrorMessage,
  DECISION_LABEL,
  formatDecisionDate,
  googleIdentityState,
  type GoogleIdentityState,
} from '../lib/lessonRecordingConsent';

type MyConsent = { applies: boolean; decision?: string; decided_at?: string | null; term_version?: string; term_body?: string };

// Aceite do professor ao termo de registro das aulas. Sem ele, nenhuma aula
// dele é transcrita, mesmo que o aluno tenha autorizado. Antes do aceite, o
// professor confirma por login Google a conta que entra como coanfitriã da
// sala (decisão da direção, 26/09/2026): a escola não infere identidade pelo
// e-mail digitado no cadastro.
export default function LessonRecordingTeacherCard() {
  const [data, setData] = useState<MyConsent | null>(null);
  const [identity, setIdentity] = useState<GoogleIdentityState | null>(null);
  const [busy, setBusy] = useState<'' | 'decide' | 'connect' | 'identity'>('');
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [authorizationUrl, setAuthorizationUrl] = useState('');

  const loadIdentity = useCallback(async () => {
    const { data: result, error: rpcError } = await supabase.rpc('get_my_google_identity');
    setIdentity(googleIdentityState(result, rpcError));
  }, []);

  const load = useCallback(async () => {
    const { data: result, error: rpcError } = await supabase.rpc('get_my_lesson_recording_consent');
    if (!rpcError && result) setData(result as MyConsent);
  }, []);
  useEffect(() => { void load(); void loadIdentity(); }, [load, loadIdentity]);

  async function refreshIdentity() {
    setBusy('identity'); setError('');
    await loadIdentity();
    setBusy('');
  }

  async function connectGoogle() {
    setBusy('connect'); setError(''); setAuthorizationUrl('');
    try {
      const result = await googleMeetAction<{ authorization_url?: string }>('teacher_identity_connect');
      if (result?.authorization_url) setAuthorizationUrl(result.authorization_url);
      else setError('Não foi possível abrir o login do Google agora. Tente de novo em instantes.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function decide(accept: boolean) {
    setBusy('decide'); setError('');
    const { data: result, error: rpcError } = await supabase.rpc('set_my_lesson_recording_consent', { p_accept: accept });
    setBusy('');
    if (rpcError || result?.ok !== true) {
      setError(consentErrorMessage(rpcError?.message));
      if (String(rpcError?.message || '').includes('teacher_google_identity_required')) void loadIdentity();
      return;
    }
    setOpen(false);
    await load();
  }

  if (!data?.applies) return null;
  const decision = asDecision(data.decision);
  const accepted = decision === 'ACCEPTED';
  const identityVerified = identity?.status === 'verified';

  return <section data-tour="recording-teacher-consent" className={`rounded-2xl border p-4 ${accepted ? 'border-emerald-200 bg-emerald-50 dark:bg-slate-900' : 'border-amber-200 bg-amber-50 dark:bg-slate-900'}`}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="flex items-center gap-2 font-bold text-slate-800 dark:text-slate-100"><ShieldCheck size={18} /> Registro das suas aulas</h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
          {accepted
            ? `Você autorizou em ${formatDecisionDate(data.decided_at)}. As aulas dos alunos que também autorizaram passam a ser transcritas.`
            : decision === 'NONE'
              ? 'As aulas na sala da escola podem ser transcritas para registrar o que foi trabalhado. Confirme sua conta Google, leia o termo e responda.'
              : `Situação: ${DECISION_LABEL[decision]}. Suas aulas não são transcritas.`}
        </p>
      </div>
      <button type="button" onClick={() => setOpen(value => !value)} className="text-sm font-semibold text-blue-700 dark:text-blue-300">
        {open ? 'Fechar termo' : accepted ? 'Ver termo' : 'Ler e responder'}
      </button>
    </div>

    <div data-tour="recording-teacher-google" className="mt-3 rounded-xl border border-slate-200 bg-white p-3 text-sm dark:border-slate-700 dark:bg-slate-950">
      <p className="font-semibold text-slate-800 dark:text-slate-100">Conta Google da sala</p>
      {identity === null && <p className="mt-1 flex items-center gap-2 text-slate-500"><Loader2 size={14} className="animate-spin" /> Conferindo…</p>}
      {identity?.status === 'verified' && <p className="mt-1 text-slate-600 dark:text-slate-300">
        Confirmada: <b>{identity.email}</b> em {formatDecisionDate(identity.verifiedAt)}. É com ela que você entra como coanfitrião.
      </p>}
      {identity?.status === 'missing' && <>
        <p className="mt-1 text-slate-600 dark:text-slate-300">
          {identity.email
            ? <>A conta <b>{identity.email}</b> ainda não foi confirmada.</>
            : 'Você ainda não confirmou a conta Google com que entra nas aulas.'} Entre com ela no Google para a escola te colocar como coanfitrião da sala.
        </p>
        <div className="mt-2 flex flex-wrap gap-3">
          <button type="button" disabled={!!busy} onClick={() => void connectGoogle()} className="rounded-xl bg-indigo-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-40">
            {busy === 'connect' ? 'Preparando…' : 'Confirmar conta Google'}
          </button>
          <button type="button" disabled={!!busy} onClick={() => void refreshIdentity()} className="inline-flex items-center gap-1 rounded-xl border border-slate-300 px-3 py-2 text-xs font-bold text-slate-700 disabled:opacity-40 dark:text-slate-200">
            {busy === 'identity' ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Já confirmei
          </button>
        </div>
        {authorizationUrl && <p className="mt-2 text-xs text-indigo-900 dark:text-indigo-200">
          <a href={authorizationUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-bold">Entrar com o Google <ExternalLink size={12} /></a>
          {' '}— abre em outra aba e vale por dez minutos. Depois volte aqui e toque em “Já confirmei”.
        </p>}
      </>}
      {identity?.status === 'unavailable' && <p className="mt-1 text-slate-600 dark:text-slate-300">
        Confirmação de conta Google indisponível por enquanto. Assim que a escola liberar, ela aparece aqui; até lá não dá para autorizar.
      </p>}
      {identity?.status === 'error' && <p className="mt-1 text-slate-600 dark:text-slate-300">
        Não foi possível conferir sua conta Google agora.{' '}
        <button type="button" disabled={!!busy} onClick={() => void refreshIdentity()} className="font-semibold text-blue-700 dark:text-blue-300">Tentar de novo</button>
      </p>}
    </div>

    {open && <div className="mt-3 space-y-3">
      <div className="max-h-72 overflow-y-auto whitespace-pre-line rounded-xl border border-slate-200 bg-white p-4 text-sm leading-relaxed text-slate-700 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200">
        {data.term_body}
      </div>
      {error && <p role="alert" className="text-sm font-semibold text-red-600">{error}</p>}
      <div className="flex flex-wrap gap-3">
        {!accepted && <button type="button" disabled={!!busy || !identityVerified} onClick={() => void decide(true)} className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-bold text-white disabled:opacity-40">
          {busy === 'decide' && <Loader2 size={14} className="animate-spin" />} Li e autorizo
        </button>}
        <button type="button" disabled={!!busy} onClick={() => void decide(false)} className="rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-bold text-slate-700 disabled:opacity-40 dark:text-slate-200">
          {accepted ? 'Revogar autorização' : 'Não autorizo'}
        </button>
      </div>
      {!accepted && !identityVerified && <p className="text-xs text-slate-500">
        “Li e autorizo” fica disponível depois que você confirmar a conta Google acima.
      </p>}
      <p className="text-xs text-slate-500">Termo {data.term_version}. Nada disso muda o seu pagamento automaticamente.</p>
    </div>}
    {!open && error && <p role="alert" className="mt-2 text-sm font-semibold text-red-600">{error}</p>}
  </section>;
}
