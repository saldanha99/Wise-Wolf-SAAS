import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { Download, Search, RefreshCw, CheckCircle, AlertCircle, Clock } from 'lucide-react';

const AdminPaymentsList: React.FC<{ tenantId: string }> = ({ tenantId }) => {
    const [payments, setPayments] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
    const [statusFilter, setStatusFilter] = useState('ALL');

    const fetchPayments = async () => {
        setLoading(true);
        try {
            let query = supabase
                .from('student_payments')
                .select(`
                    *,
                    profiles!inner (
                        full_name,
                        email,
                        tenant_id
                    )
                `)
                .eq('profiles.tenant_id', tenantId)
                .order('due_date', { ascending: false });

            // Month Filter (by due_date or payment_date)
            // Ideally we filter by the selected month. Let's use due_date for reference.
            const startOfMonth = `${month}-01`;
            const endOfMonth = `${month}-31`; // Loose, date logic handles it

            // Or better logic:
            const nextMonth = new Date(month);
            nextMonth.setMonth(nextMonth.getMonth() + 1);

            query = query
                .gte('due_date', startOfMonth)
                .lt('due_date', nextMonth.toISOString().slice(0, 10));

            if (statusFilter !== 'ALL') {
                query = query.eq('status', statusFilter);
            }

            const { data, error } = await query;

            if (error) throw error;
            setPayments(data || []);

        } catch (error) {
            console.error("Error fetching payments:", error);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (tenantId) fetchPayments();
    }, [tenantId, month, statusFilter]);

    const getStatusBadge = (status: string) => {
        switch (status) {
            case 'RECEIVED':
            case 'CONFIRMED':
                return <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest bg-emerald-100 text-emerald-600"><CheckCircle size={12} /> Pago</span>;
            case 'OVERDUE':
                return <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest bg-red-100 text-red-600"><AlertCircle size={12} /> Atrasado</span>;
            case 'PENDING':
                return <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest bg-amber-100 text-amber-600"><Clock size={12} /> Pendente</span>;
            default:
                return <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest bg-slate-100 text-slate-500">{status}</span>;
        }
    };

    return (
        <div className="bg-white dark:bg-slate-900 rounded-[2.5rem] border border-slate-100 dark:border-slate-800 shadow-xl overflow-hidden">
            <div className="p-8 border-b dark:border-slate-800 flex flex-col md:flex-row justify-between items-center gap-4">
                <div>
                    <h3 className="font-black text-slate-800 dark:text-white text-lg tracking-tight">Fluxo de Caixa Detalhado</h3>
                    <p className="text-sm text-slate-500 font-medium">Todas as transações do mês</p>
                </div>

                <div className="flex gap-2">
                    <input
                        type="month"
                        value={month}
                        onChange={e => setMonth(e.target.value)}
                        className="px-4 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-sm font-bold text-slate-700 dark:text-slate-200"
                    />
                    <select
                        value={statusFilter}
                        onChange={e => setStatusFilter(e.target.value)}
                        className="px-4 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-sm font-bold text-slate-700 dark:text-slate-200"
                    >
                        <option value="ALL">Todos os Status</option>
                        <option value="RECEIVED">Pagos</option>
                        <option value="PENDING">Pendentes</option>
                        <option value="OVERDUE">Atrasados</option>
                    </select>
                    <button onClick={fetchPayments} className="p-2 bg-slate-100 dark:bg-slate-800 text-slate-600 rounded-xl hover:bg-slate-200 transition-colors">
                        <RefreshCw size={18} />
                    </button>
                </div>
            </div>

            <div className="overflow-x-auto">
                <table className="w-full text-left">
                    <thead className="bg-slate-50 dark:bg-slate-800/50 text-[10px] uppercase font-black text-slate-400">
                        <tr>
                            <th className="px-8 py-4">Aluno</th>
                            <th className="px-8 py-4">Vencimento</th>
                            <th className="px-8 py-4">Pagamento</th>
                            <th className="px-8 py-4">Forma</th>
                            <th className="px-8 py-4">Status</th>
                            <th className="px-8 py-4 text-right">Valor</th>
                            <th className="px-8 py-4 text-center">Recibo</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50 dark:divide-slate-800">
                        {loading ? (
                            <tr><td colSpan={7} className="text-center py-10 text-slate-400 font-bold">Carregando...</td></tr>
                        ) : payments.length === 0 ? (
                            <tr><td colSpan={7} className="text-center py-10 text-slate-400 font-bold">Nenhum registro encontrado neste período.</td></tr>
                        ) : (
                            payments.map((p) => (
                                <tr key={p.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-colors">
                                    <td className="px-8 py-4">
                                        <div className="flex flex-col">
                                            <span className="text-sm font-bold text-slate-700 dark:text-slate-200">{p.profiles?.full_name}</span>
                                            <span className="text-[10px] text-slate-400 font-medium">{p.profiles?.email}</span>
                                        </div>
                                    </td>
                                    <td className="px-8 py-4 text-xs font-bold text-slate-500">
                                        {new Date(p.due_date).toLocaleDateString('pt-BR')}
                                    </td>
                                    <td className="px-8 py-4 text-xs font-bold text-slate-500">
                                        {p.payment_date ? new Date(p.payment_date).toLocaleDateString('pt-BR') : '-'}
                                    </td>
                                    <td className="px-8 py-4 text-xs font-bold text-slate-500">
                                        {p.billing_type || 'UNDEFINED'}
                                    </td>
                                    <td className="px-8 py-4">
                                        {getStatusBadge(p.status)}
                                    </td>
                                    <td className="px-8 py-4 text-right font-black text-slate-800 dark:text-white">
                                        R$ {Number(p.value).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                                    </td>
                                    <td className="px-8 py-4 text-center">
                                        {p.invoice_url && (
                                            <a href={p.invoice_url} target="_blank" rel="noopener noreferrer" className="p-2 text-slate-400 hover:text-tenant-primary transition-colors inline-block">
                                                <Download size={16} />
                                            </a>
                                        )}
                                    </td>
                                </tr>
                            ))
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
};

export default AdminPaymentsList;
