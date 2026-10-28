import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowDownCircle, ArrowUpCircle, Beaker, CalendarCheck, ChevronRight,
  Clock, GraduationCap, Link2, RefreshCw, Sparkles, TrendingUp, UserPlus, Users, Wallet,
} from 'lucide-react';
import TeacherInviteGenerator from './TeacherInviteGenerator';
import TeacherTrainingAdmin from './training/TeacherTrainingAdmin';
import AiTeamPanel from './training/AiTeamPanel';
import RegistrationLinkGenerator from './RegistrationLinkGenerator';
import AutomacaoSmart from './AutomacaoSmart';
import ManualTrialScheduler from './ManualTrialScheduler';
import DirectorPendingCenter from './DirectorPendingCenter';
import { supabase } from '../lib/supabase';
import { Teacher } from '../types';
import { isSettledStudentPayment, isStudentPaymentAwaitingCredit } from '../lib/studentPaymentStatus';
import { formatLocalDateBr, localMonth, monthRange } from '../lib/dateUtils';

interface SchoolAdminDashboardProps {
  teachers: Teacher[];
  tenantId?: string;
  onViewTeacherSchedule?: (teacherName: string, action?: 'view' | 'allocate') => void;
  onNavigate?: (tab: string) => void;
  userRole?: string;
}

type DashTab = 'analytics' | 'training' | 'registration' | 'recruiting' | 'ai_team';

// Retorno de get_cashflow — a mesma conta do Fluxo de Caixa e do DRE.
interface Cashflow {
  entradas: number;
  saldo: number;
  a_receber: number;
  saidas: { professores: number; vendedores: number; indicacoes: number; despesas: number; total: number };
  inadimplencia: { total: number; count: number; d1_30: number; d31_60: number; d60plus: number };
  serie: { mes: string; entradas: number }[] | null;
}

interface PayrollRow { amount: number | string; lessons: number; previa: boolean }

interface RecentPayment {
  id: string;
  value: number | string;
  status: string;
  payment_date: string | null;
  profiles: { full_name: string | null } | null;
}

interface Overview {
  cash: Cashflow | null;
  payroll: number | null;
  payrollPreview: boolean;
  lessons: number;
  activeStudents: number;
  contracted: number;
  presence: number | null;
  recent: RecentPayment[];
}

const EMPTY: Overview = {
  cash: null, payroll: null, payrollPreview: false, lessons: 0,
  activeStudents: 0, contracted: 0, presence: null, recent: [],
};

