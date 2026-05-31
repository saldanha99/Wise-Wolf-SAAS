import React, { useEffect, useState, useMemo } from 'react';
import { supabase } from '../lib/supabase';
import { ShieldAlert, Users, AlertTriangle, TrendingUp, RefreshCw, Eye, CreditCard, CalendarClock, Sparkles } from 'lucide-react';
import { User as UserType } from '../types';
import StudentProfileView from './StudentProfileView';

interface Props { user: UserType; tenantId?: string; }

const StudentInsightsBoard: React.FC<Props> = ({ user }) => {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewId, setViewId] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiDigest, setAiDigest] = useState<string>('');
  const [aiError, setAiError] = useState<string>('');

  const genDigest = async () => {
    setAiLoading(true); setAiError(''); setAiDigest('');
    try {
      const { data, error } = await supabase.functions.invoke('school-ai-digest', { body: {} });
      if (error || data?.error) throw new Error(data?.error || error?.message || 'falha');
      setAiDigest(data.digest);
    } catch (e: any) {
      setAiError(e.message || 'Não foi possível gerar o resumo.');
    } finally {
      setAiLoading(false);
    }
  };

  // Render simples de markdown (títulos ## e bullets -)
  const renderMd = (md: string) => md.split('\n').map((ln, i) => {
    const line = ln.replace(/\*\*(.*?)\*\*/g, '$1');
    if (line.startsWith('## ')) return <h4 key={i} className="text-sm font-black text-brand-text mt-4 mb-1">{line.slice(3)}</h4>;
    if (line.startsWith('# ')) return <h3 key={i} className="text-base font-black text-brand-text mt-4 mb-1">{line.slice(2)}</h3>;
    if (/^\s*[-*]\s/.test(line)) return <li key={i} className="text-xs text-brand-muted ml-4 list-disc">{line.replace(/^\s*[-*]\s/, '')}</li>;
    if (!line.trim()) return <div key={i} className="h-2" />;
    return <p key={i} className="text-xs text-brand-muted">{line}</p>;
  });

  const load = async () => {
    setLoading(true);
    const { data } = await supabase.rpc('list_students_overview');
    setRows(Array.isArray(data) ? data : []);
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const atRisk = useMemo(() => rows.filter(r => r.risk_level !== 'LOW')
    .sort((a, b) => (b.risk_score || 0) - (a.risk_score || 0)), [rows]);

  // Distribuição por professor
  const byTeacher = useMemo(() => {
    const map: Record<string, { name: string; count: number; risk: number; overdue: number; rateSum: number; rateN: number }> = {};
    rows.forEach(r => {
      const key = r.professor_id || 'sem';
      if (!map[key]) map[key] = { name: r.professor_name || 'Sem professor', count: 0, risk: 0, overdue: 0, rateSum: 0, rateN: 0 };
      map[key].count++;
      if (r.risk_level !== 'LOW') map[key].risk++;
      if ((r.overdue_count || 0) > 0) map[key].overdue++;
      if (r.attendance_rate != null) { map[key].rateSum += r.attendance_rate; map[key].rateN++; }
    });
    return Object.values(map).sort((a, b) => b.count - a.count);
  }, [rows]);

  const active = useMemo(() => rows.filter(r => r.has_activity), [rows]);
  const orphans = useMemo(() => rows.filter(r => !r.has_activity), [rows]);
  const maxCount = Math.max(1, ...byTeacher.map(t => t.count));
  const totals = useMemo(() => ({
    total: active.length,            // alunos REAIS (com matrícula/pagamento)
    orphans: orphans.length,         // perfis sem matrícula (possíveis testes)
    risk: atRisk.filter(r => r.has_activity).length,
    overdue: rows.filter(r => (r.overdue_count || 0) > 0).length,
    avgRate: (() => { const v = active.filter(r => r.attendance_rate != null); return v.length ? Math.round(v.reduce((s, r) => s + r.attendance_rate, 0) / v.length) : null; })(),
  }), [rows, atRisk, active, orphans]);

  const fmtMoney = (v: any) => `R$ ${Number(v || 0).toFixed(2).replace('.', ',')}`;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="p-3 rounded-2xl bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600"><Users size={24} /></div>
        <div>
          <h2 className="text-xl font-bold text-brand-text">Painel de Alunos</h2>
          <p className="text-sm text-brand-muted">Risco de evasão, frequência e distribuição por professor</p>
        </div>
        <button onClick={genDigest} disabled={aiLoading}
          className="ml-auto flex items-center gap-2 px-4 py-2 rounded-xl bg-gradient-to-r from-violet-600 to-indigo-600 text-white text-xs font-bold shadow-lg disabled:opacity-60">
          <Sparkles size={15} className={aiLoading ? 'animate-pulse' : ''} /> {aiLoading ? 'Analisando…' : 'Resumo IA'}
        </button>
        <button onClick={load} className="p-2 rounded-xl border border-brand-border text-brand-muted hover:text-brand-text"><RefreshCw size={18} className={loading ? 'animate-spin' : ''} /></button>
      </div>

      {/* Resumo executivo por IA */}
      {(aiLoading || aiDigest || aiError) && (
        <div className="bg-gradient-to-br from-violet-50 to-indigo-50 dark:from-violet-900/10 dark:to-indigo-900/10 border border-violet-200 dark:border-violet-900/30 rounded-2xl p-5">
          <div className="flex items-center gap-2 mb-3">
            <Sparkles size={16} className="text-violet-600" />
            <h3 className="text-sm font-bold text-brand-text">Resumo executivo (IA)</h3>
          </div>
          {aiLoading ? (
            <p className="text-xs text-brand-muted flex items-center gap-2"><RefreshCw size={14} className="animate-spin" /> A IA está analisando os dados da escola…</p>
          ) : aiError ? (
            <p className="text-xs text-red-600">{aiError}</p>
          ) : (
            <div className="space-y-0.5">{renderMd(aiDigest)}</div>
          )}
        </div>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi icon={<Users size={16} />} label="Alunos ativos" value={`${totals.total}`} />
        <Kpi icon={<AlertTriangle size={16} className="text-red-500" />} label="Em risco" value={`${totals.risk}`} accent="text-red-600" />
        <Kpi icon={<CreditCard size={16} className="text-amber-500" />} label="Inadimplentes" value={`${totals.overdue}`} accent="text-amber-600" />
        <Kpi icon={<TrendingUp size={16} className="text-emerald-500" />} label="Freq. média" value={totals.avgRate != null ? `${totals.avgRate}%` : '—'} />
      </div>
      {totals.orphans > 0 && (
        <div className="bg-amber-50/60 dark:bg-amber-900/10 border border-amber-300 dark:border-amber-900/40 rounded-2xl px-4 py-3 text-xs text-amber-700 dark:text-amber-300 flex items-center gap-2">
          <AlertTriangle size={14} /> <b>{totals.orphans} perfis sem matrícula</b> (sem aula e sem pagamento) — provavelmente contas de teste. Filtre por “Sem matrícula” na aba Alunos para revisar/arquivar. O número de <b>alunos ativos ({totals.total})</b> exclui esses.
        </div>
      )}

      <div className="grid lg:grid-cols-2 gap-6">
        {/* Alunos em risco */}
        <div className="bg-brand-surface border border-brand-border rounded-2xl p-5">
          <h3 className="text-sm font-bold text-brand-text mb-4 flex items-center gap-2">
            <ShieldAlert size={16} className="text-red-600" /> Alunos em risco
            {atRisk.length > 0 && <span className="text-[10px] bg-red-500 text-white px-2 py-0.5 rounded-full">{atRisk.length}</span>}
          </h3>
          {loading ? <Loading /> : atRisk.length === 0 ? <Empty txt="Nenhum aluno em risco 🎉" /> : (
            <div className="space-y-2 max-h-[460px] overflow-y-auto pr-1">
              {atRisk.map(r => (
                <button key={r.student_id} onClick={() => setViewId(r.student_id)}
                  className="w-full text-left border border-brand-border rounded-xl p-3 hover:border-brand-accent/40 transition-all">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-bold text-brand-text truncate">{r.full_name}</span>
                    <span className={`text-[9px] font-black px-2 py-0.5 rounded-full ${r.risk_level === 'HIGH' ? 'bg-red-500 text-white' : 'bg-amber-400 text-amber-900'}`}>
                      {r.risk_level === 'HIGH' ? 'ALTO' : 'ATENÇÃO'}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {(r.risk_reasons || []).map((reason: string, i: number) => (
                      <span key={i} className="text-[10px] bg-red-50 dark:bg-red-900/20 text-red-600 px-2 py-0.5 rounded">{reason}</span>
                    ))}
                  </div>
                  <p className="text-[10px] text-brand-muted mt-1.5">{r.professor_name || 'Sem professor'} · {r.module || 's/ nível'}</p>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Distribuição por professor */}
        <div className="bg-brand-surface border border-brand-border rounded-2xl p-5">
          <h3 className="text-sm font-bold text-brand-text mb-4 flex items-center gap-2">
            <CalendarClock size={16} className="text-indigo-600" /> Carga por professor
          </h3>
          {loading ? <Loading /> : (
            <div className="space-y-3 max-h-[460px] overflow-y-auto pr-1">
              {byTeacher.map((t, i) => (
                <div key={i}>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="font-bold text-brand-text truncate">{t.name}</span>
                    <span className="text-brand-muted shrink-0">{t.count} aluno{t.count !== 1 ? 's' : ''}</span>
                  </div>
                  <div className="w-full h-2.5 bg-brand-surface-2 rounded-full overflow-hidden">
                    <div className="h-full bg-gradient-to-r from-indigo-500 to-violet-500" style={{ width: `${Math.round(100 * t.count / maxCount)}%` }} />
                  </div>
                  <div className="flex gap-3 mt-1 text-[10px] text-brand-muted">
                    {t.risk > 0 && <span className="text-red-500 font-bold">{t.risk} em risco</span>}
                    {t.overdue > 0 && <span className="text-amber-600 font-bold">{t.overdue} inadimplente{t.overdue !== 1 ? 's' : ''}</span>}
                    {t.rateN > 0 && <span>freq. {Math.round(t.rateSum / t.rateN)}%</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {viewId && <StudentProfileView studentId={viewId} user={user} onClose={() => setViewId(null)} />}
    </div>
  );
};

const Kpi: React.FC<{ icon: React.ReactNode; label: string; value: string; accent?: string }> = ({ icon, label, value, accent }) => (
  <div className="bg-brand-surface border border-brand-border rounded-2xl p-4">
    <div className="flex items-center gap-2 text-brand-muted text-[10px] font-bold uppercase mb-1">{icon}{label}</div>
    <p className={`text-2xl font-black ${accent || 'text-brand-text'}`}>{value}</p>
  </div>
);
const Loading = () => <div className="py-10 text-center text-brand-muted"><RefreshCw size={20} className="animate-spin mx-auto" /></div>;
const Empty: React.FC<{ txt: string }> = ({ txt }) => <div className="py-10 text-center text-brand-muted text-sm opacity-70">{txt}</div>;

export default StudentInsightsBoard;
