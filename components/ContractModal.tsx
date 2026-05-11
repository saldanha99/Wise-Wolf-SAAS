import React, { useState, useEffect, useRef } from 'react';
import { ContractDocument } from './ContractDocument';
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
    const [isSignatureVisible, setIsSignatureVisible] = useState(false);

    useEffect(() => {
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
    }, []);

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

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-300">
            <div className="bg-white rounded-3xl w-full max-w-5xl shadow-2xl flex flex-col max-h-[90vh] lg:h-[90vh] animate-in slide-in-from-bottom-5 duration-500 relative">
                {/* Header */}
                <div className="p-6 border-b border-slate-100 bg-slate-50 flex justify-between items-center shrink-0 rounded-t-3xl z-20">
                    <h3 className="font-black text-slate-800 text-lg flex items-center gap-2">
                        <ShieldCheck className="text-emerald-600" /> Assinatura Digital
                    </h3>
                    <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
                        <ArrowRight size={20} className="rotate-180" /> Voltar
                    </button>
                </div>

                <div className="flex flex-col flex-1 overflow-y-auto overflow-x-hidden">

                    {/* Left: Contract Viewer (Takes most width on lg) */}
                    <div className="flex-1 bg-slate-100/50 p-2 sm:p-4 lg:p-6 pb-24 lg:pb-6 relative w-full flex flex-col items-center">
                        {/* 
                            For mobile/tablet layout footprint reduction we use zoom. 
                            CSS style object is used because Tailwind standard arbitrarily strips zoom depending on the compiler setup
                        */}
                        <div className="bg-white shadow-xl transition-all origin-top contract-zoom">
                            <style>{`
                                @media (max-width: 639px) { .contract-zoom { zoom: 0.43; } }
                                @media (min-width: 640px) and (max-width: 1023px) { .contract-zoom { zoom: 0.55; } }
                                @media (min-width: 1024px) { .contract-zoom { zoom: 0.8; } }
                                @media (min-width: 1280px) { .contract-zoom { zoom: 1; } }
                            `}</style>
                            {/* We can disable interaction inside or just let them read */}
                            <div className="pointer-events-none select-none w-[800px] max-w-none transform-gpu">
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
                                    acceptedAt={contractProps.acceptedAt}
                                    userIp={contractProps.userIp}
                                    subscriptionId={contractProps.subscriptionId}
                                />
                            </div>
                        </div>
                    </div>

                    {/* Right: Signature Actions */}
                    <div ref={signatureRef} className="w-full bg-white border-t border-slate-100 p-6 flex flex-col gap-6 shrink-0 z-10 shadow-[0_-10px_15px_-3px_rgba(0,0,0,0.05)] relative overflow-visible">

                        <div className="p-4 bg-blue-50 border border-blue-100 rounded-xl text-blue-800 text-xs leading-relaxed max-w-3xl mx-auto w-full">
                            <p className="font-bold flex items-center gap-1 mb-1"><Lock size={12} /> Validade Jurídica</p>
                            Esta assinatura eletrônica possui plena validade jurídica conforme MP 2.200-2/2001. Seus dados de conexão (IP) e carimbo de tempo serão registrados para auditoria.
                        </div>

                        <div className="space-y-4 max-w-3xl mx-auto w-full">
                            <div>
                                <label className="block text-xs font-black text-slate-400 uppercase tracking-widest mb-2">
                                    Digite seu nome completo (exatamente como no cadastro)
                                </label>
                                <input
                                    type="text"
                                    value={typedName}
                                    onChange={(e) => setTypedName(e.target.value)}
                                    placeholder={contractProps.studentName}
                                    className={`w-full p-4 border rounded-xl font-bold bg-slate-50 outline-none transition-all text-slate-800 placeholder:text-slate-400 ${isValidSignature
                                        ? 'border-emerald-500 ring-2 ring-emerald-100'
                                        : 'border-slate-200 focus:border-blue-500'
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
                                <label className="block text-xs font-black text-slate-400 uppercase tracking-widest mb-2">
                                    Preview da Assinatura
                                </label>
                                <div className="h-24 border border-slate-200 rounded-xl flex items-center justify-center bg-white relative overflow-hidden">
                                    {typedName ? (
                                        <span className="text-3xl text-slate-800 transform -rotate-2" style={{ fontFamily: '"Dancing Script", cursive' }}>
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

                        <div className="mt-auto space-y-4 pt-4 border-t border-slate-100">
                            <label className="flex items-start gap-3 cursor-pointer select-none">
                                <input
                                    type="checkbox"
                                    className="mt-1 w-5 h-5 accent-emerald-600 rounded-lg cursor-pointer shrink-0"
                                    checked={accepted}
                                    onChange={(e) => setAccepted(e.target.checked)}
                                />
                                <span className="text-xs text-slate-600 font-medium leading-relaxed">
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
                <div className="lg:hidden fixed bottom-6 left-0 right-0 flex justify-center z-[60] animate-in fade-in zoom-in slide-in-from-bottom-5 duration-300 pointer-events-none">
                    <button
                        onClick={scrollToSignature}
                        className="bg-emerald-600 hover:bg-emerald-700 text-white shadow-xl shadow-emerald-600/30 px-6 py-4 rounded-full font-bold flex items-center gap-2 pointer-events-auto"
                    >
                        <PenTool size={20} /> Assinar Digitalmente
                    </button>
                </div>
            )}
        </div>
    );
};

export default ContractModal;
