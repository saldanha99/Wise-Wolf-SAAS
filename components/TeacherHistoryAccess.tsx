import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import LessonHistoryPanel from './LessonHistoryPanel';

/** Entrada autenticada exclusiva de leitura/contestação da prestação própria.
 * Não restaura membership, perfil operacional nem acesso ao dossiê. */
export default function TeacherHistoryAccess() {
  const [userId, setUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(({ data, error: err }) => {
      if (!active) return;
      if (err) setError('Não foi possível conferir sua sessão. Entre novamente.');
      setUserId(data.session?.user.id || null); setLoading(false);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => { if (active) setUserId(session?.user.id || null); });
    return () => { active = false; subscription.unsubscribe(); };
  }, []);
  const login = async (e: React.FormEvent) => {
    e.preventDefault(); setLoading(true); setError('');
    const { data, error: err } = await supabase.auth.signInWithPassword({ email, password });
    setPassword(''); setLoading(false);
    if (err || !data.user) setError('Não foi possível entrar. Confira seu e-mail e sua senha.');
    else setUserId(data.user.id);
  };
  const logout = async () => {
    const { error: err } = await supabase.auth.signOut();
    if (err) { setError('Não foi possível sair. Tente novamente.'); return; }
    setUserId(null);
  };
  return <main className="min-h-screen bg-brand-surface text-brand-text p-4 sm:p-8"><div className="max-w-5xl mx-auto space-y-4">
    <h1 className="text-2xl font-bold">Histórico da minha prestação</h1>
    <p className="text-sm text-brand-muted">Teachers podem conferir e arquivar os próprios registros de aulas, inclusive após o encerramento. Use o e-mail e a senha da sua conta.</p>
    <a className="underline text-sm" href="/">Voltar ao portal</a>
    {error && <p role="alert" className="text-red-600">{error}</p>}
    {loading ? <p role="status">Conferindo acesso…</p> : userId ? <><button className="border border-brand-border rounded-xl px-4 py-2" onClick={logout}>Sair da conta</button><LessonHistoryPanel user={{ id: userId, role: 'TEACHER' }} /></> : <form onSubmit={login} className="max-w-md space-y-3">
      <label className="block">E-mail<input className="block w-full border border-brand-border rounded-xl p-3 bg-brand-surface" type="email" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)} /></label>
      <label className="block">Senha<input className="block w-full border border-brand-border rounded-xl p-3 bg-brand-surface" type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} /></label>
      <button className="border border-brand-border rounded-xl px-4 py-2 font-bold" disabled={loading}>Consultar meu histórico</button>
    </form>}
  </div></main>;
}
