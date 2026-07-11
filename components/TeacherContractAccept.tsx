import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { TeacherContractDocument } from './TeacherContractDocument';
import { Loader2, ShieldCheck, X, AlertTriangle } from 'lucide-react';

// Aceite de contrato PJ para professor JÁ logado que nunca aceitou (contract_accepted=false).
// Contas criadas pelo caminho manual (create-teacher-account) nascem sem aceite e não passam
// pelo onboarding/quiz — este modal é a regularização. Registra aceite + assinatura digitada
// + IP via RPC accept_teacher_contract (SECURITY DEFINER, escopo auth.uid()).

interface TeacherContractAcceptProps {
    userId: string;
    onAccepted: () => void;
    onClose?: () => void;
    /** Quando true, o professor não pode fechar sem aceitar (uso como gate obrigatório). */
    mandatory?: boolean;
}

const TeacherContractAccept: React.FC<TeacherContractAcceptProps> = ({ userId, onAccepted, onClose, mandatory }) => {
    const [profile, setProfile] = useState<any>(null);
    const [loading, setLoading] = useState(true);
    const [checked, setChecked] = useState(false);
    const [signature, setSignature] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        (async () => {
            try {
                const { data, error } = await supabase
                    .from('profiles')
                    .select('full_name, rg, cpf, address, address_number, postal_code, birth_date, hourly_rate, subscription_id')
                    .eq('id', userId)
                    .single();
                if (error) throw error;
                setProfile(data);
                setSignature(data?.full_name || '');
            } catch (e) {
                console.error('Erro ao carregar contrato do professor:', e);
                setError('Não foi possível carregar seu contrato. Tente novamente.');
            } finally {
                setLoading(false);
            }
        })();
    }, [userId]);

    const handleAccept = async () => {
        setError('');
        if (!checked) { setError('Marque a caixa confirmando que leu e aceita os termos.'); return; }
        if (signature.trim().length < 3) { setError('Digite seu nome completo como assinatura.'); return; }
        setSubmitting(true);
        try {
            const { data, error } = await supabase.rpc('accept_teacher_contract', { p_typed_signature: signature.trim() });
            if (error) throw error;
            if (!data?.ok) {
                const map: Record<string, string> = {
                    nao_autenticado: 'Sessão expirada. Entre novamente.',
                    apenas_professor: 'Apenas professores podem aceitar este contrato.',
                    assinatura_invalida: 'Assinatura inválida. Digite seu nome completo.',
                };
                setError(map[data?.error] || 'Não foi possível registrar o aceite. Tente novamente.');
                return;
            }
            onAccepted();
        } catch (e: any) {
            console.error('Erro ao aceitar contrato:', e);
            setError(e?.message || 'Erro ao registrar o aceite. Tente novamente.');
        } finally {
            setSubmitting(false);
        }
    };

    const addressFull = profile
        ? `${profile.address || ''}${profile.address_number ? ', ' + profile.address_number : ''}${profile.postal_code ? ' - ' + profile.postal_code : ''}`.trim()
        : '';
    const birth = profile?.birth_date
        ? new Date(profile.birth_date).toLocaleDateString('pt-BR')
        : '';

    return (
        <div className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm flex items-center justify-center p-3 sm:p-6 animate-in fade-in">
            <div className="bg-brand-surface w-full max-w-3xl max-h-[92vh] rounded-3xl border border-brand-border shadow-2xl flex flex-col overflow-hidden">
                {/* Header sticky */}
                <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-brand-border bg-brand-surface-2">
                    <div className="flex items-center gap-2">
                        <div className="p-2 rounded-xl bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400">
                            <ShieldCheck size={20} />
                        </div>
                        <div>
                            <h2 className="font-black text-brand-text text-sm uppercase tracking-widest">Aceite do Contrato PJ</h2>
                            <p className="text-[11px] text-brand-muted">Regularização obrigatória para receber alunos</p>
                        </div>
                    </div>
                    {!mandatory && onClose && (
                        <button onClick={onClose} className="p-2 rounded-xl hover:bg-brand-surface text-brand-muted transition-colors">
                            <X size={18} />
                        </button>
                    )}
                </div>

                {/* Corpo com scroll */}
                <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-5">
                    {loading ? (
                        <div className="flex items-center justify-center h-48 text-brand-muted gap-2">
                            <Loader2 className="animate-spin" /> Carregando seu contrato…
                        </div>
                    ) : (
                        <>
                            <div className="rounded-2xl border border-brand-border overflow-hidden bg-white">
                                <div className="overflow-x-auto">
                                    <div style={{ zoom: 0.7 }} className="origin-top">
                                        <TeacherContractDocument
                                            teacherName={profile?.full_name || 'Professor'}
                                            teacherRG={profile?.rg || '---'}
                                            teacherCPF={profile?.cpf || '---'}
                                            teacherAddress={addressFull || '---'}
                                            teacherBirthDate={birth || '---'}
                                            hourlyRate={Number(profile?.hourly_rate) || undefined}
                                            contractCity="Jacareí/SP"
                                            subscriptionId={profile?.subscription_id || undefined}
                                        />
                                    </div>
                                </div>
                            </div>

                            {/* Assinatura digitada */}
                            <div className="space-y-2">
                                <label className="text-xs font-bold text-brand-text uppercase tracking-wider">
                                    Assinatura (digite seu nome completo)
                                </label>
                                <input
                                    type="text"
                                    value={signature}
                                    onChange={(e) => setSignature(e.target.value)}
                                    placeholder="Seu nome completo"
                                    className="w-full px-4 py-3 rounded-xl border border-brand-border bg-brand-surface-2 text-brand-text text-sm focus:ring-2 focus:ring-emerald-500 outline-none"
                                />
                            </div>

                            <label className="flex items-start gap-3 cursor-pointer select-none">
                                <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={(e) => setChecked(e.target.checked)}
                                    className="mt-1 w-5 h-5 accent-emerald-600 shrink-0"
                                />
                                <span className="text-sm text-brand-text font-medium">
                                    Li e aceito os termos do contrato de prestação de serviços como PJ (pessoa jurídica autônoma),
                                    reconhecendo a autonomia da minha agenda e a inexistência de vínculo empregatício. Registrarei
                                    a nota fiscal dos serviços prestados conforme a legislação.
                                </span>
                            </label>

                            {error && (
                                <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/10 border border-red-200 dark:border-red-900/30 rounded-xl px-4 py-3">
                                    <AlertTriangle size={16} className="shrink-0" /> {error}
                                </div>
                            )}
                        </>
                    )}
                </div>

                {/* Footer sticky */}
                <div className="px-5 py-4 border-t border-brand-border bg-brand-surface-2">
                    <button
                        onClick={handleAccept}
                        disabled={submitting || loading || !checked}
                        className="w-full flex items-center justify-center gap-2 bg-emerald-600 text-white py-3.5 rounded-xl text-sm font-black uppercase tracking-widest hover:bg-emerald-700 active:scale-[0.99] transition-all shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {submitting ? <><Loader2 size={16} className="animate-spin" /> Registrando…</> : <><ShieldCheck size={16} /> Aceitar e assinar contrato</>}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default TeacherContractAccept;
