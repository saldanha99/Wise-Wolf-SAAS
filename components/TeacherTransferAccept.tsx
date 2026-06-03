import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

// Página PÚBLICA (sem login) para o NOVO professor aceitar/recusar uma transferência de aluno.
// Link 1-clique: /transferencia?token=...  (servida pelo SPA — edge functions não renderizam HTML).

const TeacherTransferAccept: React.FC = () => {
    const token = new URLSearchParams(window.location.search).get('token') || '';
    const [loading, setLoading] = useState(true);
    const [info, setInfo] = useState<any>(null);
    const [error, setError] = useState('');
    const [sending, setSending] = useState<'accept' | 'decline' | null>(null);
    const [done, setDone] = useState<'ACCEPTED' | 'DECLINED' | 'already' | null>(null);
    const [showDecline, setShowDecline] = useState(false);
    const [declineReason, setDeclineReason] = useState('');

    useEffect(() => {
        (async () => {
            if (!token) { setError('Link inválido.'); setLoading(false); return; }
            const { data, error } = await supabase.rpc('get_transfer_public', { p_token: token });
            if (error || !data || data.error) {
                setError('Link inválido ou expirado.');
            } else {
                setInfo(data);
                if (['ACCEPTED', 'DECLINED', 'APPLIED', 'CANCELLED'].includes(data.status)) {
                    setDone(data.status === 'DECLINED' ? 'DECLINED' : 'already');
                }
            }
            setLoading(false);
        })();
    }, [token]);

    const responder = async (accept: boolean) => {
        setSending(accept ? 'accept' : 'decline');
        setError('');
        const { data, error } = await supabase.rpc('respond_teacher_transfer', {
            p_token: token, p_accept: accept, p_decline_reason: accept ? null : (declineReason.trim() || null),
        });
        if (error || (data && data.ok === false)) {
            setError(data?.error === 'already_decided' ? 'Esta proposta já foi respondida.' : 'Não foi possível registrar. Tente novamente.');
            setSending(null);
            return;
        }
        setDone(accept ? 'ACCEPTED' : 'DECLINED');
        setSending(null);
    };

    const slots: { day_of_week: string; time_slot: string }[] = Array.isArray(info?.proposed_slots) ? info.proposed_slots : [];
    const cutover = info?.cutover_date ? new Date(info.cutover_date + 'T00:00:00').toLocaleDateString('pt-BR') : '';
    const aluno = info?.student_name || 'o aluno';

    const wrap = (children: React.ReactNode) => (
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: 'linear-gradient(160deg,#0f172a 0%,#1e1b4b 100%)' }}>
            <div style={{ background: '#fff', color: '#0f172a', borderRadius: 28, maxWidth: 440, width: '100%', padding: '32px 28px', boxShadow: '0 30px 60px -20px rgba(0,0,0,.5)', textAlign: 'center', fontFamily: '-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif' }}>
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
        let emoji = '✅', msg = '';
        if (done === 'ACCEPTED') msg = `Transferência aceita! ${aluno} passa a ser seu aluno a partir de ${cutover}. A agenda será atualizada automaticamente.`;
        else if (done === 'DECLINED') { emoji = '🚫'; msg = 'Você recusou a transferência. A coordenação foi avisada e vai propor outro arranjo.'; }
        else { emoji = 'ℹ️'; msg = 'Esta proposta já havia sido respondida.'; }
        return wrap(<>
            <div style={{ fontSize: 54, marginBottom: 10 }}>{emoji}</div>
            <h1 style={{ fontSize: 20, fontWeight: 800 }}>Registrado</h1>
            <p style={{ fontSize: 14, color: '#475569', marginTop: 8 }}>{msg}</p>
            <p style={{ fontSize: 12, color: '#94a3b8', marginTop: 18 }}>Wise Wolf · Escola de Idiomas</p>
        </>);
    }

    return wrap(<>
        <div style={{ fontSize: 46, marginBottom: 8 }}>🤝</div>
        <h1 style={{ fontSize: 20, fontWeight: 800, lineHeight: 1.3 }}>Nova proposta de aluno</h1>
        <p style={{ fontSize: 14, color: '#475569', margin: '8px 0' }}>
            A coordenação quer transferir <b>{aluno}</b> para você{info?.from_teacher ? <> (hoje com {info.from_teacher})</> : ''}.
        </p>

        <div style={{ background: '#f1f5f9', borderRadius: 14, padding: '14px 16px', margin: '16px 0', fontSize: 14, color: '#334155', textAlign: 'left' }}>
            <p style={{ fontWeight: 700, marginBottom: 8 }}>Horários propostos:</p>
            {slots.length > 0 ? slots.map((s, i) => (
                <p key={i} style={{ margin: '2px 0' }}>• {s.day_of_week} às {String(s.time_slot).slice(0, 5)}</p>
            )) : <p>—</p>}
            <p style={{ marginTop: 10, fontSize: 13, color: '#475569' }}><b>Início:</b> {cutover}</p>
            {info?.reason && <p style={{ marginTop: 4, fontSize: 12, color: '#94a3b8' }}>Motivo: {info.reason}</p>}
        </div>

        {!showDecline ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 8 }}>
                <button onClick={() => responder(true)} disabled={!!sending}
                    style={{ width: '100%', padding: 16, borderRadius: 16, fontWeight: 800, fontSize: 15, background: '#10b981', color: '#fff', border: 'none', cursor: 'pointer', opacity: sending === 'decline' ? 0.5 : 1 }}>
                    {sending === 'accept' ? 'Confirmando…' : '✅ Aceitar e assumir o aluno'}
                </button>
                <button onClick={() => setShowDecline(true)} disabled={!!sending}
                    style={{ width: '100%', padding: 14, borderRadius: 16, fontWeight: 700, fontSize: 14, background: '#f1f5f9', color: '#334155', border: '1px solid #e2e8f0', cursor: 'pointer' }}>
                    Não consigo nesses horários
                </button>
            </div>
        ) : (
            <div style={{ marginTop: 8, textAlign: 'left' }}>
                <label style={{ fontSize: 12, fontWeight: 700, color: '#334155' }}>Motivo (opcional)</label>
                <textarea value={declineReason} onChange={e => setDeclineReason(e.target.value)} rows={3}
                    placeholder="Ex.: já tenho aula nesses horários / sem disponibilidade na semana"
                    style={{ width: '100%', marginTop: 6, padding: 12, borderRadius: 12, border: '1px solid #e2e8f0', fontSize: 14, resize: 'vertical', boxSizing: 'border-box' }} />
                <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
                    <button onClick={() => setShowDecline(false)} disabled={!!sending}
                        style={{ flex: 1, padding: 14, borderRadius: 14, fontWeight: 700, fontSize: 14, background: '#f1f5f9', color: '#334155', border: '1px solid #e2e8f0', cursor: 'pointer' }}>Voltar</button>
                    <button onClick={() => responder(false)} disabled={!!sending}
                        style={{ flex: 1, padding: 14, borderRadius: 14, fontWeight: 800, fontSize: 14, background: '#ef4444', color: '#fff', border: 'none', cursor: 'pointer' }}>
                        {sending === 'decline' ? 'Enviando…' : 'Recusar'}
                    </button>
                </div>
            </div>
        )}
        {error && <p style={{ color: '#ef4444', fontSize: 13, marginTop: 12 }}>{error}</p>}
        <p style={{ fontSize: 12, color: '#94a3b8', marginTop: 18 }}>Wise Wolf · Escola de Idiomas</p>
    </>);
};

export default TeacherTransferAccept;
