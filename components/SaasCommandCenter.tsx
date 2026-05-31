import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import {
  Globe, DollarSign, TrendingUp, Users, AlertTriangle, RefreshCw, Eye,
  Building2, Clock, FileWarning, Zap, GraduationCap
} from 'lucide-react';
import TenantProfileView from './TenantProfileView';

const SaasCommandCenter: React.FC = () => {
  const [m, setM] = useState<any>(null);
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewId, setViewId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    const [{ data: metrics }, { data: list }] = await Promise.all([
      supabase.rpc('saas_metrics'),
      supabase.rpc('list_tenants_overview'),
    ]);
    setM(metrics?.error ? null : metrics);
    setRows(Array.isArray(list) ? list : []);
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const money = (v: any) => `R$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  const atRisk = rows.filter(r => r.risk_level !== 'LOW');

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="p-3 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white"><Globe size={24} /></div>
        <div>
          <h2 className="text-xl font-bold text-brand-text">SaaS Command Center</h2>
          <p className="text-sm text-brand-muted">Receita, saúde das escolas e risco de churn (B2B)</p>
        </div>
        <button onClick={load} className="ml-auto p-2 rounded-xl border border-brand-border text-brand-muted hover:text-brand-text"><RefreshCw size={18} className={loading ? 'animate-spin' : ''} /></button>
      </div>

      {/* KPIs reais */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi icon={<DollarSign size={16} className="text-emerald-500" />} label="MRR" value={money(m?.mrr)} sub={`ARR ${money(m?.arr)}`} />
        <Kpi icon={<TrendingUp size={16} />} label="ARPU" value={m?.arpu ? money(m.arpu) : '—'} sub={`${m?.paying_tenants || 0} pagantes`} />
        <Kpi icon={<Building2 size={16} />} label="Escolas ativas" value={`${m?.active_tenants ?? 0}/${m?.total_tenants ?? 0}`} sub={`${m?.blocked_tenants || 0} bloqueadas`} />
        <Kpi icon={<Users size={16} />} label="Usuários totais" value={`${m?.total_students ?? 0}`} sub={`${m?.total_teachers ?? 0} professores`} />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi icon={<FileWarning size={16} className="text-amber-500" />} label="Sem plano" value={`${m?.no_plan ?? 0}`} accent="text-amber-600" sub="receita não contabilizada" />
        <Kpi icon={<AlertTriangle size={16} className="text-red-500" />} label="Escolas em risco" value={`${atRisk.length}`} accent="text-red-600" />
        <Kpi icon={<Clock size={16} />} label="Trials expirando" value={`${m?.trials_expiring ?? 0}`} sub="próx. 7 dias" />
        <Kpi icon={<FileWarning size={16} className="text-red-500" />} label="Faturas vencidas" value={`${m?.overdue_invoices ?? 0}`} accent="text-red-600" sub={money(m?.overdue_amount)} />
      </div>

      {/* Escolas — saúde / risco */}
      <div className="bg-brand-surface border border-brand-border rounded-2xl p-5">
        <h3 className="text-sm font-bold text-brand-text mb-4 flex items-center gap-2"><Building2 size={16} className="text-indigo-600" /> Escolas parceiras</h3>
        {loading ? <div className="py-10 text-center text-brand-muted"><RefreshCw size={20} className="animate-spin mx-auto" /></div>
        : rows.length === 0 ? <div className="py-10 text-center text-brand-muted text-sm opacity-70">Nenhuma escola.</div>
        : (
          <div className="space-y-2">
            {rows.map(t => (
              <button key={t.tenant_id} onClick={() => setViewId(t.tenant_id)}
                className="w-full text-left border border-brand-border rounded-xl p-3 hover:border-brand-accent/40 transition-all">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm font-bold text-brand-text truncate">{t.name}</span>
                    <span className={`text-[9px] font-black px-2 py-0.5 rounded-full ${t.saas_status === 'active' ? 'bg-emerald-100 text-emerald-600' : 'bg-red-100 text-red-600'}`}>{t.saas_status}</span>
                    {t.plan_name ? <span className="text-[9px] font-black bg-brand-accent/10 text-brand-accent px-2 py-0.5 rounded-full">{t.plan_name}</span>
                      : <span className="text-[9px] font-black bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">SEM PLANO</span>}
                    {t.risk_level !== 'LOW' && (
                      <span className={`text-[9px] font-black px-2 py-0.5 rounded-full ${t.risk_level === 'HIGH' ? 'bg-red-500 text-white' : 'bg-amber-400 text-amber-900'}`}>
                        {t.risk_level === 'HIGH' ? 'RISCO' : 'ATENÇÃO'}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 text-[11px] text-brand-muted shrink-0">
                    <span className="flex items-center gap-1"><GraduationCap size={12} />{t.students}{t.student_limit ? `/${t.student_limit}` : ''}</span>
                    {t.usage_pct >= 80 && <span className="text-amber-600 font-bold">{t.usage_pct}%</span>}
                    <span className="flex items-center gap-1"><Zap size={12} />{t.classes_30}a/30d</span>
                    <span className="text-emerald-600 font-bold">{t.saas_status === 'active' ? money(t.mrr) : '—'}</span>
                    <Eye size={14} className="text-brand-accent" />
                  </div>
                </div>
                {(t.risk_reasons || []).length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {(t.risk_reasons || []).map((r: string, i: number) => (
                      <span key={i} className="text-[10px] bg-red-50 dark:bg-red-900/20 text-red-600 px-2 py-0.5 rounded">{r}</span>
                    ))}
                  </div>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {viewId && <TenantProfileView tenantId={viewId} onClose={() => setViewId(null)} onChanged={load} />}
    </div>
  );
};

const Kpi: React.FC<{ icon: React.ReactNode; label: string; value: string; sub?: string; accent?: string }> = ({ icon, label, value, sub, accent }) => (
  <div className="bg-brand-surface border border-brand-border rounded-2xl p-4">
    <div className="flex items-center gap-2 text-brand-muted text-[10px] font-bold uppercase mb-1">{icon}{label}</div>
    <p className={`text-xl font-black ${accent || 'text-brand-text'}`}>{value}</p>
    {sub && <p className="text-[10px] text-brand-muted mt-0.5">{sub}</p>}
  </div>
);

export default SaasCommandCenter;
