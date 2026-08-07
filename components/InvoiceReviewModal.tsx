import React, { useState } from 'react';
import { X, CheckCircle2, XCircle, FileText, AlertTriangle, Loader2, Download } from 'lucide-react';
import { supabase } from '../lib/supabase';

interface InvoiceReviewModalProps {
    invoice: {
        id: string;
        teacher: {
            full_name: string;
            email: string;
        };
        month_year: string;
        total_amount: number;
        invoice_url: string;
        status: string;
    };
    onClose: () => void;
    onUpdate: () => void;
}

const InvoiceReviewModal: React.FC<InvoiceReviewModalProps> = ({ invoice, onClose, onUpdate }) => {
    const [isRejecting, setIsRejecting] = useState(false);
    const [rejectionReason, setRejectionReason] = useState('');
    const [processing, setProcessing] = useState(false);

    const handleApprove = async () => {
        setProcessing(true);
        try {
            const { error } = await supabase
                .from('teacher_closings')
                .update({
                    status: 'COMPLETED',
                    // Nota aprovada não pode continuar exibindo o motivo da
                    // rejeição anterior na tela do professor.
                    rejection_reason: null,
                    updated_at: new Date().toISOString()
                })
                .eq('id', invoice.id);

            if (error) throw error;
            onUpdate();
            onClose();
        } catch (err) {
            console.error('Error approving invoice:', err);
            alert('Erro ao aprovar nota fiscal.');
        } finally {
            setProcessing(false);
        }
    };

    const handleReject = async () => {
        if (!rejectionReason.trim()) return;
        setProcessing(true);
        try {
            const { error } = await supabase
                .from('teacher_closings')
                .update({
                    status: 'REJECTED',
                    rejection_reason: rejectionReason,
                    updated_at: new Date().toISOString()
                })
                .eq('id', invoice.id);

            if (error) throw error;
            onUpdate();
            onClose();
        } catch (err) {
            console.error('Error rejecting invoice:', err);
            alert('Erro ao rejeitar nota fiscal.');
        } finally {
            setProcessing(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-brand-surface/80 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="bg-brand-surface w-full max-w-5xl h-[90vh] rounded-3xl shadow-2xl flex flex-col overflow-hidden border border-brand-border dark:border-brand-border">
                {/* Header */}
                <div className="p-6 border-b border-brand-border flex justify-between items-center bg-brand-surface-2/50 dark:bg-brand-surface-2/50">
                    <div>
                        <h2 className="text-xl font-black text-brand-text tracking-tight flex items-center gap-2">
                            <FileText className="text-tenant-primary" size={24} />
                            Revisão de Nota Fiscal
                        </h2>
                        <p className="text-sm text-brand-muted font-medium">
                            {invoice.teacher.full_name} • {new Date(invoice.month_year + '-02').toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })}
                        </p>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-2 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-full transition-colors"
                    >
                        <X size={24} className="text-brand-muted" />
                    </button>
                </div>

                {/* Content */}
                <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
                    {/* PDF Preview */}
                    <div className="flex-1 bg-brand-surface-2 dark:bg-slate-950 relative">
                        {invoice.invoice_url ? (
                            <iframe
                                src={invoice.invoice_url}
                                className="w-full h-full"
                                title="PDF Preview"
                            />
                        ) : (
                            <div className="flex flex-col items-center justify-center h-full text-brand-muted">
                                <AlertTriangle size={48} className="mb-4 opacity-50" />
                                <p className="font-bold">Arquivo não disponível</p>
                            </div>
                        )}
                    </div>

                    {/* Sidebar / Controls */}
                    <div className="w-full md:w-80 p-6 border-l border-brand-border bg-brand-surface overflow-y-auto">
                        <div className="mb-8">
                            <p className="text-xs font-black text-brand-muted uppercase tracking-widest mb-2">Detalhes</p>
                            <div className="space-y-4">
                                <div className="p-4 bg-brand-surface-2/50 rounded-2xl border border-brand-border">
                                    <p className="text-xs text-brand-muted mb-1">Valor Total</p>
                                    <p className="text-2xl font-black text-brand-text tracking-tight">
                                        R$ {invoice.total_amount.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                                    </p>
                                </div>
                                <a
                                    href={invoice.invoice_url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="flex items-center justify-center gap-2 w-full py-3 bg-brand-surface-2 dark:bg-brand-surface-2 hover:bg-slate-200 dark:hover:bg-slate-700 text-brand-muted rounded-xl text-xs font-bold uppercase tracking-wider transition-colors"
                                >
                                    <Download size={16} /> Baixar PDF
                                </a>
                            </div>
                        </div>

                        <div>
                            <p className="text-xs font-black text-brand-muted uppercase tracking-widest mb-4">Decisão</p>

                            {!isRejecting ? (
                                <div className="space-y-3">
                                    <button
                                        onClick={handleApprove}
                                        disabled={processing}
                                        className="w-full py-4 bg-emerald-500 text-white rounded-xl font-black text-sm uppercase tracking-widest hover:bg-emerald-600 active:scale-95 transition-all shadow-xl shadow-emerald-500/20 flex items-center justify-center gap-2"
                                    >
                                        {processing ? <Loader2 size={18} className="animate-spin" /> : <CheckCircle2 size={18} />}
                                        Aprovar Nota
                                    </button>
                                    <button
                                        onClick={() => setIsRejecting(true)}
                                        disabled={processing}
                                        className="w-full py-4 bg-brand-surface dark:bg-brand-surface-2 text-red-500 border-2 border-red-100 dark:border-red-900/30 rounded-xl font-black text-sm uppercase tracking-widest hover:bg-red-50 dark:hover:bg-red-900/10 transition-colors flex items-center justify-center gap-2"
                                    >
                                        <XCircle size={18} /> Rejeitar
                                    </button>
                                </div>
                            ) : (
                                <div className="animate-in fade-in slide-in-from-right-4 duration-200">
                                    <label className="text-xs font-bold text-red-500 mb-2 block">Motivo da Rejeição</label>
                                    <textarea
                                        value={rejectionReason}
                                        onChange={(e) => setRejectionReason(e.target.value)}
                                        className="w-full h-32 p-3 bg-red-50 dark:bg-red-900/10 border border-red-200 dark:border-red-900/30 rounded-xl text-sm outline-none focus:ring-2 focus:ring-red-500 mb-3 placeholder:text-red-300"
                                        placeholder="Descreva o problema com a nota..."
                                        autoFocus
                                    />
                                    <div className="flex gap-2">
                                        <button
                                            onClick={() => setIsRejecting(false)}
                                            className="flex-1 py-3 text-brand-muted font-bold text-xs uppercase tracking-wider hover:bg-brand-surface-2 dark:hover:bg-brand-surface-2 rounded-xl transition-colors"
                                        >
                                            Cancelar
                                        </button>
                                        <button
                                            onClick={handleReject}
                                            disabled={!rejectionReason.trim() || processing}
                                            className="flex-1 py-3 bg-red-500 text-white rounded-xl font-black text-xs uppercase tracking-widest hover:bg-red-600 shadow-lg shadow-red-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
                                        >
                                            {processing ? <Loader2 size={16} className="animate-spin mx-auto" /> : 'Confirmar'}
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default InvoiceReviewModal;
