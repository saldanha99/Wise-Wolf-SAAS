import React, { useState, useEffect } from 'react';
import { FileText, Upload, Clock, CheckCircle, XCircle, FileUp, AlertCircle, RefreshCw, Hash, Calendar, HelpCircle, ShieldCheck } from 'lucide-react';
import { User as UserType } from '../types';
import { supabase } from '../lib/supabase';
import { buildTeacherInvoiceObjectPath } from '../lib/invoiceStorage';
import NfIssuanceTour from './NfIssuanceTour';
import InvoiceDocumentLink from './InvoiceDocumentLink';

interface TeacherInvoicesProps {
    user: UserType;
    tenantId?: string;
}

const TeacherInvoices: React.FC<TeacherInvoicesProps> = ({ user, tenantId }) => {
    const [closings, setClosings] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [isUploadingFile, setIsUploadingFile] = useState<string | null>(null);
    const [showNfHelp, setShowNfHelp] = useState(false);

    useEffect(() => {
        if (user && tenantId) {
            fetchInvoicesData();
        }
    }, [user, tenantId]);

    const fetchInvoicesData = async () => {
        setLoading(true);
        try {
            // Fetch Teacher Closings (History)
            const { data: closingsData } = await supabase
                .from('teacher_closings')
                .select('*')
                .eq('teacher_id', user.id)
                .eq('tenant_id', tenantId)
                .order('month_year', { ascending: false });

            if (closingsData) setClosings(closingsData);
        } catch (err) {
            console.error('Error fetching invoices:', err);
        } finally {
            setLoading(false);
        }
    };

    const handleFileUpload = async (closingId: string, file: File) => {
        if (!file) return;
        if (file.type !== 'application/pdf') {
            alert('Por favor, envie apenas arquivos em formato PDF.');
            return;
        }
        if (file.size > 5 * 1024 * 1024) {
            alert('O arquivo é muito grande. O limite é 5MB.');
            return;
        }

        setIsUploadingFile(closingId);
        try {
            const filePath = buildTeacherInvoiceObjectPath(closingId);

            // 1. Upload to Supabase Storage
            const { error: uploadError } = await supabase.storage
                .from('invoices')
                .upload(filePath, file, {
                    upsert: false
                });

            if (uploadError) {
                if (uploadError.message === 'Bucket not found') {
                    throw new Error('Bucket "invoices" não encontrado. Contate o suporte.');
                }
                throw uploadError;
            }

            // 2. Anexa pela RPC (badge "Em Análise"). O banco guarda somente o
            // object path; a URL temporária é emitida apenas ao abrir o arquivo.
            // O professor não escreve mais
            // direto em teacher_closings — pelo PostgREST o mesmo PATCH alcançaria
            // total_amount e status. A RPC grava só o link e só move o status quando
            // o fechamento já está na faixa de NF.
            const { error: updateError } = await supabase.rpc('teacher_attach_invoice', {
                p_closing_id: closingId,
                p_nf_link: filePath,
            });

            if (updateError) throw updateError;

            alert('Nota Fiscal anexada com sucesso!');
            fetchInvoicesData();
        } catch (err: any) {
            alert('Erro no upload: ' + err.message);
        } finally {
            setIsUploadingFile(null);
        }
    };

    const getStatusBadge = (status: string) => {
        switch (status) {
            case 'COMPLETED':
                return <span className="inline-flex whitespace-nowrap rounded-full border border-emerald-200 bg-emerald-100 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-emerald-700">Aprovado</span>;
            case 'PAID_WAITING_NF':
                return <span className="inline-flex whitespace-nowrap rounded-full border border-blue-200 bg-blue-100 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-blue-700">Envie sua NF</span>;
            case 'UNDER_REVIEW':
                return <span className="inline-flex whitespace-nowrap rounded-full border border-purple-200 bg-purple-100 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-purple-700">Em Análise</span>;
            case 'REJECTED':
                return <span className="inline-flex whitespace-nowrap rounded-full border border-red-200 bg-red-100 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-red-700">Nota Rejeitada</span>;
            default:
                return <span className="inline-flex whitespace-nowrap rounded-full border border-brand-border bg-brand-surface-2 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-brand-text">Pendente</span>;
        }
    };

    const renderInvoiceAction = (inv: any) => {
        const status = inv.status || '';
        const isRejected = status === 'REJECTED' || status === 'REJEITADO';
        const hasLink = !!inv.nf_link;
        const canUpload = ['REJECTED', 'REJEITADO', 'PAGO', 'PAID', 'PAID_WAITING_NF', 'UNDER_REVIEW'].includes(status)
            && Number(inv.total_amount || 0) > 0;

        if (canUpload) {
            return (
                <div className="relative w-full">
                    {/* Sem o motivo, "Nota Rejeitada" manda o professor reenviar
                        exatamente a mesma nota errada. */}
                    {isRejected && inv.rejection_reason && (
                        <p className="mb-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-left text-[10px] font-bold leading-snug text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
                            <span className="block text-[9px] font-black uppercase tracking-widest opacity-70">Motivo</span>
                            {inv.rejection_reason}
                        </p>
                    )}
                    {hasLink && (
                        <InvoiceDocumentLink
                            reference={inv.nf_link}
                            className={`mb-2 block text-center text-[10px] font-bold hover:underline ${isRejected ? 'text-red-500' : 'text-blue-500'}`}
                        >
                            {isRejected ? 'Ver Nota Rejeitada' : 'Ver Nota Atual'}
                        </InvoiceDocumentLink>
                    )}
                    <label
                        className={`flex w-full shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-xl px-4 py-2 text-[10px] font-black uppercase tracking-widest text-white shadow-lg transition-all hover:scale-[1.02] active:scale-95 focus-within:ring-2 focus-within:ring-blue-500 focus-within:ring-offset-2 ${isUploadingFile === inv.id ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'} ${isRejected ? 'bg-red-500 shadow-red-500/20' : 'bg-blue-700 bg-tenant-primary shadow-tenant-primary/20'}`}
                    >
                        <input
                            type="file"
                            accept=".pdf"
                            aria-label={isRejected ? 'Reenviar nota fiscal em PDF' : 'Anexar nota fiscal em PDF'}
                            className="sr-only"
                            onChange={(e) => {
                                const file = e.target.files?.[0];
                                if (file) handleFileUpload(inv.id, file);
                            }}
                            disabled={isUploadingFile === inv.id}
                        />
                        {isUploadingFile === inv.id ? (
                            <><RefreshCw size={14} className="animate-spin" /> Enviando...</>
                        ) : (
                            <><Upload size={14} /> {isRejected ? 'Reenviar Nota' : 'Anexar NF (PDF)'}</>
                        )}
                    </label>
                </div>
            );
        }

        if (hasLink) {
            return (
                <InvoiceDocumentLink
                    reference={inv.nf_link}
                    className="flex w-full shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-xl bg-brand-surface-2 px-4 py-2 text-[10px] font-black uppercase tracking-widest text-brand-muted transition-all hover:bg-blue-700 hover:bg-tenant-primary hover:text-white dark:bg-brand-surface-2"
                >
                    <FileText size={14} />
                    <span>Ver Nota Fiscal</span>
                </InvoiceDocumentLink>
            );
        }

        return (
            <span className="block text-center text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-brand-muted">
                Aguardando Aprovação
            </span>
        );
    };

    return (
        <div className="mx-auto min-h-screen max-w-[1200px] bg-brand-surface-2/50 p-3 dark:bg-brand-surface/50 sm:p-6 lg:p-8">
            <div className="mb-8">
                <div className="mb-2 flex min-w-0 items-center gap-3">
                    <div className="shrink-0 rounded-xl bg-tenant-primary/10 p-3">
                        <FileText className="text-tenant-primary" size={24} />
                    </div>
                    <h1 className="min-w-0 text-2xl font-black tracking-tight text-brand-text sm:text-3xl">Minhas Notas Fiscais (NFS-e)</h1>
                </div>
                <p className="text-brand-muted font-medium">Cada linha abaixo é um fechamento exclusivamente seu. Depois do repasse, envie a NFS-e emitida para a escola.</p>
                <button
                    type="button"
                    onClick={() => setShowNfHelp(true)}
                    className="mt-3 inline-flex items-center gap-1.5 rounded-xl border border-brand-border bg-brand-surface-2 px-3.5 py-2 text-[10px] font-black uppercase tracking-widest text-brand-muted transition-all hover:border-tenant-primary hover:text-brand-text"
                >
                    <HelpCircle size={13} /> Como emitir minha nota
                </button>
                <div className="mt-4 flex max-w-3xl items-start gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-emerald-900 dark:border-emerald-500/25 dark:bg-emerald-500/10 dark:text-emerald-100">
                    <ShieldCheck size={18} className="mt-0.5 shrink-0" />
                    <p className="text-xs font-semibold leading-relaxed">
                        Esta não é uma lista geral de pagamentos. Você só pode visualizar seus próprios valores e PDFs. Se aparecer qualquer documento de outra pessoa, não abra nem compartilhe e avise a direção.
                    </p>
                </div>
            </div>

            {/* Tour obrigatório: aparece sozinho quando há pagamento autorizado sem
                nota anexada. O botão acima reabre as mesmas instruções por consulta. */}
            <NfIssuanceTour onDone={fetchInvoicesData} />
            {showNfHelp && <NfIssuanceTour manual onClose={() => setShowNfHelp(false)} />}

            {/* History Table */}
            <div className="bg-brand-surface rounded-[3rem] border border-brand-border shadow-xl overflow-hidden">
                <div className="flex items-center justify-between border-b bg-brand-surface-2/50 p-5 dark:border-brand-border dark:bg-brand-surface-2/30 sm:p-8">
                    <h3 className="font-black text-brand-text dark:text-slate-200 text-xs uppercase tracking-widest flex items-center gap-2">

                        <FileUp size={16} className="text-tenant-primary" /> Meus fechamentos e envios
                    </h3>
                </div>

                <div className="space-y-3 p-4 md:hidden">
                    {loading ? (
                        Array(3).fill(0).map((_, i) => (
                            <div key={i} className="animate-pulse rounded-2xl border border-brand-border p-4">
                                <div className="h-4 w-2/3 rounded bg-brand-surface-2" />
                                <div className="mt-4 h-16 w-full rounded bg-brand-surface-2" />
                            </div>
                        ))
                    ) : closings.length > 0 ? (
                        closings.map((inv) => (
                            <article key={inv.id} className="rounded-2xl border border-brand-border bg-brand-surface p-4">
                                <div className="flex items-start justify-between gap-3">
                                    <div className="flex min-w-0 items-center gap-3">
                                        <div className="shrink-0 rounded-xl border border-brand-border bg-brand-surface-2 p-2.5 text-brand-muted">
                                            <Calendar size={18} />
                                        </div>
                                        <div className="min-w-0">
                                            <p className="text-sm font-black text-brand-text">
                                                {new Date(inv.month_year + '-02').toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })}
                                            </p>
                                            <p className="text-[10px] font-bold uppercase tracking-wider text-brand-muted">Ref: {inv.month_year}</p>
                                        </div>
                                    </div>
                                    <div className="shrink-0">{getStatusBadge(inv.status)}</div>
                                </div>

                                <dl className="my-4 grid grid-cols-2 gap-3 border-y border-brand-border py-4">
                                    <div>
                                        <dt className="text-[10px] font-black uppercase tracking-widest text-brand-muted">Aulas</dt>
                                        <dd className="mt-1 flex items-center gap-1.5 text-sm font-bold text-brand-text">
                                            <Hash size={13} className="text-brand-muted" /> {inv.total_lessons} aulas
                                        </dd>
                                    </div>
                                    <div className="text-right">
                                        <dt className="text-[10px] font-black uppercase tracking-widest text-brand-muted">Valor total</dt>
                                        <dd className="mt-1 text-base font-black text-brand-text">
                                            R$ {Number(inv.total_amount).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                                        </dd>
                                    </div>
                                </dl>

                                <div>
                                    <p className="mb-2 text-[10px] font-black uppercase tracking-widest text-brand-muted">Ação / Arquivo</p>
                                    {renderInvoiceAction(inv)}
                                </div>
                            </article>
                        ))
                    ) : (
                        <div className="flex flex-col items-center justify-center py-12 text-center text-brand-muted">
                            <FileText size={40} className="mb-4 opacity-20" />
                            <p className="text-sm font-black uppercase tracking-widest">Nenhum fechamento disponível</p>
                        </div>
                    )}
                </div>

                <div className="hidden overflow-x-auto md:block">
                    <table className="w-full text-left border-collapse min-w-[500px]">
                        <thead>
                            <tr className="bg-brand-surface-2/50 dark:bg-brand-surface-2/50 text-[10px] text-brand-muted uppercase font-black border-b dark:border-brand-border">
                                <th className="px-8 py-5">Mês Referência</th>
                                <th className="px-8 py-5">Aulas</th>
                                <th className="px-8 py-5 text-right">Valor Total</th>
                                <th className="px-8 py-5 text-center">Status</th>
                                <th className="px-8 py-5 text-center">Ação / Arquivo</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-50 dark:divide-slate-800">
                            {loading ? (
                                Array(3).fill(0).map((_, i) => (
                                    <tr key={i} className="animate-pulse">
                                        <td colSpan={5} className="px-8 py-6"><div className="h-4 bg-brand-surface-2 dark:bg-brand-surface-2 rounded w-full"></div></td>
                                    </tr>
                                ))
                            ) : closings.length > 0 ? (
                                closings.map((inv) => (
                                    <tr key={inv.id} className="hover:bg-brand-surface-2/50 dark:hover:bg-brand-surface-2/30 transition-all group">
                                        <td className="px-8 py-6">
                                            <div className="flex items-center gap-3">
                                                <div className="p-2.5 bg-brand-surface dark:bg-slate-950 border border-brand-border rounded-xl text-brand-muted group-hover:text-tenant-primary group-hover:border-tenant-primary/30 transition-all shadow-sm">
                                                    <Calendar size={18} />
                                                </div>
                                                <div>
                                                    <p className="font-black text-brand-text dark:text-slate-200 text-sm">
                                                        {new Date(inv.month_year + '-02').toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })}
                                                    </p>
                                                    <p className="text-[10px] text-brand-muted font-bold uppercase tracking-wider">
                                                        Ref: {inv.month_year}
                                                    </p>
                                                </div>
                                            </div>
                                        </td>
                                        <td className="px-8 py-6">
                                            <div className="flex items-center gap-2">
                                                <Hash size={14} className="text-slate-300" />
                                                <span className="text-sm font-bold text-brand-muted dark:text-brand-muted">
                                                    {inv.total_lessons} aulas
                                                </span>
                                            </div>
                                        </td>
                                        <td className="px-8 py-6 text-right">
                                            <span className="font-black text-brand-text text-lg tracking-tight">
                                                R$ {Number(inv.total_amount).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                                            </span>
                                        </td>
                                        <td className="px-8 py-6">
                                            <div className="flex justify-center">
                                                {getStatusBadge(inv.status)}
                                            </div>
                                        </td>
                                        <td className="px-8 py-6">
                                            <div className="flex justify-center flex-col items-center gap-2">
                                                {renderInvoiceAction(inv)}
                                            </div>
                                        </td>
                                    </tr>
                                ))
                            ) : (
                                <tr>
                                    <td colSpan={5} className="px-8 py-20 text-center">
                                        <div className="flex flex-col items-center justify-center text-slate-300 dark:text-brand-text">
                                            <FileText size={48} className="mb-4 opacity-20" />
                                            <p className="text-sm font-black uppercase tracking-widest">Nenhum fechamento disponível</p>
                                        </div>
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div >
        </div >
    );
};

export default TeacherInvoices;
