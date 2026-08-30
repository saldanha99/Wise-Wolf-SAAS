import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

// Página PÚBLICA (sem login) de confirmação de presença pelo aluno.
// Acessada pelo link 1-clique enviado no WhatsApp: /confirmar-presenca?token=...
// Servida pelo SPA (domínio do app) — edge functions do Supabase não renderizam HTML (CSP sandbox).

type BaseResp = 'STUDENT_PRESENT' | 'TEACHER_NO_SHOW' | 'STUDENT_SELF_ABSENT';
type OptionalResp =
  | 'CLASS_CANCELLED_RESCHEDULED'
  | 'CLASS_CANCELLED_OR_RESCHEDULED'
  | 'CANCELLED_RESCHEDULED'
  | 'CANCELLED_OR_RESCHEDULED';
type Resp = BaseResp | OptionalResp;

interface ConfirmationInfo {
  found: boolean;
  already?: boolean;
  student_name?: string | null;
  teacher_name?: string | null;
  class_date?: string | null;
  class_time?: string | null;
  student_response?: string | null;
  allowed_responses?: unknown;
  can_correct?: boolean;
  can_edit?: boolean;
  response_editable?: boolean;
  editable_until?: string | null;
  correction_deadline?: string | null;
  expired?: boolean;
  cancelled?: boolean;
}

const BASE_RESPONSES = new Set<BaseResp>([
  'STUDENT_PRESENT',
  'TEACHER_NO_SHOW',
  'STUDENT_SELF_ABSENT',
]);

const OPTIONAL_RESPONSES = new Set<OptionalResp>([
  'CLASS_CANCELLED_RESCHEDULED',
  'CLASS_CANCELLED_OR_RESCHEDULED',
  'CANCELLED_RESCHEDULED',
  'CANCELLED_OR_RESCHEDULED',
]);

const asResponse = (value: unknown): Resp | null => {
  if (typeof value !== 'string') return null;
  if (BASE_RESPONSES.has(value as BaseResp) || OPTIONAL_RESPONSES.has(value as OptionalResp)) {
    return value as Resp;
  }
  return null;
};

const optionalResponseFrom = (info: ConfirmationInfo | null): OptionalResp | null => {
  if (!Array.isArray(info?.allowed_responses)) return null;
  for (const value of info.allowed_responses) {
    if (typeof value === 'string' && OPTIONAL_RESPONSES.has(value as OptionalResp)) {
      return value as OptionalResp;
    }
  }
  return null;
};

const canCorrectResponse = (info: ConfirmationInfo | null) =>
  info?.cancelled !== true
  && info?.expired !== true
  && (info?.can_correct === true || info?.can_edit === true || info?.response_editable === true);

const responseMessage = (response: Resp | 'already') => {
  if (response === 'STUDENT_PRESENT') return 'Registramos que a aula aconteceu e você participou. Obrigado!';
  if (response === 'TEACHER_NO_SHOW') return 'Registramos que o professor não compareceu. A equipe da escola vai analisar o relato.';
  if (response === 'STUDENT_SELF_ABSENT') return 'Registramos que a aula aconteceu, mas você não participou.';
  if (response === 'already') return 'Sua resposta anterior continua registrada. Obrigado!';
  return 'Registramos que a aula foi cancelada ou remarcada. A equipe da escola vai conferir a situação.';
};

