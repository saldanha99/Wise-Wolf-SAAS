import React, { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { FileText, Download, CheckCircle, Clock, AlertCircle } from 'lucide-react';

interface Invoice {
    id: string;
    amount: number;
    status: 'pending' | 'paid' | 'overdue' | 'cancelled';
    due_date: string;
    paid_at?: string;
    created_at: string;
    pdf_url?: string;
    // Join
    tenants?: { name: string };
}

const SaasBilling: React.FC = () => {
    const [invoices, setInvoices] = useState<Invoice[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetchInvoices();
    }, []);

    const fetchInvoices = async () => {
        try {
            const { data, error } = await supabase
                .from('saas_invoices')
                .select('*, tenants(name)')
                .order('due_date', { ascending: false });

            if (error) throw error;
            // Map the joined data correctly if needed, though supabase returns it nested
            setInvoices(data as any || []);
        } catch (error) {
            console.error('Error fetching invoices', error);
        } finally {
            setLoading(false);
        }
    };

    const getStatusBadge = (status: string) => {
        switch (status) {
            case 'paid': return <span className="flex items-center gap-1 text-emerald-600 bg-emerald-50 px-2 py-1 rounded text-xs font-bold"><CheckCircle size={12} /> Pago</span>;
            case 'pending': return <span className="flex items-center gap-1 text-amber-600 bg-amber-50 px-2 py-1 rounded text-xs font-bold"><Clock size={12} /> Pendente</span>;
            case 'overdue': return <span className="flex items-center gap-1 text-red-600 bg-red-50 px-2 py-1 rounded text-xs font-bold"><AlertCircle size={12} /> Atrasado</span>;
            default: return <span className="text-slate-500 bg-slate-100 px-2 py-1 rounded text-xs">{status}</span>;
        }
    };

    return (
        <div className="space-y-6">
            <div className="flex justify-between items-center">
                <div>
                    <h2 className="text-2xl font-bold text-slate-800 dark:text-white">Faturamento SaaS</h2>
                    <p className="text-sm text-slate-500">Controle de mensalidades e faturas das escolas</p>
                </div>
            </div>

            <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-sm border border-slate-100 dark:border-slate-800 overflow-hidden">
                <table className="w-full text-left text-sm">
                    <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-100 dark:border-slate-800 text-slate-500 font-medium">
                        <tr>
                            <th className="p-4 pl-6">Escola</th>
                            <th className="p-4">Vencimento</th>
                            <th className="p-4">Valor</th>
                            <th className="p-4">Status</th>
                            <th className="p-4 text-right pr-6">Fatura</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-slate-700 dark:text-slate-300">
                        {loading && <tr><td colSpan={5} className="p-8 text-center text-slate-400">Carregando faturas...</td></tr>}
                        {!loading && invoices.length === 0 && (
                            <tr><td colSpan={5} className="p-8 text-center text-slate-400">Nenhuma fatura encontrada.</td></tr>
                        )}
                        {invoices.map(invoice => (
                            <tr key={invoice.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors">
                                <td className="p-4 pl-6 font-bold">{invoice.tenants?.name || 'Desconhecido'}</td>
                                <td className="p-4">{new Date(invoice.due_date).toLocaleDateString()}</td>
                                <td className="p-4 font-mono font-medium">R$ {invoice.amount.toFixed(2)}</td>
                                <td className="p-4">{getStatusBadge(invoice.status)}</td>
                                <td className="p-4 text-right pr-6">
                                    <button className="text-slate-400 hover:text-blue-500 transition-colors" title="Baixar PDF">
                                        <Download size={16} />
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
};

export default SaasBilling;
