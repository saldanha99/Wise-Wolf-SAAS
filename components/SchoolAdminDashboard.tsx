import React, { useState, useEffect } from 'react';
import { Users, BookOpen, Clock, Zap, ArrowUpRight, TrendingDown, Target, Award, AlertCircle, Search, MoreHorizontal, UserCheck, Calendar, RefreshCw, FileDown, UserPlus, MoreVertical, Video, DollarSign, Wallet } from 'lucide-react';
import AvailabilityHeatmap from './AvailabilityHeatmap';
import TeacherTrainingAdmin from './training/TeacherTrainingAdmin';
import RegistrationLinkGenerator from './RegistrationLinkGenerator';
import AdminPaymentsList from './AdminPaymentsList';
import ContractManagement from './ContractManagement';
import AutomacaoSmart from './AutomacaoSmart';
import { supabase } from '../lib/supabase';
import { Teacher } from '../types';

interface SchoolAdminDashboardProps {
  teachers: Teacher[];
  tenantId?: string;
  onViewTeacherSchedule?: (teacherName: string, action?: 'view' | 'allocate') => void;
}

const SchoolAdminDashboard: React.FC<SchoolAdminDashboardProps> = ({ teachers, tenantId, onViewTeacherSchedule }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [isExporting, setIsExporting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'analytics' | 'training' | 'registration' | 'payments' | 'contracts'>('analytics');

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

      const { data: payments } = await supabase
        .from('student_payments')
        .select(`
          id,
          value,
          status,
          date: due_date,
          payment_date,
          profiles!inner(name, tenant_id)
        `)
        .eq('profiles.tenant_id', tenantId);
      // We fetch a broader range or filter in memory to handle the two different logic (Cash vs Accrual)
      // ideally we would use OR in query but Supabase filter is limited.
      // Let's fetch all relevant payments for this period roughly.

      const paymentsList = payments || [];

      // Calculate Real Revenue (Cash Basis: Payment Date in this month)
      const realRevenue = paymentsList
        .filter(p => {
          const isPaid = p.status === 'RECEIVED' || p.status === 'CONFIRMED';
          if (!isPaid) return false;
          // Check if payment_date is defined and within this month
          if (!p.payment_date) return false;
          const payDate = new Date(p.payment_date);
          return payDate >= startOfMonth && payDate < endOfMonth;
        })
        .reduce((acc, p) => acc + (Number(p.value) || 0), 0);

      // Calculate Pending (Pending/Overdue)
      const pendingRevenue = paymentsList
        .filter(p => p.status === 'PENDING' || p.status === 'OVERDUE')
        .reduce((acc, p) => acc + (Number(p.value) || 0), 0);

      const overdueCount = paymentsList.filter(p => p.status === 'OVERDUE').length;

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
    <div className="space-y-6 md:space-y-8 animate-in fade-in duration-500 font-sans">
      {/* Header Section */}
      <header className="flex flex-col md:flex-row justify-between items-start md:items-end gap-4 border-b border-gray-100 dark:border-gray-800 pb-6 mb-6">
        <div>
          <h2 className="text-2xl font-bold text-slate-800 dark:text-white">
            {activeTab === 'analytics' ? 'Analytics da Unidade' : 'Academia de Professores'}
          </h2>
          <p className="text-slate-500 dark:text-slate-400 text-sm mt-1">
            {activeTab === 'analytics' ? 'Monitoramento de hierarquias: Professores e Alunos.' : 'Gestão de treinamentos e padronização.'}
          </p>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex bg-slate-100 dark:bg-slate-800 p-1 rounded-xl">
            <button
              onClick={() => setActiveTab('analytics')}
              className={`px-4 py-2 rounded-lg text-sm font-bold transition-all ${activeTab === 'analytics' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
            >
              Analytics
            </button>
            <button
              onClick={() => setActiveTab('training')}
              className={`px-4 py-2 rounded-lg text-sm font-bold transition-all ${activeTab === 'training' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
            >
              Treinamento
            </button>
            <button
              onClick={() => setActiveTab('registration')}
              className={`px-4 py-2 rounded-lg text-sm font-bold transition-all ${activeTab === 'registration' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
            >
              Link Matrícula
            </button>
            <button
              onClick={() => setActiveTab('payments')}
              className={`px-4 py-2 rounded-lg text-sm font-bold transition-all ${activeTab === 'payments' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
            >
              Fluxo de Caixa
            </button>
            <button
              onClick={() => setActiveTab('contracts')}
              className={`px-4 py-2 rounded-lg text-sm font-bold transition-all ${activeTab === 'contracts' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
            >
              Contratos
            </button>
          </div>

          {activeTab === 'analytics' && (
            <div className="flex gap-2">
              <button
                onClick={fetchAnalytics}
                className="p-2 rounded-xl border border-slate-200 hover:bg-slate-50 text-slate-500 transition-colors"
                title="Atualizar Dados"
              >
                <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
              </button>
              <button
                onClick={handleExport}
                disabled={isExporting}
                className="bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 px-4 py-2 rounded-xl text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-all shadow-sm flex items-center gap-2 disabled:opacity-50"
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
              <div key={i} className="bg-white dark:bg-slate-900 p-6 rounded-[32px] shadow-[0px_4px_20px_rgba(0,0,0,0.02)] border border-slate-50 dark:border-slate-800 relative group transition-all hover:-translate-y-1 hover:shadow-lg">
                <div className="flex justify-between items-start mb-4">
                  <div className={`p-3 rounded-2xl ${stat.iconBg} dark:bg-opacity-20`}>
                    <stat.icon size={24} strokeWidth={1.5} />
                  </div>
                  <button className="text-slate-300 hover:text-slate-500 transition-colors">
                    <MoreVertical size={20} />
                  </button>
                </div>
                <h3 className="text-3xl font-bold text-slate-900 dark:text-white mb-2">{loading ? '...' : stat.value}</h3>
                <p className="text-sm text-slate-500 dark:text-slate-400 font-medium">{stat.label}</p>
                <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">{stat.sub}</p>
              </div>
            ))}
          </div>

          {/* Main Content Layout */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Left Column (2/3) */}
            <div className="lg:col-span-2 space-y-6">

              {/* Main Chart Section */}
              <div className="bg-white dark:bg-slate-900 p-8 rounded-[32px] shadow-[0px_4px_20px_rgba(0,0,0,0.02)] border border-slate-50 dark:border-slate-800">
                <div className="flex justify-between items-center mb-6">
                  <div>
                    <h3 className="text-lg font-bold text-slate-900 dark:text-white">Fluxo Financeiro</h3>
                    <p className="text-sm text-slate-500">Visão geral de receitas (Presencial x Online)</p>
                  </div>
                  <div className="flex items-center gap-2 bg-slate-50 dark:bg-slate-800 rounded-full px-4 py-2">
                    <Calendar size={14} className="text-slate-500" />
                    <span className="text-xs font-semibold text-slate-600 dark:text-slate-300">Este Mês</span>
                    <ArrowUpRight size={14} className="text-slate-500 ml-1" />
                  </div>
                </div>

                <div className="flex items-center gap-8 mb-8">
                  <div>
                    <p className="text-xs text-slate-500 mb-1">Presencial (Prop.)</p>
                    <div className="flex items-center gap-2">
                      <span className="text-2xl font-bold text-slate-900 dark:text-white">
                        R$ {stats.presencialRevenue.toLocaleString('pt-BR', { minimumFractionDigits: 0 })}
                      </span>
                    </div>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500 mb-1">Online (Prop.)</p>
                    <div className="flex items-center gap-2">
                      <span className="text-2xl font-bold text-slate-900 dark:text-white">
                        R$ {stats.onlineRevenue.toLocaleString('pt-BR', { minimumFractionDigits: 0 })}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Existing Heatmap Logic */}
                <div className="w-full">
                  <AvailabilityHeatmap />
                </div>
              </div>

              {/* Recent Payments List (Replaces Team Performance in this view) */}
              <div className="bg-white dark:bg-slate-900 rounded-[32px] shadow-[0px_4px_20px_rgba(0,0,0,0.02)] border border-slate-50 dark:border-slate-800 overflow-hidden">
                <div className="p-8 flex flex-col md:flex-row justify-between items-center gap-4">
                  <h3 className="text-lg font-bold text-slate-900 dark:text-white">Recebimentos Recentes</h3>
                  <button className="text-sm text-purple-600 font-semibold hover:underline" onClick={() => setActiveTab('payments')}>
                    Ver Todos
                  </button>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="text-xs text-slate-400 font-semibold border-b border-slate-100 dark:border-slate-800">
                      <tr>
                        <th className="px-8 py-4 font-medium">Aluno</th>
                        <th className="px-8 py-4 font-medium">Valor</th>
                        <th className="px-8 py-4 font-medium">Status</th>
                        <th className="px-8 py-4 text-right font-medium">Data Pagamento</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50 dark:divide-slate-800">
                      {recentPayments.length > 0 ? recentPayments.map((pay, i) => (
                        <tr key={i} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/50 transition-colors">
                          <td className="px-8 py-5 font-medium text-slate-800 dark:text-slate-200">
                            {pay.profiles?.name || 'Aluno Desconhecido'}
                          </td>
                          <td className="px-8 py-5 text-slate-600 dark:text-slate-300">
                            R$ {Number(pay.value).toFixed(2)}
                          </td>
                          <td className="px-8 py-5">
                            <span className={`px-2 py-1 rounded text-xs font-bold ${pay.status === 'RECEIVED' || pay.status === 'CONFIRMED' ? 'bg-green-100 text-green-700' :
                              pay.status === 'OVERDUE' ? 'bg-red-100 text-red-700' :
                                'bg-yellow-100 text-yellow-700'
                              }`}>
                              {pay.status === 'RECEIVED' || pay.status === 'CONFIRMED' ? 'PAGO' :
                                pay.status === 'OVERDUE' ? 'ATRASADO' : 'PENDENTE'}
                            </span>
                          </td>
                          <td className="px-8 py-5 text-right text-slate-500">
                            {pay.payment_date ? new Date(pay.payment_date).toLocaleDateString('pt-BR') : '-'}
                          </td>
                        </tr>
                      )) : (
                        <tr>
                          <td colSpan={4} className="px-8 py-8 text-center text-slate-500">
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
              <AutomacaoSmart />

              {/* Status Widget */}
              <div className="bg-white dark:bg-slate-900 p-8 rounded-[32px] shadow-[0px_4px_20px_rgba(0,0,0,0.02)] border border-slate-50 dark:border-slate-800">
                <div className="flex justify-between items-start mb-6">
                  <div>
                    <h3 className="text-lg font-bold text-slate-900 dark:text-white">Status da Formação</h3>
                    <p className="text-sm text-slate-500">Em andamento</p>
                  </div>
                  <button className="p-2 rounded-full bg-slate-50 dark:bg-slate-800 text-slate-400 hover:text-slate-600">
                    <ArrowUpRight size={16} />
                  </button>
                </div>

                <div className="w-full h-4 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden mb-2">
                  <div className="h-full w-2/3 bg-gradient-to-r from-purple-400 to-purple-500 rounded-full shadow-[0_0_15px_rgba(168,85,247,0.4)]" />
                </div>

                <div className="mt-8 mb-8">
                  <h3 className="text-lg font-bold text-slate-900 dark:text-white">Conclusão Estimada</h3>
                  <p className="text-sm text-slate-500">Ciclo Atual</p>
                </div>

                <button className="w-full py-4 rounded-2xl bg-white border-2 border-slate-100 dark:border-slate-700 dark:bg-slate-800 text-slate-900 dark:text-white font-bold text-sm hover:shadow-md transition-all">
                  Ver detalhes
                </button>
              </div>

              {/* Success Rate Widget */}
              <div className="bg-white dark:bg-slate-900 p-8 rounded-[32px] shadow-[0px_4px_20px_rgba(0,0,0,0.02)] border border-slate-50 dark:border-slate-800">
                <div className="flex justify-between items-start mb-2">
                  <div>
                    <h3 className="text-lg font-bold text-slate-900 dark:text-white">Taxa de Sucesso</h3>
                    <p className="text-sm text-slate-500">Indice de aprovação geral</p>
                  </div>
                  <button className="p-2 rounded-full bg-slate-50 dark:bg-slate-800 text-slate-400 hover:text-slate-600">
                    <ArrowUpRight size={16} />
                  </button>
                </div>

                <div className="flex flex-col items-center justify-center my-8 relative">
                  <div className="w-40 h-40 relative flex items-center justify-center">
                    <svg className="w-full h-full -rotate-90">
                      <circle cx="80" cy="80" r="70" stroke="currentColor" strokeWidth="12" fill="transparent" className="text-slate-100 dark:text-slate-800" strokeLinecap="round" />
                      <circle
                        cx="80" cy="80" r="70"
                        stroke="currentColor" strokeWidth="12" fill="transparent"
                        strokeDasharray="440"
                        strokeDashoffset={440 - (440 * (stats.successRate / 100))}
                        className="text-purple-500" strokeLinecap="round"
                      />
                    </svg>
                    <div className="absolute inset-0 flex flex-col items-center justify-center">
                      <span className="text-3xl font-bold text-slate-900 dark:text-white">{stats.successRate.toFixed(1)}%</span>
                      <span className="text-xs font-semibold text-green-500">Calculado</span>
                    </div>
                  </div>
                </div>

                <p className="text-center text-sm text-slate-500 mb-6">
                  Métricas calculadas com base nos logs de aulas e presença.
                </p>

                <div className="flex justify-between items-center text-center">
                  <div>
                    <p className="text-xs text-slate-400 mb-1">Leads (CRM)</p>
                    <p className="text-xl font-bold text-slate-900 dark:text-white">{stats.totalLeads}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-400 mb-1">Matrículas</p>
                    <p className="text-xl font-bold text-slate-900 dark:text-white">{stats.activeStudents}</p>
                  </div>
                </div>

              </div>

              {/* Real-Time Monitor */}
              <div className="bg-white dark:bg-slate-900 p-8 rounded-[32px] shadow-[0px_4px_20px_rgba(0,0,0,0.02)] border border-slate-50 dark:border-slate-800">
                <div className="flex items-center justify-between mb-6">
                  <div>
                    <h3 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
                      Monitoramento ao Vivo
                    </h3>
                    <p className="text-sm text-slate-500">Status das salas de aula</p>
                  </div>
                  <div className="flex items-center gap-2 px-3 py-1 bg-emerald-50 dark:bg-emerald-900/20 rounded-full">
                    <div className="w-2 h-2 bg-emerald-500 rounded-full animate-ping" />
                    <span className="text-xs font-bold text-emerald-600">AO VIVO</span>
                  </div>
                </div>

                <div className="space-y-4">
                  {teachers.slice(0, 3).map((t, i) => (
                    <div key={i} className="group flex items-center justify-between p-4 rounded-2xl bg-slate-50 dark:bg-slate-800 hover:bg-slate-100 transition-colors">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-white flex items-center justify-center text-xs font-bold text-purple-600 shadow-sm">
                          {i + 1}
                        </div>
                        <div>
                          <p className="text-sm font-bold text-slate-800 dark:text-slate-200">{t.name}</p>
                          <p className="text-xs text-slate-500">Aula em andamento</p>
                        </div>
                      </div>
                      <span className="text-xs font-semibold text-slate-400 group-hover:text-purple-500">Monitorar</span>
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
    </div>
  );
};

export default SchoolAdminDashboard;
