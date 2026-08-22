import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { supabase } from '../lib/supabase';
import { getSchoolInfo } from '../lib/schoolInfo';
import { TeacherContractDocument, getTeacherContractReadiness } from './TeacherContractDocument';
import type { SchoolInfo } from './ContractDocument';
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
    const [school, setSchool] = useState<SchoolInfo | null>(null);
    const [loading, setLoading] = useState(true);
    const [checked, setChecked] = useState(false);
    const [signature, setSignature] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');
    const dialogRef = useRef<HTMLDivElement>(null);
    const mandatoryRef = useRef(mandatory);
    const onCloseRef = useRef(onClose);
    const submittingRef = useRef(submitting);
    mandatoryRef.current = mandatory;
    onCloseRef.current = onClose;
    submittingRef.current = submitting;

    useEffect(() => {
        (async () => {
            try {
                const { data, error } = await supabase
                    .from('profiles')
                    .select('full_name, rg, cpf, address, address_number, postal_code, birth_date, hourly_rate, subscription_id, tenant_id')
                    .eq('id', userId)
                    .single();
                if (error) throw error;
                setProfile(data);
                setSignature(data?.full_name || '');
                setSchool(await getSchoolInfo(data?.tenant_id));
            } catch (e) {
                console.error('Erro ao carregar contrato do professor:', e);
                setError('Não foi possível carregar seu contrato. Tente novamente.');
            } finally {
                setLoading(false);
            }
        })();
    }, [userId]);

    const contractReadiness = getTeacherContractReadiness(school, profile?.hourly_rate);

    useEffect(() => {
        const previousOverflow = document.body.style.overflow;
        const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        document.body.style.overflow = 'hidden';

        const focusFrame = window.requestAnimationFrame(() => {
            const dialog = dialogRef.current;
            const initialFocus = dialog?.querySelector<HTMLElement>('[data-dialog-initial-focus="true"]');
            (initialFocus || dialog)?.focus();
        });

        const handleKeyDown = (event: KeyboardEvent) => {
            const dialog = dialogRef.current;
            if (!dialog) return;

            if (event.key === 'Escape') {
                if (!mandatoryRef.current && onCloseRef.current && !submittingRef.current) {
                    event.preventDefault();
                    onCloseRef.current();
                }
                return;
            }

            if (event.key !== 'Tab') return;
            const focusable = (Array.from(dialog.querySelectorAll<HTMLElement>(
                'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
            )) as HTMLElement[]).filter(element => element.getAttribute('aria-hidden') !== 'true');

            if (focusable.length === 0) {
                event.preventDefault();
                dialog.focus();
                return;
            }

            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            const focusIsOutside = !(document.activeElement instanceof Node) || !dialog.contains(document.activeElement);
            if (event.shiftKey && (document.activeElement === first || focusIsOutside)) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && (document.activeElement === last || focusIsOutside)) {
                event.preventDefault();
                first.focus();
            }
        };

        document.addEventListener('keydown', handleKeyDown);
        return () => {
            window.cancelAnimationFrame(focusFrame);
            document.body.style.overflow = previousOverflow;
            document.removeEventListener('keydown', handleKeyDown);
            previousFocus?.focus();
        };
    }, []);

    const handleAccept = async () => {
        setError('');
        if (!contractReadiness.isReady) {
            setError(`Assinatura bloqueada: a escola precisa configurar ${contractReadiness.missingFields.join(', ')}.`);
            return;
        }
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

    return createPortal(
        <div className="fixed inset-0 z-[250] bg-black/60 backdrop-blur-sm flex items-center justify-center p-0 sm:p-6 animate-in fade-in">
            <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="teacher-contract-title" tabIndex={-1} className="flex h-dvh max-h-dvh w-full max-w-3xl flex-col overflow-hidden bg-brand-surface shadow-2xl sm:h-auto sm:max-h-[92dvh] sm:rounded-3xl sm:border sm:border-brand-border">
                {/* Header sticky */}
                <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-brand-border bg-brand-surface-2">
                    <div className="flex items-center gap-2">
                        <div className="p-2 rounded-xl bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400">
                            <ShieldCheck size={20} />
                        </div>
                        <div>
                            <h2 id="teacher-contract-title" className="font-black text-brand-text text-sm uppercase tracking-widest">Aceite do Contrato PJ</h2>
                            <p className="text-[11px] text-brand-muted">Regularização obrigatória para receber alunos</p>
                        </div>
                    </div>
                    {!mandatory && onClose && (
                        <button
                            type="button"
                            onClick={onClose}
                            aria-label="Fechar contrato"
                            data-dialog-initial-focus="true"
                            className="p-2 rounded-xl hover:bg-brand-surface text-brand-muted transition-colors"
                        >
                            <X size={18} aria-hidden="true" />
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
                            <div className="overflow-hidden rounded-2xl border border-brand-border bg-white">
                                <div className="w-full">
                                        <TeacherContractDocument
                                            teacherName={profile?.full_name || 'Professor'}
                                            teacherRG={profile?.rg || '---'}
                                            teacherCPF={profile?.cpf || '---'}
                                            teacherAddress={addressFull || '---'}
                                            teacherBirthDate={birth || '---'}
                                            school={school}
                                            hourlyRate={Number(profile?.hourly_rate) || undefined}
                                            subscriptionId={profile?.subscription_id || undefined}
                                            displayMode="responsive"
                                            showPrintButton={false}
                                        />
                                </div>
                            </div>

                            {!contractReadiness.isReady && (
                                <div role="alert" className="flex items-start gap-2 text-sm text-amber-900 bg-amber-50 border border-amber-300 rounded-xl px-4 py-3">
                                    <AlertTriangle size={16} className="shrink-0 mt-0.5" />
                                    <span>Aceite bloqueado até a escola configurar {contractReadiness.missingFields.join(', ')}. Nenhuma identidade de outro tenant será usada.</span>
                                </div>
                            )}

                            {/* Assinatura digitada */}
                            <div className="space-y-2">
                                <label className="text-xs font-bold text-brand-text uppercase tracking-wider">
                                    Assinatura (digite seu nome completo)
                                </label>
                                <input
                                    type="text"
                                    value={signature}
                                    disabled={!contractReadiness.isReady}
                                    onChange={(e) => setSignature(e.target.value)}
                                    placeholder="Seu nome completo"
                                    autoComplete="name"
                                    className="w-full px-4 py-3 rounded-xl border border-brand-border bg-brand-surface-2 text-brand-text text-sm focus:ring-2 focus:ring-emerald-500 outline-none"
                                />
                            </div>

                            <label className="flex items-start gap-3 cursor-pointer select-none">
                                <input
                                    type="checkbox"
                                    checked={checked}
                                    disabled={!contractReadiness.isReady}
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
                                <div role="alert" className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/10 border border-red-200 dark:border-red-900/30 rounded-xl px-4 py-3">
                                    <AlertTriangle size={16} className="shrink-0" /> {error}
                                </div>
                            )}
                        </>
                    )}
                </div>

                {/* Footer sticky */}
                <div className="px-5 py-4 border-t border-brand-border bg-brand-surface-2">
                    <button
                        type="button"
                        onClick={handleAccept}
                        disabled={submitting || loading || !contractReadiness.isReady || !checked}
                        className="w-full flex items-center justify-center gap-2 bg-emerald-600 text-white py-3.5 rounded-xl text-sm font-black uppercase tracking-widest hover:bg-emerald-700 active:scale-[0.99] transition-all shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {submitting ? <><Loader2 size={16} className="animate-spin" /> Registrando…</> : <><ShieldCheck size={16} /> Aceitar e assinar contrato</>}
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
};

export default TeacherContractAccept;
