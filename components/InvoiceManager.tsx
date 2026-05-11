import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { FileText, Download, Search, CheckCircle, XCircle, Clock, Calendar, Users, Filter, ChevronRight, DollarSign } from 'lucide-react';

interface InvoiceManagerProps {
    tenantId?: string;
}

const InvoiceManager: React.FC<InvoiceManagerProps> = ({ tenantId }) => {
    const [loading, setLoading] = useState(true);
    const [invoices, setInvoices] = useState<any[]>([]);
    const [selectedMonth, setSelectedMonth] = useState(new Date().toISOString().substring(0, 7)); // YYYY-MM
    const [searchTerm, setSearchTerm] = useState('');
    const [filterStatus, setFilterStatus] = useState<'ALL' | 'PENDENTE' | 'CONFIRMADO' | 'PAGO' | 'CONTESTADO'>('ALL');

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

    // START MODAL LOGIC
    const [isRejecting, setIsRejecting] = useState<string | null>(null);
    const [rejectionNote, setRejectionNote] = useState('');

    const handleOpenReject = (id: string) => {
        setIsRejecting(id);
        setRejectionNote('');
    };

    const confirmRejection = async () => {
        if (!isRejecting) return;
        if (!rejectionNote.trim()) {
            alert('Por favor, informe o motivo da rejeição.');
            return;
        }

        await handleUpdateStatus(isRejecting, 'REJEITADO', rejectionNote);
        setIsRejecting(null);
    };

    const handleUpdateStatus = async (id: string, newStatus: string, note?: string) => {
        try {
            const payload: any = {
                status: newStatus,
                updated_at: new Date().toISOString()
            };
            if (note) payload.admin_notes = note;

            const { error } = await supabase
                .from('teacher_closings')
                .update(payload)
                .eq('id', id);

            if (error) throw error;
            fetchInvoices(); // Refresh
        } catch (err) {
            alert('Erro ao atualizar status.');
        }
    };
    // END MODAL LOGIC

    const getStatusStyles = (status: string) => {
        switch (status?.toUpperCase()) {
            case 'PAGO':
                return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400 border-emerald-200';
            case 'CONFIRMADO':
                return 'bg-blue-100 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400 border-blue-200';
            case 'PENDENTE':
                return 'bg-amber-100 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400 border-amber-200';
            case 'CONTESTADO':
                return 'bg-red-100 text-red-700 dark:bg-red-900/20 dark:text-red-400 border-red-200';
            case 'REJEITADO':
                return 'bg-red-100 text-red-700 dark:bg-red-900/20 dark:text-red-400 border-red-200';
            case 'AGUARDANDO_PAGAMENTO':
                return 'bg-amber-100 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400 border-amber-200';
            case 'EM ANÁLISE':
                return 'bg-purple-100 text-purple-700 dark:bg-purple-900/20 dark:text-purple-400 border-purple-200';
            default:
                return 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-400 border-slate-200';
        }
    };

    // ... existing filtering ...
    const filteredInvoices = invoices.filter(inv => {
        const matchesSearch = inv.teacher?.full_name?.toLowerCase().includes(searchTerm.toLowerCase());
        const matchesStatus = filterStatus === 'ALL' || inv.status === filterStatus;
        return matchesSearch && matchesStatus;
    });

    return (
        <div className="space-y-8 animate-in fade-in duration-700 pb-20 relative">
            {/* Rejection Modal */}
            {isRejecting && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
                    <div className="bg-white dark:bg-slate-900 p-8 rounded-[2.5rem] w-full max-w-md border border-slate-200 dark:border-slate-800 shadow-2xl animate-in zoom-in-95 duration-200">
                        <div className="flex items-center gap-3 mb-6">
                            <div className="p-2 bg-red-100 dark:bg-red-900/20 text-red-600 rounded-xl">
                                <XCircle size={20} />
                            </div>
                            <h3 className="text-xl font-black text-slate-800 dark:text-white uppercase tracking-tight">Rejeitar Nota Fiscal</h3>
                        </div>

                        <p className="text-xs text-slate-500 dark:text-slate-400 font-bold uppercase tracking-widest mb-2">Motivo da Rejeição</p>
                        <textarea
                            value={rejectionNote}
                            onChange={(e) => setRejectionNote(e.target.value)}
                            className="w-full h-32 p-4 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-2xl text-sm font-medium outline-none focus:ring-2 focus:ring-red-500 mb-6"
                            placeholder="Descreva o motivo (ex: Valor divergente, PDF ilegível)..."
                        />

                        <div className="flex gap-3">
                            <button
                                onClick={() => setIsRejecting(null)}
                                className="flex-1 py-3 text-slate-500 font-bold text-xs uppercase tracking-widest hover:bg-slate-50 dark:hover:bg-slate-800 rounded-xl transition-colors"
                            >
                                Cancelar
                            </button>
                            <button
                                onClick={confirmRejection}
                                className="flex-1 py-3 bg-red-500 text-white rounded-xl font-black text-xs uppercase tracking-widest shadow-lg shadow-red-500/20 hover:bg-red-600 transition-colors"
                            >
                                Confirmar Rejeição
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <header className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
                {/* ... existing header content ... */}
                <div>
                    <div className="flex items-center gap-3 mb-2">
                        <div className="p-3 bg-tenant-primary/10 rounded-2xl text-tenant-primary">
                            <FileText size={24} />
                        </div>
                        <h2 className="text-3xl font-black text-slate-800 dark:text-white tracking-tight">Gestão de NFs</h2>
                    </div>
                    <p className="text-slate-500 dark:text-slate-400 mt-1 ml-1">Central de recebimento e conferência de Notas Fiscais dos professores.</p>
                </div>

                <div className="flex items-center gap-4 bg-white dark:bg-slate-900 p-2 rounded-2xl border border-slate-100 dark:border-slate-800 shadow-sm">
                    <input
                        type="month"
                        value={selectedMonth}
                        onChange={(e) => setSelectedMonth(e.target.value)}
                        className="bg-slate-50 dark:bg-slate-800 border-none rounded-xl px-4 py-2 text-sm font-bold text-slate-700 dark:text-slate-200 outline-none focus:ring-2 focus:ring-tenant-primary"
                    />
                    <div className="h-8 w-[1px] bg-slate-200 dark:bg-slate-700" />
                    <div className="flex items-center gap-2 px-3">
                        <Users size={16} className="text-slate-400" />
                        <span className="text-xs font-black text-slate-600 dark:text-slate-400 uppercase tracking-wider">{filteredInvoices.length} Professores</span>
                    </div>
                </div>
            </header>

            <div className="grid grid-cols-1 gap-6">
                {/* Filters */}
                <div className="flex flex-col md:flex-row gap-4">
                    <div className="flex-1 relative">
                        <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={20} />
                        <input
                            placeholder="Buscar professor..."
                            value={searchTerm}
                            onChange={e => setSearchTerm(e.target.value)}
                            className="w-full bg-white dark:bg-slate-900 pl-12 pr-4 py-4 rounded-2xl border border-slate-100 dark:border-slate-800 outline-none focus:ring-2 focus:ring-tenant-primary font-bold text-sm text-slate-700 dark:text-slate-200 placeholder:text-slate-400 shadow-sm"
                        />
                    </div>
                    <div className="flex gap-2 overflow-x-auto pb-2 md:pb-0">
                        {['ALL', 'AGUARDANDO_NF', 'PENDENTE', 'EM ANÁLISE', 'AGUARDANDO_PAGAMENTO', 'CONFIRMADO', 'PAGO', 'CONTESTADO'].map((status) => (
                            // Updated status list to include AGUARDANDO_NF and EM ANÁLISE logic if used
                            <button
                                key={status}
                                onClick={() => setFilterStatus(status as any)}
                                className={`px-6 py-4 rounded-2xl text-xs font-black uppercase tracking-widest transition-all whitespace-nowrap border ${filterStatus === status
                                    ? 'bg-tenant-primary text-white border-tenant-primary shadow-lg shadow-tenant-primary/20'
                                    : 'bg-white dark:bg-slate-900 text-slate-500 border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800'
                                    }`}
                            >
                                {status === 'ALL' ? 'Todos' : status.replace('_', ' ')}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Invoices List */}
                <div className="bg-white dark:bg-slate-900 rounded-[2.5rem] border border-slate-100 dark:border-slate-800 shadow-xl overflow-hidden min-h-[400px]">
                    <div className="overflow-x-auto">
                        <table className="w-full text-left">
                            <thead>
                                <tr className="bg-slate-50/80 dark:bg-slate-800/50 border-b border-slate-100 dark:border-slate-800">
                                    <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest sticky left-0 bg-slate-50/80 dark:bg-slate-800/50 backdrop-blur-sm z-10">Professor</th>
                                    <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest text-center">Aulas</th>
                                    <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Valor Total</th>
                                    <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest text-center">Status</th>
                                    <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest text-center">Nota Fiscal</th>
                                    <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest text-center">Ações</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-50 dark:divide-slate-800">
                                {loading ? (
                                    <tr><td colSpan={6} className="p-10 text-center text-slate-400 text-xs font-bold uppercase tracking-widest">Carregando...</td></tr>
                                ) : filteredInvoices.length > 0 ? (
                                    filteredInvoices.map((inv) => (
                                        <tr key={inv.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-colors group">
                                            <td className="px-8 py-6 sticky left-0 bg-white dark:bg-slate-900 group-hover:bg-slate-50/50 dark:group-hover:bg-slate-800/30 transition-colors z-10">
                                                <div className="flex items-center gap-4">
                                                    <img src={inv.teacher?.avatar_url || `https://ui-avatars.com/api/?name=${inv.teacher?.full_name}&background=random`} className="w-10 h-10 rounded-xl" alt="" />
                                                    <div>
                                                        <p className="font-black text-slate-800 dark:text-white text-sm">{inv.teacher?.full_name}</p>
                                                        <p className="text-[10px] font-bold text-slate-400">{inv.teacher?.email}</p>
                                                    </div>
                                                </div>
                                            </td>
                                            <td className="px-8 py-6 text-center">
                                                <span className="inline-block px-3 py-1 bg-slate-100 dark:bg-slate-800 rounded-lg text-slate-600 dark:text-slate-400 font-bold text-xs">
                                                    {inv.total_lessons}
                                                </span>
                                            </td>
                                            <td className="px-8 py-6 text-right">
                                                <p className="font-black text-slate-800 dark:text-white text-base tracking-tight">R$ {Number(inv.total_amount).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</p>
                                            </td>
                                            <td className="px-8 py-6 text-center">
                                                <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[10px] font-black uppercase tracking-widest border ${getStatusStyles(inv.status)}`}>
                                                    {inv.status}
                                                </span>
                                            </td>
                                            <td className="px-8 py-6 text-center">
                                                {inv.nf_link ? (
                                                    <a
                                                        href={inv.nf_link}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        className="inline-flex items-center gap-2 px-4 py-2 bg-blue-50 dark:bg-blue-900/10 text-blue-600 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900/30 rounded-xl text-[10px] font-black uppercase tracking-widest transition-colors"
                                                    >
                                                        <FileText size={14} /> PDF
                                                    </a>
                                                ) : (
                                                    <span className="text-[10px] font-bold text-slate-300 dark:text-slate-600 uppercase">Pendente</span>
                                                )}
                                            </td>
                                            <td className="px-8 py-6 text-center">
                                                {inv.status === 'EM ANÁLISE' && (
                                                    <button
                                                        onClick={() => handleUpdateStatus(inv.id, 'AGUARDANDO_PAGAMENTO')}
                                                        className="p-2 bg-blue-100 text-blue-600 rounded-lg hover:bg-blue-200 transition-colors" title="Aprovar e Aguardar Pagamento"
                                                    >
                                                        <CheckCircle size={16} />
                                                    </button>
                                                )}
                                                {inv.status === 'AGUARDANDO_PAGAMENTO' && (
                                                    <button
                                                        onClick={() => handleUpdateStatus(inv.id, 'PAGO')}
                                                        className="p-2 bg-emerald-100 text-emerald-600 rounded-lg hover:bg-emerald-200 transition-colors" title="Confirmar Pagamento Realizado"
                                                    >
                                                        <DollarSign size={16} />
                                                    </button>
                                                )}
                                                {(inv.status === 'PENDENTE' || inv.status === 'EM ANÁLISE' || inv.status === 'CONFIRMADO') && (
                                                    <button
                                                        onClick={() => handleOpenReject(inv.id)}
                                                        className="p-2 bg-red-100 text-red-600 rounded-lg hover:bg-red-200 transition-colors" title="Rejeitar e Solicitar Correção"
                                                    >
                                                        <XCircle size={16} />
                                                    </button>
                                                )}
                                            </td>
                                        </tr>
                                    ))
                                ) : (
                                    <tr>
                                        <td colSpan={6} className="py-20 text-center">
                                            <div className="flex flex-col items-center gap-4 text-slate-300 dark:text-slate-600">
                                                <Filter size={48} className="opacity-20" />
                                                <p className="text-sm font-black uppercase tracking-widest">Nenhum registro encontrado</p>
                                            </div>
                                        </td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default InvoiceManager;
