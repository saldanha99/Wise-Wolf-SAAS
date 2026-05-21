import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import {
  LayoutDashboard, Users, Database, CreditCard,
  Briefcase, Building2, Server, LogOut, GraduationCap
} from 'lucide-react';

// Sub Components
// Sub Components
import SaasGlobalDashboard from './saas/SaasGlobalDashboard';
import SuperAdminMetrics from './SuperAdminMetrics';
import SaasTenantManager from './saas/SaasTenantManager';
import SaasCrmBoard from './saas/SaasCrmBoard';
import SaasPlansManager from './SaasPlansManager';
import SaasBilling from './saas/SaasBilling';
import TeacherLeadsPanel from './saas/TeacherLeadsPanel';

interface SuperAdminDashboardProps {
  onLogout?: () => void;
}

const SuperAdminDashboard: React.FC<SuperAdminDashboardProps> = ({ onLogout }) => {
  const [activeTab, setActiveTab] = useState<'global' | 'tenants' | 'crm' | 'infra' | 'billing' | 'teachers'>('global');
  const [loading, setLoading] = useState(true);

  // Global Stats for the Dashboard Tab
  const [globalStats, setGlobalStats] = useState({
    monthlyRevenue: 0,
    activeTenantsCount: 0,
    totalStudents: 0,
    churnRate: 1.2
  });

  useEffect(() => {
    fetchGlobalStats();
  }, []);

  const fetchGlobalStats = async () => {
    setLoading(true);
    try {
      // 1. Tenants count
      const { count: tenantCount } = await supabase.from('tenants').select('*', { count: 'exact', head: true });

      // 2. Revenue (Sum of all invoices paid in last 30 days? Or just sum of plan prices?)
      // Simple approximation: Sum of active plans price
      // Or better: Sum of 'monthly_fee' from all students across all tenants (Real MRR) or SaaS MRR (Plan prices)?
      // User requested "Receita Recorrente Mensal (MRR)" of the SaaS itself (B2B) or the Schools (B2C)?
      // "Faturamento SaaS: Controle das faturas que as escolas pagam" -> B2B MRR.
      // But previous dashboard calc'd B2C MRR.
      // Let's calculate B2B MRR: Sum of prices of plans of active tenants.

      const { data: tenants } = await supabase.from('tenants').select('plan_id, saas_plans(price)');
      let b2bMrr = 0;
      tenants?.forEach((t: any) => {
        if (t.saas_plans?.price) b2bMrr += Number(t.saas_plans.price);
      });

      // 3. Total Students (Network wide)
      const { count: studentCount } = await supabase.from('profiles').select('*', { count: 'exact', head: true }).eq('role', 'STUDENT');

      setGlobalStats({
        monthlyRevenue: b2bMrr,
        activeTenantsCount: tenantCount || 0,
        totalStudents: studentCount || 0,
        churnRate: 1.5 // Mock for now
      });

    } catch (error) {
      console.error('Error fetching stats', error);
    } finally {
      setLoading(false);
    }
  };

  const renderContent = () => {
    switch (activeTab) {
      case 'global': return <SuperAdminMetrics />;
      case 'tenants': return <SaasTenantManager />;
      case 'crm': return <SaasCrmBoard />;
      case 'infra': return <SaasPlansManager />;
      case 'billing': return <SaasBilling />;
      case 'teachers': return <TeacherLeadsPanel />;
      default: return <SuperAdminMetrics />;
    }
  };

  return (
    <div className="flex min-h-screen bg-brand-surface-2 dark:bg-slate-950 font-sans text-brand-text dark:text-slate-100">
      {/* Sidebar (Simplified for Super Admin Context) */}
      <aside className="w-64 bg-brand-surface border-r border-brand-border dark:border-brand-border flex flex-col fixed inset-y-0 z-50">
        <div className="p-6">
          <div className="flex items-center gap-2 text-indigo-600 dark:text-indigo-400">
            <Server size={28} />
            <span className="font-black text-lg tracking-tight">WiseWolf SaaS</span>
          </div>
          <p className="text-xs text-brand-muted mt-1 uppercase tracking-widest font-bold">Admin Console</p>
        </div>

        <nav className="flex-1 px-4 space-y-1">
          <button
            onClick={() => setActiveTab('global')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold transition-all ${activeTab === 'global' ? 'bg-indigo-50 text-indigo-600 dark:bg-indigo-900/20 dark:text-indigo-400' : 'text-brand-muted hover:bg-brand-surface-2 dark:hover:bg-brand-surface-2'}`}
          >
            <LayoutDashboard size={20} />
            Dashboard Global
          </button>
          <button
            onClick={() => setActiveTab('crm')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold transition-all ${activeTab === 'crm' ? 'bg-indigo-50 text-indigo-600 dark:bg-indigo-900/20 dark:text-indigo-400' : 'text-brand-muted hover:bg-brand-surface-2 dark:hover:bg-brand-surface-2'}`}
          >
            <Briefcase size={20} />
            CRM & Vendas
          </button>
          <button
            onClick={() => setActiveTab('tenants')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold transition-all ${activeTab === 'tenants' ? 'bg-indigo-50 text-indigo-600 dark:bg-indigo-900/20 dark:text-indigo-400' : 'text-brand-muted hover:bg-brand-surface-2 dark:hover:bg-brand-surface-2'}`}
          >
            <Building2 size={20} />
            Gestão de Tenants
          </button>

          <button
            onClick={() => setActiveTab('infra')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold transition-all ${activeTab === 'infra' ? 'bg-indigo-50 text-indigo-600 dark:bg-indigo-900/20 dark:text-indigo-400' : 'text-brand-muted hover:bg-brand-surface-2 dark:hover:bg-brand-surface-2'}`}
          >
            <Database size={20} />
            Infra & Planos
          </button>
          <button
            onClick={() => setActiveTab('billing')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold transition-all ${activeTab === 'billing' ? 'bg-indigo-50 text-indigo-600 dark:bg-indigo-900/20 dark:text-indigo-400' : 'text-brand-muted hover:bg-brand-surface-2 dark:hover:bg-brand-surface-2'}`}
          >
            <CreditCard size={20} />
            Faturamento SaaS
          </button>
          <button
            onClick={() => setActiveTab('teachers')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold transition-all ${activeTab === 'teachers' ? 'bg-amber-50 text-amber-600 dark:bg-amber-900/20 dark:text-amber-400' : 'text-brand-muted hover:bg-brand-surface-2 dark:hover:bg-brand-surface-2'}`}
          >
            <GraduationCap size={20} />
            Teachers Empreend.
          </button>
        </nav>

        <div className="p-4 border-t border-brand-border dark:border-brand-border space-y-4">
          <div className="bg-brand-surface-2 dark:bg-brand-surface-2 rounded-xl p-4">
            <p className="text-xs font-bold text-brand-muted mb-1">Status do Sistema</p>
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-xs font-bold text-brand-text dark:text-slate-300">Operacional</span>
            </div>
          </div>

          <button
            onClick={onLogout}
            className="w-full flex items-center justify-center gap-2 text-red-500 bg-red-50 dark:bg-red-900/10 hover:bg-red-100 dark:hover:bg-red-900/20 py-3 rounded-xl font-bold text-sm transition-colors"
          >
            <LogOut size={16} />
            Sair do Sistema
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="ml-64 flex-1 p-8">
        <header className="mb-8 flex justify-between items-center">
          <div>
            <h1 className="text-2xl font-black text-brand-text">
              {activeTab === 'global' && 'Visão Geral'}
              {activeTab === 'tenants' && 'Escolas Parceiras'}
              {activeTab === 'infra' && 'Infraestrutura'}
              {activeTab === 'billing' && 'Financeiro'}
              {activeTab === 'crm' && 'Funil de Vendas'}
              {activeTab === 'teachers' && 'Teachers Empreendedores'}
            </h1>
            <p className="text-brand-muted">Bem-vindo ao painel de controle mestre.</p>
          </div>
          <div className="flex gap-4">
            <div className="bg-brand-surface px-4 py-2 rounded-xl text-sm font-bold shadow-sm border border-brand-border flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-indigo-100 dark:bg-indigo-900/50 flex items-center justify-center text-indigo-600 font-black">
                SA
              </div>
              <span>Super Admin</span>
            </div>
          </div>
        </header>

        <div className="animate-in fade-in duration-500">
          {renderContent()}
        </div>
      </main>
    </div>
  );
};

export default SuperAdminDashboard;
