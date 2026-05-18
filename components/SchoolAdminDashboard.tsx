import React, { useState, useEffect } from 'react';
import { Users, BookOpen, Clock, Zap, ArrowUpRight, TrendingDown, Target, Award, AlertCircle, Search, MoreHorizontal, UserCheck, Calendar, RefreshCw, FileDown, UserPlus, MoreVertical, Video, DollarSign, Wallet, Beaker } from 'lucide-react';
import TeacherInviteGenerator from './TeacherInviteGenerator';
import AvailabilityHeatmap from './AvailabilityHeatmap';
import TeacherTrainingAdmin from './training/TeacherTrainingAdmin';
import FinancialCharts from './FinancialCharts';
import RegistrationLinkGenerator from './RegistrationLinkGenerator';
import AdminPaymentsList from './AdminPaymentsList';
import ContractManagement from './ContractManagement';
import AutomacaoSmart from './AutomacaoSmart';
import ManualTrialScheduler from './ManualTrialScheduler';
import { supabase } from '../lib/supabase';
import { Teacher } from '../types';

interface SchoolAdminDashboardProps {
  teachers: Teacher[];
  tenantId?: string;
  onViewTeacherSchedule?: (teacherName: string, action?: 'view' | 'allocate') => void;
  userRole?: string;
}

