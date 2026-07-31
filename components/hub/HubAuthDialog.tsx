import React, { useState } from 'react';
import { ArrowRight, BookOpen, Bot, Building2, Eye, EyeOff, Loader2, X } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import type { HubAudience } from './types';

interface HubAuthDialogProps {
  initialMode: 'login' | 'signup';
  initialAudience: HubAudience;
  onClose: () => void;
  onAuthenticated: (audience: HubAudience, accountName?: string) => Promise<void>;
}

const AUDIENCES: Array<{
  value: HubAudience;
  label: string;
  description: string;
  icon: React.ElementType;
}> = [
  { value: 'EDUCATOR', label: 'Professor', description: 'Materiais e IA para ensinar', icon: BookOpen },
  { value: 'LEARNER', label: 'Aprendiz', description: 'Prática de inglês com Wolfie', icon: Bot },
  { value: 'INSTITUTION', label: 'Instituição', description: 'Equipe e operação escolar', icon: Building2 },
];

const HubAuthDialog: React.FC<HubAuthDialogProps> = ({
  initialMode,
  initialAudience,
  onClose,
  onAuthenticated,
}) => {
  const [mode, setMode] = useState(initialMode);
  const [audience, setAudience] = useState<HubAudience>(initialAudience);
  const [fullName, setFullName] = useState('');
  const [accountName, setAccountName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [confirmationSent, setConfirmationSent] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError('');
    try {
      if (mode === 'signup') {
        if (fullName.trim().length < 3) throw new Error('Informe seu nome completo.');
        if (password.length < 8) throw new Error('Use uma senha com pelo menos 8 caracteres.');
        const { data, error: signUpError } = await supabase.auth.signUp({
          email: email.trim().toLowerCase(),
          password,
          options: {
            emailRedirectTo: `${window.location.origin}/hub`,
            data: { full_name: fullName.trim(), hub_audience: audience },
          },
        });
        if (signUpError) throw signUpError;
        if (!data.session) {
          setConfirmationSent(true);
          return;
        }
        await onAuthenticated(audience, accountName || fullName);
        return;
      }

      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password,
      });
      if (signInError) throw signInError;
      await onAuthenticated(audience, accountName || undefined);
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
    <div className="fixed inset-0 z-[100] flex items-end justify-center bg-[#020611]/90 p-0 backdrop-blur-xl sm:items-center sm:p-5" role="dialog" aria-modal="true" aria-labelledby="hub-auth-title">
      <div className="max-h-[96dvh] w-full max-w-xl overflow-y-auto rounded-t-[2rem] border border-white/10 bg-[#0b1426] p-6 text-white shadow-[0_40px_120px_-35px_rgba(0,0,0,.95)] sm:rounded-[2rem] sm:p-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.22em] text-blue-400">Wise Wolf Hub · Premium access</p>
            <h2 id="hub-auth-title" className="mt-2 font-[Montserrat] text-3xl font-extrabold tracking-tight text-white">
              {confirmationSent ? 'Confirme seu e-mail' : mode === 'signup' ? 'Comece seu teste grátis' : 'Bem-vindo de volta'}
            </h2>
          </div>
          <button onClick={onClose} className="grid size-10 place-items-center rounded-full border border-white/10 bg-white/5 text-slate-400 hover:bg-white/10 hover:text-white" aria-label="Fechar"><X size={18} /></button>
        </div>

        {confirmationSent ? (
          <div className="py-10 text-center">
            <div className="mx-auto grid size-20 place-items-center rounded-full border border-blue-400/20 bg-blue-500/10 text-3xl">✉️</div>
            <p className="mx-auto mt-6 max-w-sm leading-7 text-slate-300">
              Enviamos o link de confirmação para <strong className="text-white">{email}</strong>. Depois de confirmar, volte para o Hub e seu teste será ativado.
            </p>
            <button onClick={onClose} className="mt-7 rounded-xl bg-blue-600 px-6 py-3.5 text-sm font-black text-white shadow-lg shadow-blue-950">Entendi</button>
          </div>
        ) : (
          <>
            {mode === 'signup' && (
              <div className="mt-7 grid grid-cols-3 gap-2">
                {AUDIENCES.map(({ value, label, description, icon: Icon }) => (
                  <button key={value} type="button" onClick={() => setAudience(value)} className={`rounded-2xl border p-3 text-left transition ${audience === value ? 'border-blue-400/60 bg-blue-500/15 ring-2 ring-blue-500/10' : 'border-white/10 bg-white/[0.025] hover:border-white/20'}`}>
                    <Icon size={19} className={audience === value ? 'text-blue-400' : 'text-slate-500'} />
                    <p className="mt-2 text-xs font-black text-white">{label}</p>
                    <p className="mt-1 hidden text-[10px] leading-4 text-slate-400 sm:block">{description}</p>
                  </button>
                ))}
              </div>
            )}

            <form onSubmit={submit} className="mt-7 space-y-4">
              {mode === 'signup' && (
                <>
                  <label className="block">
                    <span className="mb-2 block text-xs font-black text-slate-300">Seu nome</span>
                    <input value={fullName} onChange={(event) => setFullName(event.target.value)} autoComplete="name" required className="w-full rounded-xl border border-white/10 bg-white/[0.045] px-4 py-3.5 text-white outline-none placeholder:text-slate-600 focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10" placeholder="Como devemos chamar você?" />
                  </label>
                  {audience === 'INSTITUTION' && (
                    <label className="block">
                      <span className="mb-2 block text-xs font-black text-slate-300">Nome da instituição</span>
                      <input value={accountName} onChange={(event) => setAccountName(event.target.value)} required className="w-full rounded-xl border border-white/10 bg-white/[0.045] px-4 py-3.5 text-white outline-none placeholder:text-slate-600 focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10" placeholder="Nome da escola ou instituição" />
                    </label>
                  )}
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

              <button type="submit" disabled={loading} className="flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-5 py-4 text-sm font-black text-white shadow-[0_18px_45px_-18px_rgba(37,99,235,.9)] hover:bg-blue-500 disabled:opacity-60">
                {loading ? <Loader2 className="animate-spin" size={18} /> : <ArrowRight size={18} />}
                {loading ? 'Preparando...' : mode === 'signup' ? 'Criar conta e testar' : 'Entrar no Hub'}
              </button>
            </form>

            <p className="mt-6 text-center text-sm text-slate-400">
              {mode === 'signup' ? 'Já possui uma conta?' : 'Ainda não possui uma conta?'}{' '}
              <button onClick={() => { setMode(mode === 'signup' ? 'login' : 'signup'); setError(''); }} className="font-black text-blue-400">
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
