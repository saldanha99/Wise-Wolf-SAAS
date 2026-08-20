import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Flame, LockKeyhole, RefreshCw, ShieldAlert, TimerReset, Users } from 'lucide-react';
import { supabase } from '../lib/supabase';

type TurboStatus = 'INELIGIBLE_STUDENTS' | 'BUILDING' | 'ACTIVE' | 'SUSPENDED';

interface TeacherTurboRow {
  teacher_id: string;
  full_name: string;
  tenant_id: string;
  turbo_status: TurboStatus;
  turbo_active: boolean;
  students_active: number;
  students_required: number;
  students_missing: number;
  streak_days: number;
  days_to_activate: number;
  active_since: string | null;
  active_days: number;
  suspensions_open: number;
  suspension_since: string | null;
  last_absence_on: string | null;
  blocked_by: 'carteira' | 'ofensiva' | 'conflito' | null;
}

const STATUS_ORDER: Record<TurboStatus, number> = {
  SUSPENDED: 0,
  BUILDING: 1,
  ACTIVE: 2,
  INELIGIBLE_STUDENTS: 3,
};

const TeacherTurboOverview: React.FC<{ tenantId?: string }> = ({ tenantId }) => {
  const [rows, setRows] = useState<TeacherTurboRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    const { data, error: rpcError } = await supabase.rpc('list_teacher_turbo_overview');
    if (rpcError) {
      setRows([]);
      setError('Não foi possível carregar a ofensiva do Turbo.');
    } else {
      setRows(Array.isArray(data) ? data as TeacherTurboRow[] : []);
    }
    setLoading(false);
  };

  useEffect(() => { void load(); }, [tenantId]);

  const sorted = useMemo(() => [...rows].sort((a, b) => {
    const byStatus = STATUS_ORDER[a.turbo_status] - STATUS_ORDER[b.turbo_status];
    if (byStatus !== 0) return byStatus;
    if (a.turbo_status === 'BUILDING') return a.days_to_activate - b.days_to_activate;
    if (a.turbo_status === 'ACTIVE') return b.active_days - a.active_days;
    return String(a.full_name || '').localeCompare(String(b.full_name || ''), 'pt-BR');
  }), [rows]);

  const totals = useMemo(() => ({
    active: rows.filter(row => row.turbo_status === 'ACTIVE').length,
    building: rows.filter(row => row.turbo_status === 'BUILDING').length,
    suspended: rows.filter(row => row.turbo_status === 'SUSPENDED').length,
  }), [rows]);

  return (
    <section className="bg-brand-surface border border-gray-100 dark:border-brand-border rounded-[2rem] shadow-sm overflow-hidden">
      <div className="p-5 md:p-6 border-b border-gray-100 dark:border-brand-border flex flex-col md:flex-row md:items-center gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="p-3 rounded-2xl bg-orange-50 dark:bg-orange-900/20 text-orange-600 shrink-0">
            <Flame size={22} />
          </div>
          <div className="min-w-0">
            <h3 className="font-black text-gray-800 dark:text-slate-100">Ofensiva do Turbo</h3>
            <p className="text-xs text-gray-500 dark:text-brand-muted">
              Ativa com 10 alunos e 30 dias corridos sem falta do professor.
            </p>
          </div>
        </div>
        <div className="md:ml-auto flex items-center gap-2 flex-wrap">
          <SummaryBadge label="Ativos" value={totals.active} cls="bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300" />
          <SummaryBadge label="Em construção" value={totals.building} cls="bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-300" />
          {totals.suspended > 0 && <SummaryBadge label="Para analisar" value={totals.suspended} cls="bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300" />}
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="p-2.5 rounded-xl border border-brand-border text-brand-muted hover:text-brand-text disabled:opacity-50"
            title="Atualizar ofensivas"
            aria-label="Atualizar ofensivas do Turbo"
          >
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {loading ? (
        <div className="py-12 flex items-center justify-center text-brand-muted gap-2 text-sm">
          <RefreshCw size={18} className="animate-spin" /> Calculando ofensivas…
        </div>
      ) : error ? (
        <div className="m-5 rounded-2xl border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-900/10 p-4 text-sm text-red-700 dark:text-red-300 flex items-center gap-2">
          <AlertTriangle size={18} /> {error}
        </div>
      ) : sorted.length === 0 ? (
        <div className="py-12 text-center text-sm text-brand-muted">Nenhum professor ativo nesta unidade.</div>
      ) : (
        <div className="p-4 md:p-5 grid grid-cols-1 xl:grid-cols-2 gap-3">
          {sorted.map(row => <TurboTeacherCard key={row.teacher_id} row={row} />)}
        </div>
      )}
    </section>
  );
};

