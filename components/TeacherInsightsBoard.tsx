import React, { useEffect, useState, useMemo } from 'react';
import { supabase } from '../lib/supabase';
import { Users, AlertTriangle, RefreshCw, Wallet, DollarSign, Star, UserX, ShieldAlert, Eye, FileWarning } from 'lucide-react';
import { User as UserType } from '../types';
import TeacherProfileView from './TeacherProfileView';

interface Props { user: UserType; tenantId?: string; }

const TeacherInsightsBoard: React.FC<Props> = ({ }) => {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewId, setViewId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    const { data } = await supabase.rpc('list_teachers_overview');
    setRows(Array.isArray(data) ? data : []);
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const money = (v: any) => `R$ ${Number(v || 0).toFixed(2).replace('.', ',')}`;

  const stats = useMemo(() => {
    const active = rows.filter(r => r.status === 'Ativo');
    const rates = rows.map(r => Number(r.hourly_rate || 0)).filter(v => v > 0);
    return {
      total: rows.length,
      alert: rows.filter(r => r.alert_level !== 'LOW').length,
      nfPending: rows.filter(r => r.nf_pending).length,
      avgRate: rates.length ? rates.reduce((s, v) => s + v, 0) / rates.length : 0,
      payroll: rows.reduce((s, r) => s + Number(r.earnings_est || 0), 0),
      active: active.length,
    };
  }, [rows]);

  const sorted = useMemo(() => [...rows].sort((a, b) => (b.alert_score || 0) - (a.alert_score || 0)), [rows]);
  const compliance = useMemo(() => rows.filter(r => !r.pix_ok || !r.contract_ok), [rows]);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="p-3 rounded-2xl bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600"><Users size={24} /></div>
        <div>
          <h2 className="text-xl font-bold text-brand-text">Gestão de Professores</h2>
          <p className="text-sm text-brand-muted">Desempenho, alertas, folha e pendências</p>
        </div>
        <button onClick={load} className="ml-auto p-2 rounded-xl border border-brand-border text-brand-muted hover:text-brand-text"><RefreshCw size={18} className={loading ? 'animate-spin' : ''} /></button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Kpi icon={<Users size={16} />} label="Ativos" value={`${stats.active}/${stats.total}`} />
        <Kpi icon={<AlertTriangle size={16} className="text-red-500" />} label="Em alerta" value={`${stats.alert}`} accent="text-red-600" />
        <Kpi icon={<FileWarning size={16} className="text-amber-500" />} label="NF pendente" value={`${stats.nfPending}`} accent="text-amber-600" />
        <Kpi icon={<Wallet size={16} />} label="Custo-hora médio" value={money(stats.avgRate)} />
        <Kpi icon={<DollarSign size={16} className="text-emerald-500" />} label="Folha (mês, est.)" value={money(stats.payroll)} />
      </div>

      {/* Scorecard / alertas */}
      <div className="bg-brand-surface border border-brand-border rounded-2xl p-5">
        <h3 className="text-sm font-bold text-brand-text mb-4 flex items-center gap-2"><ShieldAlert size={16} className="text-indigo-600" /> Desempenho dos professores</h3>
        {loading ? <Loading /> : sorted.length === 0 ? <Empty txt="Nenhum professor." /> : (
          <div className="space-y-2">
            {sorted.map(t => (
              <button key={t.teacher_id} onClick={() => setViewId(t.teacher_id)}
                className="w-full text-left border border-brand-border rounded-xl p-3 hover:border-brand-accent/40 transition-all">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-2 min-w-0">
                    <img src={t.avatar_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(t.full_name || 'P')}`} className="w-8 h-8 rounded-lg object-cover" alt="" />
                    <span className="text-sm font-bold text-brand-text truncate">{t.full_name}</span>
                    {t.alert_level !== 'LOW' && (
                      <span className={`text-[9px] font-black px-2 py-0.5 rounded-full ${t.alert_level === 'HIGH' ? 'bg-red-500 text-white' : 'bg-amber-400 text-amber-900'}`}>
                        {t.alert_level === 'HIGH' ? 'ALERTA' : 'ATENÇÃO'}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 text-[11px] text-brand-muted shrink-0">
                    <span className="flex items-center gap-1" title="Alunos"><Users size={12} />{t.active_students}</span>
                    <span className="flex items-center gap-1" title="Aulas 30d">{t.classes_30}a</span>
                    {t.teacher_absence_30 > 0 && <span className="flex items-center gap-1 text-red-500" title="Faltas do professor"><UserX size={12} />{t.teacher_absence_30}</span>}
                    {t.avg_rating != null && <span className="flex items-center gap-1 text-yellow-600"><Star size={12} className="fill-current" />{t.avg_rating}</span>}
                    <span className="text-emerald-600 font-bold">{money(t.earnings_est)}</span>
                    <Eye size={14} className="text-brand-accent" />
                  </div>
                </div>
                {(t.alert_reasons || []).length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {(t.alert_reasons || []).map((r: string, i: number) => (
                      <span key={i} className="text-[10px] bg-red-50 dark:bg-red-900/20 text-red-600 px-2 py-0.5 rounded">{r}</span>
                    ))}
                  </div>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Pendências de cadastro/compliance */}
      {compliance.length > 0 && (
        <div className="bg-amber-50/60 dark:bg-amber-900/10 border border-amber-300 dark:border-amber-900/40 rounded-2xl p-5">
          <h3 className="text-sm font-bold text-amber-700 dark:text-amber-400 mb-3 flex items-center gap-2"><FileWarning size={16} /> Pendências de cadastro</h3>
          <div className="space-y-2">
            {compliance.map(t => (
              <div key={t.teacher_id} className="flex items-center justify-between gap-2 bg-brand-surface border border-amber-200 dark:border-amber-900/30 rounded-xl p-3">
                <span className="text-sm font-bold text-brand-text truncate">{t.full_name}</span>
                <div className="flex gap-2 shrink-0">
                  {!t.pix_ok && <span className="text-[10px] font-bold bg-red-100 text-red-600 px-2 py-1 rounded">Sem PIX</span>}
                  {!t.contract_ok && <span className="text-[10px] font-bold bg-red-100 text-red-600 px-2 py-1 rounded">Contrato pendente</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {viewId && <TeacherProfileView teacherId={viewId} onClose={() => setViewId(null)} />}
    </div>
  );
};

const Kpi: React.FC<{ icon: React.ReactNode; label: string; value: string; accent?: string }> = ({ icon, label, value, accent }) => (
  <div className="bg-brand-surface border border-brand-border rounded-2xl p-4">
    <div className="flex items-center gap-2 text-brand-muted text-[10px] font-bold uppercase mb-1">{icon}{label}</div>
    <p className={`text-xl font-black ${accent || 'text-brand-text'}`}>{value}</p>
  </div>
);
const Loading = () => <div className="py-10 text-center text-brand-muted"><RefreshCw size={20} className="animate-spin mx-auto" /></div>;
const Empty: React.FC<{ txt: string }> = ({ txt }) => <div className="py-10 text-center text-brand-muted text-sm opacity-70">{txt}</div>;

export default TeacherInsightsBoard;
