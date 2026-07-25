import React, { useEffect, useState } from 'react';
import {
    AreaChart,
    Area,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ResponsiveContainer,
    BarChart,
    Bar,
    Legend,
    ComposedChart,
    Line
} from 'recharts';
import { supabase } from '../lib/supabase';
import { Loader2 } from 'lucide-react';

interface FinancialChartsProps {
    tenantId?: string;
}

const FinancialCharts: React.FC<FinancialChartsProps> = ({ tenantId }) => {
    const [data, setData] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (tenantId) fetchFinancialHistory();
    }, [tenantId]);

    const fetchFinancialHistory = async () => {
        try {
            setLoading(true);
            const today = new Date();
            const sixMonthsAgo = new Date();
            sixMonthsAgo.setMonth(today.getMonth() - 5);
            sixMonthsAgo.setDate(1); // Start of that month

            // 1. Fetch Class Logs (Expenses)
            const { data: logs, error: logsError } = await supabase
                .from('class_logs')
                .select(`created_at, teacher_id, presence`)
                .eq('tenant_id', tenantId)
                .gte('created_at', sixMonthsAgo.toISOString());

            if (logsError) throw logsError;

            // Taxas via RPC (hourly_rate não é mais legível direto em profiles).
            // get_tenant_teacher_pay só retorna p/ admin; p/ professor vem vazio (gráfico de despesa 0).
            const { data: payRows } = await supabase.rpc('get_tenant_teacher_pay');
            const rateById = new Map<string, number>((payRows as any[] || []).map((p: any) => [p.id, Number(p.hourly_rate) || 0]));

            // 2. Fetch Payments (Projected Income only)
            const { data: pendingPayments, error: pendingError } = await supabase
                .from('student_payments')
                .select('value, status, due_date')
                .eq('tenant_id', tenantId)
                .gte('due_date', sixMonthsAgo.toISOString())
                .in('status', ['PENDING', 'OVERDUE']); // Only want pending for projection

            if (pendingError) throw pendingError;

            // 3. Fetch Real Transactions (Real Income)
            const { data: transactions, error: transError } = await supabase
                .from('financial_transactions')
                .select('amount, created_at, occurred_at, type') // Added occurred_at
                .eq('tenant_id', tenantId)
                .eq('type', 'ENTRADA')
                .or(`created_at.gte.${sixMonthsAgo.toISOString()},occurred_at.gte.${sixMonthsAgo.toISOString()}`); // Check both or just one? Let's stick to simple first

            if (transError) throw transError;

            // Process Data by Month
            const monthlyData = new Map<string, { income: number; projected: number; expense: number }>();

            // Initialize months
            for (let i = 0; i < 6; i++) {
                const d = new Date(sixMonthsAgo);
                d.setMonth(sixMonthsAgo.getMonth() + i);
                const key = d.toISOString().slice(0, 7); // YYYY-MM
                monthlyData.set(key, { income: 0, projected: 0, expense: 0 });
            }

            // Aggregate Expenses
            logs?.forEach((log: any) => {
                const month = log.created_at.slice(0, 7);
                if (monthlyData.has(month)) {
                    if (log.presence === 'Presente' || log.presence === 'COMPLETED' || log.presence === 'Realizada') {
                        const rate = rateById.get(log.teacher_id) || 0;
                        const current = monthlyData.get(month)!;
                        current.expense += rate;
                    }
                }
            });

            // Aggregate Real Income (Transactions)
            transactions?.forEach((t: any) => {
                // Use occurred_at if available, otherwise created_at
                const dateStr = t.occurred_at || t.created_at;
                const month = dateStr.slice(0, 7);
                if (monthlyData.has(month)) {
                    const current = monthlyData.get(month)!;
                    current.income += Number(t.amount || 0);
                }
            });

            // Aggregate Projected Income (Pending Payments)
            pendingPayments?.forEach((pay: any) => {
                if (!pay.due_date) return;
                const month = pay.due_date.slice(0, 7);
                if (monthlyData.has(month)) {
                    const current = monthlyData.get(month)!;
                    current.projected += Number(pay.value || 0);
                }
            });

            // Format for Recharts
            const chartData = Array.from(monthlyData.entries()).map(([month, values]) => {
                const [year, m] = month.split('-');
                const monthName = new Date(parseInt(year), parseInt(m) - 1).toLocaleDateString('pt-BR', { month: 'short' });
                return {
                    name: monthName,
                    Receita: values.income,
                    Previsto: values.projected,
                    Despesa: values.expense,
                    Lucro: (values.income + values.projected) - values.expense
                };
            });

            setData(chartData);
        } catch (error) {
            console.error('Error fetching chart data:', error);
        } finally {
            setLoading(false);
        }
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center h-[300px] w-full bg-brand-surface-2/50 rounded-2xl">
                <Loader2 className="animate-spin text-purple-600" size={32} />
            </div>
        );
    }

    return (
        <div className="w-full min-w-0 h-[300px] mt-4">
            <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0} debounce={100}>
                <ComposedChart data={data} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                    <defs>
                        <linearGradient id="colorIncome" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#10b981" stopOpacity={0.8} />
                            <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                        </linearGradient>
                        <linearGradient id="colorExpense" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#ef4444" stopOpacity={0.8} />
                            <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
                        </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E2E8F0" />
                    <XAxis
                        dataKey="name"
                        axisLine={false}
                        tickLine={false}
                        tick={{ fill: '#64748B', fontSize: 12 }}
                        dy={10}
                    />
                    <YAxis
                        axisLine={false}
                        tickLine={false}
                        tick={{ fill: '#64748B', fontSize: 12 }}
                        tickFormatter={(value) => `R$${value / 1000}k`}
                    />
                    <Tooltip
                        contentStyle={{
                            backgroundColor: '#fff',
                            borderRadius: '12px',
                            border: 'none',
                            boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)'
                        }}
                        formatter={(value: number) => [`R$ ${value.toLocaleString('pt-BR')}`, '']}
                    />
                    <Legend iconType="circle" />

                    <Area
                        type="monotone"
                        dataKey="Receita"
                        stroke="#10b981"
                        fillOpacity={1}
                        fill="url(#colorIncome)"
                        stackId="1"
                    />
                    <Area
                        type="monotone"
                        dataKey="Previsto"
                        stroke="#6ee7b7"
                        fillOpacity={0.5}
                        fill="#6ee7b7"
                        stackId="1"
                    />
                    <Area
                        type="monotone"
                        dataKey="Despesa"
                        stroke="#ef4444"
                        fillOpacity={1}
                        fill="url(#colorExpense)"
                    />
                    <Line
                        type="monotone"
                        dataKey="Lucro"
                        stroke="#8b5cf6"
                        strokeWidth={2}
                        dot={true}
                    />
                </ComposedChart>
            </ResponsiveContainer>
        </div>
    );
};

export default FinancialCharts;