const TurboTeacherCard: React.FC<{ row: TeacherTurboRow }> = ({ row }) => {
  const requiredDays = 30;
  const progress = Math.min(100, Math.max(0, (Number(row.streak_days || 0) / requiredDays) * 100));
  const date = (value: string | null) => value
    ? new Date(`${value.slice(0, 10)}T00:00:00`).toLocaleDateString('pt-BR')
    : '—';

  const status = (() => {
    if (row.turbo_status === 'SUSPENDED') return {
      icon: <ShieldAlert size={18} />,
      title: 'Turbo suspenso para análise',
      detail: `${row.suspensions_open || 1} relato${row.suspensions_open === 1 ? '' : 's'} aguardando decisão da diretoria`,
      badge: 'Analisar presença',
      cls: 'border-red-200 dark:border-red-900/50 bg-red-50/60 dark:bg-red-900/10 text-red-700 dark:text-red-300',
    };
    if (row.turbo_status === 'ACTIVE') return {
      icon: <Flame size={18} />,
      title: `Turbo ativo há ${row.active_days} dia${row.active_days === 1 ? '' : 's'}`,
      detail: `Ativo desde ${date(row.active_since)} · ofensiva de ${row.streak_days} dias`,
      badge: 'Ativo',
      cls: 'border-orange-200 dark:border-orange-800/60 bg-gradient-to-r from-orange-50 to-amber-50 dark:from-orange-900/20 dark:to-amber-900/10 text-orange-700 dark:text-orange-300',
    };
    if (row.turbo_status === 'BUILDING') return {
      icon: <TimerReset size={18} />,
      title: `Faltam ${row.days_to_activate} dia${row.days_to_activate === 1 ? '' : 's'} para ativar`,
      detail: `${row.streak_days} de 30 dias consecutivos sem falta`,
      badge: 'Construindo',
      cls: 'border-blue-200 dark:border-blue-900/50 bg-blue-50/50 dark:bg-blue-900/10 text-blue-700 dark:text-blue-300',
    };
    return {
      icon: <LockKeyhole size={18} />,
      title: `Faltam ${row.students_missing} aluno${row.students_missing === 1 ? '' : 's'}`,
      detail: `${row.students_active} de ${row.students_required || 10} alunos necessários · ofensiva atual: ${row.streak_days} dias`,
      badge: 'Carteira mínima',
      cls: 'border-gray-200 dark:border-brand-border bg-gray-50/60 dark:bg-brand-surface-2/40 text-gray-600 dark:text-slate-300',
    };
  })();

  return (
    <article className={`rounded-2xl border p-4 ${status.cls}`}>
      <div className="flex items-start gap-3">
        <div className="p-2 rounded-xl bg-white/70 dark:bg-black/10 shrink-0">{status.icon}</div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="font-black text-sm text-gray-800 dark:text-slate-100 truncate">{row.full_name || 'Professor'}</p>
            <span className="text-[9px] uppercase tracking-wider font-black px-2 py-0.5 rounded-full bg-white/70 dark:bg-black/10">
              {status.badge}
            </span>
          </div>
          <p className="font-bold text-sm mt-2">{status.title}</p>
          <p className="text-[11px] opacity-80 mt-0.5">{status.detail}</p>
        </div>
        <div className="text-right shrink-0" title="Alunos ativos na carteira">
          <span className="inline-flex items-center gap-1 text-xs font-black"><Users size={13} /> {row.students_active}</span>
          <p className="text-[9px] uppercase font-bold opacity-70">alunos</p>
        </div>
      </div>

      {row.turbo_status === 'BUILDING' && (
        <div className="mt-3 h-2 rounded-full bg-white/70 dark:bg-black/10 overflow-hidden" aria-label={`${row.streak_days} de 30 dias`}>
          <div className="h-full rounded-full bg-blue-500 transition-all" style={{ width: `${progress}%` }} />
        </div>
      )}

      {row.turbo_status === 'SUSPENDED' && row.suspension_since && (
        <p className="text-[10px] mt-3 pt-2 border-t border-current/10">
          Suspenso desde {new Date(row.suspension_since).toLocaleString('pt-BR')}.
          A ofensiva fica preservada até a decisão; falta confirmada reinicia em zero.
        </p>
      )}

      {row.last_absence_on && row.turbo_status !== 'SUSPENDED' && (
        <p className="text-[10px] mt-3 opacity-70">Última falta confirmada: {date(row.last_absence_on)}</p>
      )}
    </article>
  );
};

const SummaryBadge: React.FC<{ label: string; value: number; cls: string }> = ({ label, value, cls }) => (
  <span className={`text-[10px] font-black uppercase tracking-wider px-2.5 py-1.5 rounded-full ${cls}`}>
    {value} {label}
  </span>
);

export default TeacherTurboOverview;