const money = (v: number | null | undefined, digits = 2) =>
  v === null || v === undefined
    ? '—'
    : `R$ ${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;

const monthShort = (m: string) => {
  const [y, mo] = m.split('-');
  return new Date(Number(y), Number(mo) - 1, 1).toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '');
};

const TABS: { id: DashTab; label: string; icon: React.ElementType }[] = [
  { id: 'analytics', label: 'Visão geral', icon: Sparkles },
  { id: 'registration', label: 'Link Matrícula', icon: Link2 },
  { id: 'recruiting', label: 'Recrutamento', icon: UserPlus },
  { id: 'training', label: 'Treinamento', icon: GraduationCap },
  { id: 'ai_team', label: 'Equipe de IA', icon: Sparkles },
];

/**
 * Cartão com inclinação 3D que segue o ponteiro. Sem ponteiro fino (celular) ou
 * com "reduzir movimento" ligado, fica parado — só a profundidade estática.
 */
const TiltCard: React.FC<{ className?: string; children: React.ReactNode; onClick?: () => void }> = ({ className = '', children, onClick }) => {
  const ref = useRef<HTMLDivElement>(null);
  const canTilt = useMemo(
    () => typeof window !== 'undefined'
      && window.matchMedia?.('(pointer: fine)').matches
      && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
    [],
  );

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!canTilt || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5;
    const y = (e.clientY - r.top) / r.height - 0.5;
    ref.current.style.transform = `perspective(900px) rotateX(${(-y * 8).toFixed(2)}deg) rotateY(${(x * 10).toFixed(2)}deg) translateZ(0)`;
    ref.current.style.setProperty('--glare-x', `${(x + 0.5) * 100}%`);
    ref.current.style.setProperty('--glare-y', `${(y + 0.5) * 100}%`);
  };
  const onLeave = () => {
    if (ref.current) ref.current.style.transform = '';
  };

  const Tag = onClick ? 'button' : 'div';
  return (
    <div
      ref={ref}
      onPointerMove={onMove}
      onPointerLeave={onLeave}
      className={`group relative rounded-3xl transition-transform duration-200 ease-out will-change-transform [transform-style:preserve-3d] ${className}`}
    >
      <Tag
        type={onClick ? 'button' : undefined}
        onClick={onClick}
        className="relative block h-full w-full overflow-hidden rounded-3xl border border-brand-border bg-brand-surface text-left shadow-[0_1px_0_rgba(255,255,255,0.06)_inset,0_18px_40px_-24px_rgba(15,23,42,0.45)] transition-shadow duration-300 group-hover:shadow-[0_1px_0_rgba(255,255,255,0.08)_inset,0_30px_60px_-28px_rgba(37,99,235,0.45)]"
      >
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
          style={{ background: 'radial-gradient(420px circle at var(--glare-x,50%) var(--glare-y,0%), color-mix(in srgb, var(--brand-accent) 16%, transparent), transparent 60%)' }}
        />
        <span className="relative block h-full [transform:translateZ(24px)]">{children}</span>
      </Tag>
    </div>
  );
};

const KpiCard: React.FC<{
  label: string;
  value: string;
  hint: string;
  icon: React.ElementType;
  tone: 'emerald' | 'rose' | 'sky' | 'amber' | 'violet';
  loading: boolean;
  onClick?: () => void;
}> = ({ label, value, hint, icon: Icon, tone, loading, onClick }) => {
  const tones = {
    emerald: 'from-emerald-400 to-teal-500 shadow-emerald-500/40',
    rose: 'from-rose-400 to-red-500 shadow-rose-500/40',
    sky: 'from-sky-400 to-blue-600 shadow-blue-500/40',
    amber: 'from-amber-300 to-orange-500 shadow-orange-500/40',
    violet: 'from-violet-400 to-indigo-600 shadow-indigo-500/40',
  } as const;
  return (
    <TiltCard onClick={onClick}>
      <span className="flex h-full flex-col gap-4 p-5">
        <span className="flex items-start justify-between gap-3">
          <span className="text-[11px] font-semibold uppercase tracking-widest text-brand-muted">{label}</span>
          <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br text-white shadow-lg ${tones[tone]}`}>
            <Icon size={18} strokeWidth={2.2} />
          </span>
        </span>
        <span className="text-[1.65rem] font-extrabold leading-none tracking-tight text-brand-text tabular-nums">
          {loading ? <span className="inline-block h-7 w-32 animate-pulse rounded-lg bg-brand-surface-2" /> : value}
        </span>
        <span className="mt-auto flex items-center justify-between text-xs text-brand-muted">
          {hint}
          {onClick && <ChevronRight size={14} className="transition-transform group-hover:translate-x-0.5" />}
        </span>
      </span>
    </TiltCard>
  );
};

