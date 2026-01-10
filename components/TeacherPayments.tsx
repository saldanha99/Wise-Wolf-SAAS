import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { FileText, Search, CheckCircle2, AlertCircle, Loader2, Download, DollarSign, XCircle, Calendar, ShieldCheck } from 'lucide-react';

interface InvoiceManagerProps {
    tenantId?: string;
}

const TeacherPayments: React.FC<InvoiceManagerProps> = ({ tenantId }) => {
    const [selectedMonth, setSelectedMonth] = useState(new Date().toISOString().slice(0, 7)); // YYYY-MM
    const [invoices, setInvoices] = useState<any[]>([]);
    const [loading, setLoading] = useState(false);
    const [searchTerm, setSearchTerm] = useState('');
    const [statusFilter, setStatusFilter] = useState('ALL'); // ALL, PENDING, PAID, CONTESTED
    const [updating, setUpdating] = useState<string | null>(null);

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
            case 'PAGO':
                return <span className="bg-emerald-100 text-emerald-700 px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest border border-emerald-200">Pago</span>;
            case 'CONTESTADO':
                return <span className="bg-red-100 text-red-700 px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest border border-red-200">Contestado</span>;
            case 'CONFIRMADO': // Legacy status, treat as Pending Payment
            case 'PENDENTE':
                return <span className="bg-yellow-100 text-yellow-700 px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest border border-yellow-200">Pendente</span>;
            default:
                return <span className="bg-slate-100 text-slate-700 px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest border border-slate-200">{status}</span>;
        }
    };

    const filteredInvoices = invoices.filter(inv => {
        const matchesSearch = inv.teacher?.full_name.toLowerCase().includes(searchTerm.toLowerCase());
        const matchesFilter = statusFilter === 'ALL' ||
            (statusFilter === 'PENDENTE' && (inv.status === 'PENDENTE' || inv.status === 'CONFIRMADO')) ||
            inv.status === statusFilter;
        return matchesSearch && matchesFilter;
    });

    const totalAmount = filteredInvoices.reduce((acc, curr) => acc + (curr.total_amount || 0), 0);
    const totalPending = filteredInvoices
        .filter(i => i.status === 'PENDENTE' || i.status === 'CONFIRMADO')
        .reduce((acc, curr) => acc + (curr.total_amount || 0), 0);

    return (
        <div className="p-8 max-w-[1600px] mx-auto min-h-screen bg-slate-50/50 dark:bg-slate-900/50">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-4">
                <div>
                    <div className="flex items-center gap-3 mb-2">
                        <div className="p-3 bg-tenant-primary/10 rounded-xl">
                            <FileText className="text-tenant-primary" size={24} />
                        </div>
                        <h1 className="text-3xl font-black text-slate-800 dark:text-white tracking-tight">Pagamentos</h1>
                    </div>
                    <p className="text-slate-500 dark:text-slate-400 font-medium">Gestão de fechamentos, autorizações e pagamentos.</p>
                </div>

                <div className="flex items-center gap-4 bg-white dark:bg-slate-800 p-2 rounded-2xl shadow-sm border border-slate-200 dark:border-slate-700">
                    <input
                        type="month"
                        value={selectedMonth}
                        onChange={(e) => setSelectedMonth(e.target.value)}
                        className="bg-transparent border-none text-sm font-bold text-slate-700 dark:text-slate-200 focus:ring-0 uppercase cursor-pointer"
                    />
                    <div className="h-8 w-[1px] bg-slate-200 dark:bg-slate-700" />
                    <div className="flex items-center gap-2 px-3">
                        <CheckCircle2 size={16} className="text-emerald-500" />
                        <span className="text-xs font-black text-slate-600 dark:text-slate-300 uppercase tracking-wider">{filteredInvoices.length} Professores</span>
                    </div>
                </div>
            </div>

            {/* Stats Cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
                <div className="bg-white dark:bg-slate-800 p-6 rounded-3xl border border-slate-100 dark:border-slate-700 shadow-sm relative overflow-hidden group">
                    <div className="absolute top-0 right-0 w-32 h-32 bg-tenant-primary/5 rounded-full blur-2xl -mr-16 -mt-16 transition-all group-hover:bg-tenant-primary/10" />
                    <p className="text-slate-400 dark:text-slate-500 text-xs font-black uppercase tracking-widest mb-1">Total da Folha</p>
                    <h3 className="text-3xl font-black text-slate-800 dark:text-white tracking-tight">
                        R$ {totalAmount.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                    </h3>
                </div>
                <div className="bg-white dark:bg-slate-800 p-6 rounded-3xl border border-slate-100 dark:border-slate-700 shadow-sm relative overflow-hidden group">
                    <div className="absolute top-0 right-0 w-32 h-32 bg-yellow-400/10 rounded-full blur-2xl -mr-16 -mt-16 transition-all group-hover:bg-yellow-400/20" />
                    <p className="text-slate-400 dark:text-slate-500 text-xs font-black uppercase tracking-widest mb-1">Pendente Pagamento</p>
                    <h3 className="text-3xl font-black text-yellow-600 dark:text-yellow-400 tracking-tight">
                        R$ {totalPending.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                    </h3>
                </div>
            </div>

            <div className="flex flex-col md:flex-row gap-4 mb-6">
                <div className="relative flex-1 group">
                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-tenant-primary transition-colors" size={20} />
                    <input
                        type="text"
                        placeholder="Buscar professor..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className="w-full pl-12 pr-4 py-4 bg-white dark:bg-slate-800 border-none rounded-2xl shadow-sm text-sm font-medium focus:ring-2 focus:ring-tenant-primary/20 transition-all placeholder:text-slate-400"
                    />
                </div>
                <div className="flex gap-2 p-1.5 bg-white dark:bg-slate-800 rounded-2xl shadow-sm">
                    {['ALL', 'PENDENTE', 'PAGO', 'CONTESTADO'].map((status) => (
                        <button
                            key={status}
                            onClick={() => setStatusFilter(status)}
                            className={`
                                px-4 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all
                                ${statusFilter === status
                                    ? 'bg-slate-800 text-white dark:bg-white dark:text-slate-900 shadow-md'
                                    : 'text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-700/50'}
                            `}
                        >
                            {status === 'ALL' ? 'Todos' : status}
                        </button>
                    ))}
                </div>
            </div>

            {loading ? (
                <div className="flex flex-col items-center justify-center py-20 text-slate-400">
                    <Loader2 className="animate-spin mb-4" size={32} />
                    <p className="text-xs font-bold uppercase tracking-widest">Carregando dados...</p>
                </div>
            ) : (
                <div className="bg-white dark:bg-slate-800 rounded-[2rem] shadow-sm border border-slate-200 dark:border-slate-700 overflow-hidden">
                    <div className="grid grid-cols-12 gap-4 p-6 border-b border-slate-100 dark:border-slate-700 text-[10px] font-black text-slate-400 uppercase tracking-widest bg-slate-50/50 dark:bg-slate-800/50">
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
                            <div key={invoice.id} className="grid grid-cols-12 gap-4 p-6 items-center hover:bg-slate-50 dark:hover:bg-slate-700/30 transition-colors group">
                                <div className="col-span-3 flex items-center gap-3">
                                    <img
                                        src={invoice.teacher?.avatar_url || `https://ui-avatars.com/api/?name=${invoice.teacher?.full_name}`}
                                        alt={invoice.teacher?.full_name}
                                        className="w-10 h-10 rounded-xl object-cover shadow-sm bg-white"
                                    />
                                    <div className="min-w-0">
                                        <p className="font-bold text-slate-800 dark:text-white text-sm truncate">{invoice.teacher?.full_name}</p>
                                        <p className="text-xs text-slate-400 truncate">{invoice.teacher?.email}</p>
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
                                        <span className="text-xs text-slate-400 font-medium italic">Aguardando</span>
                                    )}
                                    {invoice.teacher_confirmation_date && (
                                        <span className="text-[9px] text-slate-400 mt-1">
                                            {new Date(invoice.teacher_confirmation_date).toLocaleDateString()}
                                        </span>
                                    )}
                                </div>

                                <div className="col-span-1 text-center">
                                    <span className="font-bold text-slate-700 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 px-2 py-1 rounded-lg text-xs">
                                        {invoice.total_lessons}
                                    </span>
                                </div>

                                <div className="col-span-2 text-center">
                                    <span className="font-black text-slate-800 dark:text-white tracking-tight">
                                        R$ {invoice.total_amount?.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                                    </span>
                                </div>

                                <div className="col-span-1 text-center">
                                    {getStatusBadge(invoice.status)}
                                </div>

                                <div className="col-span-1 flex justify-center">
                                    {invoice.invoice_url ? (
                                        <a
                                            href={invoice.invoice_url}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="p-2 text-tenant-primary hover:bg-tenant-primary/10 rounded-xl transition-colors"
                                            title="Ver Nota Fiscal"
                                        >
                                            <FileText size={18} />
                                        </a>
                                    ) : (
                                        <span className="text-[10px] font-black text-slate-300 uppercase tracking-widest">Pendente</span>
                                    )}
                                </div>

                                <div className="col-span-2 flex justify-end gap-2">
                                    {invoice.status !== 'PAGO' && (
                                        <button
                                            onClick={() => handleStatusUpdate(invoice.id, 'PAGO')}
                                            disabled={updating === invoice.id}
                                            className="px-3 py-1.5 bg-emerald-500 text-white rounded-lg text-[10px] font-black uppercase tracking-widest hover:bg-emerald-600 transition-colors shadow-sm shadow-emerald-500/20 flex items-center gap-1 disabled:opacity-50"
                                        >
                                            {updating === invoice.id ? <Loader2 size={12} className="animate-spin" /> : <DollarSign size={12} />}
                                            Pagar
                                        </button>
                                    )}
                                    {invoice.status !== 'CONTESTADO' && (
                                        <button
                                            onClick={() => handleStatusUpdate(invoice.id, 'CONTESTADO')}
                                            disabled={updating === invoice.id}
                                            className="p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-500 rounded-lg transition-colors border border-transparent hover:border-red-100"
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
                                <p className="text-slate-400 font-medium">Nenhum registro encontrado para este período.</p>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

export default TeacherPayments;
