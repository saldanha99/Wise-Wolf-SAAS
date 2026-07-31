import React, { useEffect, useState } from 'react';
import { CheckCircle2, KeyRound, Loader2, ShieldCheck } from 'lucide-react';
import { supabase } from '../lib/supabase';

const ResetPassword: React.FC = () => {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let mounted = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setReady(Boolean(data.session));
      if (!data.session) setError('Este link é inválido ou expirou. Solicite um novo convite.');
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (mounted && session) {
        setReady(true);
        setError('');
      }
    });
    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    if (password.length < 10) {
      setError('Use uma senha com pelo menos 10 caracteres.');
      return;
    }
    if (password !== confirmPassword) {
      setError('As senhas não coincidem.');
      return;
    }
    setSaving(true);
    const { error: updateError } = await supabase.auth.updateUser({ password });
    if (updateError) {
      setError('Não foi possível salvar a senha. Solicite um novo convite.');
      setSaving(false);
      return;
    }
    setDone(true);
    setSaving(false);
    await supabase.auth.signOut();
  };

  return (
    <main className="min-h-screen bg-[#06101d] text-white flex items-center justify-center px-5 py-12">
      <div className="w-full max-w-md rounded-[28px] border border-white/10 bg-[#0b192a] p-7 sm:p-9 shadow-2xl shadow-black/40">
        <div className="mb-7 flex h-13 w-13 items-center justify-center rounded-2xl bg-teal-400/15 text-teal-300">
          {done ? <CheckCircle2 size={26} /> : <ShieldCheck size={26} />}
        </div>
        <p className="mb-2 text-xs font-black tracking-[0.22em] text-teal-300">WISE WOLF</p>
        <h1 className="text-3xl font-black tracking-tight">{done ? 'Senha definida' : 'Crie sua senha'}</h1>
        <p className="mt-3 text-sm leading-6 text-slate-400">
          {done ? 'Seu acesso foi protegido. Agora você já pode entrar na plataforma.' : 'Escolha uma senha pessoal e exclusiva para ativar seu acesso.'}
        </p>

        {done ? (
          <a href="/" className="mt-8 flex w-full items-center justify-center rounded-xl bg-teal-300 px-5 py-3.5 font-black text-slate-950 transition hover:bg-teal-200">
            Ir para o login
          </a>
        ) : (
          <form className="mt-8 space-y-4" onSubmit={submit}>
            <label className="block text-sm font-bold text-slate-200">
              Nova senha
              <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={!ready || saving} className="mt-2 w-full rounded-xl border border-white/10 bg-slate-950/60 px-4 py-3 text-white outline-none ring-teal-300 transition focus:ring-2" />
            </label>
            <label className="block text-sm font-bold text-slate-200">
              Confirmar senha
              <input type="password" autoComplete="new-password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} disabled={!ready || saving} className="mt-2 w-full rounded-xl border border-white/10 bg-slate-950/60 px-4 py-3 text-white outline-none ring-teal-300 transition focus:ring-2" />
            </label>
            {error && <p role="alert" className="rounded-xl border border-red-400/20 bg-red-400/10 px-4 py-3 text-sm text-red-200">{error}</p>}
            <button type="submit" disabled={!ready || saving} className="flex w-full items-center justify-center gap-2 rounded-xl bg-teal-300 px-5 py-3.5 font-black text-slate-950 transition hover:bg-teal-200 disabled:cursor-not-allowed disabled:opacity-50">
              {saving ? <Loader2 className="animate-spin" size={18} /> : <KeyRound size={18} />}
              {saving ? 'Salvando…' : 'Definir senha'}
            </button>
          </form>
        )}
      </div>
    </main>
  );
};

export default ResetPassword;
