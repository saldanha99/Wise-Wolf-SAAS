import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

// Página PÚBLICA (sem login) de confirmação de presença pelo aluno.
// Acessada pelo link 1-clique enviado no WhatsApp: /confirmar-presenca?token=...
// Servida pelo SPA (domínio do app) — edge functions do Supabase não renderizam HTML (CSP sandbox).

type Resp = 'STUDENT_PRESENT' | 'TEACHER_NO_SHOW' | 'STUDENT_SELF_ABSENT';

const ConfirmAttendance: React.FC = () => {
  const token = new URLSearchParams(window.location.search).get('token') || '';
  const [loading, setLoading] = useState(true);
  const [info, setInfo] = useState<any>(null);
  const [sending, setSending] = useState<Resp | null>(null);
  const [done, setDone] = useState<Resp | 'already' | null>(null);
  const [error, setError] = useState<string>('');

  useEffect(() => {
    (async () => {
      if (!token) { setError('Link inválido.'); setLoading(false); return; }
      const { data, error } = await supabase.rpc('get_confirmation_public', { p_token: token });
      if (error || !data || data.found !== true) {
        setError('Link inválido ou expirado.');
      } else {
        setInfo(data);
        if (data.already) setDone('already');
      }
      setLoading(false);
    })();
  }, [token]);

  const responder = async (r: Resp) => {
    setSending(r);
    setError('');
    const { data, error } = await supabase.rpc('apply_student_response', { p_token: token, p_response: r });
    if (error || (data && data.ok === false)) {
      setError('Não foi possível registrar. Tente novamente.');
      setSending(null);
      return;
    }
    setDone(r);
    setSending(null);
  };

  const aluno = (info?.student_name || '').split(' ')[0] || '';
  const prof = info?.teacher_name || 'seu professor';
  const dataFmt = info?.class_date
    ? new Date(info.class_date + 'T00:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: 'long' })
    : '';
  const hora = info?.class_time ? ` às ${String(info.class_time).slice(0, 5)}` : '';

  const wrap = (children: React.ReactNode) => (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: 'linear-gradient(160deg,#0f172a 0%,#1e1b4b 100%)' }}>
      <div style={{ background: '#fff', color: '#0f172a', borderRadius: 28, maxWidth: 420, width: '100%', padding: '32px 28px', boxShadow: '0 30px 60px -20px rgba(0,0,0,.5)', textAlign: 'center', fontFamily: '-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif' }}>
        {children}
      </div>
    </div>
  );

  if (loading) return wrap(<p style={{ color: '#475569' }}>Carregando…</p>);

  if (error && !info) return wrap(<>
    <div style={{ fontSize: 46, marginBottom: 8 }}>🐺</div>
    <h1 style={{ fontSize: 20, fontWeight: 800 }}>{error}</h1>
    <p style={{ fontSize: 14, color: '#475569', marginTop: 8 }}>Pode fechar esta página.</p>
  </>);

  if (done) {
    let msg = 'Obrigado pela confirmação!';
    if (done === 'STUDENT_PRESENT') msg = 'Que bom que sua aula aconteceu! 🎉';
    else if (done === 'TEACHER_NO_SHOW') msg = 'Registramos que o professor não compareceu. Nossa equipe vai verificar. 🙏';
    else if (done === 'STUDENT_SELF_ABSENT') msg = 'Tudo bem, registramos sua ausência. Te esperamos na próxima! 💪';
    else if (done === 'already') msg = 'Você já havia respondido. Obrigado!';
    return wrap(<>
      <div style={{ fontSize: 54, marginBottom: 10 }}>✅</div>
      <h1 style={{ fontSize: 20, fontWeight: 800 }}>Resposta registrada</h1>
      <p style={{ fontSize: 14, color: '#475569', marginTop: 8 }}>{msg}</p>
      <p style={{ fontSize: 12, color: '#94a3b8', marginTop: 18 }}>Obrigado{aluno ? `, ${aluno}` : ''}. Pode fechar esta página.</p>
    </>);
  }

  const btn = (r: Resp, label: string, bg: string, color: string, border?: string) => (
    <button
      onClick={() => responder(r)}
      disabled={!!sending}
      style={{ display: 'block', width: '100%', textAlign: 'center', padding: 16, borderRadius: 16, fontWeight: 700, fontSize: 15, background: bg, color, border: border || 'none', cursor: 'pointer', opacity: sending && sending !== r ? 0.5 : 1 }}
    >
      {sending === r ? 'Enviando…' : label}
    </button>
  );

  return wrap(<>
    <div style={{ fontSize: 46, marginBottom: 8 }}>🐺</div>
    <h1 style={{ fontSize: 20, fontWeight: 800, lineHeight: 1.3 }}>Oi {aluno}! Sobre sua aula{dataFmt ? ` de ${dataFmt}${hora}` : ''}</h1>
    <p style={{ fontSize: 14, color: '#475569', margin: '8px 0' }}>Com <b>{prof}</b>. Pra gente manter a qualidade, confirme rapidinho o que aconteceu:</p>
    <div style={{ background: '#f1f5f9', borderRadius: 14, padding: '12px 14px', margin: '16px 0', fontSize: 13, color: '#334155' }}>Sua resposta é confidencial e ajuda a garantir que tudo ocorra certinho. 💜</div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 20 }}>
      {btn('STUDENT_PRESENT', '✅ Sim, tive minha aula normalmente', '#10b981', '#fff')}
      {btn('TEACHER_NO_SHOW', '❌ O professor não apareceu', '#ef4444', '#fff')}
      {btn('STUDENT_SELF_ABSENT', '🤷 Eu que não pude comparecer', '#f1f5f9', '#334155', '1px solid #e2e8f0')}
    </div>
    {error && <p style={{ color: '#ef4444', fontSize: 13, marginTop: 12 }}>{error}</p>}
    <p style={{ fontSize: 12, color: '#94a3b8', marginTop: 18 }}>Wise Wolf · Escola de Idiomas</p>
  </>);
};

export default ConfirmAttendance;
