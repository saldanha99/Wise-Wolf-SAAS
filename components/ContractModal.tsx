import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { ContractDocument, type SchoolInfo } from './ContractDocument';
import { ShieldCheck, ArrowRight, Lock, Loader2, PenTool } from 'lucide-react';

interface ContractModalProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: (signatureData?: { type: 'DIGITAL', typedName: string }) => void;
    loading?: boolean;

    // Contract Data
    studentName: string;
    studentCPF: string;
    studentAddress: string;
    studentEmail: string;
    studentPhone: string;
    planName: string;
    planValue: string;
    totalValue: string;
    planDuration: number;
    startDate: string;
    endDate: string;
    dueDay: number;
    classFrequency: number | string;
    acceptedAt?: string;
    userIp?: string;
    subscriptionId?: string;
    school?: SchoolInfo;
    dependentName?: string;
    enrollmentFee?: number;
    proRataValue?: number;
    dueToday?: number;
    firstDueDate?: string;
    processingStage?: 'IDLE' | 'ACCOUNT' | 'PROFILE' | 'CUSTOMER' | 'BILLING' | 'FINALIZING' | 'COMPLETE' | 'ERROR';
    processingError?: string | null;
    correlationId?: string;
}

const ContractModal: React.FC<ContractModalProps> = ({
    isOpen,
    onClose,
    onConfirm,
    loading = false,
    ...contractProps
}) => {
    const [accepted, setAccepted] = useState(false);
    const [typedName, setTypedName] = useState('');
    const [isValidSignature, setIsValidSignature] = useState(false);

    // Floating Button State & Observer
    const signatureRef = useRef<HTMLDivElement>(null);
    const dialogRef = useRef<HTMLDivElement>(null);
    const onCloseRef = useRef(onClose);
    const [isSignatureVisible, setIsSignatureVisible] = useState(false);

    useEffect(() => {
        onCloseRef.current = onClose;
    }, [onClose]);

    useEffect(() => {
        if (!isOpen) return;
        const observer = new IntersectionObserver(
            ([entry]) => {
                setIsSignatureVisible(entry.isIntersecting);
            },
            { root: null, rootMargin: '0px', threshold: 0.1 }
        );

        if (signatureRef.current) observer.observe(signatureRef.current);
        return () => {
            if (signatureRef.current) observer.unobserve(signatureRef.current);
        };
    }, [isOpen]);

    useEffect(() => {
        if (!isOpen) {
            setAccepted(false);
            setTypedName('');
            setIsValidSignature(false);
        }
    }, [isOpen]);

    useEffect(() => {
        if (!isOpen) return;
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        const previousFocus = document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        dialogRef.current?.focus();

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && !loading) {
                event.preventDefault();
                onCloseRef.current();
                return;
            }
            if (event.key !== 'Tab' || !dialogRef.current) return;

            const focusable = Array.from(
                dialogRef.current.querySelectorAll(
                    'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
                ) as NodeListOf<HTMLElement>
            ).filter((element: HTMLElement) => !element.hasAttribute('aria-hidden'));
            if (focusable.length === 0) return;

            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        };

        document.addEventListener('keydown', handleKeyDown);
        return () => {
            document.removeEventListener('keydown', handleKeyDown);
            document.body.style.overflow = previousOverflow;
            previousFocus?.focus();
        };
    }, [isOpen, loading]);

    const scrollToSignature = () => {
        signatureRef.current?.scrollIntoView({ behavior: 'smooth' });
    };

    useEffect(() => {
        // Validation: Typed name must match studentName exactly (trimming whitespace is fair)
        // Case insensitive as requested
        if (typedName.trim().toLowerCase() === contractProps.studentName.trim().toLowerCase()) {
            setIsValidSignature(true);
        } else {
            setIsValidSignature(false);
        }
    }, [typedName, contractProps.studentName]);

    if (!isOpen) return null;

    const handleConfirm = () => {
        if (accepted && isValidSignature) {
            onConfirm({ type: 'DIGITAL', typedName: typedName.trim() });
        }
    };

    const progressSteps = [
        { key: 'ACCOUNT', label: 'Confirmando sua conta' },
        { key: 'PROFILE', label: 'Registrando contrato' },
        { key: 'CUSTOMER', label: 'Preparando dados financeiros' },
        { key: 'BILLING', label: 'Criando cobrança' },
        { key: 'FINALIZING', label: 'Confirmando matrícula' },
    ];
    const currentProgressIndex = progressSteps.findIndex(item => item.key === contractProps.processingStage);

    return createPortal(
        <div className="fixed inset-0 z-[250] flex items-center justify-center bg-black/60 backdrop-blur-sm p-0 animate-in fade-in duration-300 sm:p-4">
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="contract-dialog-title"
                tabIndex={-1}
                className="relative flex h-dvh max-h-dvh w-full max-w-5xl flex-col bg-brand-surface shadow-2xl animate-in slide-in-from-bottom-5 duration-500 sm:h-auto sm:max-h-[92dvh] sm:rounded-3xl lg:h-[90dvh]"
            >
                {/* Header */}
                <div className="z-20 flex shrink-0 items-center justify-between gap-3 border-b border-brand-border bg-brand-surface-2 p-4 sm:rounded-t-3xl sm:p-6">
                    <h3 id="contract-dialog-title" className="flex min-w-0 items-center gap-2 text-base font-black text-brand-text sm:text-lg">
                        <ShieldCheck className="text-emerald-600" /> Assinatura Digital
                    </h3>
                    <button
                        type="button"
                        onClick={onClose}
                        disabled={loading}
                        aria-label="Voltar para o formulário de matrícula"
                        className="shrink-0 text-brand-muted hover:text-brand-text disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                        <ArrowRight size={20} className="rotate-180" /> Voltar
                    </button>
                </div>

                <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden">

                    {/* Left: Contract Viewer (Takes most width on lg) */}
                    <div className="relative flex w-full flex-1 flex-col items-center bg-brand-surface-2/50 p-2 pb-24 sm:p-4 sm:pb-24 lg:p-6">
                        <div className="w-full max-w-[210mm] bg-white shadow-xl">
                            <div className="select-text">
                                <ContractDocument
                                    studentName={contractProps.studentName}
                                    studentCPF={contractProps.studentCPF}
                                    studentAddress={contractProps.studentAddress}
                                    studentEmail={contractProps.studentEmail}
                                    studentPhone={contractProps.studentPhone}
                                    planName={contractProps.planName}
                                    planValue={contractProps.planValue}
                                    totalValue={contractProps.totalValue}
                                    planDuration={contractProps.planDuration}
                                    startDate={contractProps.startDate}
                                    endDate={contractProps.endDate}
                                    dueDay={contractProps.dueDay}
                                    classFrequency={contractProps.classFrequency}
                                    enrollmentFee={contractProps.enrollmentFee}
                                    proRataValue={contractProps.proRataValue}
                                    acceptedAt={contractProps.acceptedAt}
                                    userIp={contractProps.userIp}
                                    subscriptionId={contractProps.subscriptionId}
                                    school={contractProps.school}
                                    dependentName={contractProps.dependentName}
                                    displayMode="responsive"
                                    showPrintButton={false}
                                />
                            </div>
                        </div>
                    </div>

                    {/* Right: Signature Actions */}
                    <div ref={signatureRef} className="relative z-10 flex w-full shrink-0 flex-col gap-6 overflow-visible border-t border-brand-border bg-brand-surface p-4 shadow-[0_-10px_15px_-3px_rgba(0,0,0,0.05)] sm:p-6">

                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 rounded-xl border border-blue-100 bg-blue-50 p-4 text-xs text-blue-900 max-w-3xl mx-auto w-full">
                            <div>
                                <p className="text-[9px] uppercase font-bold text-blue-600">Mensalidade</p>
                                <p className="font-black">R$ {contractProps.planValue}</p>
                            </div>
                            <div>
                                <p className="text-[9px] uppercase font-bold text-blue-600">Total</p>
                                <p className="font-black">R$ {contractProps.totalValue}</p>
                            </div>
                            <div>
                                <p className="text-[9px] uppercase font-bold text-blue-600">Taxa inicial</p>
                                <p className="font-black">R$ {Number(contractProps.enrollmentFee || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</p>
                            </div>
                            <div>
                                <p className="text-[9px] uppercase font-bold text-blue-600">1º vencimento</p>
                                <p className="font-black">{contractProps.firstDueDate || contractProps.startDate}</p>
                            </div>
                            {Number(contractProps.proRataValue || 0) > 0 && (
                                <p className="col-span-2 sm:col-span-4 text-[10px] text-blue-700">
                                    Inclui valor proporcional inicial de R$ {Number(contractProps.proRataValue).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}.
                                </p>
                            )}
                        </div>

                        <div className="p-4 bg-blue-50 border border-blue-100 rounded-xl text-blue-800 text-xs leading-relaxed max-w-3xl mx-auto w-full">
                            <p className="font-bold flex items-center gap-1 mb-1"><Lock size={12} /> Validade Jurídica</p>
                            Esta assinatura eletrônica possui plena validade jurídica conforme MP 2.200-2/2001. Seus dados de conexão (IP) e carimbo de tempo serão registrados para auditoria.
                        </div>

                        <div className="space-y-4 max-w-3xl mx-auto w-full">
                            <div>
                                <label className="block text-xs font-black text-brand-muted uppercase tracking-widest mb-2">
                                    Digite seu nome completo (exatamente como no cadastro)
                                </label>
                                <button
                                    type="button"
                                    onClick={() => setTypedName(contractProps.studentName)}
                                    disabled={loading}
                                    className="mb-2 text-[10px] font-bold text-blue-700 hover:underline disabled:opacity-50"
                                >
                                    Usar o nome do cadastro
                                </button>
                                <input
                                    type="text"
                                    disabled={loading}
                                    value={typedName}
                                    onChange={(e) => setTypedName(e.target.value)}
                                    placeholder={contractProps.studentName}
                                    className={`w-full p-4 border rounded-xl font-bold bg-brand-surface-2 outline-none transition-all text-brand-text placeholder:text-brand-muted ${isValidSignature
                                        ? 'border-emerald-500 ring-2 ring-emerald-100'
                                        : 'border-brand-border focus:border-blue-500'
                                        }`}
                                />
                                {typedName && !isValidSignature && (
                                    <p className="text-[10px] text-red-500 mt-1 font-bold">
                                        O nome deve ser idêntico ao cadastro: "{contractProps.studentName}"
                                    </p>
                                )}
                            </div>

                            {/* Live Preview */}
                            <div>
                                <label className="block text-xs font-black text-brand-muted uppercase tracking-widest mb-2">
                                    Preview da Assinatura
                                </label>
                                <div className="h-24 border border-brand-border rounded-xl flex items-center justify-center bg-brand-surface relative overflow-hidden">
                                    {typedName ? (
                                        <span className="text-3xl text-brand-text transform -rotate-2" style={{ fontFamily: '"Dancing Script", cursive' }}>
                                            {typedName}
                                        </span>
                                    ) : (
                                        <span className="text-slate-300 text-sm italic">Sua assinatura aparecerá aqui</span>
                                    )}
                                    <div className="absolute bottom-2 right-2 text-[10px] text-slate-300 font-mono">
                                        {new Date().toLocaleDateString()}
                                    </div>
                                </div>
                            </div>
                        </div>

                        {(loading || contractProps.processingError) && (
                            <div
                                className="max-w-3xl mx-auto w-full rounded-xl border border-brand-border bg-brand-surface-2 p-4"
                                aria-live="polite"
                                role="status"
                            >
                                {contractProps.processingError ? (
                                    <div className="text-sm text-red-700">
                                        <p className="font-bold mb-1">Não foi possível concluir agora</p>
                                        <p>{contractProps.processingError}</p>
                                        <p className="mt-2 text-xs">Você pode clicar novamente sem duplicar cadastro ou cobrança.</p>
                                    </div>
                                ) : (
                                    <div className="space-y-2">
                                        {progressSteps.map((item, index) => (
                                            <div key={item.key} className="flex items-center gap-2 text-xs">
                                                {index < currentProgressIndex ? (
                                                    <ShieldCheck size={15} className="text-emerald-600" />
                                                ) : index === currentProgressIndex ? (
                                                    <Loader2 size={15} className="animate-spin text-blue-600" />
                                                ) : (
                                                    <span className="w-[15px] h-[15px] rounded-full border border-slate-300" />
                                                )}
                                                <span className={index <= currentProgressIndex ? 'font-bold text-brand-text' : 'text-brand-muted'}>
                                                    {item.label}
                                                </span>
                                            </div>
                                        ))}
                                    </div>
                                )}
                                {contractProps.correlationId && (
                                    <p className="mt-3 text-[10px] text-brand-muted">
                                        Protocolo: <span className="font-mono font-bold">{contractProps.correlationId.slice(0, 8).toUpperCase()}</span>
                                    </p>
                                )}
                            </div>
                        )}

                        <div className="mt-auto space-y-4 pt-4 border-t border-brand-border">
                            <label className="flex items-start gap-3 cursor-pointer select-none">
                                <input
                                    type="checkbox"
                                    className="mt-1 w-5 h-5 accent-emerald-600 rounded-lg cursor-pointer shrink-0"
                                    checked={accepted}
                                    disabled={loading}
                                    onChange={(e) => setAccepted(e.target.checked)}
                                />
                                <span className="text-xs text-brand-muted font-medium leading-relaxed">
                                    Li e concordo com os termos do contrato e com a assinatura digital.
                                </span>
                            </label>

                            <button
                                onClick={handleConfirm}
                                disabled={loading || !accepted || !isValidSignature}
                                className="w-full py-4 bg-[#002366] disabled:bg-slate-300 disabled:cursor-not-allowed hover:bg-blue-900 text-white rounded-xl font-black text-sm uppercase tracking-widest transition-all shadow-xl shadow-blue-900/20 flex items-center justify-center gap-3"
                            >
                                {loading ? <Loader2 className="animate-spin" /> : <>
                                    <ShieldCheck size={18} /> FINALIZAR MATRÍCULA
                                </>}
                            </button>
                        </div>

                    </div>
                </div>
            </div>

            {/* Floating Action Button for Mobile */}
            {!isSignatureVisible && (
                <div className="lg:hidden fixed bottom-[max(1.5rem,env(safe-area-inset-bottom))] left-0 right-0 flex justify-center z-[260] animate-in fade-in zoom-in slide-in-from-bottom-5 duration-300 pointer-events-none">
                    <button
                        onClick={scrollToSignature}
                        disabled={loading}
                        className="bg-emerald-600 hover:bg-emerald-700 text-white shadow-xl shadow-emerald-600/30 px-6 py-4 rounded-full font-bold flex items-center gap-2 pointer-events-auto"
                    >
                        <PenTool size={20} /> Assinar Digitalmente
                    </button>
                </div>
            )}
        </div>,
        document.body,
    );
};

export default ContractModal;
