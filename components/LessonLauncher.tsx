import React, { useState, useEffect } from 'react';
import { Save, User as UserIcon, BookOpen, ChevronRight, Sparkles, AlertCircle, CheckCircle, ArrowLeft, RefreshCw, Clock, X, MoreHorizontal, Calendar } from 'lucide-react';
import { getPedagogicalSuggestion } from '../services/geminiService';
import ClassLogForm from './ClassLogForm';
import { supabase } from '../lib/supabase';
import { User as UserType } from '../types';

interface LessonLauncherProps {
  user: UserType;
  tenantId?: string;
  onRefresh?: () => void;
}

const LessonLauncher: React.FC<LessonLauncherProps> = ({ user, tenantId, onRefresh }) => {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [loading, setLoading] = useState(true);
  const [todayLessons, setTodayLessons] = useState<any[]>([]);

  const effectiveTenantId = tenantId || user.tenantId;

  useEffect(() => {
    if (user && effectiveTenantId) {
      fetchTodaySchedule();
    }
  }, [user, effectiveTenantId]);

  const fetchTodaySchedule = async () => {
    if (!user || !effectiveTenantId) return;
    setLoading(true);
    try {
      const now = new Date();
      // Fetch for last 3 days to catch immediate backlog plus today
      const startDate = new Date();
      startDate.setDate(now.getDate() - 3);
      const startDateStr = startDate.toISOString().split('T')[0];
      const endDateStr = now.toISOString().split('T')[0];

      // 1. Fetch EVERYTHING in bulk
      const [
        { data: bookingsData },
        { data: reschedulesData },
        { data: trialsData },
        { data: logsData }
      ] = await Promise.all([
        supabase.from('bookings').select('*, student:student_id(id, full_name, module, avatar_url, current_topic_id)').eq('teacher_id', user.id).eq('tenant_id', effectiveTenantId),
        supabase.from('reschedules').select('*, student:student_id(id, full_name, module, avatar_url)').eq('teacher_id', user.id).eq('tenant_id', effectiveTenantId).gte('date', startDateStr).lte('date', endDateStr),
        supabase.from('appointments').select('*').eq('teacher_id', user.id).eq('tenant_id', effectiveTenantId).gte('date', startDateStr).lte('date', endDateStr),
        supabase.from('class_logs').select('booking_id, reschedule_id, appointment_id, class_date').eq('teacher_id', user.id).eq('tenant_id', effectiveTenantId).gte('class_date', startDateStr).lte('class_date', endDateStr)
      ]);

      const daysOfWeek = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
      const allLessons: any[] = [];

      // 2. Iterate days in memory (D-3 to Today)
      for (let i = 0; i <= 3; i++) {
        const checkDate = new Date();
        checkDate.setDate(now.getDate() - i);
        const dayName = daysOfWeek[checkDate.getDay()];
        const dateStr = checkDate.toISOString().split('T')[0];

        if (dayName === 'Domingo') continue;

        // Regular bookings mapping
        bookingsData?.filter(b => b.day_of_week === dayName).forEach(b => {
          if (b.start_date && dateStr < b.start_date) return;
          
          const hasLog = logsData?.some(l => 
            l.class_date === dateStr && l.booking_id && String(l.booking_id) === String(b.id)
          );
          if (!hasLog) {
            allLessons.push({
              id: b.id,
              studentId: b.student?.id,
              name: b.student?.full_name || 'Desconhecido',
              date: i === 0 ? `Hoje às ${b.time_slot}` : `${checkDate.toLocaleDateString('pt-BR')} às ${b.time_slot}`,
              dateObj: dateStr,
              avatar: b.student?.avatar_url || `https://ui-avatars.com/api/?name=${b.student?.full_name}`,
              level: b.student?.module?.split(' ')[0] || 'N/A',
              type: 'REGULAR',
              time: b.time_slot
            });
          }
        });

        // Reschedules mapping
        reschedulesData?.filter(r => r.date === dateStr).forEach(r => {
          const hasLog = logsData?.some(l => l.reschedule_id && String(l.reschedule_id) === String(r.id));
          if (!hasLog) {
            allLessons.push({
              id: `repo-${r.id}`,
              studentId: r.student?.id,
              name: r.student?.full_name || 'Desconhecido',
              date: i === 0 ? `Hoje às ${r.time}` : `${checkDate.toLocaleDateString('pt-BR')} às ${r.time}`,
              dateObj: dateStr,
              avatar: r.student?.avatar_url || `https://ui-avatars.com/api/?name=${r.student?.full_name}`,
              level: r.student?.module?.split(' ')[0] || 'N/A',
              type: 'REPOSIÇÃO',
              time: r.time
            });
          }
        });

        // Trial mapping
        trialsData?.filter(t => t.date === dateStr).forEach(t => {
          const hasLog = logsData?.some(l => l.appointment_id && String(l.appointment_id) === String(t.id));
          if (!hasLog) {
            allLessons.push({
              id: `trial-${t.id}`,
              studentId: null,
              name: t.student_name || 'Prospect Trial',
              date: i === 0 ? `Hoje às ${t.time}` : `${checkDate.toLocaleDateString('pt-BR')} às ${t.time}`,
              dateObj: dateStr,
              avatar: `https://ui-avatars.com/api/?name=${t.student_name}`,
              level: t.module || 'TRIAL',
              type: 'AULA EXPERIMENTAL',
              time: t.time
            });
          }
        });
      }

      setTodayLessons(allLessons.sort((a, b) => a.time.localeCompare(b.time)));
    } catch (error) {
      console.error('Error in fetchTodaySchedule:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleBulkSave = async (formData: any) => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      const now = new Date();
      const currentMonthYear = `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, '0')}`;

      const entries = todayLessons.map(item => {
        const lessonId = String(item.id);
        const data = formData[lessonId];
        if (!data) return null;

        const isReschedule = lessonId.startsWith('repo-');
        const isTrial = lessonId.startsWith('trial-');

        return {
          tenant_id: effectiveTenantId,
          teacher_id: user.id,
          student_id: item.studentId || null,
          booking_id: (!isReschedule && !isTrial) ? lessonId : null,
          reschedule_id: isReschedule ? lessonId.replace('repo-', '') : null,
          appointment_id: isTrial ? lessonId.replace('trial-', '') : null,
          presence: data.type || 'COMPLETED',
          subtype: item.type === 'AULA EXPERIMENTAL' ? 'AULA EXPERIMENTAL' : (isReschedule ? 'REPOSIÇÃO' : (data.subtype || null)),
          content_covered: data.lastApplied || null,
          observations: data.observation || null,
          class_date: item.dateObj,
          created_at: new Date().toISOString()
        };
      }).filter(Boolean);

      if (entries.length > 0) {
        const { error } = await supabase.from('class_logs').insert(entries);
        if (error) throw error;

        // Cleanup Reschedules
        const completedReschedules = entries.filter(e => e.reschedule_id).map(e => e.reschedule_id);
        if (completedReschedules.length > 0) {
          await supabase.from('reschedules').delete().in('id', completedReschedules);
        }

        setShowSuccess(true);
        if (onRefresh) onRefresh();
        setTimeout(() => setShowSuccess(false), 3000);
        await fetchTodaySchedule();
      }
    } catch (err: any) {
      console.error('Save Error:', err);
      alert(`Erro: ${err.message}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="max-w-6xl mx-auto space-y-8 animate-in fade-in duration-500 relative h-[calc(100vh-140px)] flex flex-col">
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-6 pb-4 border-b border-slate-100 dark:border-slate-800 shrink-0">
        <div>
          <h2 className="text-4xl font-black text-slate-800 dark:text-white tracking-tighter">Lançamento Rápido</h2>
          <p className="text-slate-500 dark:text-slate-400 text-sm mt-1">Registre a presença e conteúdo das aulas ocorridas.</p>
        </div>
        <div className="hidden md:flex items-center gap-2 text-xs font-bold text-slate-400 bg-slate-50 dark:bg-slate-900 px-4 py-2 rounded-full border border-slate-100 dark:border-slate-800">
          <Calendar size={14} />
          {new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })}
        </div>
      </header>

      {showSuccess && (
        <div className="fixed top-10 right-10 z-50 bg-emerald-500 text-white px-6 py-4 rounded-2xl shadow-2xl flex items-center gap-4 animate-in slide-in-from-right duration-500">
          <div className="bg-white/20 p-2 rounded-full"><CheckCircle size={20} /></div>
          <div>
            <p className="font-black uppercase text-xs tracking-widest">Sucesso!</p>
            <p className="text-sm font-medium">Aulas registradas com perfeição.</p>
          </div>
        </div>
      )}

      <div className="flex-1 min-h-0">
        {loading ? (
          <div className="flex flex-col items-center justify-center h-64 text-slate-400">
            <RefreshCw className="animate-spin mb-4" size={32} />
            <p className="text-sm font-bold uppercase tracking-widest">Sincronizando Agenda...</p>
          </div>
        ) : todayLessons.length > 0 ? (
          <ClassLogForm
            items={todayLessons}
            onSave={handleBulkSave}
            title="Aulas Recentes e de Hoje"
            loading={isSubmitting}
          />
        ) : (
          <div className="flex flex-col items-center justify-center p-20 bg-white dark:bg-slate-900 rounded-[3rem] border border-dashed border-slate-200 dark:border-slate-800">
            <div className="w-20 h-20 bg-slate-50 dark:bg-slate-800 rounded-3xl flex items-center justify-center text-slate-300 mb-6">
              <Calendar size={40} />
            </div>
            <h4 className="text-2xl font-black text-slate-800 dark:text-white tracking-tight">Sem aulas pendentes</h4>
            <p className="text-sm text-slate-400 dark:text-slate-500 mt-2 font-medium">Você está em dia com seus lançamentos recentes.</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default LessonLauncher;
