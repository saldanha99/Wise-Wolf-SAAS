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
  const [selectedStudent, setSelectedStudent] = useState<any | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [loading, setLoading] = useState(true);
  const [todayLessons, setTodayLessons] = useState<any[]>([]);

  useEffect(() => {
    if (user && tenantId) {
      fetchTodaySchedule();
    }
  }, [user, tenantId]);

  const fetchTodaySchedule = async () => {
    setLoading(true);
    try {
      const DAYS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
      const today = new Date();
      const todayStr = today.toISOString().split('T')[0];
      const todayDay = DAYS[today.getDay()];

      const startDate = new Date();
      startDate.setDate(today.getDate() - 7);

      const allLessons: any[] = [];
      const currentDate = new Date();

      // FIX: appointments.teacher_id é null — o vínculo com o professor está em
      // opportunities.winner_teacher_id. Buscar os IDs de appointments via opportunities.
      // Também corrigi: appointments usa start_time (timestamp), não date/time.
      const { data: teacherOpps } = await supabase
        .from('opportunities')
        .select('trial_appointment_id')
        .eq('winner_teacher_id', user.id)
        .eq('tenant_id', tenantId)
        .not('trial_appointment_id', 'is', null);

      const trialApptIds = teacherOpps?.map((o: any) => o.trial_appointment_id).filter(Boolean) || [];

      let allTrialAppointments: any[] = [];
      if (trialApptIds.length > 0) {
        const { data: trialAppts } = await supabase
          .from('appointments')
          .select('id, start_time, student_name, student_phone, type, status')
          .in('id', trialApptIds)
          .in('type', ['experimental', 'training']);
        allTrialAppointments = trialAppts || [];
      }

      for (let i = 0; i < 8; i++) {
        const checkDate = new Date();
        checkDate.setDate(today.getDate() - i);
        const dateStr = checkDate.toISOString().split('T')[0];
        const dayName = DAYS[checkDate.getDay()];

        if (dayName === 'Domingo') continue;

        const { data: bookings } = await supabase
          .from('bookings')
          .select('id, time_slot, start_date, student:student_id(id, full_name, email, avatar_url, module, current_topic_id, status)')
          .eq('teacher_id', user.id)
          .eq('day_of_week', dayName);

        const { data: reschedules } = await supabase
          .from('reschedules')
          .select('id, time, fault_type, student:student_id(id, full_name, email, avatar_url, module, current_topic_id, status)')
          .eq('teacher_id', user.id)
          .eq('date', dateStr);

        // Filtrar os trials deste professor para este dia específico
        const appointments = allTrialAppointments.filter(t => {
          const apptDate = new Date(t.start_time);
          return apptDate.toISOString().split('T')[0] === dateStr;
        });

        const { data: logs } = await supabase
          .from('class_logs')
          .select('booking_id, reschedule_id, appointment_id')
          .eq('teacher_id', user.id)
          .eq('class_date', dateStr);

        // Helper to process lesson
        const processLesson = async (b: any, type: 'REGULAR' | 'REPOSIÇÃO', time: string) => {
          const student = b.student as any;
          if (!student) return;

          // Fetch Topic Info if exists
          let topicInfo = null;
          if (student.current_topic_id) {
            const { data: t } = await supabase
              .from('module_topics')
              .select('title, base_material:base_material_id(title, file_url)')
              .eq('id', student.current_topic_id)
              .single();
            topicInfo = t;
          }

          const isTrial = student.status === 'TRIAL' || student.status === 'Aula Experimental';

          allLessons.push({
            id: type === 'REGULAR' ? b.id : `repo-${b.id}`,
            studentId: student.id,
            name: student.full_name || 'Estudante',
            email: student.email, // Added email
            date: i === 0 ? `Hoje às ${time}` : `${checkDate.toLocaleDateString('pt-BR')} às ${time}${type === 'REPOSIÇÃO' && !isTrial ? ' (Rep)' : ''}`,
            dateObj: dateStr,
            avatar: student.avatar_url || `https://ui-avatars.com/api/?name=${student.full_name}`,
            level: student.module?.split(' ')[0] || 'N/A',
            type: isTrial ? 'AULA EXPERIMENTAL' : type,
            // Origem da reposição (só relevante para REPOSIÇÃO): TEACHER paga, STUDENT não
            faultType: type === 'REPOSIÇÃO' ? (b.fault_type || 'STUDENT') : null,
            isLate: i > 0,
            suggestedTopic: topicInfo?.title || null,
            suggestedMaterial: topicInfo?.base_material?.title || null,
            suggestedMaterialUrl: topicInfo?.base_material?.file_url || null
          });
        };

        // Bookings
        if (bookings) {
          // Defesa contra agendamentos duplicados: no mesmo dia, só processa 1 aula
          // por horário (evita que bookings redundantes virem várias aulas a lançar).
          const slotSeen = new Set<string>();
          for (const b of bookings) {
            if (b.start_date && dateStr < b.start_date) continue;
            if (i === 0) {
              const [h, m] = b.time_slot.split(':').map(Number);
              if (new Date().setHours(h, m, 0, 0) > currentDate.getTime()) continue;
            }
            if (slotSeen.has(b.time_slot)) continue; // horário já coberto neste dia
            slotSeen.add(b.time_slot);
            if (!logs?.some(l => l.booking_id === b.id)) {
              await processLesson(b, 'REGULAR', b.time_slot);
            }
          }
        }

        // Reschedules
        if (reschedules) {
          for (const r of reschedules) {
            if (i === 0) {
              const [h, m] = (r as any).time.split(':').map(Number);
              if (new Date().setHours(h, m, 0, 0) > currentDate.getTime()) continue;
            }
            if (!logs?.some(l => l.reschedule_id === r.id)) {
              await processLesson(r, 'REPOSIÇÃO', (r as any).time);
            }
          }
        }

        // Trials e Treinamentos (from appointments via opportunities)
        for (const t of appointments) {
          // Extrair hora/minuto do start_time (timestamp UTC)
          const apptDate = new Date(t.start_time);
          const timeStr = `${String(apptDate.getUTCHours()).padStart(2, '0')}:${String(apptDate.getUTCMinutes()).padStart(2, '0')}`;

          if (i === 0) {
            const [h, m] = timeStr.split(':').map(Number);
            if (new Date().setHours(h, m, 0, 0) > currentDate.getTime()) continue;
          }
          if (!logs?.some(l => l.appointment_id === t.id)) {
            const isTraining = t.type === 'training';
            allLessons.push({
              id: `trial-${t.id}`,
              studentId: null,
              leadName: t.student_name,
              leadPhone: t.student_phone,
              name: t.student_name || (isTraining ? 'Treinamento' : 'Aula Experimental'),
              date: i === 0 ? `Hoje às ${timeStr}` : `${checkDate.toLocaleDateString('pt-BR')} às ${timeStr}`,
              dateObj: dateStr,
              avatar: `https://ui-avatars.com/api/?name=${t.student_name || (isTraining ? 'T' : 'E')}`,
              level: isTraining ? 'TREINO' : 'TRIAL',
              type: isTraining ? 'TREINAMENTO' : 'AULA EXPERIMENTAL',
              isLate: i > 0,
              suggestedTopic: isTraining ? 'Treinamento Wise Wolf' : 'Avaliação de Nível',
              suggestedMaterial: null
            });
          }
        }
      }

      const currentMonthYear = `${today.getFullYear()}-${(today.getMonth() + 1).toString().padStart(2, '0')}`;
      setTodayLessons(allLessons
        .filter(l => l.dateObj.substring(0, 7) === currentMonthYear)
        .sort((a, b) => a.isLate === b.isLate ? 0 : a.isLate ? 1 : -1)
      );
    } catch (err) {
      console.error('Error fetching today schedule:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleBulkSave = async (formData: any) => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      // Validação de Fechamento Automático removida para permitir lançamento retroativo flexível
      const entries = Object.keys(formData).map(bookingId => {
        const item = todayLessons.find(l => String(l.id) === bookingId);
        const data = formData[bookingId];

        if (!item) return null;

        const isReschedule = String(bookingId).startsWith('repo-');
        const isTrial = String(bookingId).startsWith('trial-');

        return {
          tenant_id: tenantId,
          teacher_id: user.id,
          student_id: item.studentId || null,
          booking_id: (!isReschedule && !isTrial) ? bookingId : null,
          reschedule_id: isReschedule ? bookingId.replace('repo-', '') : null,
          appointment_id: isTrial ? bookingId.replace('trial-', '') : null,
          presence: data.type || 'Presença',
          // Reposição de falta do PROFESSOR é paga (REPOSIÇÃO_PROF); de falta do ALUNO não (REPOSIÇÃO)
          subtype: item.type === 'AULA EXPERIMENTAL'
            ? 'AULA EXPERIMENTAL'
            : item.type === 'TREINAMENTO'
              ? 'TREINAMENTO'
              : (isReschedule
                  ? (item.faultType === 'TEACHER' ? 'REPOSIÇÃO_PROF' : 'REPOSIÇÃO')
                  : (data.subtype || null)),
          content_covered: data.lastApplied || null, // Book Selection
          observations: data.observation || null, // Free text OBS

          // Trial Fields
          assessment_level: item.type === 'AULA EXPERIMENTAL' ? data.assessment_level : null,
          psychological_profile: item.type === 'AULA EXPERIMENTAL' ? data.psychological_profile : null,
          teacher_verdict: item.type === 'AULA EXPERIMENTAL' ? data.teacher_verdict : null,

          // Legacy fields mapping
          content: data.lastApplied || null,
          class_date: item.dateObj, // Use the real date of the class
          created_at: new Date().toISOString()
        };
      }).filter(Boolean);

      if (entries.length > 0) {
        // 1. Insert Class Logs
        const { error: logError } = await supabase.from('class_logs').insert(entries);
        if (logError) throw logError;

        // Update CRM Leads to TRIAL_DONE
        const trialEntries = (entries as any[]).filter(e => e.subtype === 'AULA EXPERIMENTAL');
        if (trialEntries.length > 0) {
          for (const entry of trialEntries) {
            const item = todayLessons.find(l => String(l.id) === `trial-${entry.appointment_id}`);
            
            if (entry.student_id) {
              // Update by student_id if we have it
              await supabase.from('crm_leads')
                .update({ status: 'TRIAL_DONE' })
                .eq('student_id', entry.student_id)
                .eq('tenant_id', tenantId);
            } else if (item?.leadPhone) {
              // Update by phone if no student_id
              await supabase.from('crm_leads')
                .update({ status: 'TRIAL_DONE' })
                .eq('phone', item.leadPhone)
                .eq('tenant_id', tenantId);
            }
          }
        }

        // 2. Clear used Reschedules if any
        const completedReschedules = entries.filter(e => e.reschedule_id).map(e => e.reschedule_id);
        if (completedReschedules.length > 0) {
          await supabase.from('reschedules').delete().in('id', completedReschedules);
        }

        // 3. Create credits for absences
        const absences = (entries as any[]).filter(e =>
          (e.presence === 'STUDENT_ABSENCE' || e.presence === 'Falta Justificada' || e.presence === 'TEACHER_ABSENCE')
          && e.subtype !== 'REPOSIÇÃO'
        );

        if (absences.length > 0) {
          const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();

          for (const a of absences) {
            // Rule: Teacher Fault = Always Create. Student Fault = Limit 5.
            const isTeacherFault = a.presence === 'TEACHER_ABSENCE';

            // Limite de 5 reposições por falta de ALUNO no mês (falta do professor é ilimitada)
            const { count, error: countError } = await supabase
              .from('reschedules')
              .select('id', { count: 'exact', head: true })
              .eq('student_id', a.student_id)
              .eq('fault_type', 'STUDENT')
              .gte('created_at', startOfMonth);

            const currentCount = count || 0;
            const canCreate = isTeacherFault || currentCount < 5;

            if (!countError && canCreate) {
              await supabase.from('reschedules').insert([{
                tenant_id: tenantId,
                teacher_id: user.id,
                student_id: a.student_id,
                original_booking_id: a.booking_id,
                date: 'Pendente',
                time: 'Pendente',
                // Marca a origem: TEACHER → reposição paga; STUDENT → não paga
                fault_type: isTeacherFault ? 'TEACHER' : 'STUDENT',
                created_at: new Date().toISOString(),
              }]);
            }
          }
        }
      }

      setShowSuccess(true);
      if (onRefresh) onRefresh();
      setTimeout(() => setShowSuccess(false), 3000);
      await fetchTodaySchedule();
    } catch (err: any) {
      console.error('Save Error:', err);
      alert(`Erro: ${err.message}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="max-w-6xl mx-auto space-y-8 animate-in fade-in duration-500 relative h-[calc(100vh-140px)] flex flex-col">

      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 pb-4 border-b border-brand-border shrink-0">
        <div>
          <h2 className="text-4xl font-black text-brand-text tracking-tighter">Lançamento Rápido</h2>
          <p className="text-brand-muted text-sm mt-1">Registre a presença e conteúdo das aulas de hoje.</p>
        </div>
        <div className="hidden md:flex items-center gap-2 text-xs font-bold text-brand-muted bg-brand-surface-2 dark:bg-brand-surface px-4 py-2 rounded-full border border-brand-border">
          <Calendar size={14} />
          {new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })}
        </div>
      </div>

      {/* Success Toast */}
      {showSuccess && (
        <div className="fixed top-10 right-10 z-50 bg-emerald-500 text-white px-6 py-4 rounded-2xl shadow-2xl flex items-center gap-4 animate-in slide-in-from-right duration-500">
          <div className="bg-brand-surface/20 p-2 rounded-full"><CheckCircle size={20} /></div>
          <div>
            <p className="font-black uppercase text-xs tracking-widest">Sucesso!</p>
            <p className="text-sm font-medium">Aulas registradas com perfeição.</p>
          </div>
        </div>
      )}

      {/* Bulk Form */}
      <div className="flex-1 min-h-0">
        {loading ? (
          <div className="flex flex-col items-center justify-center h-64 text-brand-muted">
            <RefreshCw className="animate-spin mb-4" size={32} />
            <p className="text-sm font-bold uppercase tracking-widest">Sincronizando Agenda...</p>
          </div>
        ) : todayLessons.length > 0 ? (
          <ClassLogForm
            items={todayLessons}
            onSave={handleBulkSave}
            title="Aulas Programadas para Hoje"
            loading={isSubmitting}
          />
        ) : (
          <div className="flex flex-col items-center justify-center p-20 bg-brand-surface rounded-[3rem] border border-dashed border-brand-border dark:border-brand-border">
            <div className="w-20 h-20 bg-brand-surface-2 rounded-3xl flex items-center justify-center text-slate-300 mb-6">
              <Calendar size={40} />
            </div>
            <h4 className="text-2xl font-black text-brand-text tracking-tight">Sem aulas hoje</h4>
            <p className="text-sm text-brand-muted mt-2 font-medium">Você não possui aulas agendadas para esta {new Date().toLocaleDateString('pt-BR', { weekday: 'long' })}.</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default LessonLauncher;
