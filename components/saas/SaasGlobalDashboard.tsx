import React from 'react';
import { TrendingUp, Users, AlertTriangle, ArrowUpRight, DollarSign, Activity, Globe } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

interface GlobalStats {
    monthlyRevenue: number;
    activeTenantsCount: number;
    totalStudents: number;
    churnRate: number;
}

const SaasGlobalDashboard: React.FC<{ stats: GlobalStats }> = ({ stats }) => {
    // Mock data for chart - in real app, fetch historical data
    const data = [
        { name: 'Jan', mrr: 4000 },
        { name: 'Fev', mrr: 3000 },
        { name: 'Mar', mrr: 5000 },
        { name: 'Abr', mrr: 8000 },
        { name: 'Mai', mrr: 7500 },
        { name: 'Jun', mrr: 9000 },
        { name: 'Jul', mrr: stats.monthlyRevenue || 12000 },
    ];

    return (
        <div className="space-y-6">
            {/* KPI Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                <div className="bg-white dark:bg-slate-900 p-6 rounded-2xl shadow-sm border border-slate-100 dark:border-slate-800">
                    <div className="flex justify-between items-start mb-4">
                        <div className="p-3 bg-emerald-100 text-emerald-600 rounded-xl">
                            <DollarSign size={20} />
                        </div>
                        <span className="flex items-center text-emerald-500 text-xs font-bold gap-1 bg-emerald-50 px-2 py-1 rounded">
                            +12% <ArrowUpRight size={12} />
                        </span>
                    </div>
                    <p className="text-slate-500 text-sm font-medium">MRR (Recorrência)</p>
                    <h3 className="text-2xl font-black text-slate-800 dark:text-white">
                        R$ {stats.monthlyRevenue.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                    </h3>
                </div>

                <div className="bg-white dark:bg-slate-900 p-6 rounded-2xl shadow-sm border border-slate-100 dark:border-slate-800">
                    <div className="flex justify-between items-start mb-4">
                        <div className="p-3 bg-blue-100 text-blue-600 rounded-xl">
                            <Globe size={20} />
                        </div>
                        <span className="flex items-center text-blue-500 text-xs font-bold gap-1 bg-blue-50 px-2 py-1 rounded">
                            Ativos
                        </span>
                    </div>
                    <p className="text-slate-500 text-sm font-medium">Escolas Ativas</p>
                    <h3 className="text-2xl font-black text-slate-800 dark:text-white">
                        {stats.activeTenantsCount}
                    </h3>
                </div>

                <div className="bg-white dark:bg-slate-900 p-6 rounded-2xl shadow-sm border border-slate-100 dark:border-slate-800">
                    <div className="flex justify-between items-start mb-4">
                        <div className="p-3 bg-purple-100 text-purple-600 rounded-xl">
                            <Users size={20} />
                        </div>
                    </div>
                    <p className="text-slate-500 text-sm font-medium">Total de Alunos (Rede)</p>
                    <h3 className="text-2xl font-black text-slate-800 dark:text-white">
                        {stats.totalStudents}
                    </h3>
                </div>

                <div className="bg-white dark:bg-slate-900 p-6 rounded-2xl shadow-sm border border-slate-100 dark:border-slate-800">
                    <div className="flex justify-between items-start mb-4">
                        <div className="p-3 bg-red-100 text-red-600 rounded-xl">
                            <AlertTriangle size={20} />
                        </div>
                        <span className="flex items-center text-slate-400 text-xs font-bold gap-1 bg-slate-50 px-2 py-1 rounded">
                            Alvo: &lt; 2%
                        </span>
                    </div>
                    <p className="text-slate-500 text-sm font-medium">Churn Rate (Cancelamentos)</p>
                    <h3 className="text-2xl font-black text-slate-800 dark:text-white">
                        {stats.churnRate}%
                    </h3>
                </div>
            </div>

            {/* Main Chart */}
            <div className="bg-white dark:bg-slate-900 p-8 rounded-3xl shadow-sm border border-slate-100 dark:border-slate-800">
                <div className="flex justify-between items-center mb-8">
                    <div>
                        <h3 className="text-lg font-bold text-slate-800 dark:text-white">Crescimento de Receita (MRR)</h3>
                        <p className="text-sm text-slate-500">Desempenho financeiro dos últimos 6 meses</p>
                    </div>
                    <div className="flex gap-2">
                        <button className="px-4 py-2 bg-slate-100 dark:bg-slate-800 rounded-lg text-xs font-bold text-slate-600 hover:bg-slate-200 transition">Download Relatório</button>
                    </div>
                </div>

                <div className="h-64 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={data}>
                            <defs>
                                <linearGradient id="colorMrr" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="5%" stopColor="#8884d8" stopOpacity={0.8} />
                                    <stop offset="95%" stopColor="#8884d8" stopOpacity={0} />
                                </linearGradient>
                            </defs>
                            <XAxis dataKey="name" axisLine={false} tickLine={false} />
                            <YAxis axisLine={false} tickLine={false} tickFormatter={(value) => `R$${value / 1000}k`} />
                            <Tooltip
                                contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 4px 20px rgba(0,0,0,0.1)' }}
                                formatter={(value: number) => [`R$ ${value}`, 'MRR']}
                            />
                            <Area type="monotone" dataKey="mrr" stroke="#8884d8" fillOpacity={1} fill="url(#colorMrr)" strokeWidth={3} />
                        </AreaChart>
                    </ResponsiveContainer>
                </div>
            </div>
        </div>
    );
};

export default SaasGlobalDashboard;
