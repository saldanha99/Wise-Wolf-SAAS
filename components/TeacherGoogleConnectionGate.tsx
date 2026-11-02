import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, ExternalLink, Loader2, ShieldCheck } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { googleMeetAction } from '../lib/googleMeet';
import { googleIdentityState } from '../lib/lessonRecordingConsent';
import { openGoogleAuthorization } from '../lib/googleAuthorizationWindow';

/** Required identity setup for teachers in the school's automatic recording mode. */
export default function TeacherGoogleConnectionGate({ onActiveChange, onLogout }: {
  onActiveChange: (active: boolean) => void;
  onLogout: () => void;
}) {
  const [phase, setPhase] = useState<'checking' | 'missing' | 'confirmed' | 'error' | 'done'>('checking');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fallbackUrl, setFallbackUrl] = useState('');
  const [waiting, setWaiting] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const alive = useRef(true);
  const initial = useRef(true);
  const checking = useRef(false);

  const check = useCallback(async () => {
    if (checking.current) return;
    checking.current = true;
    try {
      const { data, error: rpcError } = await supabase.rpc('get_my_google_identity');
      if (!alive.current) return;
      const identity = googleIdentityState(data, rpcError);
      if (identity.status === 'verified') {
        setEmail(identity.email);
        setPhase(initial.current ? 'done' : 'confirmed');
        setWaiting(false);
        setError('');
      } else if (identity.status === 'missing') {
        setPhase('missing');
      } else {
        setPhase('error');
        setError('Não foi possível conferir sua conexão agora. Tente novamente. Se continuar, avise a escola.');
      }
      initial.current = false;
    } catch {
      if (alive.current) {
        initial.current = false;
        setPhase('error');
        setError('Não foi possível conferir sua conexão agora. Tente novamente.');
      }
    } finally { checking.current = false; }
  }, []);

  useEffect(() => {
    alive.current = true;
    void check();
    return () => { alive.current = false; };
  }, [check]);

  const active = phase !== 'done';
  useEffect(() => { onActiveChange(active); }, [active, onActiveChange]);
  useEffect(() => () => onActiveChange(false), [onActiveChange]);
  useEffect(() => {
    if (!active) return;
    const node = dialog.current;
    if (node && !node.open) node.showModal();
    return () => { if (node?.open) node.close(); };
  }, [active]);

  useEffect(() => {
    if (!waiting) return;
    const refresh = () => { if (document.visibilityState === 'visible') void check(); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    const timer = window.setInterval(refresh, 5000);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
      window.clearInterval(timer);
    };
  }, [waiting, check]);

  async function connect() {
    setBusy(true); setError(''); setFallbackUrl('');
    try {
      const { result, opened } = await openGoogleAuthorization(() =>
        googleMeetAction<{ authorization_url?: string }>('teacher_identity_connect'));
      if (!alive.current) return;
      setWaiting(true);
      if (!opened) setFallbackUrl(result.authorization_url || '');
    } catch (err) {
      if (alive.current) setError((err as Error).message);
    } finally { if (alive.current) setBusy(false); }
  }

  if (!active) return null;
  return <dialog ref={dialog} onCancel={event => event.preventDefault()} aria-labelledby="teacher-google-title"
    aria-describedby="teacher-google-description"
    className="m-auto w-[calc(100%-2rem)] max-w-lg max-h-[90dvh] overflow-y-auto rounded-3xl border-0 bg-white p-6 text-slate-900 shadow-2xl backdrop:bg-slate-950/70 dark:bg-slate-900 dark:text-white sm:p-8">
    <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-100 text-indigo-700"><ShieldCheck size={26} /></div>
    <p className="mb-2 text-xs font-bold uppercase tracking-wide text-indigo-600 dark:text-indigo-300">Configuração obrigatória · Professores</p>
    <h2 id="teacher-google-title" className="text-2xl font-bold">Conecte a conta que você usa nas aulas</h2>
    <p id="teacher-google-description" className="mt-3 text-sm leading-6 text-slate-600 dark:text-slate-300">
      Para continuar no portal, confirme a mesma conta Google com que você entra no Google Meet.
      Ela será sua conta de coanfitrião nas salas oficiais da escola. Pode ser diferente do e-mail de acesso ao portal.
    </p>
    {phase === 'checking' ? <p role="status" className="mt-6 flex items-center gap-2"><Loader2 className="animate-spin" size={18} /> Conferindo sua conexão…</p>
      : phase === 'confirmed' ? <div className="mt-6">
        <p role="status" className="flex items-center gap-2 font-bold text-emerald-700 dark:text-emerald-300"><CheckCircle2 size={20} /> Conta Google conectada</p>
        <p className="mt-2 break-all font-semibold">{email}</p>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">Entre nas aulas com essa conta e use o link oficial de cada aula na plataforma.</p>
        <button type="button" onClick={() => setPhase('done')} className="mt-5 w-full rounded-xl bg-indigo-600 px-4 py-3 font-bold text-white">Continuar no portal</button>
      </div> : <>
        <ol className="my-5 list-decimal space-y-2 pl-5 text-sm leading-6">
          <li>Toque no botão abaixo para abrir o Google.</li>
          <li>Escolha a conta que você realmente usa nas reuniões. Se aparecer outra conta, selecione “Usar outra conta”.</li>
          <li>Conclua o login e volte a esta aba. Conferimos a conexão automaticamente.</li>
        </ol>
        <button data-tour="teacher-google-required-connect" type="button" disabled={busy} onClick={() => void connect()}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-3 font-bold text-white disabled:opacity-50">
          {busy ? <Loader2 size={18} className="animate-spin" /> : <ExternalLink size={18} />}
          {busy ? 'Abrindo o Google…' : 'Conectar minha conta do Google Meet'}
        </button>
        {fallbackUrl && <div className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-slate-900">
          <p>Seu navegador bloqueou a nova aba. Abra o login pelo botão abaixo.</p>
          <a href={fallbackUrl} target="_blank" rel="noopener noreferrer" className="mt-2 flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-3 font-bold text-white">Abrir login do Google <ExternalLink size={16} /></a>
        </div>}
        {waiting && <p role="status" className="mt-3 text-sm">Aguardando a confirmação do Google. Conclua o login e volte para cá.</p>}
        <button type="button" disabled={busy} onClick={() => void check()} className="mt-3 w-full rounded-xl border border-slate-300 px-4 py-3 text-sm font-semibold disabled:opacity-50">Já conectei · Conferir novamente</button>
      </>}
    {error && <p role="alert" className="mt-4 rounded-xl bg-red-50 p-3 text-sm text-red-800">{error}</p>}
    <button type="button" onClick={onLogout} className="mt-5 w-full py-2 text-sm text-slate-500 dark:text-slate-400">Sair da conta do portal</button>
  </dialog>;
}
