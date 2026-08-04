import React, { useState, useEffect } from 'react';
import { FUNCTIONS_URL, supabase } from '../lib/supabase';
import { localMonth } from '../lib/dateUtils';
import { FileText, Search, CheckCircle2, AlertCircle, Loader2, Download, DollarSign, XCircle, Calendar, ShieldCheck } from 'lucide-react';
import InvoiceReviewModal from './InvoiceReviewModal';
import TeacherPayrollReportModal from './TeacherPayrollReportModal';
import AjusteRepasseModal from './AjusteRepasseModal';

interface InvoiceManagerProps {
    tenantId?: string;
}

const TeacherPayments: React.FC<InvoiceManagerProps> = ({ tenantId }) => {
    const [selectedMonth, setSelectedMonth] = useState(localMonth()); // YYYY-MM
    const [invoices, setInvoices] = useState<any[]>([]);
    const [loading, setLoading] = useState(false);
    const [searchTerm, setSearchTerm] = useState('');
    const [statusFilter, setStatusFilter] = useState('ALL'); // ALL, PENDING, PAID, CONTESTED
    const [updating, setUpdating] = useState<string | null>(null);
    const [selectedInvoice, setSelectedInvoice] = useState<any>(null);
    // Fechamento clicado → relatório unificado por professor (formato da folha manual)
    const [reportInvoice, setReportInvoice] = useState<any>(null);
    // Lançamento manual (reserva de agenda, bônus, desconto) direto no repasse.
    const [ajusteInvoice, setAjusteInvoice] = useState<any>(null);

    useEffect(() => {
        if (tenantId) fetchInvoices();
    }, [tenantId, selectedMonth]);

    const fetchInvoices = async () => {
        setLoading(true);
        try {
            const { data: closings, error } = await supabase
                .from('teacher_closings')
                .select(`
                    *,
                    teacher:teacher_id(full_name, avatar_url, email)
                `)
                .eq('tenant_id', tenantId)
                .eq('month_year', selectedMonth)
                .order('updated_at', { ascending: false });

            if (error) throw error;
            setInvoices(closings || []);
        } catch (err) {
            console.error('Error fetching invoices:', err);
        } finally {
            setLoading(false);
        }
    };

    const handlePayViaPix = async (invoice: any) => {
        if (!confirm(`Confirma o pagamento de R$ ${invoice.total_amount} para ${invoice.teacher.full_name} via Pix Automático?`)) return;

        setUpdating(invoice.id);
        try {
            const { data: { session } } = await supabase.auth.getSession();

            const response = await fetch(`${FUNCTIONS_URL}/transfer-teacher-pay`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${session?.access_token}`
                },
                body: JSON.stringify({ closingId: invoice.id })
            });

            const result = await response.json();

            if (!response.ok || !result.success) {
                throw new Error(result.error || 'Erro na transferência Pix');
            }

            // Success! The edge function already updated the DB, but let's refresh local state just in case
            fetchInvoices();
            alert('Pagamento Pix enviado com sucesso!');

        } catch (err: any) {
            console.error('Pix Error:', err);
            alert(`Falha no Pagamento: ${err.message}`);
        } finally {
            setUpdating(null);
        }
    };

    const handleStatusUpdate = async (id: string, newStatus: string) => {
        setUpdating(id);
        try {
            const { error } = await supabase
                .from('teacher_closings')
                .update({ status: newStatus, updated_at: new Date().toISOString() })
                .eq('id', id);

            if (error) throw error;
            // Optimistic update
            setInvoices(invoices.map(inv => inv.id === id ? { ...inv, status: newStatus } : inv));
        } catch (err) {
            alert('Erro ao atualizar status.');
        } finally {
            setUpdating(null);
        }
    };

    const getStatusBadge = (status: string) => {
        switch (status) {
            case 'COMPLETED':
            case 'PAGO': // Legacy
                return <span className="bg-emerald-100 text-emerald-700 px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest border border-emerald-200">Finalizado</span>;
            case 'PAID_WAITING_NF':
                return <span className="bg-blue-100 text-blue-700 px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest border border-blue-200">Pago (Aguarda NF)</span>;
            case 'UNDER_REVIEW':
                return <span className="bg-purple-100 text-purple-700 px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest border border-purple-200">Em Análise</span>;
            case 'REJECTED':
            case 'CONTESTADO':
                return <span className="bg-red-100 text-red-700 px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest border border-red-200">Contestado/Rejeitado</span>;
            case 'WAITING_PAYMENT':
            case 'PENDENTE':
                return <span className="bg-yellow-100 text-yellow-700 px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest border border-yellow-200">Pendente</span>;
            default:
                return <span className="bg-brand-surface-2 text-brand-text px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest border border-brand-border">{status}</span>;
        }
    };

    const filteredInvoices = invoices.filter(inv => {
        const matchesSearch = inv.teacher?.full_name.toLowerCase().includes(searchTerm.toLowerCase());
        const matchesFilter = statusFilter === 'ALL' ||
            (statusFilter === 'PENDENTE' && (inv.status === 'PENDENTE' || inv.status === 'WAITING_PAYMENT' || inv.status === 'CONFIRMADO')) ||
            (statusFilter === 'AGUARDANDO_NF' && inv.status === 'PAID_WAITING_NF') ||
            (statusFilter === 'ANALISE' && inv.status === 'UNDER_REVIEW') ||
            inv.status === statusFilter;
        return matchesSearch && matchesFilter;
    });

    const totalAmount = filteredInvoices.reduce((acc, curr) => acc + (curr.total_amount || 0), 0);
    const totalPending = filteredInvoices
        .filter(i => i.status === 'PENDENTE' || i.status === 'WAITING_PAYMENT' || i.status === 'CONFIRMADO')
        .reduce((acc, curr) => acc + (curr.total_amount || 0), 0);

    return (
        <div className="p-8 max-w-[1600px] mx-auto min-h-screen bg-brand-surface-2/50 dark:bg-brand-surface/50">
            {/* ... Header ... */}
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-4">
                <div>
                    {/* ... Title ... */}
                    <div className="flex items-center gap-3 mb-2">
                        <div className="p-3 bg-tenant-primary/10 rounded-xl">
                            <FileText className="text-tenant-primary" size={24} />
                        </div>
                        <h1 className="text-3xl font-black text-brand-text tracking-tight">Pagamentos</h1>
                    </div>
                    <p className="text-brand-muted font-medium">Gestão de fechamentos, autorizações e pagamentos.</p>
                </div>

                <div className="flex items-center gap-4 bg-brand-surface dark:bg-brand-surface-2 p-2 rounded-2xl shadow-sm border border-brand-border">
                    <input
                        type="month"
                        value={selectedMonth}
                        onChange={(e) => setSelectedMonth(e.target.value)}
                        className="bg-transparent border-none text-sm font-bold text-brand-text dark:text-slate-200 focus:ring-0 uppercase cursor-pointer"
                    />
                    <div className="h-8 w-[1px] bg-slate-200 dark:bg-slate-700" />
                    <div className="flex items-center gap-2 px-3">
                        <CheckCircle2 size={16} className="text-emerald-500" />
                        <span className="text-xs font-black text-brand-muted uppercase tracking-wider">{filteredInvoices.length} Professores</span>
                    </div>
                </div>
            </div>

            {/* Stats Cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
                {/* ... Stats ... */}
                <div className="bg-brand-surface dark:bg-brand-surface-2 p-6 rounded-3xl border border-brand-border dark:border-brand-border shadow-sm relative overflow-hidden group">
                    <div className="absolute top-0 right-0 w-32 h-32 bg-tenant-primary/5 rounded-full blur-2xl -mr-16 -mt-16 transition-all group-hover:bg-tenant-primary/10" />
                    <p className="text-brand-muted text-xs font-black uppercase tracking-widest mb-1">Total da Folha</p>
                    <h3 className="text-3xl font-black text-brand-text tracking-tight">
                        R$ {totalAmount.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                    </h3>
                </div>
                <div className="bg-brand-surface dark:bg-brand-surface-2 p-6 rounded-3xl border border-brand-border dark:border-brand-border shadow-sm relative overflow-hidden group">
                    <div className="absolute top-0 right-0 w-32 h-32 bg-yellow-400/10 rounded-full blur-2xl -mr-16 -mt-16 transition-all group-hover:bg-yellow-400/20" />
                    <p className="text-brand-muted text-xs font-black uppercase tracking-widest mb-1">Pendente Pagamento</p>
                    <h3 className="text-3xl font-black text-yellow-600 dark:text-yellow-400 tracking-tight">
                        R$ {totalPending.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                    </h3>
                </div>
            </div>

            <div className="flex flex-col md:flex-row gap-4 mb-6">
                <div className="relative flex-1 group">
                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-brand-muted group-focus-within:text-tenant-primary transition-colors" size={20} />
                    <input
                        type="text"
                        placeholder="Buscar professor..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className="w-full pl-12 pr-4 py-4 bg-brand-surface dark:bg-brand-surface-2 border-none rounded-2xl shadow-sm text-sm font-medium focus:ring-2 focus:ring-tenant-primary/20 transition-all placeholder:text-brand-muted"
                    />
                </div>
                <div className="flex gap-2 p-1.5 bg-brand-surface dark:bg-brand-surface-2 rounded-2xl shadow-sm overflow-x-auto">
                    {['ALL', 'PENDENTE', 'AGUARDANDO_NF', 'ANALISE', 'COMPLETED'].map((status) => (
                        <button
                            key={status}
                            onClick={() => setStatusFilter(status)}
                            className={`
                                px-4 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all whitespace-nowrap
                                ${statusFilter === status
                                    ? 'bg-tenant-primary text-white shadow-md'
                                    : 'text-brand-muted hover:bg-brand-surface-2 dark:hover:bg-slate-700/50'}
                            `}
                        >
                            {status === 'ALL' ? 'Todos' : status.replace('_', ' ')}
                        </button>
                    ))}
                </div>
            </div>

            {loading ? (
                <div className="flex flex-col items-center justify-center py-20 text-brand-muted">
                    <Loader2 className="animate-spin mb-4" size={32} />
                    <p className="text-xs font-bold uppercase tracking-widest">Carregando dados...</p>
                </div>
            ) : (
                <div className="bg-brand-surface dark:bg-brand-surface-2 rounded-[2rem] shadow-sm border border-brand-border overflow-hidden">
                    {/* ... Header Row ... */}
                    <div className="grid grid-cols-12 gap-4 p-6 border-b border-brand-border dark:border-brand-border text-[10px] font-black text-brand-muted uppercase tracking-widest bg-brand-surface-2/50 dark:bg-brand-surface-2/50">
                        <div className="col-span-3">Professor</div>
                        <div className="col-span-2 text-center">Autorização</div>
                        <div className="col-span-1 text-center">Aulas</div>
                        <div className="col-span-2 text-center">Valor Total</div>
                        <div className="col-span-1 text-center">Status</div>
                        <div className="col-span-1 text-center">Nota Fiscal</div>
                        <div className="col-span-2 text-right">Ações</div>
                    </div>

                    <div className="divide-y divide-slate-100 dark:divide-slate-700">
                        {filteredInvoices.map((invoice) => (
                            <div
                                key={invoice.id}
                                onClick={() => setReportInvoice(invoice)}
                                title="Ver relatório de pagamento do professor"
                                className="relative grid grid-cols-12 gap-4 p-6 items-center hover:bg-brand-surface-2 dark:hover:bg-slate-700/30 transition-colors group cursor-pointer"
                            >
                                {/* ... Columns ... */}
                                <button
                                    onClick={(e) => { e.stopPropagation(); setAjusteInvoice(invoice); }}
                                    title="Lançamento manual (reserva de agenda, bônus, desconto)"
                                    className="absolute right-4 top-4 z-10 p-1.5 rounded-lg text-brand-muted hover:text-emerald-600 hover:bg-emerald-500/10 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
                                >
                                    <DollarSign size={16} />
                                </button>
                                <div className="col-span-3 flex items-center gap-3">
                                    <img
                                        src={invoice.teacher?.avatar_url || `https://ui-avatars.com/api/?name=${invoice.teacher?.full_name}`}
                                        alt={invoice.teacher?.full_name}
                                        className="w-10 h-10 rounded-xl object-cover shadow-sm bg-brand-surface"
                                    />
                                    <div className="min-w-0">
                                        <p className="font-bold text-brand-text text-sm truncate">{invoice.teacher?.full_name}</p>
                                        <p className="text-xs text-brand-muted truncate">{invoice.teacher?.email}</p>
                                    </div>
                                </div>

                                <div className="col-span-2 flex flex-col items-center justify-center">
                                    {invoice.teacher_confirmation_status === 'OK' ? (
                                        <div className="flex items-center gap-1.5 text-emerald-600 bg-emerald-50 px-2.5 py-1 rounded-lg border border-emerald-100">
                                            <ShieldCheck size={14} />
                                            <span className="text-[10px] font-black uppercase tracking-widest">Autorizado</span>
                                        </div>
                                    ) : invoice.teacher_confirmation_status === 'CONTESTADO' ? (
                                        <div className="flex items-center gap-1.5 text-red-600 bg-red-50 px-2.5 py-1 rounded-lg border border-red-100">
                                            <AlertCircle size={14} />
                                            <span className="text-[10px] font-black uppercase tracking-widest">Contestado</span>
                                        </div>
                                    ) : (
                                        <span className="text-xs text-brand-muted font-medium italic">Aguardando</span>
                                    )}
                                    {invoice.teacher_confirmation_date && (
                                        <span className="text-[9px] text-brand-muted mt-1">
                                            {new Date(invoice.teacher_confirmation_date).toLocaleDateString()}
                                        </span>
                                    )}
                                </div>

                                <div className="col-span-1 text-center">
                                    <span className="font-bold text-brand-text dark:text-slate-300 bg-brand-surface-2 dark:bg-slate-700 px-2 py-1 rounded-lg text-xs">
                                        {invoice.total_lessons}
                                    </span>
                                </div>

                                <div className="col-span-2 text-center">
                                    <span className="font-black text-brand-text tracking-tight">
                                        R$ {invoice.total_amount?.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                                    </span>
                                </div>

                                <div className="col-span-1 text-center">
                                    {getStatusBadge(invoice.status)}
                                </div>

                                <div className="col-span-1 flex justify-center">
                                    {(invoice.nf_link || invoice.invoice_url) ? (
                                        <button
                                            onClick={(e) => { e.stopPropagation(); setSelectedInvoice(invoice); }}
                                            className="p-2 text-tenant-primary hover:bg-tenant-primary/10 rounded-xl transition-colors"
                                            title="Ver Nota Fiscal"
                                        >
                                            <FileText size={18} />
                                        </button>
                                    ) : (
                                        <span className="text-[10px] font-black text-slate-300 uppercase tracking-widest">N/A</span>
                                    )}
                                </div>

                                {/* ... existing handleStatusUpdate ... */}

                                <div className="col-span-2 flex justify-end gap-2">
                                    {/* Action Logic: If Pending or Waiting Payment, Show Pay Button */}
                                    {(invoice.status === 'PENDENTE' || invoice.status === 'WAITING_PAYMENT' || invoice.status === 'CONFIRMADO') && (
                                        <div className="flex gap-1">
                                            {/* Manual Pay */}
                                            <button
                                                onClick={(e) => { e.stopPropagation(); handleStatusUpdate(invoice.id, 'PAID_WAITING_NF'); }}
                                                disabled={updating === invoice.id}
                                                className="px-3 py-1.5 bg-brand-surface-2 text-brand-muted rounded-lg text-[10px] font-black uppercase tracking-widest hover:bg-slate-200 transition-colors flex items-center gap-1 disabled:opacity-50"
                                                title="Marcar como Pago (Manual)"
                                            >
                                                {updating === invoice.id ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
                                            </button>

                                            {/* Auto Pay (Asaas) */}
                                            <button
                                                onClick={(e) => { e.stopPropagation(); handlePayViaPix(invoice); }}
                                                disabled={updating === invoice.id}
                                                className="px-3 py-1.5 bg-emerald-500 text-white rounded-lg text-[10px] font-black uppercase tracking-widest hover:bg-emerald-600 transition-colors shadow-sm shadow-emerald-500/20 flex items-center gap-1 disabled:opacity-50"
                                                title="Pagar via Pix (Asaas)"
                                            >
                                                {updating === invoice.id ? <Loader2 size={12} className="animate-spin" /> : <DollarSign size={12} />}
                                                Pix
                                            </button>
                                        </div>
                                    )}

                                    {/* If Under Review or Completed, Show Review/View Button */}
                                    {(invoice.status === 'UNDER_REVIEW' || invoice.status === 'COMPLETED') && (
                                        <button
                                            onClick={(e) => { e.stopPropagation(); setSelectedInvoice(invoice); }}
                                            className="px-3 py-1.5 bg-purple-500 text-white rounded-lg text-[10px] font-black uppercase tracking-widest hover:bg-purple-600 transition-colors shadow-sm shadow-purple-500/20 flex items-center gap-1"
                                        >
                                            <FileText size={12} />
                                            {invoice.status === 'COMPLETED' ? 'Ver Nota' : 'Revisar'}
                                        </button>
                                    )}

                                    {invoice.status !== 'CONTESTADO' && invoice.status !== 'REJECTED' && invoice.status !== 'COMPLETED' && (
                                        <button
                                            onClick={(e) => { e.stopPropagation(); handleStatusUpdate(invoice.id, 'REJECTED'); }}
                                            disabled={updating === invoice.id}
                                            className="p-1.5 text-brand-muted hover:bg-red-50 hover:text-red-500 rounded-lg transition-colors border border-transparent hover:border-100"
                                            title="Rejeitar / Contestar"
                                        >
                                            <XCircle size={16} />
                                        </button>
                                    )}
                                </div>
                            </div>
                        ))}


                        {filteredInvoices.length === 0 && (
                            <div className="p-12 text-center">
                                <p className="text-brand-muted font-medium">Nenhum registro encontrado para este período.</p>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* Relatório unificado por professor (formato da folha manual da escola) */}
            {reportInvoice && (
                <TeacherPayrollReportModal
                    teacherId={reportInvoice.teacher_id}
                    month={reportInvoice.month_year}
                    onClose={() => setReportInvoice(null)}
                />
            )}

            {ajusteInvoice && (
                <AjusteRepasseModal
                    teacherId={ajusteInvoice.teacher_id}
                    teacherName={ajusteInvoice.teacher?.full_name || 'Professor'}
                    month={ajusteInvoice.month_year}
                    closingStatus={ajusteInvoice.status}
                    onClose={() => setAjusteInvoice(null)}
                    onSaved={fetchInvoices}
                />
            )}

            {/* Modal Integration */}
            {selectedInvoice && (
                <InvoiceReviewModal
                    invoice={{ ...selectedInvoice, invoice_url: selectedInvoice.invoice_url || selectedInvoice.nf_link }}
                    onClose={() => setSelectedInvoice(null)}
                    onUpdate={fetchInvoices}
                />
            )}
        </div>
    );
};

export default TeacherPayments;
