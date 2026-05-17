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
                return <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest bg-brand-surface-2 text-brand-muted">{status}</span>;
        }
    };

    return (
        <div className="bg-brand-surface rounded-[2.5rem] border border-brand-border shadow-xl overflow-hidden">
            <div className="p-8 border-b dark:border-brand-border flex flex-col md:flex-row justify-between items-center gap-4">
                <div>
                    <h3 className="font-black text-brand-text text-lg tracking-tight">Fluxo de Caixa Detalhado</h3>
                    <p className="text-sm text-brand-muted font-medium">Todas as transações do mês</p>
                </div>

                <div className="flex gap-2">
                    <input
                        type="month"
                        value={month}
                        onChange={e => setMonth(e.target.value)}
                        className="px-4 py-2 bg-brand-surface-2 border border-brand-border rounded-xl text-sm font-bold text-brand-text dark:text-slate-200"
                    />
                    <select
                        value={statusFilter}
                        onChange={e => setStatusFilter(e.target.value)}
                        className="px-4 py-2 bg-brand-surface-2 border border-brand-border rounded-xl text-sm font-bold text-brand-text dark:text-slate-200"
                    >
                        <option value="ALL">Todos os Status</option>
                        <option value="RECEIVED">Pagos</option>
                        <option value="PENDING">Pendentes</option>
                        <option value="OVERDUE">Atrasados</option>
                    </select>
                    <button onClick={fetchPayments} className="p-2 bg-brand-surface-2 dark:bg-brand-surface-2 text-brand-muted rounded-xl hover:bg-slate-200 transition-colors">
                        <RefreshCw size={18} />
                    </button>
                </div>
            </div>

            <div className="overflow-x-auto">
                <table className="w-full text-left">
                    <thead className="bg-brand-surface-2/50 text-[10px] uppercase font-black text-brand-muted">
                        <tr>
                            <th className="px-8 py-4">Aluno</th>
                            <th className="px-8 py-4">Vencimento</th>
                            <th className="px-8 py-4">Pagamento</th>
                            <th className="px-8 py-4">Forma</th>
                            <th className="px-8 py-4">Status</th>
                            <th className="px-8 py-4 text-right">Valor</th>
                            <th className="px-8 py-4 text-center">Ações</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50 dark:divide-slate-800">
                        {loading ? (
                            <tr><td colSpan={7} className="text-center py-10 text-brand-muted font-bold">Carregando...</td></tr>
                        ) : payments.length === 0 ? (
                            <tr><td colSpan={7} className="text-center py-10 text-brand-muted font-bold">Nenhum registro encontrado neste período.</td></tr>
                        ) : (
                            payments.map((p) => (
                                <tr key={p.id} className="hover:bg-brand-surface-2/50 dark:hover:bg-brand-surface-2/30 transition-colors">
                                    <td className="px-8 py-4">
                                        <div className="flex flex-col">
                                            <span className="text-sm font-bold text-brand-text dark:text-slate-200">{p.profiles?.full_name}</span>
                                            <span className="text-[10px] text-brand-muted font-medium">{p.profiles?.email}</span>
                                        </div>
                                    </td>
                                    <td className="px-8 py-4 text-xs font-bold text-brand-muted">
                                        {new Date(p.due_date).toLocaleDateString('pt-BR')}
                                    </td>
                                    <td className="px-8 py-4 text-xs font-bold text-brand-muted">
                                        {p.payment_date ? new Date(p.payment_date).toLocaleDateString('pt-BR') : '-'}
                                    </td>
                                    <td className="px-8 py-4 text-xs font-bold text-brand-muted">
                                        {p.billing_type || 'UNDEFINED'}
                                    </td>
                                    <td className="px-8 py-4">
                                        {getStatusBadge(p.status)}
                                    </td>
                                    <td className="px-8 py-4 text-right font-black text-brand-text">
                                        R$ {Number(p.value).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                                    </td>
                                    <td className="px-8 py-4 text-center flex items-center justify-center gap-2">
                                        {p.invoice_url && (
                                            <a href={p.invoice_url} target="_blank" rel="noopener noreferrer" className="p-2 text-brand-muted hover:text-tenant-primary transition-colors inline-block" title="Ver Recibo/Boleto">
                                                <Download size={16} />
                                            </a>
                                        )}

                                        {(p.status === 'PENDING' || p.status === 'OVERDUE') && (
                                            <button
                                                onClick={async () => {
                                                    if (!confirm(`Confirmar recebimento manual de R$ ${p.value}?`)) return;
                                                    try {
                                                        // 1. Update Payment Status
                                                        const { error: updateError } = await supabase
                                                            .from('student_payments')
                                                            .update({
                                                                status: 'RECEIVED',
                                                                payment_date: new Date().toISOString()
                                                            })
                                                            .eq('id', p.id);

                                                        if (updateError) throw updateError;

                                                        // 2. Insert into Financial Transactions (Revenue Ledger)
                                                        const payload = {
                                                            tenant_id: p.profiles?.tenant_id || tenantId,
                                                            type: 'ENTRADA',
                                                            category: 'student_tuition',
                                                            amount: p.value,
                                                            amount_cents: Math.round(p.value * 100),
                                                            description: `Mensalidade (Manual) - ${p.profiles?.full_name}`,
                                                            reference_id: p.student_id,
                                                            student_payment_id: p.id,
                                                            occurred_at: new Date().toISOString(),
                                                            created_at: new Date().toISOString()
                                                        };
                                                        console.log("💰 Manually inserting transaction:", payload);

                                                        const { error: transError } = await supabase
                                                            .from('financial_transactions')
                                                            .insert(payload);

                                                        if (transError) console.error("Erro ao criar transação:", transError);

                                                        fetchPayments();
                                                        alert('Pagamento confirmado e registrado no caixa!');
                                                    } catch (err: any) {
                                                        alert('Erro: ' + err.message);
                                                    }
                                                }}
                                                className="p-2 text-emerald-500 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 rounded-lg transition-colors"
                                                title="Confirmar Pagamento Manual"
                                            >
                                                <CheckCircle size={16} />
                                            </button>
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
