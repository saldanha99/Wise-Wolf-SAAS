import React, { useState, useEffect } from 'react';
import { 
    Users, 
    Zap, 
    Link, 
    Target, 
    TrendingUp, 
    Clock, 
    Activity,
    ArrowUpRight,
    Search,
    RefreshCw,
    MessageSquare,
    Globe
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import RegistrationLinkGenerator from './RegistrationLinkGenerator';
import TrialsToContracts from './TrialsToContracts';
import CRMPage from './CRMPage';

interface CommercialDashboardProps {
    tenantId?: string;
    user: any;
}

const CommercialDashboard: React.FC<CommercialDashboardProps> = ({ tenantId, user }) => {
    const [activeTab, setActiveTab] = useState<'overview' | 'leads' | 'trials' | 'links'>('overview');
    const [loading, setLoading] = useState(true);
    const [stats, setStats] = useState({
        totalLeads: 0,
        activeTrials: 0,
        convertedToday: 0,
        conversionRate: 0,
        pendingFollowups: 0
    });

    useEffect(() => {
        if (tenantId) fetchCommercialStats();
    }, [tenantId]);

    const fetchCommercialStats = async () => {
        setLoading(true);
        try {
            // 1. Fetch Leads Count
            const { count: leadsCount } = await supabase
                .from('crm_leads')
                .select('*', { count: 'exact', head: true })
                .eq('tenant_id', tenantId);

            // 2. Fetch Active Opportunities (Trials)
            const { count: trialsCount } = await supabase
                .from('opportunities')
                .select('*', { count: 'exact', head: true })
                .eq('tenant_id', tenantId)
                .eq('status', 'OPEN');

            // 3. Converted Today (Students created today)
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const { count: convertedToday } = await supabase
                .from('profiles')
                .select('*', { count: 'exact', head: true })
                .eq('tenant_id', tenantId)
                .eq('role', 'STUDENT')
                .gte('created_at', today.toISOString());

            setStats({
                totalLeads: leadsCount || 0,
                activeTrials: trialsCount || 0,
                convertedToday: convertedToday || 0,
                conversionRate: leadsCount ? ((convertedToday || 0) / leadsCount) * 100 : 0,
                pendingFollowups: 12 // Mock or fetch from crm_activities
            });
        } catch (e) {
            console.error("Error fetching commercial stats", e);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="space-y-6 md:space-y-8 animate-in fade-in duration-500 font-sans">
            <header className="flex flex-col md:flex-row justify-between items-start md:items-end gap-4 border-b border-gray-100 dark:border-gray-800 pb-6 mb-6">
                <div>
                    <h2 className="text-2xl font-bold text-slate-800 dark:text-white flex items-center gap-2">
                        <Target className="text-tenant-primary" size={24} /> Painel Comercial
                    </h2>
                    <p className="text-slate-500 dark:text-slate-400 text-sm mt-1">
                        Gestão de leads, experimentais e fechamento de matrículas.
                    </p>
                </div>
                
                <div className="flex bg-slate-100 dark:bg-slate-800 p-1 rounded-xl">
                    {[
                        { id: 'overview', label: 'Início', icon: Activity },
                        { id: 'leads', label: 'Pipeline CRM', icon: Users },
                        { id: 'trials', label: 'Disparar Vagas', icon: Zap },
                        { id: 'links', label: 'Links Matrícula', icon: Link },
                    ].map((tab) => (
                        <button
                            key={tab.id}
                            onClick={() => setActiveTab(tab.id as any)}
                            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-bold transition-all ${activeTab === tab.id ? 'bg-white dark:bg-slate-900 text-slate-800 dark:text-white shadow-sm ring-1 ring-slate-200 dark:ring-slate-700' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'}`}
                        >
                            <tab.icon size={16} />
                            <span className="hidden sm:inline">{tab.label}</span>
                        </button>
                    ))}
                </div>
            </header>

            {activeTab === 'overview' && (
                <>
                    {/* Stats Grid */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
                        {[
                            {
                                label: 'Leads no Funil',
                                value: stats.totalLeads.toString(),
                                sub: 'Total acumulado',
                                icon: Users,
                                iconBg: 'bg-blue-100 text-blue-600'
                            },
                            {
                                label: 'Vagas Abertas',
                                value: stats.activeTrials.toString(),
                                sub: 'Aguardando professor',
                                icon: Zap,
                                iconBg: 'bg-amber-100 text-amber-600'
                            },
                            {
                                label: 'Matrículas Hoje',
                                value: stats.convertedToday.toString(),
                                sub: 'Novos alunos',
                                icon: TrendingUp,
                                iconBg: 'bg-emerald-100 text-emerald-600'
                            },
                            {
                                label: 'Pendências',
                                value: stats.pendingFollowups.toString(),
                                sub: 'Follow-ups p/ hoje',
                                icon: Clock,
                                iconBg: 'bg-indigo-100 text-indigo-600'
                            },
                        ].map((stat, i) => (
                            <div key={i} className="bg-white dark:bg-slate-900 p-6 rounded-[32px] shadow-sm border border-slate-50 dark:border-slate-800 transition-all hover:-translate-y-1">
                                <div className="flex justify-between items-start mb-4">
                                    <div className={`p-3 rounded-2xl ${stat.iconBg} dark:bg-opacity-20`}>
                                        <stat.icon size={24} strokeWidth={1.5} />
                                    </div>
                                    <button className="text-slate-300 hover:text-slate-500">
                                        <ArrowUpRight size={20} />
                                    </button>
                                </div>
                                <h3 className="text-3xl font-bold text-slate-900 dark:text-white mb-1">{loading ? '...' : stat.value}</h3>
                                <p className="text-sm text-slate-500 dark:text-slate-400 font-medium">{stat.label}</p>
                                <p className="text-[10px] text-slate-400 dark:text-slate-500 uppercase tracking-widest font-black mt-2">{stat.sub}</p>
                            </div>
                        ))}
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                        {/* Quick Actions */}
                        <div className="bg-gradient-to-br from-tenant-primary to-indigo-900 p-8 rounded-[32px] text-white shadow-xl relative overflow-hidden group">
                            <div className="relative z-10">
                                <h3 className="text-2xl font-black mb-2 tracking-tight">Ações Rápidas de Vendas</h3>
                                <p className="text-indigo-100 mb-8 text-sm max-w-xs opacity-80">Converta seus leads mais rápido usando nossas ferramentas de automação.</p>
                                
                                <div className="grid grid-cols-1 gap-3">
                                    <button 
                                        onClick={() => setActiveTab('trials')}
                                        className="flex items-center justify-between p-4 bg-white/10 backdrop-blur-md rounded-2xl hover:bg-white/20 transition-all border border-white/10 group/btn"
                                    >
                                        <div className="flex items-center gap-3">
                                            <div className="p-2 bg-amber-400/20 text-amber-400 rounded-xl group-hover/btn:scale-110 transition-transform">
                                                <Zap size={18} />
                                            </div>
                                            <div className="text-left">
                                                <p className="font-bold text-sm">Disparar Vaga Experimental</p>
                                                <p className="text-[10px] text-indigo-200">Notificar todos os professores</p>
                                            </div>
                                        </div>
                                        <ArrowUpRight size={18} className="text-white/40" />
                                    </button>

                                    <button 
                                        onClick={() => setActiveTab('links')}
                                        className="flex items-center justify-between p-4 bg-white/10 backdrop-blur-md rounded-2xl hover:bg-white/20 transition-all border border-white/10 group/btn"
                                    >
                                        <div className="flex items-center gap-3">
                                            <div className="p-2 bg-emerald-400/20 text-emerald-400 rounded-xl group-hover/btn:scale-110 transition-transform">
                                                <Link size={18} />
                                            </div>
                                            <div className="text-left">
                                                <p className="font-bold text-sm">Gerar Link de Matrícula</p>
                                                <p className="text-[10px] text-indigo-200">Emitir contrato e cobrança</p>
                                            </div>
                                        </div>
                                        <ArrowUpRight size={18} className="text-white/40" />
                                    </button>

                                    <button 
                                        onClick={() => setActiveTab('leads')}
                                        className="flex items-center justify-between p-4 bg-white/10 backdrop-blur-md rounded-2xl hover:bg-white/20 transition-all border border-white/10 group/btn"
                                    >
                                        <div className="flex items-center gap-3">
                                            <div className="p-2 bg-blue-400/20 text-blue-400 rounded-xl group-hover/btn:scale-110 transition-transform">
                                                <Users size={18} />
                                            </div>
                                            <div className="text-left">
                                                <p className="font-bold text-sm">Ver Pipeline de Leads</p>
                                                <p className="text-[10px] text-indigo-200">Mover oportunidades no funil</p>
                                            </div>
                                        </div>
                                        <ArrowUpRight size={18} className="text-white/40" />
                                    </button>
                                </div>
                            </div>

                            {/* Background decoration */}
                            <div className="absolute top-0 right-0 p-12 opacity-10 pointer-events-none group-hover:scale-125 transition-transform duration-700">
                                <Target size={200} />
                            </div>
                        </div>

                        {/* Recent Activity or CRM Summary */}
                        <div className="bg-white dark:bg-slate-900 p-8 rounded-[32px] border border-slate-50 dark:border-slate-800 shadow-sm">
                            <div className="flex justify-between items-center mb-6">
                                <h3 className="font-black text-gray-800 dark:text-white flex items-center gap-2">
                                    <Activity className="text-indigo-500" size={18} /> Atividade de Hoje
                                </h3>
                                <button onClick={fetchCommercialStats} className="p-2 hover:bg-slate-50 rounded-lg transition-colors">
                                    <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
                                </button>
                            </div>

                            <div className="space-y-4">
                                {[
                                    { text: 'Novo lead capturado via Site Institucional', time: '10 min atrás', icon: Globe, color: 'text-blue-500', bg: 'bg-blue-50' },
                                    { text: 'Vaga experimental aceita por Prof. Marcelo', time: '2h atrás', icon: Zap, color: 'text-amber-500', bg: 'bg-amber-50' },
                                    { text: 'Matrícula concluída: Aluno Lucas Rocha', time: '4h atrás', icon: TrendingUp, color: 'text-emerald-500', bg: 'bg-emerald-50' },
                                    { text: 'Mensagem via WhatsApp recebida de Maria', time: '5h atrás', icon: MessageSquare, color: 'text-tenant-primary', bg: 'bg-indigo-50' },
                                ].map((item, i) => (
                                    <div key={i} className="flex items-center gap-4 p-4 rounded-2xl border border-slate-50 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors">
                                        <div className={`p-2 rounded-xl ${item.bg} dark:bg-opacity-10 ${item.color}`}>
                                            <item.icon size={16} />
                                        </div>
                                        <div className="flex-1">
                                            <p className="text-sm font-bold text-slate-700 dark:text-slate-200">{item.text}</p>
                                            <p className="text-[10px] text-slate-400 font-medium uppercase tracking-tight">{item.time}</p>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                </>
            )}

            {activeTab === 'leads' && <CRMPage tenantId={tenantId || ''} />}
            {activeTab === 'trials' && <TrialsToContracts tenantId={tenantId} user={user} />}
            {activeTab === 'links' && <RegistrationLinkGenerator tenantId={tenantId} teachers={[]} />}
        </div>
    );
};

export default CommercialDashboard;