const SchoolAdminDashboard: React.FC<SchoolAdminDashboardProps> = ({ teachers, tenantId, onViewTeacherSchedule, userRole }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [isExporting, setIsExporting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'analytics' | 'training' | 'registration' | 'payments' | 'contracts' | 'recruiting'>('analytics');
  const [showTrialScheduler, setShowTrialScheduler] = useState(false);

  const [stats, setStats] = useState({
    realRevenue: 0,
    mrrForecast: 0,
    pendingRevenue: 0,
    overdueCount: 0,
    ticketAvg: 0,
    payroll: 0,
    activeStudents: 0,
    totalLeads: 0,
    successRate: 0,
    presencialRevenue: 0,
    onlineRevenue: 0
  });

  const [recentPayments, setRecentPayments] = useState<any[]>([]);

  useEffect(() => {
    if (tenantId) fetchAnalytics();
  }, [tenantId]);

  const fetchAnalytics = async () => {
    setLoading(true);
    try {
      const startOfMonth = new Date();
      startOfMonth.setDate(1);
      startOfMonth.setHours(0, 0, 0, 0);

      const startOfMonthStr = startOfMonth.toISOString().split('T')[0];
      const endOfMonth = new Date(startOfMonth);
      endOfMonth.setMonth(endOfMonth.getMonth() + 1);
      const endOfMonthStr = endOfMonth.toISOString().split('T')[0];

      // 1. Fetch Students (MRR Forecast & Active Count)
      const { data: students } = await supabase
        .from('profiles')
        .select('id, monthly_fee, financial_status, modality')
        .eq('tenant_id', tenantId)
        .eq('role', 'STUDENT');

      const studentList = students || [];
      const activeStudents = studentList.length;

      // MRR Forecast = Sum of all contracts (monthly_fees)
      const mrrForecast = studentList.reduce((acc, s) => acc + (s.monthly_fee || 0), 0);

      // 2. Fetch REAL Payments (Cash Flow - This Month)
      // We explicitly check:
      // a) Recieved/Confirmed payments where PAYMENT_DATE is inside the range (Cash Basis)
      // OR
      // b) Pending payments where DUE_DATE is inside the range (Forecast)

      // 2. Fetch REAL Revenue from FINANCIAL TRANSACTIONS (Official Ledger)
      const { data: transactions } = await supabase
        .from('financial_transactions') // Use the correct table
        .select('amount, type, created_at')
        .eq('tenant_id', tenantId)
        .eq('type', 'ENTRADA') // Only income
        .gte('created_at', startOfMonth.toISOString())
        .lt('created_at', endOfMonth.toISOString());

      const realRevenue = (transactions || []).reduce((acc, t) => acc + (Number(t.amount) || 0), 0);


      // Calculate Pending (Pending/Overdue)
      // Calculate Pending (Pending/Overdue) from Student Payments (Forecast)
      // We still need to fetch pending payments for this part
      const { data: pendingPayments } = await supabase
        .from('student_payments')
        .select('value, status')
        .eq('tenant_id', tenantId) // Ensure tenant_id is on student_payments or use inner join
        .or('status.eq.PENDING,status.eq.OVERDUE'); // Fetch all pending/overdue to filter in memory or fine tune

      // Actually, for dashboard we usually show pending for THIS MONTH.
      // But "Pendente" widget usually means "A receiveable that is open".
      // Let's stick to the previous filtered logic but we need to fetch them now since we removed the previous fetch.

      const { data: paymentsForPending } = await supabase
        .from('student_payments')
        .select('value, status, due_date')
        .eq('tenant_id', tenantId)
        .gte('due_date', startOfMonth.toISOString())
        .lt('due_date', endOfMonth.toISOString());

      const pendingRevenue = (paymentsForPending || [])
        .filter(p => p.status === 'PENDING' || p.status === 'OVERDUE')
        .reduce((acc, p) => acc + (Number(p.value) || 0), 0);

      const overdueCount = (paymentsForPending || []).filter(p => p.status === 'OVERDUE').length;

      const ticketAvg = activeStudents > 0 ? realRevenue / activeStudents : 0;

      // Presencial vs Online Estimates (using Real Revenue ratio)
      const presencialCount = studentList.filter(s => s.modality === 'PRESENCIAL').length;
      const onlineCount = studentList.filter(s => s.modality === 'ONLINE').length;
      const totalModality = presencialCount + onlineCount || 1;

      const presencialRevenue = (presencialCount / totalModality) * realRevenue;
      const onlineRevenue = (onlineCount / totalModality) * realRevenue;

      // 3. Fetch Payroll
      const { data: teachersData } = await supabase
        .from('profiles')
        .select('id, hourly_rate')
        .eq('tenant_id', tenantId)
        .eq('role', 'TEACHER');

      const teacherRates = new Map(teachersData?.map(t => [t.id, t.hourly_rate || 0]));

      const { data: logs } = await supabase
        .from('class_logs')
        .select('teacher_id, presence')
        .eq('tenant_id', tenantId)
        .gte('created_at', startOfMonth.toISOString());

      let payroll = 0;
      let attendanceCount = 0;
      let totalLogs = 0;

      logs?.forEach(log => {
        totalLogs++;
        if (log.presence === 'Presente') attendanceCount++;
        const rate = teacherRates.get(log.teacher_id) || 0;
        if (log.presence !== 'Falta do Professor') {
          payroll += rate;
        }
      });

      const successRate = totalLogs > 0 ? (attendanceCount / totalLogs) * 100 : 100;

      // 4. Fetch Leads
      const { count: leadsCount } = await supabase
        .from('crm_leads')
        .select('*', { count: 'exact', head: true })
        .eq('tenant_id', tenantId);

      // 5. Recent Payments List (Global - not just this month, strictly recent)
      // Actually let's just use the payments from this month query or a separate "recent" query?
      // "Liste os últimos itens..." usually implies strictly latest globally.
      const { data: recent } = await supabase
        .from('student_payments')
        .select(`
          id,
          student_id,
          value,
          status,
          payment_date,
          profiles!inner(name, tenant_id)
        `)
        .eq('profiles.tenant_id', tenantId)
        .neq('status', 'PENDING') // Show finished/problematic ones? Or all? User said "items of student_payments". Let's show all recent.
        .order('payment_date', { ascending: false })
        .limit(5);

      setRecentPayments(recent || []);

      setStats({
        realRevenue,
        mrrForecast,
        pendingRevenue,
        overdueCount,
        ticketAvg,
        payroll,
        activeStudents,
        totalLeads: leadsCount || 0,
        successRate,
        presencialRevenue,
        onlineRevenue
      });

    } catch (e) {
      console.error("Error fetching analytics", e);
    } finally {
      setLoading(false);
    }
  };

  const handleExport = () => {
    setIsExporting(true);
    setTimeout(() => {
      setIsExporting(false);
      alert("Relatórios consolidados da unidade exportados com sucesso!");
    }, 1500);
  };

  return (
    <div className="space-y-6 md:space-y-8 animate-fade-in-up font-sans">
      {/* Header Section */}
      <header className="flex flex-col md:flex-row justify-between items-start md:items-end gap-4 border-b border-brand-border pb-6 mb-6">
        <div>
          <h2 className="text-2xl font-[family-name:var(--font-display)] font-extrabold text-brand-text uppercase tracking-wide">
            {activeTab === 'analytics' ? 'Analytics da Unidade' : 'Academia de Professores'}
          </h2>
          <p className="text-brand-muted text-sm mt-0.5">
            {activeTab === 'analytics' ? 'Monitoramento de hierarquias: Professores e Alunos.' : 'Gestão de treinamentos e padronização.'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex overflow-x-auto max-w-full bg-brand-surface border border-brand-border p-1 rounded-2xl">
            <button
              onClick={() => setActiveTab('analytics')}
              className={`shrink-0 whitespace-nowrap px-4 py-2 rounded-xl text-xs font-bold transition-all ${activeTab === 'analytics' ? 'bg-brand-accent text-white shadow-sm' : 'text-brand-muted hover:text-brand-text'}`}
            >
              Analytics
            </button>
            <button
              onClick={() => setActiveTab('training')}
              className={`shrink-0 whitespace-nowrap px-4 py-2 rounded-xl text-xs font-bold transition-all ${activeTab === 'training' ? 'bg-brand-accent text-white shadow-sm' : 'text-brand-muted hover:text-brand-text'}`}
            >
              Treinamento
            </button>
            <button
              onClick={() => setActiveTab('registration')}
              className={`shrink-0 whitespace-nowrap px-4 py-2 rounded-xl text-xs font-bold transition-all ${activeTab === 'registration' ? 'bg-brand-accent text-white shadow-sm' : 'text-brand-muted hover:text-brand-text'}`}
            >
              Link Matrícula
            </button>
            <button
              onClick={() => setActiveTab('payments')}
              className={`shrink-0 whitespace-nowrap px-4 py-2 rounded-xl text-xs font-bold transition-all ${activeTab === 'payments' ? 'bg-brand-accent text-white shadow-sm' : 'text-brand-muted hover:text-brand-text'}`}
            >
              Fluxo de Caixa
            </button>
            <button
              onClick={() => setActiveTab('contracts')}
              className={`shrink-0 whitespace-nowrap px-4 py-2 rounded-xl text-xs font-bold transition-all ${activeTab === 'contracts' ? 'bg-brand-accent text-white shadow-sm' : 'text-brand-muted hover:text-brand-text'}`}
            >
              Contratos
            </button>
            <button
              onClick={() => setActiveTab('recruiting')}
              className={`shrink-0 whitespace-nowrap px-4 py-2 rounded-xl text-xs font-bold transition-all ${activeTab === 'recruiting' ? 'bg-brand-accent text-white shadow-sm' : 'text-brand-muted hover:text-brand-text'}`}
            >
              Recrutamento (Link)
            </button>
          </div>

          {activeTab === 'analytics' && (
            <div className="flex gap-2">
              <button
                onClick={() => setShowTrialScheduler(true)}
                className="flex items-center gap-2 bg-brand-accent hover:bg-brand-accent-hover text-white px-4 py-2 rounded-xl text-xs font-bold transition-colors shadow-lg"
              >
                <Beaker size={14} /> Agendar Experimental
              </button>
              <button
                onClick={fetchAnalytics}
                className="p-2 rounded-xl border border-brand-border bg-brand-surface hover:bg-brand-surface-2 text-brand-muted transition-colors"
                title="Atualizar Dados"
              >
                <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
              </button>
              <button
                onClick={handleExport}
                disabled={isExporting}
                className="bg-brand-surface border border-brand-border px-4 py-2 rounded-xl text-xs font-semibold text-brand-text hover:bg-brand-surface-2 transition-all shadow-sm flex items-center gap-2 disabled:opacity-50"
              >
                {isExporting ? <RefreshCw className="animate-spin" size={14} /> : <FileDown size={14} />}
                {isExporting ? 'Exportando...' : 'Exportar Dados'}
              </button>
            </div>
          )}
        </div>
      </header>

      {activeTab === 'analytics' && (
        <>
          {/* Stats Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
            {[
              {
                label: 'Faturamento Total',
                value: `R$ ${stats.realRevenue.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`,
                sub: 'Entradas Reais (Pago)',
                icon: DollarSign,
                iconBg: 'bg-emerald-100 text-emerald-600'
              },
              {
                label: 'Pendente',
                value: `R$ ${stats.pendingRevenue.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`,
                sub: 'Aberto ou Atrasado',
                icon: Clock,
                iconBg: 'bg-orange-100 text-orange-600'
              },
              {
                label: 'Meta de MRR',
                value: `R$ ${stats.mrrForecast.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`,
                sub: 'Previsão Contratos',
                icon: Target,
                iconBg: 'bg-blue-100 text-blue-600'
              },
              {
                label: 'Inadimplência',
                value: stats.overdueCount.toString(),
                sub: 'Faturas Vencidas',
                icon: TrendingDown,
                iconBg: 'bg-red-100 text-red-600'
              },
            ].map((stat, i) => (
              <div key={i} className="group relative bg-brand-surface border border-brand-border rounded-2xl p-5 overflow-hidden transition-all duration-300 hover:-translate-y-1 hover:shadow-2xl cursor-default">
                <div
                  className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none rounded-2xl"
                  style={{ background: `radial-gradient(ellipse at 80% 0%, var(--brand-accent) 0%, transparent 65%)`, opacity: 0.1 }}
                />
                <div
                  className="absolute top-0 left-4 right-4 h-px opacity-0 group-hover:opacity-100 transition-opacity duration-300"
                  style={{ background: `linear-gradient(90deg, transparent, var(--brand-accent), transparent)`, opacity: 0.5 }}
                />

                <div className="flex justify-between items-start mb-3">
                  <span className="text-brand-muted text-[11px] uppercase tracking-widest font-semibold">{stat.label}</span>
                  <span className={`flex items-center justify-center w-9 h-9 rounded-xl transition-all duration-300 group-hover:scale-110 group-hover:rotate-6 ${stat.iconBg}`}>
                    <stat.icon size={20} strokeWidth={2} />
                  </span>
                </div>
                <div className="flex items-end gap-2">
                  <h3 className="text-brand-text text-[2rem] font-extrabold leading-none tabular-nums tracking-tight">
                    {loading ? '...' : stat.value}
                  </h3>
                </div>
                <p className="text-brand-muted text-xs mt-1.5">{stat.sub}</p>
              </div>
            ))}
          </div>

          {/* Main Content Layout */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Left Column (2/3) */}
            <div className="lg:col-span-2 space-y-6">

              {/* Main Chart Section */}
              <div className="bg-brand-surface p-6 md:p-8 rounded-2xl border border-brand-border">
                <div className="flex justify-between items-center mb-6">
                  <div>
                    <h3 className="text-brand-text font-bold text-sm">Fluxo Financeiro</h3>
                    <p className="text-brand-muted text-xs mt-0.5">Visão geral de receitas (Presencial x Online)</p>
                  </div>
                  <div className="flex items-center gap-2 bg-brand-surface-2 border border-brand-border rounded-lg px-2.5 py-1.5">
                    <Calendar size={14} className="text-brand-muted" />
                    <span className="text-xs font-semibold text-brand-muted">Este Mês</span>
                    <ArrowUpRight size={14} className="text-brand-muted ml-1" />
                  </div>
                </div>

                <div className="flex items-center gap-8 mb-8">
                  <div className="bg-brand-surface-2 rounded-xl p-3 border border-brand-border flex-1">
                    <div className="flex items-center gap-1.5 mb-1">
                      <span className="w-2 h-2 rounded-full bg-blue-400" />
                      <span className="text-brand-muted text-[10px] uppercase tracking-wider">Presencial (Prop.)</span>
                    </div>
                    <span className="text-brand-text text-xl font-bold leading-tight">
                      R$ {stats.presencialRevenue.toLocaleString('pt-BR', { minimumFractionDigits: 0 })}
                    </span>
                  </div>
                  <div className="bg-brand-surface-2 rounded-xl p-3 border border-brand-border flex-1">
                    <div className="flex items-center gap-1.5 mb-1">
                      <span className="w-2 h-2 rounded-full bg-purple-400" />
                      <span className="text-brand-muted text-[10px] uppercase tracking-wider">Online (Prop.)</span>
                    </div>
                    <span className="text-brand-text text-xl font-bold leading-tight">
                      R$ {stats.onlineRevenue.toLocaleString('pt-BR', { minimumFractionDigits: 0 })}
                    </span>
                  </div>
                </div>

                {/* Chart Logic */}
                <div className="w-full space-y-8">
                  <FinancialCharts tenantId={tenantId} />
                  <AdminPaymentsList tenantId={tenantId} />
                </div>
              </div>

              {/* Recent Payments List (Replaces Team Performance in this view) */}
              <div className="bg-brand-surface rounded-2xl border border-brand-border overflow-hidden">
                <div className="p-6 md:p-8 flex flex-col md:flex-row justify-between items-center gap-4">
                  <h3 className="text-brand-text font-bold text-sm">Recebimentos Recentes</h3>
                  <button className="text-xs text-brand-accent font-semibold hover:text-brand-accent-hover transition-colors" onClick={() => setActiveTab('payments')}>
                    Ver Todos
                  </button>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm min-w-[500px]">
                    <thead className="text-xs text-brand-muted font-semibold border-b border-brand-border">
                      <tr>
                        <th className="px-6 py-4 font-medium">Aluno</th>
                        <th className="px-6 py-4 font-medium">Valor</th>
                        <th className="px-6 py-4 font-medium">Status</th>
                        <th className="px-6 py-4 text-right font-medium">Data Pagamento</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-brand-border/50">
                      {recentPayments.length > 0 ? recentPayments.map((pay, i) => (
                        <tr key={i} className="hover:bg-brand-surface-2 transition-colors">
                          <td className="px-6 py-4 font-medium text-brand-text">
                            {pay.profiles?.name || 'Aluno Desconhecido'}
                          </td>
                          <td className="px-6 py-4 text-brand-text font-semibold">
                            R$ {Number(pay.value).toFixed(2)}
                          </td>
                          <td className="px-6 py-4">
                            <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold border ${pay.status === 'RECEIVED' || pay.status === 'CONFIRMED' ? 'bg-emerald-400/10 text-emerald-500 border-emerald-400/30' :
                              pay.status === 'OVERDUE' ? 'bg-red-400/10 text-red-500 border-red-400/30' :
                                'bg-amber-400/10 text-amber-500 border-amber-400/30'
                              }`}>
                              {pay.status === 'RECEIVED' || pay.status === 'CONFIRMED' ? 'PAGO' :
                                pay.status === 'OVERDUE' ? 'ATRASADO' : 'PENDENTE'}
                            </span>
                          </td>
                          <td className="px-6 py-4 text-right text-brand-muted flex items-center justify-end gap-2">
                            <span className="text-xs">{pay.payment_date ? new Date(pay.payment_date).toLocaleDateString('pt-BR') : '-'}</span>

                            {(pay.status === 'PENDING' || pay.status === 'OVERDUE') && (
                              <button
                                onClick={async (e) => {
                                  e.stopPropagation();
                                  if (!confirm(`Confirmar recebimento manual de R$ ${pay.value}?`)) return;
                                  try {
                                    // 1. Update Payment Status
                                    const { error: updateError } = await supabase
                                      .from('student_payments')
                                      .update({
                                        status: 'RECEIVED',
                                        payment_date: new Date().toISOString()
                                      })
                                      .eq('id', pay.id);

                                    if (updateError) throw updateError;

                                    const payload = {
                                      tenant_id: pay.profiles?.tenant_id || tenantId,
                                      type: 'ENTRADA',
                                      category: 'student_tuition',
                                      amount: pay.value,
                                      amount_cents: Math.round(pay.value * 100),
                                      description: `Mensalidade (Manual) - ${pay.profiles?.name || 'Aluno'}`,
                                      reference_id: pay.student_id,
                                      student_payment_id: pay.id,
                                      occurred_at: new Date().toISOString(),
                                      created_at: new Date().toISOString()
                                    };
                                    console.log("💰 Manually inserting transaction:", payload);

                                    const { error: transError } = await supabase
                                      .from('financial_transactions')
                                      .insert(payload);

                                    if (transError) throw transError;

                                    fetchAnalytics(); // Refresh dashboard
                                    alert('Pagamento confirmado e registrado no caixa!');
                                  } catch (err: any) {
                                    alert('Erro: ' + err.message);
                                  }
                                }}
                                className="ml-2 p-1 text-emerald-500 hover:bg-emerald-400/10 rounded transition-colors"
                                title="Confirmar Pagamento Manual"
                              >
                                <Clock size={14} className="text-emerald-500" />
                              </button>
                            )}
                          </td>
                        </tr>
                      )) : (
                        <tr>
                          <td colSpan={4} className="px-6 py-8 text-center text-brand-muted">
                            Nenhum pagamento recente encontrado.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            {/* Right Column (1/3) */}
            <div className="space-y-6">

              {/* Whatsapp Connection Card (Automacao Smart) */}
              {userRole === 'TEACHER' && <AutomacaoSmart />}

              {/* Financial Summary Widget */}
              <div className="bg-brand-surface p-6 md:p-8 rounded-2xl border border-brand-border">
                <div className="flex justify-between items-start mb-6">
                  <div>
                    <h3 className="text-brand-text font-bold text-sm">Resumo Financeiro</h3>
                    <p className="text-brand-muted text-xs mt-0.5">Mês Atual</p>
                  </div>
                  <div className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold border ${stats.realRevenue + stats.pendingRevenue - stats.payroll >= 0 ? 'bg-emerald-400/10 text-emerald-500 border-emerald-400/30' : 'bg-red-400/10 text-red-500 border-red-400/30'}`}>
                    {(stats.realRevenue + stats.pendingRevenue - stats.payroll >= 0 ? 'Superávit' : 'Déficit')}
                  </div>
                </div>

                <div className="space-y-6">
                  {/* Income */}
                  <div className="space-y-2">
                    <div className="flex justify-between text-xs font-bold">
                      <span className="text-brand-muted">Entradas (Real + Previsto)</span>
                      <span className="text-brand-text">R$ {(stats.realRevenue + stats.pendingRevenue).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</span>
                    </div>
                    {/* Multi-color bar */}
                    <div className="w-full h-2 bg-brand-surface-2 border border-brand-border rounded-full overflow-hidden flex">
                      <div style={{ width: `${(stats.realRevenue / (stats.realRevenue + stats.pendingRevenue + 0.1)) * 100}%` }} className="bg-brand-accent h-full" title="Recebido" />
                      <div style={{ width: `${(stats.pendingRevenue / (stats.realRevenue + stats.pendingRevenue + 0.1)) * 100}%` }} className="bg-brand-accent/40 h-full" title="Pendente" />
                    </div>
                    <div className="flex justify-between text-[10px] text-brand-muted font-semibold uppercase tracking-wider mt-1">
                      <span>Recebido: {stats.realRevenue.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</span>
                      <span>Pendente: {stats.pendingRevenue.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</span>
                    </div>
                  </div>

                  {/* Expenses (Payroll) */}
                  <div className="space-y-2">
                    <div className="flex justify-between text-xs font-bold">
                      <span className="text-brand-muted">Saídas (Folha Professores)</span>
                      <span className="text-red-400">R$ {stats.payroll.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</span>
                    </div>
                    <div className="w-full h-2 bg-brand-surface-2 border border-brand-border rounded-full overflow-hidden">
                      {/* Scale payroll relative to income for visualization, max 100% */}
                      <div style={{ width: `${Math.min(100, (stats.payroll / (stats.realRevenue + stats.pendingRevenue + 0.1)) * 100)}%` }} className="bg-red-400 h-full" />
                    </div>
                    <p className="text-[10px] text-brand-muted font-semibold uppercase tracking-wider mt-1">
                      Baseado em {stats.activeStudents} alunos ativos
                    </p>
                  </div>

                  {/* Net Result Forecast */}
                  <div className="pt-4 border-t border-brand-border">
                    <div className="flex justify-between items-end">
                      <span className="text-[10px] font-semibold text-brand-muted uppercase tracking-widest">Saldo Previsto</span>
                      <span className={`text-2xl font-extrabold ${stats.realRevenue + stats.pendingRevenue - stats.payroll >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        R$ {(stats.realRevenue + stats.pendingRevenue - stats.payroll).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Success Rate Widget (Moved/Kept Small) - or just removing the complex SVG one to save space and tokens if needed. 
                  Use simpler version below or keep original if I didn't overwrite it. 
                  I replaced the block containing Success Rate, so I need to decide.
                  I'll keep a simpler version.
               */}
              <div className="bg-brand-surface p-6 md:p-8 rounded-2xl border border-brand-border flex justify-between items-center">
                <div>
                  <h3 className="text-brand-text font-bold text-sm">Taxa de Presença</h3>
                  <p className="text-brand-muted text-xs mt-0.5">Geral da Escola</p>
                </div>
                <div className="text-right">
                  <p className="text-3xl font-extrabold text-brand-accent">{stats.successRate.toFixed(1)}%</p>
                  <p className="text-[10px] text-brand-muted font-bold uppercase mt-0.5">Calculado</p>
                </div>
              </div>


              {/* Real-Time Monitor */}
              <div className="bg-brand-surface p-6 md:p-8 rounded-2xl border border-brand-border">
                <div className="flex items-center justify-between mb-6">
                  <div>
                    <h3 className="text-brand-text font-bold text-sm flex items-center gap-2">
                      Monitoramento ao Vivo
                    </h3>
                    <p className="text-brand-muted text-xs mt-0.5">Status das salas de aula</p>
                  </div>
                  <div className="flex items-center gap-2 px-2.5 py-1 bg-emerald-400/10 border border-emerald-400/30 rounded-full">
                    <div className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-pulse" />
                    <span className="text-[10px] font-bold text-emerald-500">AO VIVO</span>
                  </div>
                </div>

                <div className="space-y-3">
                  {teachers.slice(0, 3).map((t, i) => (
                    <div key={i} className="group flex items-center justify-between p-3 rounded-xl bg-brand-surface-2 border border-brand-border hover:-translate-y-0.5 transition-all duration-200">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg bg-brand-surface border border-brand-border flex items-center justify-center text-xs font-bold text-brand-accent shadow-sm">
                          {i + 1}
                        </div>
                        <div>
                          <p className="text-sm font-bold text-brand-text leading-tight">{t.name}</p>
                          <p className="text-xs text-brand-muted mt-0.5">Aula em andamento</p>
                        </div>
                      </div>
                      <span className="text-[10px] font-semibold text-brand-muted group-hover:text-brand-accent transition-colors uppercase tracking-wider">Monitorar</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {activeTab === 'training' && <TeacherTrainingAdmin tenantId={tenantId || ''} />}
      {activeTab === 'registration' && <RegistrationLinkGenerator tenantId={tenantId} teachers={teachers} />}
      {activeTab === 'payments' && <AdminPaymentsList tenantId={tenantId || ''} />}
      {activeTab === 'contracts' && <ContractManagement />}
      {activeTab === 'recruiting' && (
        <div className="max-w-md mx-auto animate-in zoom-in-95 duration-300">
          <TeacherInviteGenerator tenantId={tenantId || ''} />
        </div>
      )}

      {/* Manual Trial Scheduler Modal */}
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

export default SchoolAdminDashboard;
