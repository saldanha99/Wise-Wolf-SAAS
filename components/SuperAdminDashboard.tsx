import React, { useState, useEffect } from 'react';
import { Globe, Shield, CreditCard, Activity, MoreVertical, Plus, TrendingUp, AlertTriangle, Zap, RefreshCw, Cpu, Database, Server, LayoutDashboard, Package, Users, ArrowUpRight, Calendar, Search, Clock } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { Tenant } from '../types';
import SaasPlansManager from './SaasPlansManager';
import StudentPlansManager from './StudentPlansManager';

const SuperAdminDashboard: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'saas_plans' | 'student_plans'>('dashboard');
  const [isProvisioning, setIsProvisioning] = useState(false);

  // Real Data State
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [globalStats, setGlobalStats] = useState({
    monthlyRevenue: 0,
    expenses: 0,
    netProfit: 0,
    profitMargin: 0,
    activeTenantsCount: 0,
    totalStudents: 0
  });

  const [tenantStats, setTenantStats] = useState<Record<string, { studentCount: number, revenue: number }>>({});

  useEffect(() => {
    fetchDashboardData();
  }, []);

  const fetchDashboardData = async () => {
    try {
      setLoading(true);

      // 1. Fetch Tenants
      const { data: tenantsData, error: tenantsError } = await supabase
        .from('tenants')
        .select('*');

      if (tenantsError) throw tenantsError;

      // 2. Fetch Profiles (to calc revenue and counts)
      const { data: profilesData, error: profilesError } = await supabase
        .from('profiles')
        .select('id, tenant_id, role, monthly_fee');

      if (profilesError) throw profilesError;

      // 3. Process Data
      const tStats: Record<string, { studentCount: number, revenue: number }> = {};
      let totalRev = 0;
      let totalStudents = 0;

      // Initialize stats for each tenant
      tenantsData?.forEach(t => {
        tStats[t.id] = { studentCount: 0, revenue: 0 };
      });

      // Aggregate from profiles
      profilesData?.forEach(p => {
        if (p.role === 'STUDENT' && p.tenant_id && tStats[p.tenant_id]) {
          tStats[p.tenant_id].studentCount++;
          const fee = Number(p.monthly_fee) || 0;
          tStats[p.tenant_id].revenue += fee;
          totalRev += fee;
          totalStudents++;
        }
      });

      // Calc Expenses (Mock: 30% of revenue + fixed infra cost)
      const fixedCost = 1500; // AWS base
      const variableCost = totalStudents * 5; // Licensing per user
      const totalExpenses = fixedCost + variableCost;

      const netProfit = totalRev - totalExpenses;
      const margin = totalRev > 0 ? (netProfit / totalRev) * 100 : 0;

      setTenants(tenantsData || []);
      setTenantStats(tStats);
      setGlobalStats({
        monthlyRevenue: totalRev,
        expenses: totalExpenses,
        netProfit: netProfit,
        profitMargin: margin,
        activeTenantsCount: tenantsData?.length || 0,
        totalStudents
      });

    } catch (error) {
      console.error('Error loading Super Admin data:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleProvision = () => {
    setIsProvisioning(true);
    setTimeout(() => {
      setIsProvisioning(false);
      alert("Sucesso! Infraestrutura provisionada via AWS Lambda + RDS Schema Isolation. Os DNS estão em processo de propagação.");
    }, 2000);
  };

  const renderContent = () => {
    if (activeTab === 'saas_plans') return <SaasPlansManager />;
    if (activeTab === 'student_plans') return <StudentPlansManager />;

    if (loading) {
      return (
        <div className="flex flex-col items-center justify-center min-h-[400px] text-slate-400">
          <RefreshCw className="animate-spin mb-4" size={32} />
          <p className="text-sm font-bold">Sincronizando dados da hierarquia...</p>
        </div>
      )
    }

    return (
      <div className="space-y-6 md:space-y-8 animate-in fade-in duration-500 font-sans">

        {/* Stats Grid - Glass Style */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {[
            {
              label: 'Receita',
              value: globalStats.monthlyRevenue.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
              sub: 'Recorrente Mensal (MRR)',
              icon: TrendingUp,
              iconBg: 'bg-emerald-100 text-emerald-600',
              trend: 'positive'
            },
            {
              label: 'Despesas',
              value: globalStats.expenses.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
              sub: 'Infra + Licenças',
              icon: CreditCard,
              iconBg: 'bg-red-100 text-red-600',
              trend: 'negative'
            },
            {
              label: 'Lucro Líquido',
              value: globalStats.netProfit.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
              sub: `Margem: ${globalStats.profitMargin.toFixed(1)}%`,
              icon: Shield,
              iconBg: 'bg-blue-100 text-blue-600',
              trend: 'positive'
            },
            {
              label: 'Global Students',
              value: globalStats.totalStudents,
              sub: 'Em todos os tenants',
              icon: Users,
              iconBg: 'bg-indigo-100 text-indigo-600',
              trend: 'neutral'
            }
          ].map((stat, i) => (
            <div key={i} className="bg-white dark:bg-slate-900 p-6 rounded-[32px] shadow-[0px_4px_20px_rgba(0,0,0,0.02)] border border-slate-50 dark:border-slate-800 relative group transition-all hover:-translate-y-1 hover:shadow-lg">
              <div className="flex justify-between items-start mb-4">
                <div className={`p-3 rounded-2xl ${stat.iconBg} dark:bg-opacity-20`}>
                  {stat.icon === Clock ? <AlertTriangle size={24} strokeWidth={1.5} /> : <stat.icon size={24} strokeWidth={1.5} />}
                </div>
                <button className="text-slate-300 hover:text-slate-500 transition-colors">
                  <MoreVertical size={20} />
                </button>
              </div>
              <h3 className="text-2xl font-bold text-slate-900 dark:text-white mb-2">{stat.value}</h3>
              <p className="text-sm text-slate-500 dark:text-slate-400 font-medium">{stat.label}</p>
              <div className="flex items-center gap-1 mt-1">
                {stat.trend === 'positive' && <ArrowUpRight size={14} className="text-emerald-500" />}
                <p className="text-xs text-slate-400 dark:text-slate-500">{stat.sub}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Main Chart Section */}
          <div className="lg:col-span-2 bg-white dark:bg-slate-900 p-8 rounded-[32px] shadow-[0px_4px_20px_rgba(0,0,0,0.02)] border border-slate-50 dark:border-slate-800">
            <div className="flex justify-between items-center mb-6">
              <div>
                <h3 className="text-lg font-bold text-slate-900 dark:text-white">Fluxo de Caixa Global</h3>
                <p className="text-sm text-slate-500">Entradas e Sáidas por período</p>
              </div>
              <div className="flex items-center gap-2 bg-slate-50 dark:bg-slate-800 rounded-full px-4 py-2">
                <Calendar size={14} className="text-slate-500" />
                <span className="text-xs font-semibold text-slate-600 dark:text-slate-300">Este Ano</span>
                <ArrowUpRight size={14} className="text-slate-500 ml-1" />
              </div>
            </div>

            <div className="h-64 flex items-end gap-2 px-2 mt-8">
              {[45, 60, 45, 30, 80, 50, 90, 60, 30, 70, 40, 85].map((v, i) => (
                <div key={i} className="flex-1 flex flex-col gap-1 items-center group relative">
                  {/* Hover Tooltip */}
                  <div className="opacity-0 group-hover:opacity-100 absolute -top-12 left-1/2 -translate-x-1/2 bg-slate-800 text-white text-xs py-1 px-2 rounded-lg pointer-events-none transition-opacity">
                    R$ {v}k
                  </div>

                  {/* Stacked Bars with Gradients */}
                  <div className="w-full bg-red-100 dark:bg-red-900/30 rounded-t-sm" style={{ height: `${v * 0.4}%` }} />
                  <div className="w-full bg-gradient-to-t from-emerald-500 to-emerald-400 rounded-t-2xl shadow-sm hover:from-emerald-400 hover:to-emerald-300 transition-all cursor-pointer" style={{ height: `${v}%` }} />
                </div>
              ))}
            </div>
            <div className="flex justify-between mt-6 px-1 text-xs font-semibold text-slate-400 uppercase tracking-wide">
              <span>Jan</span><span>Fev</span><span>Mar</span><span>Abr</span><span>Mai</span><span>Jun</span><span>Jul</span><span>Ago</span><span>Set</span><span>Out</span><span>Nov</span><span>Dez</span>
            </div>
          </div>

          {/* Side Widget - Lucrative Units */}
          <div className="bg-white dark:bg-slate-900 p-8 rounded-[32px] shadow-[0px_4px_20px_rgba(0,0,0,0.02)] border border-slate-50 dark:border-slate-800 flex flex-col justify-between">
            <div>
              <div className="flex justify-between items-start mb-6">
                <div>
                  <h3 className="text-lg font-bold text-slate-900 dark:text-white">Unidades Top</h3>
                  <p className="text-sm text-slate-500">Mais lucrativas</p>
                </div>
                <button className="p-2 rounded-full bg-slate-50 dark:bg-slate-800 text-slate-400 hover:text-slate-600">
                  <ArrowUpRight size={16} />
                </button>
              </div>

              <div className="space-y-6">
                {tenants.slice(0, 3).map((tenant, i) => {
                  const stats = tenantStats[tenant.id] || { revenue: 0, studentCount: 0 };
                  const roi = stats.revenue > 0 ? ((stats.revenue - (stats.studentCount * 10)) / stats.revenue * 100).toFixed(0) : 0; // Mock ROI calc
                  const colors = ['bg-blue-500', 'bg-emerald-500', 'bg-orange-500', 'bg-purple-500'];

                  return (
                    <div key={tenant.id} className="flex items-center gap-4 group cursor-pointer">
                      <div className={`w-12 h-12 rounded-2xl ${colors[i % colors.length]} flex items-center justify-center text-white font-bold text-lg shadow-md group-hover:scale-110 transition-transform`}>
                        {tenant.name.charAt(0)}
                      </div>
                      <div className="flex-1">
                        <p className="text-sm font-bold text-slate-800 dark:text-slate-200 group-hover:text-purple-600 transition-colors truncate max-w-[150px]">{tenant.name}</p>
                        <div className="flex justify-between mt-1 items-center">
                          <span className="text-xs font-semibold text-slate-500">
                            {stats.revenue.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 })}
                          </span>
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 border border-slate-200 dark:border-slate-700">
                            ROI: {roi}%
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <button className="w-full mt-8 py-4 rounded-2xl bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-300 font-bold text-sm hover:bg-slate-100 dark:hover:bg-slate-700 transition-all">
              Ver Relatório Completo
            </button>
          </div>
        </div>

        {/* List Section - Tenants */}
        <div className="bg-white dark:bg-slate-900 rounded-[32px] shadow-[0px_4px_20px_rgba(0,0,0,0.02)] border border-slate-50 dark:border-slate-800 overflow-hidden">
          <div className="p-8 flex flex-col md:flex-row justify-between items-center gap-4">
            <div>
              <h3 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <Globe size={20} className="text-purple-500" /> Tenants Ativos
              </h3>
              <p className="text-sm text-slate-500">Instâncias rodando atualmente</p>
            </div>

            <div className="relative w-full md:w-64">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
              <input
                type="text"
                placeholder="Filtrar tenants..."
                className="w-full pl-11 pr-4 py-3 bg-slate-50 dark:bg-slate-800 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-purple-100 transition-all placeholder:text-slate-400"
              />
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm min-w-[900px]">
              <thead className="text-xs text-slate-400 font-semibold border-b border-slate-100 dark:border-slate-800">
                <tr>
                  <th className="px-8 py-5 font-medium">Tenant / Endereço</th>
                  <th className="px-8 py-5 font-medium">Licença</th>
                  <th className="px-8 py-5 font-medium">Utilização de Cota</th>
                  <th className="px-8 py-5 font-medium">Infra Status</th>
                  <th className="px-8 py-5 text-right font-medium">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50 dark:divide-slate-800">
                {tenants.map((tenant) => {
                  const tStats = tenantStats[tenant.id] || { studentCount: 0 };
                  const usage = tenant.studentLimit > 0 ? (tStats.studentCount / tenant.studentLimit) : 0;
                  const usagePercent = (usage * 100).toFixed(0);

                  return (
                    <tr key={tenant.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-colors group">
                      <td className="px-8 py-5">
                        <div className="flex items-center gap-4">
                          <div className="w-12 h-12 rounded-2xl bg-white dark:bg-slate-800 p-2 shadow-sm border border-slate-100 dark:border-slate-700 flex items-center justify-center group-hover:scale-105 transition-transform">
                            {tenant.branding?.logoUrl ? (
                              <img src={tenant.branding.logoUrl} className="max-h-full max-w-full object-contain" alt="" />
                            ) : (
                              <div className="bg-slate-200 w-full h-full rounded text-[10px] flex items-center justify-center">N/A</div>
                            )}
                          </div>
                          <div>
                            <p className="font-bold text-slate-800 dark:text-slate-200 text-sm">{tenant.name}</p>
                            <p className="text-xs text-slate-500 italic">{tenant.domain}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-8 py-5">
                        <span className="bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-300 text-xs px-3 py-1.5 rounded-full font-bold border border-purple-100 dark:border-purple-800">Enterprise v3</span>
                      </td>
                      <td className="px-8 py-5">
                        <div className="space-y-2 w-48">
                          <div className="flex justify-between text-xs font-semibold text-slate-500">
                            <span>{tStats.studentCount}/{tenant.studentLimit} Alunos</span>
                            <span className={usage > 0.8 ? 'text-red-500' : ''}>{usagePercent}%</span>
                          </div>
                          <div className="w-full bg-slate-100 dark:bg-slate-800 h-2 rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all duration-1000 ${usage > 0.8 ? 'bg-red-500' : 'bg-purple-500'}`}
                              style={{ width: `${Math.min(usage * 100, 100)}%` }}
                            />
                          </div>
                        </div>
                      </td>
                      <td className="px-8 py-5">
                        <div className="flex flex-wrap gap-2">
                          <div className="p-1.5 bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400 rounded-lg" title="Database Schema OK">
                            <Database size={14} />
                          </div>
                          <div className="p-1.5 bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 rounded-lg" title="DNS Propagated">
                            <Server size={14} />
                          </div>
                          <div className="p-1.5 bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400 rounded-lg" title="Storage CDN Active">
                            <Cpu size={14} />
                          </div>
                        </div>
                      </td>
                      <td className="px-8 py-5 text-right">
                        <button
                          onClick={() => alert(`Configurações avançadas de instância: ${tenant.name}`)}
                          className="p-2 text-slate-300 hover:text-purple-600 hover:bg-purple-50 dark:hover:bg-slate-800 rounded-xl transition-all"
                        >
                          <MoreVertical size={20} />
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6 md:space-y-8 animate-in fade-in duration-500 font-sans">
      <header className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
        <div>
          <h2 className="text-2xl font-bold text-slate-800 dark:text-white">Central de Comando SaaS</h2>
          <p className="text-slate-500 dark:text-slate-400 text-sm mt-1">Governança global de infraestrutura e receita.</p>
        </div>
        <div className="flex gap-3 bg-slate-100 dark:bg-slate-800 p-1 rounded-2xl">
          <button
            onClick={() => setActiveTab('dashboard')}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition-all ${activeTab === 'dashboard'
              ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-sm'
              : 'text-slate-500 hover:text-slate-700'
              }`}
          >
            Dashboard
          </button>
          <button
            onClick={() => setActiveTab('saas_plans')}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition-all ${activeTab === 'saas_plans'
              ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-sm'
              : 'text-slate-500 hover:text-slate-700'
              }`}
          >
            Planos SaaS
          </button>
          <button
            onClick={() => setActiveTab('student_plans')}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition-all ${activeTab === 'student_plans'
              ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-sm'
              : 'text-slate-500 hover:text-slate-700'
              }`}
          >
            Planos Alunos
          </button>
        </div>

        <button
          onClick={handleProvision}
          disabled={isProvisioning}
          className="hidden md:flex bg-slate-900 dark:bg-white text-white dark:text-slate-900 px-6 py-3 rounded-xl text-xs font-bold items-center gap-2 hover:opacity-90 transition-all shadow-lg shadow-slate-900/20 disabled:opacity-50"
        >
          {isProvisioning ? <RefreshCw className="animate-spin" size={14} /> : <Plus size={14} />}
          PROVISIONAR
        </button>
      </header>

      {renderContent()}

    </div>
  );
};

export default SuperAdminDashboard;
