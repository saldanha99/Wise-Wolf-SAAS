import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { AlertCircle, ArrowRight, CheckCircle2, FileSignature, Loader2 } from 'lucide-react';

// Página pública de assinatura do aditivo de plano (aluno deslogado, via link).
// Fica no SPA e NÃO numa edge function: o gateway do Supabase força
// `content-type: text/plain` + CSP sandbox, então edge function não renderiza
// HTML para o usuário final (mesma pegadinha da confirmação de presença).

interface PlanChange {
    student_name: string;
    from_frequency: string | null;
    to_frequency: string;
    from_monthly_fee: number | null;
    to_monthly_fee: number;
    fidelity_plan: string | null;
    due_day: number | null;
    status: string;
    signed_at: string | null;
    expired: boolean;
    school_name: string | null;
}

const brl = (v: number | null | undefined) =>
    Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const PlanChangeSign: React.FC = () => {
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [data, setData] = useState<PlanChange | null>(null);
    const [signature, setSignature] = useState('');
    const [signing, setSigning] = useState(false);
    const [done, setDone] = useState(false);

    const token = new URLSearchParams(window.location.search).get('token') || '';

    useEffect(() => {
        if (!token) {
            setError('Link inválido.');
            setLoading(false);
            return;
        }
        (async () => {
            const { data: res, error: rpcError } = await supabase.rpc('get_plan_change_public', { p_token: token });
            if (rpcError || !res?.ok) {
                setError(res?.error || 'Não foi possível carregar a proposta.');
            } else {
                setData(res.data as PlanChange);
                if (res.data?.status === 'SIGNED') setDone(true);
            }
            setLoading(false);
        })();
    }, [token]);

    const assinar = async () => {
        setError('');
        setSigning(true);
        const { data: res, error: rpcError } = await supabase.rpc('sign_student_plan_change', {
            p_token: token,
            p_typed_signature: signature,
        });
        setSigning(false);
        if (rpcError || !res?.ok) {
            setError(res?.error || rpcError?.message || 'Não foi possível assinar.');
            return;
        }
        setDone(true);
    };

    if (loading) {
        return (
            <div className="min-h-screen flex flex-col items-center justify-center bg-slate-100 gap-4">
                <Loader2 className="animate-spin text-[#002366]" size={40} />
                <p className="text-slate-500 font-bold uppercase tracking-widest text-[11px]">Carregando proposta…</p>
            </div>
        );
    }

    if (error && !data) {
        return (
            <div className="min-h-screen bg-slate-100 flex items-center justify-center p-4">
                <div className="bg-white p-8 rounded-3xl shadow-xl max-w-md w-full text-center">
                    <AlertCircle size={44} className="text-red-500 mx-auto mb-4" />
                    <h2 className="text-lg font-black text-slate-800 mb-2">Não foi possível abrir</h2>
                    <p className="text-slate-500 text-sm">{error}</p>
                </div>
            </div>
        );
    }

    if (done) {
        return (
            <div className="min-h-screen bg-slate-100 flex items-center justify-center p-4">
                <div className="bg-white p-8 rounded-3xl shadow-xl max-w-md w-full text-center">
                    <CheckCircle2 size={48} className="text-emerald-500 mx-auto mb-4" />
                    <h2 className="text-xl font-black text-slate-800 mb-2">Plano alterado</h2>
                    <p className="text-slate-500 text-sm mb-6">
                        Seu plano agora é de <b className="text-slate-800">{data?.to_frequency} por semana</b> por{' '}
                        <b className="text-slate-800">{brl(data?.to_monthly_fee)}/mês</b>.
                        A escola já foi avisada.
                    </p>
                    <p className="text-[11px] text-slate-400">Você pode fechar esta página.</p>
                </div>
            </div>
        );
    }

    const expirado = data?.expired;

    return (
        <div className="min-h-screen bg-slate-100 py-8 px-4">
            <div className="max-w-lg mx-auto space-y-4">
                <div className="text-center">
                    <FileSignature size={32} className="text-[#002366] mx-auto mb-2" />
                    <h1 className="text-xl font-black text-slate-800">Alteração do seu plano</h1>
                    <p className="text-slate-500 text-xs font-medium mt-1">{data?.school_name || 'Wise Wolf'}</p>
                </div>

                <div className="bg-white rounded-3xl shadow-sm border border-slate-200 p-6 space-y-5">
                    <p className="text-sm text-slate-600">
                        Olá, <b className="text-slate-800">{data?.student_name?.trim()}</b>. Confirme abaixo a mudança
                        combinada com a escola. Ao assinar, este passa a ser o seu plano.
                    </p>

                    <div className="flex items-stretch gap-3">
                        <div className="flex-1 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                            <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1">Plano atual</p>
                            <p className="text-lg font-black text-slate-500">{data?.from_frequency || '—'}<span className="text-xs font-bold">/semana</span></p>
                            <p className="text-sm font-bold text-slate-500">{brl(data?.from_monthly_fee)}</p>
                        </div>
                        <div className="flex items-center"><ArrowRight size={18} className="text-slate-300" /></div>
                        <div className="flex-1 rounded-2xl border-2 border-emerald-500 bg-emerald-50 p-4">
                            <p className="text-[10px] font-black uppercase tracking-widest text-emerald-600 mb-1">Novo plano</p>
                            <p className="text-lg font-black text-slate-800">{data?.to_frequency}<span className="text-xs font-bold">/semana</span></p>
                            <p className="text-sm font-black text-slate-800">{brl(data?.to_monthly_fee)}</p>
                        </div>
                    </div>

                    <ul className="text-[11px] text-slate-500 space-y-1.5 border-t border-slate-100 pt-4">
                        <li>• O vencimento continua no dia <b className="text-slate-700">{data?.due_day || '—'}</b>.</li>
                        <li>• O prazo de permanência combinado na matrícula <b className="text-slate-700">não muda</b>.</li>
                        <li>• As demais cláusulas do seu contrato seguem valendo.</li>
                    </ul>

                    {expirado ? (
                        <div className="rounded-2xl bg-amber-50 border border-amber-200 p-4 text-center">
                            <p className="text-sm font-bold text-amber-700">Esta proposta expirou.</p>
                            <p className="text-xs text-amber-600 mt-1">Peça um link novo à escola.</p>
                        </div>
                    ) : (
                        <>
                            <div>
                                <label className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-2 block">
                                    Assine digitando seu nome completo
                                </label>
                                <input
                                    value={signature}
                                    onChange={e => setSignature(e.target.value)}
                                    placeholder={data?.student_name?.trim()}
                                    autoComplete="off"
                                    className="w-full px-4 py-3.5 bg-slate-50 border border-slate-200 rounded-2xl text-base text-slate-800 outline-none focus:ring-2 focus:ring-[#002366]/30 focus:border-[#002366]"
                                    style={{ fontFamily: 'cursive' }}
                                />
                            </div>

                            {error && <p className="text-xs text-red-500 font-bold">{error}</p>}

                            <button
                                onClick={assinar}
                                disabled={signing || signature.trim().length < 3}
                                className="w-full py-4 bg-[#002366] text-white rounded-2xl font-black text-[11px] uppercase tracking-widest hover:bg-blue-900 disabled:opacity-40 flex items-center justify-center gap-2"
                            >
                                {signing ? <Loader2 size={14} className="animate-spin" /> : <FileSignature size={14} />}
                                Assinar e confirmar
                            </button>

                            <p className="text-[10px] text-slate-400 text-center leading-relaxed">
                                A assinatura digital tem validade jurídica (MP 2.200-2/2001). Registramos data, hora e IP.
                            </p>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
};

export default PlanChangeSign;
