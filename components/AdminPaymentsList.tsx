import React, { useState, useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { formatLocalDateBr, localMonth, monthRange } from '../lib/dateUtils';
import { Download, Search, RefreshCw, CheckCircle, AlertCircle, Clock } from 'lucide-react';
import { isSettledStudentPayment, isStudentPaymentAwaitingCredit } from '../lib/studentPaymentStatus';

const AdminPaymentsList: React.FC<{ tenantId: string }> = ({ tenantId }) => {
    const [payments, setPayments] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    // localMonth (não toISOString): depois das 21h do último dia o mês pularia para o seguinte
    const [month, setMonth] = useState(localMonth());
    const [statusFilter, setStatusFilter] = useState('ALL');
    const [errorMessage, setErrorMessage] = useState('');
    const requestSequence = useRef(0);

    const fetchPayments = async () => {
        const sequence = ++requestSequence.current;
        setLoading(true);
        setErrorMessage('');
        setPayments([]);
        try {
            let query = supabase
                .from('student_payments')
                .select(`
                    *,
                    profiles (
                        full_name,
                        email,
                        tenant_id
                    )
                `)
                .eq('tenant_id', tenantId)
                .order('due_date', { ascending: false });

            // Filtro do mês por due_date, janela [dia 1, dia 1 do mês seguinte).
            // O cálculo antigo (new Date(month) + setMonth) escorregava no fuso: escondia
            // as mensalidades que vencem no dia 31 e puxava as do dia 1º do mês seguinte.
            const { start, endExclusive } = monthRange(month);

            query = query
                .gte('due_date', start)
                .lt('due_date', endExclusive);

            if (statusFilter === 'SETTLED') {
                query = query.in('status', ['RECEIVED', 'RECEIVED_IN_CASH']);
            } else if (statusFilter !== 'ALL') {
                query = query.eq('status', statusFilter);
            }

            const { data, error } = await query;

            if (error) throw error;
            if (sequence !== requestSequence.current) return;
            setPayments(data || []);

        } catch (error) {
            console.error("Error fetching payments:", error);
            if (sequence === requestSequence.current) {
                setErrorMessage('Não foi possível consultar os pagamentos. Tente novamente.');
            }
        } finally {
            if (sequence === requestSequence.current) setLoading(false);
        }
    };

    useEffect(() => {
        if (tenantId) fetchPayments();
        return () => { requestSequence.current += 1; };
    }, [tenantId, month, statusFilter]);

    const getStatusBadge = (status: string) => {
        if (isSettledStudentPayment(status)) {
            return <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest bg-emerald-100 text-emerald-600"><CheckCircle size={12} /> Pago</span>;
        }
        if (isStudentPaymentAwaitingCredit(status)) {
            return <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest bg-sky-100 text-sky-700"><Clock size={12} /> Confirmado · aguardando crédito</span>;
        }
        switch (status) {
            case 'OVERDUE':
                return <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest bg-red-100 text-red-600"><AlertCircle size={12} /> Atrasado</span>;
            case 'PENDING':
                return <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest bg-amber-100 text-amber-600"><Clock size={12} /> Pendente</span>;
            case 'CANCELLED':
                return <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest bg-slate-100 text-slate-600"><AlertCircle size={12} /> Cancelado</span>;
            default:
                return <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest bg-brand-surface-2 text-brand-muted">{status}</span>;
        }
    };

    return (
        <div className="bg-brand-surface rounded-[2.5rem] border border-brand-border shadow-xl overflow-hidden">
            <div className="p-8 border-b dark:border-brand-border flex flex-col md:flex-row justify-between items-center gap-4">
                <div>
                    <h3 className="font-black text-brand-text text-lg tracking-tight">Fluxo de Caixa Detalhado</h3>
                    <p className="text-sm text-brand-muted font-medium">Baixas confirmadas pelo Asaas; ajustes exigem conciliação auditada.</p>
                </div>

                <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
                    <input
                        type="month"
                        value={month}
                        onChange={e => setMonth(e.target.value)}
                        className="w-full px-4 py-2 bg-brand-surface-2 border border-brand-border rounded-xl text-sm font-bold text-brand-text dark:text-slate-200 sm:w-auto"
                    />
                    <select
                        value={statusFilter}
                        onChange={e => setStatusFilter(e.target.value)}
                        className="w-full px-4 py-2 bg-brand-surface-2 border border-brand-border rounded-xl text-sm font-bold text-brand-text dark:text-slate-200 sm:w-auto"
                    >
                        <option value="ALL">Todos os Status</option>
                        <option value="SETTLED">Pagos</option>
                        <option value="CONFIRMED">Confirmados, aguardando crédito</option>
                        <option value="PENDING">Pendentes</option>
                        <option value="OVERDUE">Atrasados</option>
                        <option value="CANCELLED">Cancelados</option>
                    </select>
                    <button aria-label="Atualizar pagamentos" onClick={fetchPayments} className="p-2 bg-brand-surface-2 dark:bg-brand-surface-2 text-brand-muted rounded-xl hover:bg-slate-200 transition-colors">
                        <RefreshCw size={18} />
                    </button>
                </div>
            </div>

            {errorMessage && (
                <div role="alert" className="m-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-red-500/40 bg-red-500/5 p-4 text-sm font-bold text-brand-text sm:m-6">
                    <span>{errorMessage}</span>
                    <button type="button" onClick={fetchPayments} className="rounded-xl border border-brand-border bg-brand-surface px-3 py-2 text-[10px] font-black uppercase tracking-widest text-brand-muted">
                        Tentar novamente
                    </button>
                </div>
            )}

            <div className="overflow-x-auto">
                <table className="w-full text-left min-w-[600px]">
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
                                            <span className="text-sm font-bold text-brand-text dark:text-slate-200">
                                                {p.profiles?.full_name || 'Sem aluno vinculado'}
                                            </span>
                                            <span className="text-[10px] text-brand-muted font-medium">
                                                {p.profiles?.email || 'Aguardando classificação da gestão'}
                                            </span>
                                        </div>
                                    </td>
                                    <td className="px-8 py-4 text-xs font-bold text-brand-muted">
                                        {formatLocalDateBr(p.due_date)}
                                    </td>
                                    <td className="px-8 py-4 text-xs font-bold text-brand-muted">
                                        {formatLocalDateBr(p.payment_date, '-')}
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

                                        {!p.invoice_url && (p.status === 'PENDING' || p.status === 'OVERDUE') && (
                                            <span className="text-[9px] font-black uppercase tracking-wider text-brand-muted" title="A baixa acontece pela conciliação auditada com o Asaas">
                                                Conciliação automática
                                            </span>
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