const ConfirmAttendance: React.FC = () => {
  const token = new URLSearchParams(window.location.search).get('token') || '';
  const [loading, setLoading] = useState(true);
  const [info, setInfo] = useState<ConfirmationInfo | null>(null);
  const [sending, setSending] = useState<Resp | null>(null);
  const [done, setDone] = useState<Resp | 'already' | null>(null);
  const [editingExisting, setEditingExisting] = useState(false);
  const [error, setError] = useState<string>('');
  const [rated, setRated] = useState(false);

  const rate = async (stars: number) => {
    setRated(true);
    await supabase.rpc('rate_attendance', { p_token: token, p_stars: stars });
  };

  useEffect(() => {
    (async () => {
      if (!token) { setError('Link inválido.'); setLoading(false); return; }
      const { data, error } = await supabase.rpc('get_confirmation_public', { p_token: token });
      if (error || !data || data.found !== true) {
        setError('Link inválido ou expirado.');
      } else {
        const confirmation = data as ConfirmationInfo;
        if (confirmation.cancelled) {
          setError('Esta confirmação foi cancelada pela escola.');
        } else if (confirmation.expired && !confirmation.already) {
          setError('O prazo desta confirmação terminou. Fale com a escola se precisar corrigir a presença.');
        } else {
          setInfo(confirmation);
        }
        if (!confirmation.cancelled && confirmation.already) {
          setDone(asResponse(confirmation.student_response) || 'already');
        }
      }
      setLoading(false);
    })();
  }, [token]);

  const responder = async (r: Resp) => {
    setSending(r);
    setError('');
    const { data, error } = await supabase.rpc('apply_student_response', { p_token: token, p_response: r });
    if (error || (data && data.ok === false)) {
      const reason = String(data?.error || error?.message || '');
      if (/locked|window|prazo|expired|expirad|janela_correcao/i.test(reason)) {
        setError('O prazo para corrigir esta resposta terminou. A escola pode ajudar se algo estiver incorreto.');
      } else if (/invalid_response|resposta_invalida/i.test(reason)) {
        setError('Essa opção ainda não está disponível para esta aula.');
      } else {
        setError('Não foi possível registrar. Tente novamente.');
      }
      setSending(null);
      return;
    }
    const savedResponse = asResponse(data?.student_response);
    setInfo(previous => previous ? { ...previous, ...(data || {}), student_response: savedResponse || r, already: true } : previous);
    setDone(data?.already === true && !savedResponse ? 'already' : (savedResponse || r));
    setEditingExisting(false);
    setSending(null);
  };

  const aluno = (info?.student_name || '').split(' ')[0] || '';
  const prof = info?.teacher_name || 'seu professor';
  const dataFmt = info?.class_date
    ? new Date(info.class_date + 'T00:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: 'long' })
    : '';
  const hora = info?.class_time ? ` às ${String(info.class_time).slice(0, 5)}` : '';
  const optionalResponse = optionalResponseFrom(info);
  const correctionDeadline = info?.editable_until || info?.correction_deadline;
  const correctionDeadlineLabel = correctionDeadline
    ? new Date(correctionDeadline).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
    : null;

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
    return wrap(<>
      <div style={{ fontSize: 54, marginBottom: 10 }}>✅</div>
      <h1 style={{ fontSize: 20, fontWeight: 800 }}>Resposta registrada</h1>
      <p style={{ fontSize: 14, color: '#475569', marginTop: 8 }}>{responseMessage(done)}</p>
      {/* Avaliação opcional da aula (só quando teve a aula) */}
      {done === 'STUDENT_PRESENT' && (
        rated ? (
          <p style={{ fontSize: 13, color: '#10b981', marginTop: 16, fontWeight: 700 }}>Obrigado pela avaliação! ⭐</p>
        ) : (
          <div style={{ marginTop: 18, borderTop: '1px solid #e2e8f0', paddingTop: 16 }}>
            <p style={{ fontSize: 13, color: '#334155', marginBottom: 10 }}>Como foi a aula com <b>{prof}</b>?</p>
            <div style={{ display: 'flex', justifyContent: 'center', gap: 8 }}>
              {[1, 2, 3, 4, 5].map(n => (
                <button key={n} onClick={() => rate(n)} aria-label={`${n} estrelas`}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 32, lineHeight: 1, padding: 0 }}>⭐</button>
              ))}
            </div>
            <p style={{ fontSize: 11, color: '#94a3b8', marginTop: 8 }}>Toque nas estrelas (opcional)</p>
          </div>
        )
      )}
      {canCorrectResponse(info) && done !== 'already' && (
        <div style={{ marginTop: 18, borderTop: '1px solid #e2e8f0', paddingTop: 16 }}>
          <p style={{ fontSize: 12, color: '#64748b', marginBottom: 10 }}>
            Percebeu algum engano? Você pode corrigir sua resposta
            {correctionDeadlineLabel ? ` até ${correctionDeadlineLabel}` : ' durante o prazo disponível'}.
          </p>
          <button
            type="button"
            onClick={() => { setDone(null); setEditingExisting(true); setError(''); }}
            style={{ background: '#fff', border: '1px solid #cbd5e1', borderRadius: 12, color: '#334155', cursor: 'pointer', fontSize: 13, fontWeight: 700, padding: '10px 14px' }}
          >
            Corrigir minha resposta
          </button>
        </div>
      )}
      <p style={{ fontSize: 12, color: '#94a3b8', marginTop: 18 }}>Obrigado{aluno ? `, ${aluno}` : ''}. Pode fechar esta página.</p>
    </>);
  }

  const btn = (r: Resp, label: string, bg: string, color: string, border?: string) => (
    <button
      type="button"
      onClick={() => responder(r)}
      disabled={!!sending}
      aria-busy={sending === r}
      style={{ display: 'block', width: '100%', textAlign: 'center', padding: 16, borderRadius: 16, fontWeight: 700, fontSize: 15, background: bg, color, border: border || 'none', cursor: 'pointer', opacity: sending && sending !== r ? 0.5 : 1 }}
    >
      {sending === r ? 'Enviando…' : label}
    </button>
  );

  return wrap(<>
    <div style={{ fontSize: 46, marginBottom: 8 }}>🐺</div>
    <h1 style={{ fontSize: 20, fontWeight: 800, lineHeight: 1.3 }}>
      {editingExisting ? 'Corrija sua resposta' : `Oi ${aluno}! O que aconteceu com sua aula${dataFmt ? ` de ${dataFmt}${hora}` : ''}?`}
    </h1>
    <p style={{ fontSize: 14, color: '#475569', margin: '8px 0' }}>
      Aula com <b>{prof}</b>. Escolha a opção que descreve melhor a situação.
    </p>
    <div style={{ background: '#f1f5f9', borderRadius: 14, padding: '12px 14px', margin: '16px 0', fontSize: 13, color: '#334155', lineHeight: 1.5 }}>
      A escola usa sua resposta para conferir a realização da aula, comparar com o registro do professor e analisar divergências. Gestores autorizados podem consultá-la.
    </div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 20 }}>
      {btn('STUDENT_PRESENT', '✅ A aula aconteceu e eu participei', '#10b981', '#fff')}
      {btn('STUDENT_SELF_ABSENT', '🤷 A aula aconteceu, mas eu não participei', '#f1f5f9', '#334155', '1px solid #e2e8f0')}
      {btn('TEACHER_NO_SHOW', '❌ O professor não compareceu', '#ef4444', '#fff')}
      {optionalResponse && btn(optionalResponse, '📅 A aula foi cancelada ou remarcada', '#fff7ed', '#9a3412', '1px solid #fed7aa')}
    </div>
    {error && <p role="alert" style={{ color: '#ef4444', fontSize: 13, marginTop: 12 }}>{error}</p>}
    <p style={{ fontSize: 12, color: '#94a3b8', marginTop: 18 }}>Wise Wolf · Escola de Idiomas</p>
  </>);
};

export default ConfirmAttendance;
