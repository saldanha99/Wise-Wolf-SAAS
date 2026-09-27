import React, { useCallback, useEffect, useState } from 'react';
import { ExternalLink, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { googleMeetAction } from '../lib/googleMeet';
import {
  asAuthorizationMode,
  asDecision,
  asTermSchoolIdentity,
  consentErrorMessage,
  DECISION_LABEL,
  fillTermMarkers,
  formatDecisionDate,
  googleIdentityState,
  isObjection,
  TERM_CHANGED_ERROR,
  type GoogleIdentityState,
} from '../lib/lessonRecordingConsent';

type MyConsent = {
  applies: boolean;
  decision?: string;
  decided_at?: string | null;
  term_version?: string;
  term_body?: string;
  /** Versão que o professor aceitou (20260927100000). */
  decided_term_version?: string | null;
  /** O aceite vale: é da versão vigente. Ausente = servidor antigo, vale a decisão. */
  effective?: boolean;
  /** Aceitou uma versão anterior à vigente: precisa aceitar de novo. */
  term_updated?: boolean;
  school_identity?: unknown;
  /** Como a escola autoriza o registro (20260929100000). */
  authorization_mode?: string;
  /** Pediu para não registrar (recusa ou revogação é a última decisão). */
  objected?: boolean;
  /** TERM (termo de aceite) ou NOTICE (aviso do registro autorizado pela escola). */
  term_kind?: string;
};

// Aceite do professor ao termo de registro das aulas. Sem ele, nenhuma aula
// dele é transcrita, mesmo que o aluno tenha autorizado. Antes do aceite, o
// professor confirma por login Google a conta que entra como coanfitriã da
// sala (decisão da direção, 26/09/2026): a escola não infere identidade pelo
// e-mail digitado no cadastro.
// ⚠️ Depende do backend de identidade (get_my_google_identity, ação
// teacher_identity_connect do google-meet e a trava
// teacher_google_identity_required em set_my_lesson_recording_consent), de
// outra frente: sem ele o estado é "indisponível" e ninguém aceita pela tela.
// Os dois sobem juntos (runbook, "Conta Google do professor antes do aceite").
// Termo v3 (20260927100000): o texto identifica a escola por marcadores que o
// servidor já devolve preenchidos com os dados dela (o cartão só completa, se
// sobrar algum), e o aceite de uma versão anterior não vale — o cartão diz que
// o termo mudou e volta a oferecer "Li e autorizo". O aceite manda a versão
// exibida: se a direção publicou outra com o texto aberto, o servidor recusa
// (`termo_mudou`) e o cartão recarrega o texto novo.
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
    const { data: result, error: rpcError } = await supabase.rpc('set_my_lesson_recording_consent', {
      p_accept: accept,
      // O aceite vale para o texto que está na tela.
      p_term_version: data?.term_version ?? null,
    });
    if (rpcError || result?.ok !== true) {
      const message = String(rpcError?.message || '');
      // Termo novo publicado com o texto aberto: mostra a versão nova.
      if (message.includes(TERM_CHANGED_ERROR)) await load();
      setBusy('');
      setError(consentErrorMessage(message));
      if (message.includes('teacher_google_identity_required')) void loadIdentity();
      return;
    }
    setBusy('');
    setOpen(false);
    await load();
  }

  if (!data?.applies) return null;
  const decision = asDecision(data.decision);
  // Aceite de versão anterior não vale: o professor lê o texto novo e responde de novo.
  const termUpdated = decision === 'ACCEPTED' && (data.term_updated === true || data.effective === false);
  const accepted = decision === 'ACCEPTED' && !termUpdated;
  const identityVerified = identity?.status === 'verified';
  const termText = fillTermMarkers(data.term_body, asTermSchoolIdentity(data.school_identity));
  const schoolDefault = asAuthorizationMode(data.authorization_mode) === 'SCHOOL_DEFAULT';

  const googleBlock = <div data-tour="recording-teacher-google" className="mt-3 rounded-xl border border-slate-200 bg-white p-3 text-sm dark:border-slate-700 dark:bg-slate-950">
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
        {schoolDefault
          ? 'Confirmação de conta Google indisponível por enquanto. Assim que a escola liberar, ela aparece aqui; até lá suas aulas seguem pelo link de sempre.'
          : 'Confirmação de conta Google indisponível por enquanto. Assim que a escola liberar, ela aparece aqui; até lá não dá para autorizar.'}
      </p>}
      {identity?.status === 'error' && <p className="mt-1 text-slate-600 dark:text-slate-300">
        Não foi possível conferir sua conta Google agora.{' '}
        <button type="button" disabled={!!busy} onClick={() => void refreshIdentity()} className="font-semibold text-blue-700 dark:text-blue-300">Tentar de novo</button>
      </p>}
    </div>;

  // Registro autorizado pela escola (20260929100000): não há "Li e autorizo".
  // O cartão diz que as aulas são registradas pela escola, pede só a conta
  // Google (para a sala nascer) e oferece o pedido para não registrar.
  if (schoolDefault) {
    const objected = data.objected === true || isObjection(data.decision);
    const ready = !objected && identityVerified;
    const object = async () => {
      if (!window.confirm('Pedir para não registrar as suas aulas? A partir de agora elas acontecem normalmente, sem transcrição (a sala da escola é desligada). Dá para voltar atrás aqui mesmo.')) return;
      await decide(false);
    };
    return <section data-tour="recording-teacher-consent" className={`rounded-2xl border p-4 ${ready ? 'border-emerald-200 bg-emerald-50 dark:bg-slate-900' : 'border-amber-200 bg-amber-50 dark:bg-slate-900'}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 font-bold text-slate-800 dark:text-slate-100"><ShieldCheck size={18} /> Registro das suas aulas</h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
            {objected
              ? `Você pediu para não registrar as suas aulas${data.decided_at ? ` em ${formatDecisionDate(data.decided_at)}` : ''}. Elas acontecem normalmente, sem transcrição.`
              : identityVerified
                ? 'A escola registra as aulas (transcrição pelo Google Meet, sem vídeo), e sua conta Google está confirmada: suas aulas ganham a sala da escola. Se não quiser ser registrado, é só pedir.'
                : 'A escola registra as aulas (transcrição pelo Google Meet, sem vídeo). Confirme sua conta Google abaixo: a sala da escola só nasce para as suas aulas depois disso. Se não quiser ser registrado, é só pedir.'}
          </p>
        </div>
        <button type="button" onClick={() => setOpen(value => !value)} className="text-sm font-semibold text-blue-700 dark:text-blue-300">
          {open ? 'Fechar aviso' : 'Ler o aviso'}
        </button>
      </div>

      {!objected && googleBlock}

      {open && <div className="mt-3 max-h-72 overflow-y-auto whitespace-pre-line rounded-xl border border-slate-200 bg-white p-4 text-sm leading-relaxed text-slate-700 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200">
        {termText}
      </div>}
      {error && <p role="alert" className="mt-2 text-sm font-semibold text-red-600">{error}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {objected
          ? <button type="button" disabled={!!busy} onClick={() => void decide(true)} className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-bold text-white disabled:opacity-40">
              {busy === 'decide' && <Loader2 size={14} className="animate-spin" />} Voltar a registrar minhas aulas
            </button>
          : <button type="button" data-tour="recording-teacher-objection" disabled={!!busy} onClick={() => void object()} className="rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-bold text-slate-700 disabled:opacity-40 dark:text-slate-200">
              {busy === 'decide' ? 'Gravando…' : 'Não quero que minhas aulas sejam registradas'}
            </button>}
        <span className="text-xs text-slate-500">Aviso {data.term_version}. Nada disso muda o seu pagamento.</span>
      </div>
    </section>;
  }

  return <section data-tour="recording-teacher-consent" className={`rounded-2xl border p-4 ${accepted ? 'border-emerald-200 bg-emerald-50 dark:bg-slate-900' : 'border-amber-200 bg-amber-50 dark:bg-slate-900'}`}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="flex items-center gap-2 font-bold text-slate-800 dark:text-slate-100"><ShieldCheck size={18} /> Registro das suas aulas</h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
          {termUpdated
            ? `O termo mudou${data.decided_term_version ? `: você autorizou a versão ${data.decided_term_version}` : ''} e a vigente é a ${data.term_version || 'nova'}. Leia a nova versão e autorize de novo — até lá suas aulas não são transcritas.`
            : accepted
            ? `Você autorizou em ${formatDecisionDate(data.decided_at)}. As aulas dos alunos que também autorizaram passam a ser transcritas.`
            : decision === 'NONE'
              ? 'As aulas na sala da escola podem ser transcritas para registrar o que foi trabalhado. Confirme sua conta Google, leia o termo e responda.'
              : `Situação: ${DECISION_LABEL[decision]}. Suas aulas não são transcritas.`}
        </p>
      </div>
      <button type="button" onClick={() => setOpen(value => !value)} className="text-sm font-semibold text-blue-700 dark:text-blue-300">
        {open ? 'Fechar termo' : accepted ? 'Ver termo' : termUpdated ? 'Ler a nova versão' : 'Ler e responder'}
      </button>
    </div>

    {googleBlock}

    {open && <div className="mt-3 space-y-3">
      <div className="max-h-72 overflow-y-auto whitespace-pre-line rounded-xl border border-slate-200 bg-white p-4 text-sm leading-relaxed text-slate-700 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200">
        {termText}
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
