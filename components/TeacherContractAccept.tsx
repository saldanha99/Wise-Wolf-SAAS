import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { supabase } from '../lib/supabase';
import { getSchoolInfo } from '../lib/schoolInfo';
import { TeacherContractDocument, getTeacherContractReadiness } from './TeacherContractDocument';
import type { SchoolInfo } from './ContractDocument';
import { AlertTriangle, CheckCircle2, Loader2, PencilLine, ShieldCheck, Sparkles, Type, X } from 'lucide-react';
import { PROFILE_SAFE_COLS } from '../constants';
import { loadAuthorizedProfilePrivate } from '../lib/profilePrivacy';

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
    const [isValidSignature, setIsValidSignature] = useState(false);
    const [signatureMode, setSignatureMode] = useState<'typed' | 'scribble'>('scribble');
    const [hasSignature, setHasSignature] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');
    const dialogRef = useRef<HTMLDivElement>(null);
    const signatureCanvasRef = useRef<HTMLCanvasElement>(null);
    const isDrawingRef = useRef(false);
    const mandatoryRef = useRef(mandatory);
    const onCloseRef = useRef(onClose);
    const submittingRef = useRef(submitting);
    mandatoryRef.current = mandatory;
    onCloseRef.current = onClose;
    submittingRef.current = submitting;

    useEffect(() => {
        (async () => {
            try {
                const [profileResult, privateProfile, payResult] = await Promise.all([
                    supabase
                    .from('profiles')
                    .select(PROFILE_SAFE_COLS)
                    .eq('id', userId)
                    .single(),
                    loadAuthorizedProfilePrivate(userId),
                    supabase.rpc('get_my_pay'),
                ]);
                if (profileResult.error) throw profileResult.error;
                const data = {
                    ...profileResult.data,
                    ...privateProfile,
                    hourly_rate: (payResult.data as any)?.hourly_rate ?? privateProfile.hourly_rate,
                };
                const normalizedName = ((data.full_name as string) || '').trim();
                setProfile(data);
                setSignature(normalizedName);
                setIsValidSignature(normalizedName.length >= 3);
                setHasSignature(false);
                setSchool(await getSchoolInfo(data.tenant_id as string));
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
        if (!signatureCanvasRef.current) return;
        const canvas = signatureCanvasRef.current;
        const context = canvas.getContext('2d');
        if (!context) return;
        const bounds = canvas.getBoundingClientRect();
        const scale = Math.max(window.devicePixelRatio || 1, 1);
        canvas.width = Math.floor(bounds.width * scale);
        canvas.height = Math.floor(bounds.height * scale);
        context.setTransform(scale, 0, 0, scale, 0, 0);
        context.lineCap = 'round';
        context.lineJoin = 'round';
        context.lineWidth = 3;
        context.strokeStyle = '#0f172a';
        context.clearRect(0, 0, bounds.width, bounds.height);
        setHasSignature(false);
    }, [signatureMode, loading, contractReadiness.isReady]);

    const syncSignature = (value: string) => {
        setSignature(value);
        const expectedName = ((profile?.full_name as string) || '').trim().toLowerCase();
        const normalizedValue = value.trim().toLowerCase();
        if (!expectedName) {
            setIsValidSignature(false);
            return;
        }
        setIsValidSignature(
            normalizedValue.length > 0
                && normalizedValue.length >= 3
                && normalizedValue === expectedName,
        );
    };

    const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
        if (submitting || signatureMode !== 'scribble' || !contractReadiness.isReady) return;
        const canvas = signatureCanvasRef.current;
        const context = canvas?.getContext('2d');
        if (!canvas || !context) return;
        const rect = canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;

        isDrawingRef.current = true;
        context.beginPath();
        context.moveTo(x, y);
        context.lineTo(x + 0.001, y + 0.001);
        context.stroke();
        setHasSignature(true);
        event.currentTarget.setPointerCapture(event.pointerId);
    };

    const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
        if (!isDrawingRef.current || signatureMode !== 'scribble' || !contractReadiness.isReady) return;
        const canvas = signatureCanvasRef.current;
        const context = canvas?.getContext('2d');
        if (!canvas || !context) return;
        const rect = canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        context.lineTo(x, y);
        context.stroke();
    };

    const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
        if (!isDrawingRef.current) return;
        isDrawingRef.current = false;
        event.currentTarget.releasePointerCapture(event.pointerId);
    };

    const clearSignatureCanvas = () => {
        const canvas = signatureCanvasRef.current;
        const context = canvas?.getContext('2d');
        if (!canvas || !context) return;
        context.clearRect(0, 0, canvas.width, canvas.height);
        setHasSignature(false);
    };

    useEffect(() => {
        if (!profile?.full_name) return;
        syncSignature(signature);
    }, [profile?.full_name]);

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
        if (signatureMode === 'typed' && !isValidSignature) {
            setError('No modo digitado, digite seu nome completo exatamente como no cadastro.');
            return;
        }
        if (signatureMode === 'scribble' && !hasSignature) {
            setError('No modo rabisco, assine abaixo para habilitar a confirmação.');
            return;
        }
        setSubmitting(true);
        try {
            const expectedName = ((profile?.full_name as string) || '').trim();
            const finalSignature = (signatureMode === 'scribble' && !signature.trim())
                ? expectedName
                : signature.trim();
            if (!finalSignature) {
                setError('Não foi possível obter um nome válido para registro da assinatura.');
                return;
            }
            const { data, error } = await supabase.rpc('accept_teacher_contract', { p_typed_signature: finalSignature });
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
    const canSubmitSignature = contractReadiness.isReady
        && checked
        && (signatureMode === 'typed' ? isValidSignature : hasSignature);

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
                            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
                                <p className="flex items-center gap-2 font-black uppercase tracking-[0.15em] text-emerald-900">
                                    <CheckCircle2 size={15} />
                                    Contrato digital com trilha de auditoria
                                </p>
                                <p className="mt-2 text-xs leading-6 text-emerald-800">
                                    Seu aceite fica registrado com data, conta e fonte do acesso. O histórico fica preservado para
                                    consulta e rastreabilidade.
                                </p>
                            </div>
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

                            <div className="rounded-xl border border-brand-border bg-brand-surface-2 p-4 space-y-4">
                                <p className="text-xs font-black text-brand-muted uppercase tracking-wider">
                                    Como você quer assinar?
                                </p>
                                <div className="grid grid-cols-2 gap-3">
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setSignatureMode('typed');
                                            setHasSignature(false);
                                        }}
                                        disabled={loading || submitting || !contractReadiness.isReady}
                                        className={`px-3 py-2.5 rounded-xl border text-[11px] font-black uppercase tracking-widest transition-all ${signatureMode === 'typed'
                                            ? 'border-emerald-500 bg-emerald-50 text-emerald-700'
                                            : 'border-brand-border text-brand-muted hover:border-blue-500 hover:text-blue-700'}`}
                                    >
                                        <Type size={14} /> Digitar nome
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setSignatureMode('scribble')}
                                        disabled={loading || submitting || !contractReadiness.isReady}
                                        className={`px-3 py-2.5 rounded-xl border text-[11px] font-black uppercase tracking-widest transition-all ${signatureMode === 'scribble'
                                            ? 'border-emerald-500 bg-emerald-50 text-emerald-700'
                                            : 'border-brand-border text-brand-muted hover:border-blue-500 hover:text-blue-700'}`}
                                    >
                                        <PencilLine size={14} /> Rabisco no app
                                    </button>
                                </div>
                                <div className="mt-3 flex flex-wrap gap-2">
                                    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-black uppercase tracking-wider ${signatureMode === 'typed'
                                        ? isValidSignature
                                            ? 'bg-emerald-100 text-emerald-700'
                                            : 'bg-amber-100 text-amber-700'
                                        : hasSignature
                                            ? 'bg-emerald-100 text-emerald-700'
                                            : 'bg-slate-100 text-slate-600'
                                        }`}>
                                        <CheckCircle2 size={12} />
                                        {signatureMode === 'typed'
                                            ? isValidSignature
                                                ? 'Nome conferido com cadastro'
                                                : 'Digite exatamente como no cadastro'
                                            : hasSignature
                                                ? 'Rabisco registrado'
                                                : 'Assine abaixo para habilitar'}
                                    </span>
                                </div>
                            </div>

                            {signatureMode === 'typed' ? (
                                <div className="space-y-2">
                                    <label className="text-xs font-bold text-brand-text uppercase tracking-wider">
                                        Assinatura (digite seu nome completo)
                                    </label>
                                    <button
                                        type="button"
                                        onClick={() => syncSignature((profile?.full_name as string) || '')}
                                        disabled={loading || submitting || !contractReadiness.isReady}
                                        className="mb-2 text-[10px] font-bold text-blue-700 hover:underline disabled:opacity-50"
                                    >
                                        Usar o nome do cadastro
                                    </button>
                                    <input
                                        type="text"
                                        value={signature}
                                        disabled={loading || submitting || !contractReadiness.isReady}
                                        onChange={(e) => syncSignature(e.target.value)}
                                        placeholder={profile?.full_name || 'Seu nome completo'}
                                        autoComplete="name"
                                        className={`w-full px-4 py-3 rounded-xl border bg-brand-surface-2 text-brand-text text-sm outline-none transition-all ${isValidSignature
                                            ? 'border-emerald-500 ring-2 ring-emerald-100'
                                            : 'border-brand-border focus:border-blue-500'
                                        }`}
                                    />
                                    {signature && !isValidSignature && (
                                        <p className="text-[10px] text-red-500 font-bold">
                                            O nome precisa bater com o cadastro: "{profile?.full_name || 'seu cadastro'}"
                                        </p>
                                    )}
                                </div>
                            ) : (
                                <div className="space-y-3">
                                    <label className="text-xs font-bold text-brand-text uppercase tracking-wider">
                                        Assine abaixo com o dedo
                                    </label>
                                    <div className="rounded-xl border border-brand-border bg-white p-3">
                                        <canvas
                                            ref={signatureCanvasRef}
                                            onPointerDown={onPointerDown}
                                            onPointerMove={onPointerMove}
                                            onPointerUp={onPointerUp}
                                            onPointerLeave={onPointerUp}
                                            onPointerCancel={onPointerUp}
                                            className="w-full h-40 rounded-lg bg-white border border-slate-200 touch-none block"
                                        />
                                    </div>
                                    <div className="flex justify-between items-center text-[10px] text-brand-muted">
                                        <span>{hasSignature ? 'Assinatura registrada' : 'Toque e arraste para assinar'}</span>
                                        <button
                                            type="button"
                                            onClick={clearSignatureCanvas}
                                            className="text-xs font-bold text-blue-700 hover:text-blue-900"
                                        >
                                            Limpar assinatura
                                        </button>
                                    </div>
                                    <p className="text-[10px] text-brand-muted leading-relaxed">
                                        Ao assinar, registramos trilha com data, hora e origem da sessão para auditoria.
                                    </p>
                                    <div className="h-20 border border-brand-border rounded-xl bg-brand-surface flex items-center justify-center text-slate-300 relative overflow-hidden">
                                        <span className="text-xs italic">Seu rabisco será anexado após a confirmação</span>
                                        <div className="absolute bottom-2 right-2 text-[9px] font-mono text-slate-300">
                                            {new Date().toLocaleDateString()}
                                        </div>
                                    </div>
                                </div>
                            )}

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
                        disabled={submitting || loading || !canSubmitSignature}
                        className="w-full flex items-center justify-center gap-2 bg-emerald-600 text-white py-3.5 rounded-xl text-sm font-black uppercase tracking-widest hover:bg-emerald-700 active:scale-[0.99] transition-all shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {submitting ? <><Loader2 size={16} className="animate-spin" /> Registrando…</> : <><Sparkles size={16} /> Aceitar e assinar contrato</>}
                    </button>
                    <p className="mt-2 text-center text-xs text-brand-muted">
                        Após esse aceite, o contrato fica disponível para consulta na sua área e segue para validação interna.
                    </p>
                </div>
            </div>
        </div>,
        document.body,
    );
};

export default TeacherContractAccept;