const SchoolAdminDashboard: React.FC<SchoolAdminDashboardProps> = ({ teachers, tenantId, onNavigate, userRole }) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<DashTab>('analytics');
  const [showTrialScheduler, setShowTrialScheduler] = useState(false);
  const [data, setData] = useState<Overview>(EMPTY);
  const month = localMonth();

  const fetchAnalytics = useCallback(async () => {
    if (!tenantId) return;
    setLoading(true);
    setError(null);
    const { start, endExclusive } = monthRange(month);
    try {
      // Tudo das fontes oficiais: caixa = get_cashflow (mesma conta do Fluxo de
      // Caixa e do DRE), folha = payroll_month_preview (mesma do Repasse a Profs).
      const [cashRes, payrollRes, studentsRes, logsRes, recentRes] = await Promise.all([
        supabase.rpc('get_cashflow', { p_month: month }),
        supabase.rpc('payroll_month_preview', { p_month: month }),
        supabase.rpc('get_authorized_student_billing_summary', { p_tenant_id: tenantId }),
        supabase
          .from('class_logs')
          .select('presence')
          .eq('tenant_id', tenantId)
          .gte('class_date', start)
          .lt('class_date', endExclusive),
        supabase
          .from('student_payments')
          .select('id, value, status, payment_date, profiles ( full_name )')
          .eq('tenant_id', tenantId)
          .in('status', ['RECEIVED', 'RECEIVED_IN_CASH', 'CONFIRMED'])
          .not('payment_date', 'is', null)
          .order('payment_date', { ascending: false })
          .limit(6),
      ]);

      const cashRaw = cashRes.data as (Cashflow & { error?: string }) | null;
      const cash = cashRes.error || !cashRaw || cashRaw.error ? null : cashRaw;

      const payrollRows = Array.isArray((payrollRes.data as { teachers?: PayrollRow[] } | null)?.teachers)
        ? (payrollRes.data as { teachers: PayrollRow[] }).teachers
        : null;
      const payroll = payrollRes.error || !payrollRows
        ? null
        : payrollRows.reduce((acc, r) => acc + Number(r.amount || 0), 0);
      const lessons = (payrollRows || []).reduce((acc, r) => acc + Number(r.lessons || 0), 0);

      const students = (studentsRes.data as { monthly_fee: number | null }[] | null) || [];
      const contracted = students.reduce((acc, s) => acc + Number(s.monthly_fee || 0), 0);

      // Presença: aulas dadas sobre o que foi lançado no mês da aula (class_date).
      const logs = (logsRes.data as { presence: string | null }[] | null) || [];
      const presence = logs.length
        ? (logs.filter((l) => l.presence === 'COMPLETED').length / logs.length) * 100
        : null;

      setData({
        cash,
        payroll,
        payrollPreview: (payrollRows || []).some((r) => r.previa),
        lessons,
        activeStudents: students.length,
        contracted,
        presence,
        recent: (recentRes.data as unknown as RecentPayment[] | null) || [],
      });
      if (!cash) setError('Não foi possível ler o caixa do mês agora.');
    } catch (e) {
      console.error('Erro ao carregar o painel do diretor', e);
      setError('Não foi possível carregar o painel. Tente atualizar.');
    } finally {
      setLoading(false);
    }
  }, [tenantId, month]);

  useEffect(() => {
    fetchAnalytics();
  }, [fetchAnalytics]);

  const cash = data.cash;
  const serie = cash?.serie || [];
  const maxSerie = Math.max(1, ...serie.map((s) => Number(s.entradas || 0)));
  // Resultado previsto do mês: entradas reais + o que ainda vence no mês − folha
  // (competência) − demais saídas já pagas. Sem folha lida, não mostramos número.
  const otherOut = cash ? Number(cash.saidas.total) - Number(cash.saidas.professores) : 0;
  const forecast = cash && data.payroll !== null
    ? Number(cash.entradas) + Number(cash.a_receber) - data.payroll - otherOut
    : null;
  const monthName = new Date().toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });

  return (
    <div className="space-y-6 font-sans animate-fade-in-up md:space-y-8">
      {/* Hero */}
      <section className="relative overflow-hidden rounded-[2rem] border border-brand-border bg-gradient-to-br from-blue-600 via-indigo-600 to-violet-700 p-6 text-white shadow-[0_40px_80px_-40px_rgba(79,70,229,0.75)] md:p-8">
        <div aria-hidden className="pointer-events-none absolute -right-20 -top-24 h-72 w-72 rounded-full bg-white/15 blur-3xl" />
        <div aria-hidden className="pointer-events-none absolute -bottom-28 left-10 h-64 w-64 rounded-full bg-fuchsia-400/25 blur-3xl" />
        <div aria-hidden className="pointer-events-none absolute inset-0 opacity-[0.12] [background-image:linear-gradient(rgba(255,255,255,.6)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.6)_1px,transparent_1px)] [background-size:36px_36px] [mask-image:radial-gradient(ellipse_at_top_right,black,transparent_70%)]" />

        <div className="relative flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/70">Painel da direção · {monthName}</p>
            <h2 className="mt-2 text-3xl font-extrabold tracking-tight md:text-4xl">
              {activeTab === 'analytics' ? 'Como a escola está hoje' : TABS.find((t) => t.id === activeTab)?.label}
            </h2>
            {activeTab === 'analytics' && (
              <p className="mt-2 max-w-xl text-sm text-white/80">
                {loading
                  ? 'Carregando os números do mês…'
                  : `${money(cash ? Number(cash.entradas) : null, 0)} recebidos no mês, ${data.activeStudents} alunos ativos e ${data.lessons} aulas lançadas.`}
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setShowTrialScheduler(true)}
              className="flex items-center gap-2 rounded-2xl bg-white px-4 py-2.5 text-xs font-bold text-indigo-700 shadow-lg shadow-indigo-900/30 transition-transform hover:-translate-y-0.5"
            >
              <Beaker size={15} /> Agendar experimental
            </button>
            <button
              onClick={fetchAnalytics}
              className="flex items-center gap-2 rounded-2xl border border-white/30 bg-white/10 px-4 py-2.5 text-xs font-bold backdrop-blur transition-colors hover:bg-white/20"
              title="Atualizar dados"
            >
              <RefreshCw size={15} className={loading ? 'animate-spin' : ''} /> Atualizar
            </button>
          </div>
        </div>

        <nav className="relative mt-6 flex gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden rounded-2xl border border-white/20 bg-white/10 p-1.5 backdrop-blur" aria-label="Seções do painel">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              aria-current={activeTab === t.id ? 'page' : undefined}
              className={`flex shrink-0 items-center gap-2 whitespace-nowrap rounded-xl px-4 py-2 text-xs font-bold transition-all ${activeTab === t.id ? 'bg-white text-indigo-700 shadow-md' : 'text-white/80 hover:bg-white/10 hover:text-white'}`}
            >
              <t.icon size={14} />
              {/* Alvo do tour do link de matrícula: o literal é o que o teste de tours procura. */}
              {t.id === 'registration' ? <span data-tour="enrollment-link-tab">{t.label}</span> : t.label}
            </button>
          ))}
        </nav>
      </section>

      {activeTab === 'analytics' && (
        <>
          {error && (
            <div className="flex items-center gap-2 rounded-2xl border border-amber-400/40 bg-amber-400/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
              <AlertTriangle size={16} /> {error}
            </div>
          )}

          <div data-tour="pending-center">
            <DirectorPendingCenter onNavigate={onNavigate} />
          </div>

          {/* KPIs */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard
              label="Recebido no mês"
              value={money(cash ? Number(cash.entradas) : null)}
              hint="Dinheiro que entrou no caixa"
              icon={ArrowDownCircle}
              tone="emerald"
              loading={loading}
              onClick={() => onNavigate?.('cashflow')}
            />
            <KpiCard
              label="A receber no mês"
              value={money(cash ? Number(cash.a_receber) : null)}
              hint="Cobranças em aberto que vencem no mês"
              icon={Clock}
              tone="sky"
              loading={loading}
              onClick={() => onNavigate?.('student-payments')}
            />
            <KpiCard
              label="Inadimplência"
              value={money(cash ? Number(cash.inadimplencia.total) : null)}
              hint={cash ? `${cash.inadimplencia.count} cobranças vencidas` : 'Cobranças vencidas'}
              icon={AlertTriangle}
              tone="rose"
              loading={loading}
              onClick={() => onNavigate?.('student-payments')}
            />
            <KpiCard
              label={data.payrollPreview ? 'Folha do mês (prévia)' : 'Folha do mês'}
              value={money(data.payroll)}
              hint={`${data.lessons} aulas pagáveis lançadas`}
              icon={Wallet}
              tone="violet"
              loading={loading}
              onClick={() => onNavigate?.('payments')}
            />
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            {/* Receita 6 meses — barras com profundidade */}
            <TiltCard className="lg:col-span-2">
              <span className="block p-6 md:p-7">
                <span className="mb-6 flex items-start justify-between gap-4">
                  <span>
                    <span className="flex items-center gap-2 text-sm font-bold text-brand-text"><TrendingUp size={16} className="text-emerald-500" /> Receita recebida</span>
                    <span className="mt-0.5 block text-xs text-brand-muted">Últimos 6 meses, pela data em que o dinheiro entrou</span>
                  </span>
                  <span className="rounded-full border border-brand-border bg-brand-surface-2 px-3 py-1 text-[11px] font-semibold text-brand-muted">
                    Contratado: {money(data.contracted, 0)}/mês
                  </span>
                </span>
                <span className="flex h-52 items-end gap-3 [perspective:700px]">
                  {serie.length === 0 && !loading && (
                    <span className="m-auto text-sm text-brand-muted">Sem dados de caixa.</span>
                  )}
                  {serie.map((s, i) => {
                    const h = Math.max(6, Math.round((180 * Number(s.entradas || 0)) / maxSerie));
                    const current = s.mes === month;
                    return (
                      <span key={s.mes} className="group/bar flex flex-1 flex-col items-center gap-2">
                        <span className="text-[10px] font-bold text-brand-muted opacity-0 transition-opacity group-hover/bar:opacity-100">
                          {money(Number(s.entradas), 0)}
                        </span>
                        <span
                          className={`relative w-full max-w-14 origin-bottom rounded-t-xl transition-all duration-700 ease-out [transform:rotateX(14deg)] group-hover/bar:[transform:rotateX(0deg)_translateY(-4px)] ${current ? 'bg-gradient-to-t from-blue-600 to-violet-400 shadow-[0_18px_30px_-12px_rgba(99,102,241,0.8)]' : 'bg-gradient-to-t from-emerald-600 to-emerald-300 shadow-[0_14px_24px_-14px_rgba(16,185,129,0.8)]'}`}
                          style={{ height: loading ? 6 : h, transitionDelay: `${i * 60}ms` }}
                          title={money(Number(s.entradas))}
                        >
                          <span aria-hidden className="absolute inset-x-0 top-0 h-2 rounded-t-xl bg-white/40" />
                        </span>
                        <span className={`text-[11px] font-bold capitalize ${current ? 'text-brand-accent' : 'text-brand-muted'}`}>{monthShort(s.mes)}</span>
                      </span>
                    );
                  })}
                </span>
              </span>
            </TiltCard>

            {/* Resultado do mês */}
            <TiltCard>
              <span className="flex h-full flex-col p-6 md:p-7">
                <span className="text-sm font-bold text-brand-text">Resultado previsto do mês</span>
                <span className="mt-0.5 text-xs text-brand-muted">Recebido + a receber − folha − outras saídas</span>
                <span className={`mt-5 text-4xl font-extrabold tracking-tight tabular-nums ${forecast === null ? 'text-brand-muted' : forecast >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                  {loading ? '…' : money(forecast, 0)}
                </span>
                <span className="mt-6 space-y-2.5 text-sm">
                  <Line label="Recebido" value={money(cash ? Number(cash.entradas) : null)} dot="bg-emerald-500" />
                  <Line label="A receber" value={money(cash ? Number(cash.a_receber) : null)} dot="bg-sky-500" />
                  <Line label="Folha (competência)" value={money(data.payroll)} dot="bg-violet-500" negative />
                  <Line label="Comissões, indicações e despesas" value={money(cash ? otherOut : null)} dot="bg-rose-500" negative />
                </span>
                <button
                  onClick={() => onNavigate?.('dre')}
                  className="mt-auto flex items-center gap-1 pt-6 text-xs font-semibold text-brand-accent hover:text-brand-accent-hover"
                >
                  Ver DRE completo <ChevronRight size={14} />
                </button>
              </span>
            </TiltCard>
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            {/* Recebimentos recentes */}
            <TiltCard className="lg:col-span-2">
              <span className="block">
                <span className="flex items-center justify-between gap-4 p-6 pb-3 md:px-7">
                  <span className="text-sm font-bold text-brand-text">Recebimentos recentes</span>
                  <button onClick={() => onNavigate?.('student-payments')} className="text-xs font-semibold text-brand-accent hover:text-brand-accent-hover">
                    Ver todos
                  </button>
                </span>
                <span className="block divide-y divide-brand-border/60 px-3 pb-3 md:px-4">
                  {data.recent.length === 0 && (
                    <span className="block px-3 py-8 text-center text-sm text-brand-muted">
                      {loading ? 'Carregando…' : 'Nenhum recebimento recente.'}
                    </span>
                  )}
                  {data.recent.map((pay) => {
                    const settled = isSettledStudentPayment(pay.status);
                    const awaiting = isStudentPaymentAwaitingCredit(pay.status);
                    const name = pay.profiles?.full_name || 'Sem aluno vinculado';
                    return (
                      <span key={pay.id} className="flex items-center gap-3 rounded-2xl px-3 py-3 transition-colors hover:bg-brand-surface-2">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-violet-500 text-xs font-bold text-white shadow-md">
                          {name.trim().charAt(0).toUpperCase()}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold text-brand-text">{name}</span>
                          <span className="block text-xs text-brand-muted">{formatLocalDateBr(pay.payment_date, '-')}</span>
                        </span>
                        <span className={`hidden rounded-full border px-2.5 py-0.5 text-[10px] font-bold sm:inline ${settled ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-600' : awaiting ? 'border-sky-400/30 bg-sky-400/10 text-sky-600' : 'border-amber-400/30 bg-amber-400/10 text-amber-600'}`}>
                          {settled ? 'PAGO' : awaiting ? 'AGUARDANDO CRÉDITO' : pay.status}
                        </span>
                        <span className="text-sm font-bold tabular-nums text-brand-text">{money(Number(pay.value))}</span>
                      </span>
                    );
                  })}
                </span>
              </span>
            </TiltCard>

            <div className="space-y-6">
              {userRole === 'TEACHER' && <AutomacaoSmart />}

              {/* Presença em anel */}
              <TiltCard>
                <span className="flex items-center gap-5 p-6">
                  <PresenceRing value={data.presence} loading={loading} />
                  <span>
                    <span className="flex items-center gap-2 text-sm font-bold text-brand-text"><CalendarCheck size={16} className="text-brand-accent" /> Presença</span>
                    <span className="mt-1 block text-xs text-brand-muted">Aulas dadas sobre as lançadas no mês</span>
                  </span>
                </span>
              </TiltCard>

              {/* Inadimplência por idade */}
              <TiltCard onClick={() => onNavigate?.('cashflow')}>
                <span className="block p-6">
                  <span className="flex items-center gap-2 text-sm font-bold text-brand-text"><Users size={16} className="text-rose-500" /> Vencidas por idade</span>
                  <span className="mt-4 block space-y-3">
                    {([
                      ['1 a 30 dias', cash?.inadimplencia.d1_30, 'from-amber-300 to-amber-500'],
                      ['31 a 60 dias', cash?.inadimplencia.d31_60, 'from-orange-400 to-orange-600'],
                      ['Mais de 60 dias', cash?.inadimplencia.d60plus, 'from-rose-500 to-red-600'],
                    ] as const).map(([label, value, grad]) => {
                      const total = Number(cash?.inadimplencia.total || 0);
                      const pct = total > 0 ? (Number(value || 0) / total) * 100 : 0;
                      return (
                        <span key={label} className="block">
                          <span className="flex justify-between text-xs">
                            <span className="text-brand-muted">{label}</span>
                            <span className="font-semibold text-brand-text">{money(value === undefined ? null : Number(value), 0)}</span>
                          </span>
                          <span className="mt-1.5 block h-2 overflow-hidden rounded-full bg-brand-surface-2">
                            <span className={`block h-full rounded-full bg-gradient-to-r ${grad} transition-all duration-700`} style={{ width: `${pct}%` }} />
                          </span>
                        </span>
                      );
                    })}
                  </span>
                </span>
              </TiltCard>
            </div>
          </div>

          <p className="flex items-center gap-1.5 px-1 text-[11px] text-brand-muted">
            <ArrowUpCircle size={12} /> Caixa, a receber e inadimplência saem do Fluxo de Caixa; a folha, do Repasse a Profs. Os números são os mesmos das telas de origem.
          </p>
        </>
      )}

      {activeTab === 'training' && <TeacherTrainingAdmin tenantId={tenantId || ''} />}
      {activeTab === 'ai_team' && <AiTeamPanel tenantId={tenantId} />}
      {activeTab === 'registration' && <RegistrationLinkGenerator tenantId={tenantId} teachers={teachers} />}
      {activeTab === 'recruiting' && (
        <div className="mx-auto max-w-md animate-in zoom-in-95 duration-300">
          <TeacherInviteGenerator tenantId={tenantId || ''} />
        </div>
      )}

      {showTrialScheduler && (
        <ManualTrialScheduler
          tenantId={tenantId || ''}
          teachers={teachers}
          onClose={() => setShowTrialScheduler(false)}
          onSuccess={fetchAnalytics}
        />
      )}
    </div>
  );
};

