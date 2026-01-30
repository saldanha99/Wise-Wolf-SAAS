import React, { useState, useEffect } from 'react';
import { ContractDocument } from './ContractDocument';
import { ShieldCheck, ArrowRight, Lock, Loader2 } from 'lucide-react';

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
            <div className="bg-white rounded-3xl w-full max-w-5xl overflow-hidden shadow-2xl flex flex-col h-[90vh] animate-in slide-in-from-bottom-5 duration-500">
                {/* Header */}
                <div className="p-6 border-b border-slate-100 bg-slate-50 flex justify-between items-center shrink-0">
                    <h3 className="font-black text-slate-800 text-lg flex items-center gap-2">
                        <ShieldCheck className="text-emerald-600" /> Assinatura Digital
                    </h3>
                    <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
                        <ArrowRight size={20} className="rotate-180" /> Voltar
                    </button>
                </div>

                <div className="flex flex-1 overflow-hidden flex-col lg:flex-row">

                    {/* Left: Contract Preview */}
                    <div className="flex-1 bg-slate-100/50 p-6 overflow-y-auto relative">
                        <div className="bg-white shadow-sm mx-auto min-h-screen lg:min-h-0">
                            {/* We can disable interaction inside or just let them read */}
                            <div className="pointer-events-none select-none origin-top scale-[0.6] sm:scale-75 lg:scale-90 w-fit mx-auto">
                                <ContractDocument
                                    studentName={contractProps.studentName}
                                    studentCPF={contractProps.studentCPF}
                                    studentAddress={contractProps.studentAddress}
                                    studentEmail={contractProps.studentEmail}
                                    studentPhone={contractProps.studentPhone}
                                    planName={contractProps.planName}
                                    planValue={contractProps.planValue}
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
                    <div className="w-full lg:w-96 bg-white border-l border-slate-100 p-6 flex flex-col gap-6 shrink-0 overflow-y-auto">

                        <div className="p-4 bg-blue-50 border border-blue-100 rounded-xl text-blue-800 text-xs leading-relaxed">
                            <p className="font-bold flex items-center gap-1 mb-1"><Lock size={12} /> Validade Jurídica</p>
                            Esta assinatura eletrônica possui plena validade jurídica conforme MP 2.200-2/2001. Seus dados de conexão (IP) e carimbo de tempo serão registrados para auditoria.
                        </div>

                        <div className="space-y-4">
                            <div>
                                <label className="block text-xs font-black text-slate-400 uppercase tracking-widest mb-2">
                                    Digite seu nome completo (exatamente como no cadastro)
                                </label>
                                <input
                                    type="text"
                                    value={typedName}
                                    onChange={(e) => setTypedName(e.target.value)}
                                    placeholder={contractProps.studentName}
                                    className={`w-full p-4 border rounded-xl font-bold bg-slate-50 outline-none transition-all ${isValidSignature
                                        ? 'border-emerald-500 ring-2 ring-emerald-100 text-emerald-800'
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
        </div>
    );
};

export default ContractModal;
