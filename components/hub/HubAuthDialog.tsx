import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, BookOpen, Eye, EyeOff, Loader2, X } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import type { HubAudience, HubCheckoutIntent } from './types';
import {
  appendHubCheckoutIntentToUrl,
  createHubCheckoutIntent,
  persistHubCheckoutIntent,
} from './hubCheckoutIntent';
import { hubMarketingPath } from './hubRoutes';
import { HUB_THEME_STORAGE_KEY, type HubMarketingTheme } from './HubMarketingShell';

interface HubAuthDialogProps {
  initialMode: 'login' | 'signup';
  initialAudience: HubAudience;
  checkoutIntent?: HubCheckoutIntent | null;
  onClose: () => void;
  onAuthenticated: (audience: HubAudience, accountName?: string) => Promise<void>;
}

const HubAuthDialog: React.FC<HubAuthDialogProps> = ({
  initialMode,
  initialAudience,
  checkoutIntent,
  onClose,
  onAuthenticated,
}) => {
  const [mode, setMode] = useState(initialMode);
  const [audience, setAudience] = useState<HubAudience>(initialMode === 'signup' ? 'EDUCATOR' : initialAudience);
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [confirmationSent, setConfirmationSent] = useState(false);
  const continuingCheckout = mode === 'signup' && checkoutIntent != null;
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmationTitleRef = useRef<HTMLHeadingElement>(null);
  const [theme] = useState<HubMarketingTheme>(() => {
    try {
      return window.localStorage.getItem(HUB_THEME_STORAGE_KEY) === 'dark' ? 'dark' : 'light';
    } catch {
      return 'light';
    }
  });

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const focusableSelector = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusFirstControl = () => {
      const controls = dialogRef.current?.querySelectorAll<HTMLElement>(focusableSelector);
      controls?.[0]?.focus();
    };
    const focusTimer = window.setTimeout(focusFirstControl, 0);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const controls: HTMLElement[] = [];
      dialogRef.current?.querySelectorAll<HTMLElement>(focusableSelector).forEach((element) => {
        if (!element.hasAttribute('disabled')) controls.push(element);
      });
      if (controls.length === 0) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, [onClose]);

  useEffect(() => {
    if (confirmationSent) confirmationTitleRef.current?.focus();
  }, [confirmationSent]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError('');
    try {
      if (mode === 'signup') {
        if (fullName.trim().length < 3) throw new Error('Informe seu nome completo.');
        if (password.length < 8) throw new Error('Use uma senha com pelo menos 8 caracteres.');
        const redirectBase = new URL(hubMarketingPath('overview'), window.location.origin).toString();
        const refreshedIntent = checkoutIntent
          ? createHubCheckoutIntent(checkoutIntent.planCode, checkoutIntent.billingCycle)
          : null;
        try {
          if (refreshedIntent) persistHubCheckoutIntent(window.localStorage, refreshedIntent);
        } catch {}
        const { data, error: signUpError } = await supabase.auth.signUp({
          email: email.trim().toLowerCase(),
          password,
          options: {
            emailRedirectTo: refreshedIntent
              ? appendHubCheckoutIntentToUrl(redirectBase, refreshedIntent)
              : redirectBase,
            data: { full_name: fullName.trim(), hub_audience: audience },
          },
        });
        if (signUpError) throw signUpError;
        if (!data.session) {
          setConfirmationSent(true);
          return;
        }
        await onAuthenticated(audience, fullName);
        return;
      }

      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password,
      });
      if (signInError) throw signInError;
      await onAuthenticated(audience);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Não foi possível entrar agora.';
      setError(
        message.toLowerCase().includes('invalid login')
          ? 'E-mail ou senha inválidos.'
          : message,
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="hub-auth-overlay fixed inset-0 z-[100] flex items-end justify-center bg-[#020611]/90 p-0 backdrop-blur-xl sm:items-center sm:p-5" data-hub-theme={theme} role="dialog" aria-modal="true" aria-labelledby="hub-auth-title">
      <div ref={dialogRef} className="hub-auth-panel max-h-[96dvh] w-full max-w-xl overflow-y-auto rounded-t-[2rem] border border-white/10 bg-[#0b1426] p-6 text-white shadow-[0_40px_120px_-35px_rgba(0,0,0,.95)] sm:rounded-[2rem] sm:p-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.22em] text-blue-400">Wise Wolf Hub · acesso protegido</p>
            <h2 ref={confirmationTitleRef} id="hub-auth-title" tabIndex={confirmationSent ? -1 : undefined} className="mt-2 font-[Montserrat] text-3xl font-extrabold tracking-tight text-white">
              {confirmationSent
                ? 'Confirme seu e-mail'
                : mode === 'signup'
                  ? continuingCheckout ? 'Crie sua conta para continuar' : 'Comece sua descoberta grátis'
                  : 'Bem-vindo de volta'}
            </h2>
          </div>
          <button type="button" onClick={onClose} className="grid size-10 place-items-center rounded-full border border-white/10 bg-white/5 text-slate-400 hover:bg-white/10 hover:text-white" aria-label="Fechar"><X size={18} /></button>
        </div>

        {confirmationSent ? (
          <div className="py-10 text-center" role="status" aria-live="polite">
            <div className="mx-auto grid size-20 place-items-center rounded-full border border-blue-400/20 bg-blue-500/10 text-3xl">✉️</div>
            <p className="mx-auto mt-6 max-w-sm leading-7 text-slate-300">
              Enviamos o link de confirmação para <strong className="text-white">{email}</strong>. Ao confirmar, você voltará ao Hub para concluir o acesso e retomar sua escolha. A confirmação do e-mail, sozinha, não ativa plano nem cria cobrança.
            </p>
            <button onClick={onClose} className="mt-7 rounded-xl bg-blue-600 px-6 py-3.5 text-sm font-black text-white shadow-lg shadow-blue-950">Entendi</button>
          </div>
        ) : (
          <>
            {mode === 'signup' && (
              <div className="hub-auth-context mt-7 flex items-center gap-3 rounded-2xl border border-blue-400/25 bg-blue-500/10 p-4">
                <div className="grid size-11 shrink-0 place-items-center rounded-xl bg-blue-500/15 text-blue-300"><BookOpen size={20} /></div>
                <div>
                  <p className="text-sm font-black text-white">Acesso profissional para educadores</p>
                  <p className="mt-1 text-xs leading-5 text-slate-400">Biblioteca e planejamento pedagógico ficam separados do Wolfie individual e do sistema institucional.</p>
                </div>
              </div>
            )}

            <form onSubmit={submit} className="hub-auth-form mt-7 space-y-4">
              {mode === 'signup' && (
                <>
                  <label className="block">
                    <span className="mb-2 block text-xs font-black text-slate-300">Seu nome</span>
                    <input value={fullName} onChange={(event) => setFullName(event.target.value)} autoComplete="name" required className="w-full rounded-xl border border-white/10 bg-white/[0.045] px-4 py-3.5 text-white outline-none placeholder:text-slate-600 focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10" placeholder="Como devemos chamar você?" />
                  </label>
                </>
              )}
              <label className="block">
                <span className="mb-2 block text-xs font-black text-slate-300">E-mail</span>
                <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required className="w-full rounded-xl border border-white/10 bg-white/[0.045] px-4 py-3.5 text-white outline-none placeholder:text-slate-600 focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10" placeholder="voce@email.com" />
              </label>
              <label className="block">
                <span className="mb-2 block text-xs font-black text-slate-300">Senha</span>
                <div className="relative">
                  <input type={showPassword ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} required className="w-full rounded-xl border border-white/10 bg-white/[0.045] px-4 py-3.5 pr-12 text-white outline-none placeholder:text-slate-600 focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10" placeholder="Mínimo de 8 caracteres" />
                  <button type="button" onClick={() => setShowPassword((current) => !current)} className="absolute right-3 top-1/2 -translate-y-1/2 p-2 text-slate-400" aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button>
                </div>
              </label>

              {error && <p className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm font-bold text-rose-700" role="alert">{error}</p>}

              <button type="submit" disabled={loading} className="hub-auth-submit flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-5 py-4 text-sm font-black text-white shadow-[0_18px_45px_-18px_rgba(37,99,235,.9)] hover:bg-blue-500 disabled:opacity-60">
                {loading ? <Loader2 className="animate-spin" size={18} /> : <ArrowRight size={18} />}
                {loading ? 'Preparando...' : mode === 'signup' ? continuingCheckout ? 'Criar conta e continuar' : 'Criar conta e descobrir' : 'Entrar no Hub'}
              </button>
            </form>

            <p className="hub-auth-switch mt-6 text-center text-sm text-slate-400">
              {mode === 'signup' ? 'Já possui uma conta?' : 'Ainda não possui uma conta?'}{' '}
              <button type="button" onClick={() => { const nextMode = mode === 'signup' ? 'login' : 'signup'; setMode(nextMode); if (nextMode === 'signup') setAudience('EDUCATOR'); setError(''); }} className="font-black text-blue-400">
                {mode === 'signup' ? 'Entrar' : 'Começar grátis'}
              </button>
            </p>
          </>
        )}
      </div>
    </div>
  );
};

export default HubAuthDialog;