const Line: React.FC<{ label: string; value: string; dot: string; negative?: boolean }> = ({ label, value, dot, negative }) => (
  <span className="flex items-center justify-between gap-3">
    <span className="flex items-center gap-2 text-brand-muted"><span className={`h-2 w-2 rounded-full ${dot}`} />{label}</span>
    <span className={`shrink-0 whitespace-nowrap font-semibold tabular-nums ${negative ? 'text-rose-500' : 'text-brand-text'}`}>{negative && value !== '—' ? `− ${value}` : value}</span>
  </span>
);

const PresenceRing: React.FC<{ value: number | null; loading: boolean }> = ({ value, loading }) => {
  const r = 34;
  const c = 2 * Math.PI * r;
  const pct = value === null ? 0 : Math.max(0, Math.min(100, value));
  return (
    <span className="relative flex h-24 w-24 shrink-0 items-center justify-center drop-shadow-[0_12px_18px_rgba(37,99,235,0.35)]">
      <svg viewBox="0 0 80 80" className="h-24 w-24 -rotate-90">
        <defs>
          <linearGradient id="presence-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#38bdf8" />
            <stop offset="100%" stopColor="#7c3aed" />
          </linearGradient>
        </defs>
        <circle cx="40" cy="40" r={r} fill="none" stroke="var(--brand-surface-2)" strokeWidth="9" />
        <circle
          cx="40" cy="40" r={r} fill="none" stroke="url(#presence-grad)" strokeWidth="9" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={loading ? c : c - (pct / 100) * c}
          style={{ transition: 'stroke-dashoffset 900ms ease-out' }}
        />
      </svg>
      <span className="absolute text-lg font-extrabold text-brand-text tabular-nums">
        {loading || value === null ? '—' : `${value.toFixed(0)}%`}
      </span>
    </span>
  );
};

export default SchoolAdminDashboard;
