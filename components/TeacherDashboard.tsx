
import React, { useEffect, useState } from 'react';
import { Users, Clock, CheckCircle, TrendingUp, Calendar, ArrowRight, BookOpen, Video, Zap } from 'lucide-react';
import { whatsappService } from '../services/whatsappService';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { supabase } from '../lib/supabase';
import { User as UserType } from '../types';
import FinancialClosingModal from './FinancialClosingModal';

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

  const effectiveTenantId = tenantId || user.tenantId;

  // WhatsApp Automation Watchdog
  useEffect(() => {
    if (loading || !upcomingLessons.length) return;

    const checkReminders = async () => {
      const now = new Date();
      const currentHour = now.getHours();
      const currentMin = now.getMinutes();
      const currentTimeInMins = currentHour * 60 + currentMin;

      // 1. Check if teacher has a connected WhatsApp instance
      const { data: instanceData } = await supabase
        .from('whatsapp_instances')
        .select('instance_name, status')
        .eq('user_id', user.id)
        .eq('status', 'connected')
        .maybeSingle();

      if (!instanceData) return; // No active connection, skip automation

      upcomingLessons.forEach(async (lesson) => {
        if (!lesson.time) return;

        const [lHour, lMin] = lesson.time.split(':').map(Number);
        const lessonTimeInMins = lHour * 60 + lMin;

        // Target: exactly 60 minutes before
        const diff = lessonTimeInMins - currentTimeInMins;
        const reminderId = `${lesson.studentId || lesson.name}-${lesson.time}-${new Date().toDateString()}`;

        if (diff === 60 && !sentReminders.has(reminderId)) {
          console.log('Attemping to send WhatsApp reminder for:', lesson.name);

          // Need student phone - fetch if not in lesson object
          let phone = lesson.phone;
          if (!phone && lesson.studentId) {
            const { data } = await supabase.from('profiles').select('phone').eq('id', lesson.studentId).single();
            phone = data?.phone;
          }

          if (phone) {
            const res = await whatsappService.sendLessonReminder(
              effectiveTenantId,
              user.id,
              instanceData.instance_name, // Pass the connected instance name
              lesson.name,
              phone,
              lesson.time
            );

            if (res.success) {
              setSentReminders(prev => new Set(prev).add(reminderId));
            }
          }
        }
      });
    };

    const interval = setInterval(checkReminders, 60000); // Check every minute
    return () => clearInterval(interval);
  }, [upcomingLessons, loading, sentReminders, effectiveTenantId, user.id]);

  useEffect(() => {
    if (user && (tenantId || user.tenantId)) {
      fetchDashboardData();
    }
  }, [user, tenantId]);

  const fetchDashboardData = async () => {
    setLoading(true);
    try {
      const now = new Date();
      const DAYS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
      const todayDay = DAYS[now.getDay()];
      const todayISO = now.toISOString().split('T')[0];
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

      // 1. Fetch Bookings for stats
      const { data: bookings } = await supabase
        .from('bookings')
        .select('student_id, day_of_week, time_slot, module')
        .eq('teacher_id', user.id)
        .eq('tenant_id', effectiveTenantId);

      const uniqueStudents = new Set(bookings?.map(b => b.student_id));

      // 2. Classes Today
      const todayBookings = (bookings || []).filter(b => b.day_of_week === todayDay);

      const { data: todayRepos } = await supabase
        .from('reschedules')
        .select(`
          *,
          student:student_id(id, full_name, avatar_url, module, meeting_link)
        `)
        .eq('teacher_id', user.id)
        .eq('date', todayISO)
        .eq('tenant_id', effectiveTenantId);

      // 3. Earnings (Sum from logs this month)
      const { data: logs } = await supabase
        .from('class_logs')
        .select('presence, subtype, class_date, created_at')
        .eq('teacher_id', user.id)
        .gte('class_date', startOfMonth);

      const paidLogs = (logs || []).filter(l => l.presence !== 'Falta do Professor' && l.subtype !== 'REPOSIÇÃO');
      const earnings = paidLogs.length * (user.hourlyRate || 7.50);

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
          student:student_id(id, full_name, avatar_url, module, meeting_link)
        `)
        .eq('teacher_id', user.id)
        .eq('day_of_week', todayDay)
        .eq('tenant_id', effectiveTenantId);

      const upcomingRegular = (bComplete || [])
        .filter(b => b.time_slot >= currentTimeStr)
        .map(b => ({
          name: (b.student as any)?.full_name || 'Desconhecido',
          time: b.time_slot,
          module: (b.student as any)?.module || 'N/A',
          img: (b.student as any)?.avatar_url || `https://ui-avatars.com/api/?name=${(b.student as any)?.full_name}`,
          meet: (b.student as any)?.meeting_link,
          type: 'REGULAR'
        }));

      const upcomingRepos = (todayRepos || [])
        .filter(r => r.time >= currentTimeStr)
        .map(r => ({
          name: (r.student as any)?.full_name || 'Reposição',
          time: r.time,
          module: (r.student as any)?.module || 'N/A',
          img: (r.student as any)?.avatar_url || `https://ui-avatars.com/api/?name=${(r.student as any)?.full_name || 'R'}`,
          meet: (r.student as any)?.meeting_link,
          type: 'REPOSIÇÃO'
        }));

      setUpcomingLessons([...upcomingRegular, ...upcomingRepos].sort((a, b) => a.time.localeCompare(b.time)).slice(0, 4));

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
        let targetMonth = '';
        if (isLastDay) {
          // It is TODAY, the last day
          targetMonth = now.toISOString().substring(0, 7);
        } else {
          // It is the start of next month, closing the previous one
          const prev = new Date(now);
          prev.setMonth(prev.getMonth() - 1);
          targetMonth = prev.toISOString().substring(0, 7);
        }

        // Check database for status
        const { data: closing } = await supabase
          .from('teacher_closings')
          .select('status')
          .eq('teacher_id', user.id)
          .eq('month_year', targetMonth)
          .maybeSingle();

        // If no closing record OR status is PENDING/null => Show Modal
        if (!closing || closing.status === 'PENDENTE' || closing.status === 'REJEITADO') {
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
    <div className="space-y-6 md:space-y-8 animate-in fade-in duration-700 font-sans">

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

      {/* Header Section */}
      <header className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
        <div>
          <h2 className="text-2xl font-bold text-slate-900 dark:text-white">
            Olá, {user.name?.split(' ')[0] || 'Prof.'} 👋
          </h2>
          <p className="text-slate-500 dark:text-slate-400 text-sm mt-1">
            Resumo da sua performance e agenda de hoje.
          </p>
        </div>

        {/* Quick Actions */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => onNavigate?.('lessons')}
            className="flex items-center gap-2 bg-slate-900 dark:bg-white text-white dark:text-slate-900 px-6 py-3 rounded-xl text-xs font-bold hover:opacity-90 transition-all shadow-lg shadow-slate-900/20"
          >
            <BookOpen size={16} />
            <span>Lançar Aulas</span>
          </button>
          <button
            onClick={() => onNavigate?.('schedule')}
            className="flex items-center gap-2 bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 px-6 py-3 rounded-xl text-xs font-bold border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700 transition-all"
          >
            <Calendar size={16} />
            <span>Agenda</span>
          </button>
        </div>
      </header>

      {/* Stats Cards - Glass Style */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        {[
          { label: 'Alunos Ativos', value: stats.activeStudents, icon: Users, color: 'bg-blue-100 text-blue-600' },
          { label: 'Aulas Hoje', value: stats.classesToday, icon: Clock, color: 'bg-purple-100 text-purple-600' },
          { label: 'Ganhos (Mês)', value: `R$ ${stats.monthlyEarnings.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`, icon: TrendingUp, color: 'bg-emerald-100 text-emerald-600' },
          { label: 'Conclusão', value: `${stats.completionRate}%`, icon: CheckCircle, color: 'bg-amber-100 text-amber-600' },
        ].map((stat, i) => (
          <div key={i} className="bg-white dark:bg-slate-900 p-6 rounded-[32px] shadow-[0px_4px_20px_rgba(0,0,0,0.02)] border border-slate-50 dark:border-slate-800 transition-all hover:-translate-y-1 hover:shadow-lg">
            <div className="flex justify-between items-start mb-4">
              <div className={`p-3 rounded-2xl ${stat.color} dark:bg-opacity-20`}>
                <stat.icon size={24} strokeWidth={1.5} />
              </div>
            </div>
            <h3 className="text-3xl font-bold text-slate-900 dark:text-white mb-1">{stat.value}</h3>
            <p className="text-sm text-slate-500 dark:text-slate-400 font-medium">{stat.label}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Chart Section */}
        <div className="lg:col-span-2 bg-white dark:bg-slate-900 p-8 rounded-[32px] shadow-[0px_4px_20px_rgba(0,0,0,0.02)] border border-slate-50 dark:border-slate-800">
          <div className="flex items-center justify-between mb-8">
            <div>
              <h3 className="text-lg font-bold text-slate-900 dark:text-white">Volume de Aulas</h3>
              <p className="text-sm text-slate-500 mt-1">Comparativo semanal</p>
            </div>
          </div>
          <div className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
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

        {/* Schedule Section */}
        <div className="bg-white dark:bg-slate-900 p-8 rounded-[32px] shadow-[0px_4px_20px_rgba(0,0,0,0.02)] border border-slate-50 dark:border-slate-800 flex flex-col relative overflow-hidden">
          <div className="flex justify-between items-center mb-6 relative z-10">
            <h3 className="text-lg font-bold text-slate-900 dark:text-white">Próximas Aulas</h3>
            <div className="flex items-center gap-2">
              <span className="flex items-center gap-1 text-[10px] bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-300 px-3 py-1 rounded-full font-bold border border-indigo-100 dark:border-indigo-800">
                <Zap size={10} className="fill-current" /> AUTO
              </span>
            </div>
          </div>

          <div className="space-y-4 flex-1 overflow-y-auto pr-1 relative z-10 custom-scrollbar">
            {upcomingLessons.length > 0 ? upcomingLessons.map((aula, i) => (
              <div key={i} className="flex items-center gap-4 p-4 rounded-2xl bg-slate-50 dark:bg-slate-800/50 border border-slate-100 dark:border-slate-700 hover:border-purple-200 transition-all group">
                <div className="relative shrink-0">
                  <img src={aula.img} className="w-12 h-12 rounded-2xl object-cover shadow-sm" alt={aula.name} />
                  <div className="absolute -bottom-1 -right-1 w-3.5 h-3.5 bg-emerald-500 border-2 border-white dark:border-slate-800 rounded-full" />
                </div>

                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold text-slate-900 dark:text-white truncate">{aula.name}</p>
                  <div className="flex items-center gap-2 mt-1 text-xs text-slate-500">
                    <span className="flex items-center gap-1 font-medium bg-white dark:bg-slate-800 px-2 py-0.5 rounded-md shadow-sm">
                      <Clock size={10} className="text-purple-500" /> {aula.time}
                    </span>
                    <span className="truncate">{aula.module}</span>
                  </div>
                </div>

                {aula.meet && (
                  <a
                    href={aula.meet}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="w-10 h-10 rounded-xl bg-white dark:bg-slate-800 text-slate-400 hover:text-purple-600 hover:bg-purple-50 dark:hover:bg-slate-700 flex items-center justify-center transition-all shadow-sm border border-slate-100 dark:border-slate-700"
                  >
                    <Video size={18} />
                  </a>
                )}
              </div>
            )) : (
              <div className="flex flex-col items-center justify-center h-48 text-slate-300 dark:text-slate-600">
                <Calendar size={40} strokeWidth={1.5} className="mb-3 opacity-50" />
                <p className="text-xs font-bold uppercase tracking-widest">Sem aulas futuras</p>
              </div>
            )}
          </div>

          <button
            onClick={() => onNavigate?.('schedule')}
            className="w-full mt-6 py-4 text-xs font-bold text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-slate-800 rounded-2xl hover:bg-slate-100 dark:hover:bg-slate-700 transition-all uppercase tracking-widest flex items-center justify-center gap-2"
          >
            Ver Agenda Completa <ArrowRight size={14} />
          </button>
        </div>
      </div>
    </div>
  );
};

export default TeacherDashboard;
