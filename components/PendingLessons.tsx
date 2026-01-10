
import React, { useEffect, useState } from 'react';
import { AlertTriangle, Clock, ChevronRight, CheckSquare, Calendar, User, Zap, RefreshCw } from 'lucide-react';
import ClassLogForm from './ClassLogForm';
import { supabase } from '../lib/supabase';
import { User as UserType } from '../types';

interface PendingLessonsProps {
  user: UserType;
  tenantId?: string;
  onRegister: (lessonId: string) => void;
  onRefresh?: () => void;
}

const PendingLessons: React.FC<PendingLessonsProps> = ({ user, tenantId, onRegister, onRefresh }) => {
  const [pending, setPending] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedLesson, setSelectedLesson] = useState<any | null>(null);
  const [isBulkRegularizing, setIsBulkRegularizing] = useState(false);

  useEffect(() => {
    if (user && tenantId) {
      fetchPendingLessons();
    }
  }, [user, tenantId]);

  const fetchPendingLessons = async () => {
    setLoading(true);
    try {
      const now = new Date();
      // Start 30 days ago
      const startDate = new Date();
      startDate.setDate(now.getDate() - 30);

      // End 7 days ago (Grace Period)
      const endDate = new Date();
      endDate.setDate(now.getDate() - 7);

      const daysOfWeek = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

      // We'll collect all expected lessons in the range [Day-30 to Day-7]
      const allExpected: any[] = [];

      // Iterate dates from startDate to endDate
      for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
        const dayName = daysOfWeek[d.getDay()];
        const dateStr = d.toISOString().split('T')[0];

        if (dayName === 'Domingo') continue;

        // 1. Fetch regular bookings for this day
        const { data: bookings } = await supabase
          .from('bookings')
          .select('id, time_slot, start_date, student:student_id(id, full_name, module)')
          .eq('teacher_id', user.id)
          .eq('day_of_week', dayName)
          .eq('tenant_id', tenantId);

        if (bookings) {
          bookings.forEach(b => {
            if (b.start_date && dateStr < b.start_date) return;
            // No need to check future time since we are > 7 days ago

            allExpected.push({
              id: `book-${b.id}-${dateStr}`,
              bookingId: b.id,
              studentId: (b.student as any)?.id,
              student: (b.student as any)?.full_name,
              module: (b.student as any)?.module || 'N/A',
              date: d.toLocaleDateString('pt-BR'),
              rawDate: dateStr,
              time: b.time_slot,
              type: 'REGULAR'
            });
          });
        }

        // 2. Fetch reschedules
        const { data: reschedules } = await supabase
          .from('reschedules')
          .select('id, time, student:student_id(id, full_name, module)')
          .eq('teacher_id', user.id)
          .eq('date', dateStr)
          .eq('tenant_id', tenantId);

        if (reschedules) {
          reschedules.forEach(r => {
            allExpected.push({
              id: `repo-${r.id}`,
              rescheduleId: r.id,
              studentId: (r.student as any)?.id,
              student: (r.student as any)?.full_name,
              module: (r.student as any)?.module || 'N/A',
              date: d.toLocaleDateString('pt-BR'),
              rawDate: dateStr,
              time: r.time,
              type: 'REPOSIÇÃO'
            });
          });
        }
      }

      // 3. Fetch logs from strict range to filter out
      const { data: logs } = await supabase
        .from('class_logs')
        .select('booking_id, reschedule_id, student_id, created_at')
        .eq('teacher_id', user.id)
        .eq('tenant_id', tenantId)
        .gte('created_at', startDate.toISOString())
        .lte('created_at', endDate.toISOString() + 'T23:59:59Z');

      // Filter: Keep only those that DON'T have a log
      const pendingLessons = allExpected.filter(exp => {
        const hasLog = logs?.some(log => {
          const logDate = log.created_at.split('T')[0];
          const expDate = exp.rawDate;

          if (exp.type === 'REGULAR' && log.booking_id && String(log.booking_id) === String(exp.bookingId)) {
            return logDate === expDate;
          }
          if (exp.type === 'REPOSIÇÃO' && log.reschedule_id && String(log.reschedule_id) === String(exp.rescheduleId)) {
            return true;
          }
          return String(log.student_id) === String(exp.studentId) && logDate === expDate;
        });
        return !hasLog;
      });

      setPending(pendingLessons);
    } catch (err) {
      console.error('Error fetching pending lessons:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = (lesson: any) => {
    setSelectedLesson(lesson);
  };

  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSave = async (formData: any) => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      const entries = Object.keys(formData).map(lessonId => {
        const lesson = pending.find(p => p.id === lessonId) || (selectedLesson?.id === lessonId ? selectedLesson : null);
        if (!lesson) return null;

        const data = formData[lessonId];
        return {
          tenant_id: tenantId,
          teacher_id: user.id,
          student_id: lesson.studentId,
          booking_id: lesson.type === 'REGULAR' ? lesson.bookingId : null,
          reschedule_id: lesson.type === 'REPOSIÇÃO' ? lesson.rescheduleId : null,
          presence: data.type || 'Presença',
          subtype: lesson.type === 'REPOSIÇÃO' ? 'REPOSIÇÃO' : (data.subtype || null),
          content: data.lastApplied || null,
          observations: data.observation || null,
          created_at: lesson.rawDate ? `${lesson.rawDate}T12:00:00Z` : new Date().toISOString()
        };
      }).filter(Boolean);

      if (entries.length === 0) return;

      const { error } = await supabase.from('class_logs').insert(entries);
      if (error) throw error;

      // Clear used Reschedules 
      const completedReschedules = entries.filter(e => e.reschedule_id).map(e => e.reschedule_id);
      if (completedReschedules.length > 0) {
        await supabase.from('reschedules').delete().in('id', completedReschedules);
      }

      // Handle Automated Reschedules for absences (exclusing makeup itself)
      const absences = (entries as any[]).filter(e => (e.presence === 'Falta' || e.presence === 'Falta Justificada') && e.subtype !== 'REPOSIÇÃO');
      if (absences.length > 0) {
        const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();

        for (const a of absences) {
          const { count, error: countError } = await supabase
            .from('reschedules')
            .select('id', { count: 'exact', head: true })
            .eq('student_id', a.student_id)
            .gte('created_at', startOfMonth);

          if (!countError && (count || 0) < 5) {
            await supabase.from('reschedules').insert([{
              tenant_id: tenantId,
              teacher_id: user.id,
              student_id: a.student_id,
              original_booking_id: a.booking_id,
              date: 'Pendente',
              time: 'Pendente',
              created_at: new Date().toISOString()
            }]);
          }
        }
      }

      await fetchPendingLessons();
      setSelectedLesson(null);
      setIsBulkRegularizing(false);
      onRefresh?.();
    } catch (err: any) {
      console.error('Error regularizing lessons:', err);
      alert('Erro: ' + (err.message || 'Verifique sua conexão.'));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-8 animate-in fade-in duration-500 max-w-6xl mx-auto">
      <header className="flex flex-col md:flex-row justify-between items-start md:items-end gap-6 bg-white dark:bg-slate-900 p-8 rounded-[2.5rem] border border-slate-100 dark:border-slate-800 shadow-sm relative overflow-hidden">
        <div className="absolute top-0 right-0 w-64 h-64 bg-red-500/5 rounded-full blur-3xl -mr-32 -mt-32 pointer-events-none" />

        <div className="relative z-10">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 bg-red-100 dark:bg-red-900/20 text-red-600 rounded-lg">
              <AlertTriangle size={20} />
            </div>
            <span className="text-xs font-black text-red-500 uppercase tracking-widest">Ação Necessária</span>
          </div>
          <h2 className="text-3xl font-black text-slate-800 dark:text-white tracking-tight">Histórico Pendente</h2>
          <p className="text-slate-500 dark:text-slate-400 text-sm mt-1 max-w-lg">
            Regularize as aulas ocorridas há mais de 7 dias para liberar seu faturamento.
          </p>
        </div>

        <div className="relative z-10 flex flex-col items-end gap-3">
          <div className="bg-red-50 dark:bg-red-900/10 px-6 py-4 rounded-2xl border border-red-100 dark:border-red-900/30 flex items-center gap-4">
            <div className="text-right">
              <p className="text-[10px] font-black text-red-400 uppercase tracking-widest">Pendências</p>
              <p className="text-2xl font-black text-red-600 dark:text-red-400">{pending.length} Aulas</p>
            </div>
            <Zap size={24} className="text-red-500 animate-pulse fill-red-500" />
          </div>

          {pending.length > 1 && (
            <button
              onClick={() => setIsBulkRegularizing(true)}
              className="flex items-center gap-2 bg-slate-900 dark:bg-white text-white dark:text-slate-900 px-4 py-2 rounded-xl font-bold text-[10px] uppercase tracking-widest hover:bg-tenant-primary dark:hover:bg-tenant-primary dark:hover:text-white transition-all shadow-lg"
            >
              <CheckSquare size={14} /> Regularizar Todas
            </button>
          )}
        </div>
      </header>

      {loading ? (
        <div className="flex flex-col items-center justify-center py-20 text-slate-400">
          <RefreshCw className="animate-spin mb-4" size={32} />
          <p className="text-sm font-bold uppercase tracking-widest">Escaneando Histórico...</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4">
          {pending.map((lesson) => (
            <div key={lesson.id} className="group bg-white dark:bg-slate-900 p-6 rounded-[2rem] border border-slate-100 dark:border-slate-800 hover:border-tenant-primary dark:hover:border-tenant-primary/50 hover:shadow-xl hover:shadow-tenant-primary/10 transition-all flex flex-col md:flex-row items-center justify-between gap-6 relative overflow-hidden">
              <div className="absolute left-0 top-0 bottom-0 w-1.5 bg-tenant-primary scale-y-0 group-hover:scale-y-100 transition-transform duration-300 origin-bottom" />

              <div className="flex items-center gap-6 w-full md:w-auto">
                <div className="w-16 h-16 bg-slate-50 dark:bg-slate-800 rounded-2xl flex items-center justify-center font-black text-slate-400 dark:text-slate-500 text-xl group-hover:bg-tenant-primary group-hover:text-white transition-colors duration-300 shadow-sm relative">
                  {lesson.student.substring(0, 2).toUpperCase()}
                  <div className="absolute -bottom-1 -right-1 w-5 h-5 bg-white dark:bg-slate-900 rounded-full flex items-center justify-center">
                    <div className="w-3 h-3 bg-red-500 rounded-full animate-bounce" />
                  </div>
                </div>

                <div className="overflow-hidden">
                  <h4 className="font-black text-slate-800 dark:text-white text-lg tracking-tight group-hover:text-tenant-primary transition-colors">
                    {lesson.student}
                  </h4>
                  <p className="text-[10px] font-black text-tenant-primary uppercase tracking-widest mb-2">
                    {lesson.type} • {lesson.module}
                  </p>

                  <div className="flex flex-wrap items-center gap-3">
                    <span className="flex items-center gap-1.5 px-3 py-1 bg-slate-100 dark:bg-slate-800 rounded-lg text-[10px] font-bold text-slate-600 dark:text-slate-300 uppercase tracking-wide">
                      <Calendar size={12} /> {lesson.date}
                    </span>
                    <span className="flex items-center gap-1.5 px-3 py-1 bg-slate-100 dark:bg-slate-800 rounded-lg text-[10px] font-bold text-slate-600 dark:text-slate-300 uppercase tracking-wide">
                      <Clock size={12} /> {lesson.time}
                    </span>
                  </div>
                </div>
              </div>

              <button
                onClick={() => handleRegister(lesson)}
                className="w-full md:w-auto flex items-center justify-center gap-3 bg-slate-900 dark:bg-white text-white dark:text-slate-900 px-8 py-4 rounded-xl font-black text-xs uppercase tracking-widest hover:scale-105 hover:bg-tenant-primary dark:hover:bg-tenant-primary dark:hover:text-white transition-all shadow-lg active:scale-95 group/btn"
              >
                Regularizar <ChevronRight size={16} className="group-hover/btn:translate-x-1 transition-transform" />
              </button>
            </div>
          ))}

          {pending.length === 0 && (
            <div className="text-center py-24 bg-white dark:bg-slate-900 rounded-[3rem] border border-dashed border-slate-200 dark:border-slate-800 animate-in zoom-in duration-500">
              <div className="w-24 h-24 bg-emerald-50 dark:bg-emerald-900/10 text-emerald-500 dark:text-emerald-400 rounded-full flex items-center justify-center mx-auto mb-6 shadow-xl shadow-emerald-500/10">
                <CheckSquare size={48} strokeWidth={1.5} />
              </div>
              <h4 className="text-2xl font-black text-slate-800 dark:text-white uppercase tracking-tight">Tudo em Dia!</h4>
              <p className="text-sm text-slate-400 dark:text-slate-500 mt-2 font-medium max-w-xs mx-auto">
                Nenhuma aula pendente nos últimos 7 dias.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Single Lesson Modal */}
      {selectedLesson && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-md animate-in fade-in duration-300">
          <div className="w-full max-w-[90%] lg:max-w-7xl">
            <ClassLogForm
              items={[{
                id: selectedLesson.id,
                name: selectedLesson.student,
                date: `${selectedLesson.date} às ${selectedLesson.time}`,
                level: selectedLesson.module.split('•')[0].trim() || 'N/A'
              }]}
              onCancel={() => setSelectedLesson(null)}
              onSave={handleSave}
              title="Regularizar Aula"
              loading={isSubmitting}
            />
          </div>
        </div>
      )}

      {/* Bulk Regularize Modal */}
      {isBulkRegularizing && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-md animate-in fade-in duration-300">
          <div className="w-full max-w-[90%] lg:max-w-7xl">
            <ClassLogForm
              items={pending.map(p => ({
                id: p.id,
                name: p.student,
                date: `${p.date} às ${p.time}`,
                level: p.module.split('•')[0].trim() || 'N/A'
              }))}
              onCancel={() => setIsBulkRegularizing(false)}
              onSave={handleSave}
              title="Regularizar Todas as Pendências"
              loading={isSubmitting}
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default PendingLessons;
