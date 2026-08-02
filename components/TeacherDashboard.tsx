
import React, { useEffect, useState } from 'react';
import { Users, Clock, CheckCircle, TrendingUp, Calendar, ArrowRight, BookOpen, Video, Zap, AlertCircle, Lock, MessageCircle, Send, RefreshCw } from 'lucide-react';
import { whatsappService } from '../services/whatsappService';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { supabase } from '../lib/supabase';
import { localMonth } from '../lib/dateUtils';
import { User as UserType } from '../types';
import FinancialClosingModal from './FinancialClosingModal';
import { WolfieAssignButton } from './WolfieAssignButton';
import AutomacaoSmart from './AutomacaoSmart';
import TeacherAffiliateCard from './TeacherAffiliateCard';
import TeacherContractAccept from './TeacherContractAccept';

interface TeacherDashboardProps {
  user: UserType;
  tenantId?: string;
  onNavigate?: (tab: string) => void;
}

const TeacherDashboard: React.FC<TeacherDashboardProps> = ({ user, tenantId, onNavigate }) => {
  const [stats, setStats] = useState({
    activeStudents: 0,
    classesToday: 0,
    monthlyEarnings: 0,
    completionRate: 100
  });
  const [upcomingLessons, setUpcomingLessons] = useState<any[]>([]);
  const [chartData, setChartData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [sentReminders, setSentReminders] = useState<Set<string>>(new Set());
  const [complianceLocked, setComplianceLocked] = useState({ isLocked: false, reason: '' });
  // Configuração de disparo manual: instância do professor + template + nome
  const [teacherWa, setTeacherWa] = useState<{ instance: string | null; template: string | null; name: string; automation: boolean }>({ instance: null, template: null, name: '', automation: false });
  // Estado por aula: 'sending' | 'sent' | 'error'
  const [dispatching, setDispatching] = useState<Record<string, 'sending' | 'sent' | 'error'>>({});
  // Aceite de contrato PJ pendente (contas criadas sem passar pelo onboarding nascem com
  // contract_accepted=false e não tinham caminho de regularização).
  const [contractPending, setContractPending] = useState(false);
  const [showContractModal, setShowContractModal] = useState(false);

  const effectiveTenantId = tenantId || user.tenantId;

  // Template default usado quando o professor não definiu o seu
  const DEFAULT_TEMPLATE = `Oi {student_name}, tudo bem? 👋\n\nLembrando que nossa aula começa em 30 minutos, às *{class_time}*.\n\n{class_link}\n\nTe espero! 🐺`;

  // Renderiza o template substituindo as variáveis {chave}
  const renderTemplate = (tpl: string, vars: Record<string, string>) =>
    tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');

  // Busca instância + template do professor para o disparo manual
  useEffect(() => {
    if (!user?.id) return;
    (async () => {
      const { data } = await supabase
        .from('profiles')
        .select('full_name, whatsapp_instance, lesson_reminder_template, date_automation_enabled')
        .eq('id', user.id)
        .single();
      if (data) {
        setTeacherWa({
          instance: data.whatsapp_instance || null,
          template: data.lesson_reminder_template || null,
          name: data.full_name || user.name || '',
          automation: !!data.date_automation_enabled,
        });
      }
    })();
  }, [user?.id]);

  // Verifica se o professor ainda não aceitou o contrato PJ (regularização).
  useEffect(() => {
    if (!user?.id) return;
    (async () => {
      const { data } = await supabase
        .from('profiles')
        .select('contract_accepted')
        .eq('id', user.id)
        .single();
      setContractPending(data ? data.contract_accepted !== true : false);
    })();
  }, [user?.id]);

  // Dispara a mensagem personalizada pela instância do professor (Evolution API)
  const handleDispatch = async (aula: any, key: string) => {
    if (!aula.phone) {
      alert('Este aluno não tem telefone cadastrado.');
      return;
    }
    if (!teacherWa.instance) {
      alert('Conecte seu WhatsApp (QR Code) na seção "Conexão Pessoal" para disparar pela sua instância.');
      return;
    }
    setDispatching(prev => ({ ...prev, [key]: 'sending' }));
    try {
      const classLink = aula.meet || user.meeting_link || '';
      const tpl = (teacherWa.template && teacherWa.template.trim()) ? teacherWa.template : DEFAULT_TEMPLATE;
      const message = renderTemplate(tpl, {
        student_name: (aula.name || '').split(' ')[0],
        class_time: aula.time || '',
        teacher_name: teacherWa.name,
        class_link: classLink,
        tenant_name: '',
      });

      const { data, error } = await supabase.functions.invoke('send-class-notification', {
        body: {
          type: 'CUSTOM',
          student_name: aula.name,
          student_phone: aula.phone,
          teacher_name: teacherWa.name,
          date: 'hoje',
          time: aula.time || '',
          instanceName: teacherWa.instance,
          meeting_link: classLink,
          message,
        },
      });

      if (error || (data && data.error)) throw new Error(error?.message || data?.error || 'Falha no envio');
      setDispatching(prev => ({ ...prev, [key]: 'sent' }));
    } catch (err: any) {
      console.error('Erro ao disparar:', err);
      setDispatching(prev => ({ ...prev, [key]: 'error' }));
      alert(`Erro ao disparar: ${err.message || 'tente novamente'}`);
    }
  };

  // Client-side watchdog removed in favor of Server-side Automation (Cron 6am-6:30am)
  // See supabase/functions/prepare-daily-reminders

  useEffect(() => {
    if (user && (tenantId || user.tenantId)) {
      fetchDashboardData();
    }
  }, [user, tenantId]);

  const fetchDashboardData = async () => {
    setLoading(true);
    try {
      // 1. Check Compliance Lock First
      const { data: pendingClosings } = await supabase
        .from('teacher_closings')
        .select('*')
        .eq('teacher_id', user.id)
        .in('status', ['PAID_WAITING_NF', 'REJECTED']);

      let isLocked = false;
      let lockReason = '';

      if (pendingClosings && pendingClosings.length > 0) {
        const fiveDaysAgo = new Date();
        fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);

        const overdueClosing = pendingClosings.find(c => new Date(c.updated_at) < fiveDaysAgo);

        if (overdueClosing) {
          isLocked = true;
          lockReason = overdueClosing.status === 'REJECTED'
            ? 'Você possui uma nota fiscal rejeitada há mais de 5 dias. Regularize para visualizar seus ganhos.'
            : 'Você possui um pagamento recebido sem nota fiscal emitida há mais de 5 dias. Envie a NF para liberar o acesso.';
        }
      }
      setComplianceLocked({ isLocked, reason: lockReason });


      // 2. Fetch Dashboard Stats
      const now = new Date();
      const DAYS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
      const todayDay = DAYS[now.getDay()];
      const todayISO = now.toISOString().split('T')[0];
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

      // 1. Fetch Bookings for stats
      const { data: bookings } = await supabase
        .from('bookings')
        .select('student_id, day_of_week, time_slot, module, start_date')
        .eq('teacher_id', user.id)
        .eq('tenant_id', effectiveTenantId)
        .or(`start_date.lte.${todayISO},start_date.is.null`);

      const uniqueStudents = new Set(bookings?.map(b => b.student_id));

      // 2. Classes Today
      const todayBookings = (bookings || []).filter(b => b.day_of_week === todayDay);

      const { data: todayRepos } = await supabase
        .from('reschedules')
        .select(`
          *,
          student:student_id(id, full_name, avatar_url, module, meeting_link, phone)
        `)
        .eq('teacher_id', user.id)
        .eq('date', todayISO)
        .eq('tenant_id', effectiveTenantId);

      // 3. Earnings (Sum from logs this month)
      const { data: logs } = await supabase
        .from('class_logs')
        .select('presence, subtype, class_date, created_at, booking_id, reschedule_id, appointment_id, payment_hold')
        .eq('teacher_id', user.id)
        .gte('class_date', startOfMonth);

      // Rule: Pay if (not teacher absence) AND (not repo) AND (not on hold). Trials ARE paid.
      const paidLogs = (logs || []).filter(l =>
        l.presence !== 'Falta do Professor' &&
        l.presence !== 'TEACHER_ABSENCE' &&
        l.subtype !== 'REPOSIÇÃO' &&
        l.payment_hold !== true
      );

      // Fetch Paid Trainings (Ao Vivo / Meet)
      const { data: completedTrainings } = await supabase
        .from('training_assignments')
        .select(`
          status,
          completed_at,
          module:module_id(resource_type)
        `)
        .eq('teacher_id', user.id)
        .eq('status', 'COMPLETED')
        .gte('completed_at', startOfMonth);

      const paidTrainings = (completedTrainings || []).filter(t =>
        (t.module as any)?.resource_type === 'meet'
      );

      const earnings = (paidLogs.length + paidTrainings.length) * (user.hourlyRate || 8.00);

      setStats({
        activeStudents: uniqueStudents.size,
        classesToday: (todayBookings.length + (todayRepos?.length || 0)),
        monthlyEarnings: earnings,
        completionRate: 100
      });

      // 4. Upcoming Lessons
      const currentHour = now.getHours();
      const currentMin = now.getMinutes();
      const currentTimeStr = `${currentHour.toString().padStart(2, '0')}:${currentMin.toString().padStart(2, '0')}`;

      const { data: bComplete } = await supabase
        .from('bookings')
        .select(`
          id, time_slot, 
          student:student_id(id, full_name, avatar_url, module, meeting_link, phone)
        `)
        .eq('teacher_id', user.id)
        .eq('day_of_week', todayDay)
        .eq('tenant_id', effectiveTenantId)
        .or(`start_date.lte.${todayISO},start_date.is.null`);

      // 3. Trials Today (from appointments table)
      const { data: trials } = await supabase
        .from('appointments')
        .select(`
          id, time, date, student_name, student_phone, type, status
        `)
        .eq('teacher_id', user.id)
        .eq('date', todayISO)
        .eq('type', 'experimental')
        .eq('tenant_id', effectiveTenantId);

      const upcomingRegular = (bComplete || [])
        .filter(b => b.time_slot >= currentTimeStr && !logs?.some(l => l.booking_id === b.id && l.class_date === todayISO))
        .map(b => ({
          name: (b.student as any)?.full_name || 'Desconhecido',
          studentId: (b.student as any)?.id || null,
          time: b.time_slot,
          module: (b.student as any)?.module || 'N/A',
          img: (b.student as any)?.avatar_url || `https://ui-avatars.com/api/?name=${(b.student as any)?.full_name}`,
          meet: (b.student as any)?.meeting_link,
          phone: (b.student as any)?.phone,
          type: 'REGULAR'
        }));

      const upcomingRepos = (todayRepos || [])
        .filter(r => r.time >= currentTimeStr && !logs?.some(l => l.reschedule_id === r.id && l.class_date === todayISO))
        .map(r => ({
          name: (r.student as any)?.full_name || 'Reposição',
          time: r.time,
          module: (r.student as any)?.module || 'N/A',
          img: (r.student as any)?.avatar_url || `https://ui-avatars.com/api/?name=${(r.student as any)?.full_name || 'R'}`,
          meet: (r.student as any)?.meeting_link,
          phone: (r.student as any)?.phone,
          type: 'REPOSIÇÃO'
        }));

      const upcomingTrials = (trials || [])
        .filter(t => t.time >= currentTimeStr && !logs?.some(l => l.appointment_id === t.id && l.class_date === todayISO))
        .map(t => ({
          name: t.student_name || 'Aula Experimental',
          time: t.time,
          module: 'EXPERIMENTAL',
          img: `https://ui-avatars.com/api/?name=${t.student_name || 'E'}`,
          meet: user.meeting_link, // Usually teacher's own link
          phone: t.student_phone,
          type: 'TRIAL'
        }));

      setUpcomingLessons([...upcomingRegular, ...upcomingRepos, ...upcomingTrials]
        .sort((a, b) => a.time.localeCompare(b.time))
      );

      // 5. Weekly Chart Data (Last 7 days)
      const last7DaysLogs = (logs || []).filter(l => {
        const logDate = new Date(l.created_at);
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        return logDate >= sevenDaysAgo;
      });

      const dayShortNames = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
      const weeklyData = dayShortNames.map((name, index) => {
        const count = last7DaysLogs.filter(l => new Date(l.created_at).getDay() === index).length;
        return { name, aulas: count };
      });

      // Rotate weekly data so today is at the end or in correct order
      const rotatedData = [];
      for (let i = 0; i < 7; i++) {
        const d = new Date();
        d.setDate(d.getDate() - (6 - i));
        const dayIndex = d.getDay();
        const count = last7DaysLogs.filter(l => new Date(l.created_at).toLocaleDateString() === d.toLocaleDateString()).length;
        rotatedData.push({ name: dayShortNames[dayIndex], aulas: count });
      }
      setChartData(rotatedData);

      // 6. Check for Closing Popup Trigger
      // Logic: Strictly on the LAST DAY OF THE MONTH to ensure sync.
      // Also allow in the first 5 days of next month as a fallback if they missed it.

      const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      const isLastDay = now.getDate() === lastDayOfMonth.getDate();
      const isFirstDays = now.getDate() <= 5;

      if (isLastDay || isFirstDays) {
        // localMonth (NUNCA toISOString): o professor fecha o mês à noite e, depois das
        // 21h do dia 31, o UTC já está no mês seguinte — o modal abria o mês errado
        // (agosto no dia 31/07) e o fechamento de julho nunca era confirmado.
        let targetMonth = '';
        if (isLastDay) {
          // It is TODAY, the last day
          targetMonth = localMonth(now);
        } else {
          // It is the start of next month, closing the previous one
          targetMonth = localMonth(new Date(now.getFullYear(), now.getMonth() - 1, 1));
        }

        // Check database for status
        const { data: closing } = await supabase
          .from('teacher_closings')
          .select('status, teacher_confirmation_status')
          .eq('teacher_id', user.id)
          .eq('month_year', targetMonth)
          .maybeSingle();

        // If no closing record OR (status is PENDING/REJECTED AND not yet confirmed by teacher) => Show Modal
        const isConfirmed = closing?.teacher_confirmation_status === 'OK' || closing?.teacher_confirmation_status === 'CONTESTADO';

        if (!closing || ((closing.status === 'PENDENTE' || closing.status === 'REJEITADO') && !isConfirmed)) {
          // Additional check: If it is strictly the last day, ensure we are not showing it too early in the day if needed.
          // For now, showing it anytime on the last day is correct.
          setClosingModalMonth(targetMonth);
          setShowClosingModal(true);
        }
      }

    } catch (err) {
      console.error('Dashboard Fetch Error:', err);
    } finally {
      setLoading(false);
    }
  };

  const [showClosingModal, setShowClosingModal] = useState(false);
  const [closingModalMonth, setClosingModalMonth] = useState('');

  return (
    <div className="space-y-6 md:space-y-8 animate-fade-in-up font-sans">

      {/* Financial Closing Modal */}
      {showClosingModal && (
        <FinancialClosingModal
          user={user}
          tenantId={tenantId}
          month={closingModalMonth}
          onClose={() => setShowClosingModal(false)}
          onSuccess={() => {
            setShowClosingModal(false);
            fetchDashboardData();
          }}
        />
      )}


      {/* Aceite de contrato PJ pendente — banner de regularização */}
      {contractPending && (
        <div className="bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-900/30 p-4 rounded-2xl flex flex-col sm:flex-row sm:items-center gap-4 animate-in slide-in-from-top-4">
          <div className="p-2 bg-amber-100 dark:bg-amber-900/30 rounded-xl text-amber-600 dark:text-amber-400 self-start">
            <AlertCircle size={24} />
          </div>
          <div className="flex-1">
            <h3 className="font-bold text-amber-700 dark:text-amber-400">Aceite do contrato pendente</h3>
            <p className="text-sm text-amber-700/80 dark:text-amber-300/80 font-medium">
              Você ainda não assinou o contrato de prestação de serviços PJ. É rápido e necessário para regularizar seu cadastro.
            </p>
          </div>
          <button
            onClick={() => setShowContractModal(true)}
            className="bg-amber-600 text-white px-6 py-3 rounded-xl text-xs font-bold hover:bg-amber-700 transition-all shadow-lg whitespace-nowrap self-start sm:self-auto"
          >
            Revisar e assinar
          </button>
        </div>
      )}

      {showContractModal && user?.id && (
        <TeacherContractAccept
          userId={user.id}
          onClose={() => setShowContractModal(false)}
          onAccepted={() => { setShowContractModal(false); setContractPending(false); }}
        />
      )}

      {/* Header Section */}
      <header className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
        <div>
          <h2 className="text-2xl font-[family-name:var(--font-display)] font-extrabold text-brand-text tracking-wide">
            Olá, {user.name?.split(' ')[0] || 'Prof.'} 👋
          </h2>
          <p className="text-brand-muted text-sm mt-1">
            Resumo da sua performance e agenda de hoje.
          </p>
        </div>

        {/* Quick Actions */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => onNavigate?.('lessons')}
            className="flex items-center gap-2 bg-brand-accent text-white px-6 py-3 rounded-xl text-xs font-bold hover:bg-brand-accent-hover transition-all shadow-lg"
          >
            <BookOpen size={16} />
            <span>Lançar Aulas</span>
          </button>
          <button
            onClick={() => onNavigate?.('schedule')}
            className="flex items-center gap-2 bg-brand-surface text-brand-muted px-6 py-3 rounded-xl text-xs font-bold border border-brand-border hover:bg-brand-surface-2 transition-all"
          >
            <Calendar size={16} />
            <span>Agenda</span>
          </button>
        </div>
      </header>

      {/* Compliance Lock Banner */}
      {complianceLocked.isLocked && (
        <div className="bg-red-50 dark:bg-red-900/10 border border-red-200 dark:border-red-900/30 p-4 rounded-2xl flex items-center gap-4 animate-in slide-in-from-top-4">
          <div className="p-2 bg-red-100 dark:bg-red-900/30 rounded-xl text-red-600 dark:text-red-400">
            <AlertCircle size={24} />
          </div>
          <div className="flex-1">
            <h3 className="font-bold text-red-700 dark:text-red-400">Regularização Necessária</h3>
            <p className="text-sm text-red-600 dark:text-red-300 font-medium">
              {complianceLocked.reason}
            </p>
          </div>
          <button
            onClick={() => onNavigate?.('invoices')}
            className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-xs font-bold uppercase tracking-widest rounded-xl transition-colors shadow-lg shadow-red-600/20"
          >
            Resolver Agora
          </button>
        </div>
      )}

      {/* Stats Cards - Glass Style */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        {[
          { label: 'Alunos Ativos', value: stats.activeStudents, icon: Users, color: 'bg-blue-100 text-blue-600' },
          { label: 'Aulas Hoje', value: stats.classesToday, icon: Clock, color: 'bg-purple-100 text-purple-600' },
          {
            label: 'Ganhos (Mês)',
            value: `R$ ${stats.monthlyEarnings.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`,
            icon: TrendingUp,
            color: 'bg-emerald-100 text-emerald-600',
            isFinancial: true
          },
          { label: 'Conclusão', value: `${stats.completionRate}%`, icon: CheckCircle, color: 'bg-amber-100 text-amber-600' },
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
            <div className="flex justify-between items-start mb-4">
              <div className={`p-3 rounded-2xl ${stat.color}`}>
                <stat.icon size={24} strokeWidth={1.5} />
              </div>
            </div>

            <div className={stat.isFinancial && complianceLocked.isLocked ? 'blur-md select-none opacity-50 transition-all duration-500' : ''}>
              <h3 className="text-3xl font-extrabold text-brand-text mb-1 tracking-tight">{stat.value}</h3>
              <p className="text-xs text-brand-muted font-medium uppercase tracking-widest">{stat.label}</p>
            </div>

            {stat.isFinancial && complianceLocked.isLocked && (
              <div className="absolute inset-0 flex items-center justify-center bg-brand-surface/50 backdrop-blur-sm z-10">
                <div className="flex flex-col items-center gap-1">
                  <Lock size={20} className="text-brand-muted" />
                  <span className="text-[10px] font-black uppercase tracking-widest text-brand-muted">Bloqueado</span>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Chart Section */}
        <div className="lg:col-span-2 bg-brand-surface p-6 md:p-8 rounded-2xl border border-brand-border">
          <div className="flex items-center justify-between mb-8">
            <div>
              <h3 className="text-sm font-bold text-brand-text">Volume de Aulas</h3>
              <p className="text-xs text-brand-muted mt-1">Comparativo semanal</p>
            </div>
          </div>
          <div className="h-72 w-full min-w-0">
            <ResponsiveContainer
              width="100%"
              height="100%"
              minWidth={0}
              minHeight={0}
              debounce={100}
              initialDimension={{ width: 800, height: 288 }}
            >
              <LineChart data={chartData.length > 0 ? chartData : [{ name: '...', aulas: 0 }]}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" className="dark:stroke-slate-800" />
                <XAxis
                  dataKey="name"
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 12, fill: '#94a3b8', fontWeight: '600' }}
                  dy={10}
                />
                <YAxis
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 12, fill: '#94a3b8', fontWeight: '600' }}
                />
                <Tooltip
                  contentStyle={{
                    borderRadius: '16px',
                    border: 'none',
                    backgroundColor: '#1e293b',
                    color: '#f8fafc',
                    boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.1)'
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="aulas"
                  stroke="#8b5cf6"
                  strokeWidth={4}
                  dot={{ r: 4, fill: '#8b5cf6', strokeWidth: 2, stroke: '#fff' }}
                  activeDot={{ r: 6, fill: '#8b5cf6' }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Right Column */}
        <div className="space-y-6">
          <AutomacaoSmart />

          {/* Affiliate Link Card */}
          <TeacherAffiliateCard user={user} />

          {/* Schedule Section */}
          <div className="bg-brand-surface p-6 md:p-8 rounded-2xl border border-brand-border flex flex-col relative overflow-hidden">
            <div className="flex justify-between items-center mb-6 relative z-10">
              <h3 className="text-sm font-bold text-brand-text">Aulas de Hoje</h3>
              <div className="flex items-center gap-2">
                {teacherWa.automation ? (
                  <span className="flex items-center gap-1 text-[10px] bg-emerald-500/10 text-emerald-600 px-3 py-1 rounded-full font-bold border border-emerald-500/20" title="Os lembretes são enviados automaticamente 30 min antes de cada aula">
                    <Zap size={10} className="fill-current" /> AUTO · 30min
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-[10px] bg-amber-500/10 text-amber-600 px-3 py-1 rounded-full font-bold border border-amber-500/20" title="Modo manual: clique em Disparar para enviar o lembrete">
                    <MessageCircle size={10} className="fill-current" /> MANUAL
                  </span>
                )}
              </div>
            </div>

            <div className="space-y-4 flex-1 overflow-y-auto pr-1 relative z-10 custom-scrollbar">
              {upcomingLessons.length > 0 ? upcomingLessons.map((aula, i) => {
                const dispatchKey = `${aula.type}-${aula.time}-${aula.name}`;
                const dispatchState = dispatching[dispatchKey];
                return (
                <div key={i} className={`flex items-center gap-4 p-4 rounded-xl border transition-all group ${aula.type === 'TRIAL'
                  ? 'border-brand-accent/40 bg-brand-accent/5'
                  : 'border-brand-border bg-brand-surface-2 hover:border-brand-accent/30'}`}>
                  <div className="relative shrink-0">
                    <img src={aula.img} className="w-12 h-12 rounded-xl object-cover shadow-sm" alt={aula.name} />
                    <div className={`absolute -bottom-1 -right-1 w-3.5 h-3.5 border-2 border-brand-surface rounded-full ${aula.type === 'TRIAL' ? 'bg-brand-accent' : 'bg-emerald-500'}`} />
                  </div>

                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold text-brand-text truncate">{aula.name}</p>
                    <div className="flex items-center gap-2 mt-1 text-xs text-brand-muted">
                      <span className="flex items-center gap-1 font-medium bg-brand-surface border border-brand-border px-2 py-0.5 rounded-md shadow-sm">
                        <Clock size={10} className={aula.type === 'TRIAL' ? 'text-brand-accent' : 'text-brand-muted'} /> {aula.time}
                      </span>
                      {aula.type === 'TRIAL' ? (
                        <span className="text-[9px] font-black bg-brand-accent text-white px-2 py-0.5 rounded-md uppercase tracking-wider animate-pulse">Experimental</span>
                      ) : (
                        <span className="truncate">{aula.module}</span>
                      )}
                    </div>
                  </div>

                  <div className="flex gap-2 items-center shrink-0">
                    {/* Botão Disparar — envia o lembrete personalizado pela INSTÂNCIA do professor */}
                    {aula.phone && (
                      <button
                        onClick={() => handleDispatch(aula, dispatchKey)}
                        disabled={dispatchState === 'sending' || dispatchState === 'sent'}
                        className={`px-3 h-10 rounded-xl flex items-center justify-center gap-1.5 transition-all shadow-sm border text-xs font-bold ${
                          dispatchState === 'sent'
                            ? 'bg-emerald-500 border-emerald-500 text-white cursor-default'
                            : dispatchState === 'error'
                              ? 'bg-red-50 border-red-200 text-red-600'
                              : dispatchState === 'sending'
                                ? 'bg-brand-surface border-brand-border text-brand-muted cursor-wait'
                                : 'bg-emerald-500 hover:bg-emerald-600 border-emerald-500 text-white'
                        }`}
                        title={teacherWa.instance ? 'Disparar lembrete agora pelo seu WhatsApp' : 'Conecte seu WhatsApp para disparar'}
                      >
                        {dispatchState === 'sending' ? (
                          <><RefreshCw size={14} className="animate-spin" /> Enviando</>
                        ) : dispatchState === 'sent' ? (
                          <><CheckCircle size={14} /> Enviado</>
                        ) : dispatchState === 'error' ? (
                          <><AlertCircle size={14} /> Tentar</>
                        ) : (
                          <><Send size={14} /> Disparar</>
                        )}
                      </button>
                    )}
                    {aula.studentId && (
                      <WolfieAssignButton
                        studentId={aula.studentId}
                        studentName={aula.name}
                        compact
                      />
                    )}
                    {aula.meet && (
                      <a
                        href={aula.meet}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="w-10 h-10 rounded-xl bg-brand-surface text-brand-muted hover:text-brand-accent hover:bg-brand-accent/10 flex items-center justify-center transition-all shadow-sm border border-brand-border"
                        title="Entrar na Sala"
                      >
                        <Video size={18} />
                      </a>
                    )}
                  </div>
                </div>
              ); }) : (
                <div className="flex flex-col items-center justify-center h-48 text-brand-muted opacity-60">
                  <Calendar size={40} strokeWidth={1.5} className="mb-3" />
                  <p className="text-[10px] font-bold uppercase tracking-widest">Sem aulas futuras</p>
                </div>
              )}
            </div>

            <button
              onClick={() => onNavigate?.('schedule')}
              className="w-full mt-6 py-4 text-xs font-bold text-brand-text bg-brand-surface-2 border border-brand-border rounded-xl hover:bg-brand-surface transition-all uppercase tracking-widest flex items-center justify-center gap-2"
            >
              Ver Agenda Completa <ArrowRight size={14} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TeacherDashboard;
