import React, { useState, useEffect } from 'react';
import { Save, User as UserIcon, BookOpen, ChevronRight, Sparkles, AlertCircle, CheckCircle, ArrowLeft, RefreshCw, Clock, X, MoreHorizontal, Calendar } from 'lucide-react';
import { getPedagogicalSuggestion } from '../services/geminiService';
import ClassLogForm from './ClassLogForm';
import { supabase } from '../lib/supabase';
import { localYMD } from '../lib/dateUtils';
import { splitAlreadyLogged } from '../lib/classLogGuard';
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
  const [launchedTodayCount, setLaunchedTodayCount] = useState(0); // aulas de hoje já lançadas (confirmação visual)
  const [dupNotice, setDupNotice] = useState<string | null>(null); // aviso quando uma aula já estava lançada (não duplicada)
  const [loadError, setLoadError] = useState<string | null>(null);

  // A escola do professor vem do próprio perfil quando o App não resolveu o tenant.
  // Sem este fallback a tela ficava PARADA no "Sincronizando Agenda..." para sempre —
  // foi assim que uma mudança de permissão em `tenants` derrubou o lançamento de aulas
  // de todos os professores sem nenhum erro visível.
  const effectiveTenantId = tenantId || user?.tenantId;

  useEffect(() => {
    if (user && effectiveTenantId) {
      fetchTodaySchedule();
    } else if (user) {
      setLoading(false);
      setLoadError('Não conseguimos identificar sua escola nesta sessão. Recarregue a página (ou saia e entre de novo) — se continuar assim, avise a direção.');
    }
  }, [user, effectiveTenantId]);

  const fetchTodaySchedule = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const DAYS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
      const today = new Date();
      // localYMD (NUNCA toISOString): depois das 21h a data UTC pula pro dia seguinte
      // e a aula era listada com a data errada — gerava lançamento duplicado no fechamento.
      const todayStr = localYMD(today);
      const todayDay = DAYS[today.getDay()];

      // Janela de lançamento ampliada: cobre atrasos e a virada de mês (antes eram só 8 dias).
      const LOOKBACK_DAYS = 45;
      const startDate = new Date();
      startDate.setDate(today.getDate() - LOOKBACK_DAYS);
      const startStr = localYMD(startDate);

      const allLessons: any[] = [];
      let launchedToday = 0; // quantas aulas de HOJE já foram lançadas (confirmação visual)

      // Link de reunião do professor (buscado uma única vez; usado no botão "Avisar aluno").
      const { data: tProf } = await supabase
        .from('profiles').select('meeting_link').eq('id', user.id).maybeSingle();
      const teacherMeetLink: string | null = tProf?.meeting_link || null;

      // FIX: appointments.teacher_id é null — o vínculo com o professor está em
      // opportunities.winner_teacher_id. Buscar os IDs de appointments via opportunities.
      // Também corrigi: appointments usa start_time (timestamp), não date/time.
      const { data: teacherOpps } = await supabase
        .from('opportunities')
        .select('trial_appointment_id')
        .eq('winner_teacher_id', user.id)
        .eq('tenant_id', effectiveTenantId)
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

      // BUSCAS EM LOTE (1x cada) — antes eram N consultas por dia; com 45 dias isso
      // ficaria lento. Buscamos tudo da janela e filtramos em memória por dia.
      const { data: allBookings } = await supabase
        .from('bookings')
        .select('id, time_slot, start_date, day_of_week, student:student_id(id, full_name, email, phone, meeting_link, avatar_url, module, current_topic_id, status)')
        .eq('teacher_id', user.id)
        .not('day_of_week', 'is', null);

      const { data: allReschedules } = await supabase
        .from('reschedules')
        .select('id, time, date, fault_type, student:student_id(id, full_name, email, phone, meeting_link, avatar_url, module, current_topic_id, status)')
        .eq('teacher_id', user.id)
        .gte('date', startStr);

      const { data: allLogs } = await supabase
        .from('class_logs')
        .select('booking_id, reschedule_id, appointment_id, class_date')
        .eq('teacher_id', user.id)
        .gte('class_date', startStr);

      launchedToday = (allLogs || []).filter((l: any) => l.class_date === todayStr).length;

      for (let i = 0; i < LOOKBACK_DAYS; i++) {
        const checkDate = new Date();
        checkDate.setDate(today.getDate() - i);
        const dateStr = localYMD(checkDate);
        const dayName = DAYS[checkDate.getDay()];

        if (dayName === 'Domingo') continue;

        const bookings = (allBookings || []).filter((b: any) => b.day_of_week === dayName);
        const reschedules = (allReschedules || []).filter((r: any) => r.date === dateStr);

        // Filtrar os trials deste professor para este dia específico
        const appointments = allTrialAppointments.filter(t => {
          const apptDate = new Date(t.start_time);
          return localYMD(apptDate) === dateStr;
        });

        const logs = (allLogs || []).filter((l: any) => l.class_date === dateStr);

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
            time, // horário HH:MM da aula (para o botão "Avisar aluno")
            phone: student.phone || null,
            meetLink: teacherMeetLink || student.meeting_link || null,
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

        // Helper: checa se um horário HH:MM ainda está no futuro (hoje).
        // Usa Date.now() para comparação sempre fresca (evita stale de async).
        const isStillFutureToday = (timeSlot: string | null | undefined): boolean => {
          if (!timeSlot) return false; // slot nulo → considerar passado (não bloqueia)
          const parts = timeSlot.split(':');
          const h = parseInt(parts[0], 10);
          const m = parseInt(parts[1] || '0', 10);
          if (isNaN(h) || isNaN(m)) return false;
          const classTs = new Date();
          classTs.setHours(h, m, 0, 0);
          return classTs.getTime() > Date.now();
        };

        // Bookings
        if (bookings) {
          // Defesa contra agendamentos duplicados: no mesmo dia, só processa 1 aula
          // por horário (evita que bookings redundantes virem várias aulas a lançar).
          const slotSeen = new Set<string>();
          for (const b of bookings) {
            if (b.start_date && dateStr < b.start_date) continue;
            // Hoje: ocultar aulas que ainda não chegou o horário
            if (i === 0 && isStillFutureToday(b.time_slot)) continue;
            if (!b.time_slot) continue; // booking sem horário definido: ignorar
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
            const rTime = (r as any).time;
            if (i === 0 && isStillFutureToday(rTime)) continue;
            if (!logs?.some(l => l.reschedule_id === r.id)) {
              await processLesson(r, 'REPOSIÇÃO', rTime || '');
            }
          }
        }

        // Trials e Treinamentos (from appointments via opportunities)
        for (const t of appointments) {
          // Extrair hora/minuto do start_time (timestamp UTC → converte p/ horário local BRT)
          const apptDate = new Date(t.start_time);
          const timeStr = `${String(apptDate.getHours()).padStart(2, '0')}:${String(apptDate.getMinutes()).padStart(2, '0')}`;

          if (i === 0 && isStillFutureToday(timeStr)) continue;
          if (!logs?.some(l => l.appointment_id === t.id)) {
            const isTraining = t.type === 'training';
            allLessons.push({
              id: `trial-${t.id}`,
              studentId: null,
              leadName: t.student_name,
              leadPhone: t.student_phone,
              time: timeStr, // horário HH:MM (para o botão "Avisar aluno")
              phone: t.student_phone || null,
              meetLink: teacherMeetLink || null,
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

      setLaunchedTodayCount(launchedToday);
      // Mostra tudo dentro da janela de 45 dias (inclui mês anterior). Antes filtrava só o
      // mês atual, escondendo aulas atrasadas da virada de mês e impedindo o lançamento.
      setTodayLessons(allLessons
        .sort((a, b) => a.isLate === b.isLate ? 0 : a.isLate ? 1 : -1)
      );
    } catch (err: any) {
      console.error('Error fetching today schedule:', err);
      // Limpa o estado para evitar que aulas "fantasma" (stale) fiquem visíveis
      // após um erro, o que causava relançamentos duplicados.
      setTodayLessons([]);
      // Erro visível: "sem aulas hoje" escondia falha de carregamento e o professor
      // achava que não tinha nada para lançar.
      setLoadError(err?.message || 'Não foi possível carregar sua agenda agora.');
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
          tenant_id: effectiveTenantId,
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

      // Guarda de origem cruzada: barra aula relançada como reposição quando o mesmo
      // aluno já tem lançamento naquela data (as travas do banco não cobrem esse caso).
      const { allowed, blocked: crossOriginDups } = await splitAlreadyLogged(supabase, user.id, entries as any[]);
      let blockedDuplicates = crossOriginDups.length; // aulas que já estavam lançadas
      if (allowed.length > 0) {
        // 1. Insert Class Logs — resiliente: se uma aula já foi lançada (23505), NÃO
        // derruba o lote inteiro. Cai pra inserção linha-a-linha e ignora as duplicatas
        // (a trava de unicidade do banco garante que nunca há pagamento dobrado).
        const { error: logError } = await supabase.from('class_logs').insert(allowed);
        if (logError) {
          if (logError.code === '23505') {
            for (const e of allowed) {
              const { error: rowErr } = await supabase.from('class_logs').insert([e]);
              if (rowErr) {
                if (rowErr.code === '23505') {
                  blockedDuplicates++;
                  console.warn('[LessonLauncher] Aula já lançada — ignorada (sem duplicar):', e.booking_id || e.appointment_id || e.reschedule_id);
                } else {
                  throw rowErr;
                }
              }
            }
          } else {
            throw logError;
          }
        }

        // Update CRM Leads to TRIAL_DONE
        const trialEntries = (allowed as any[]).filter(e => e.subtype === 'AULA EXPERIMENTAL');
        if (trialEntries.length > 0) {
          for (const entry of trialEntries) {
            const item = todayLessons.find(l => String(l.id) === `trial-${entry.appointment_id}`);
            
            if (entry.student_id) {
              // Update by student_id if we have it
              await supabase.from('crm_leads')
                .update({ status: 'TRIAL_DONE' })
                .eq('student_id', entry.student_id)
                .eq('tenant_id', effectiveTenantId);
            } else if (item?.leadPhone) {
              // Update by phone if no student_id
              await supabase.from('crm_leads')
                .update({ status: 'TRIAL_DONE' })
                .eq('phone', item.leadPhone)
                .eq('tenant_id', effectiveTenantId);
            }
          }
        }

        // 2. Clear used Reschedules if any
        const completedReschedules = allowed.filter(e => e.reschedule_id).map(e => e.reschedule_id);
        if (completedReschedules.length > 0) {
          await supabase.from('reschedules').delete().in('id', completedReschedules);
        }

        // 3. Create credits for absences
        const absences = (allowed as any[]).filter(e =>
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
                tenant_id: effectiveTenantId,
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

      if (blockedDuplicates > 0) {
        setDupNotice(`${blockedDuplicates} aula(s) já estavam lançadas e foram mantidas — não duplicamos nada. ✓`);
        setTimeout(() => setDupNotice(null), 6000);
        // Auditoria leve (best-effort, nunca quebra o fluxo): registra a tentativa barrada.
        try {
          await supabase.from('debug_logs').insert([{
            message: `[LessonLauncher] ${blockedDuplicates} lançamento(s) duplicado(s) barrado(s) — prof ${user.id} / tenant ${effectiveTenantId}`
          }]);
        } catch (_) { /* ignora: o console.warn já registrou */ }
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

      {/* Aviso: aula já estava lançada (não duplicada) — tranquiliza em vez de erro */}
      {dupNotice && (
        <div className="fixed top-28 right-10 z-50 bg-amber-500 text-white px-6 py-4 rounded-2xl shadow-2xl flex items-center gap-3 animate-in slide-in-from-right duration-500 max-w-sm">
          <CheckCircle size={20} className="shrink-0" />
          <p className="text-sm font-medium">{dupNotice}</p>
        </div>
      )}

      {/* Bulk Form */}
      <div className="flex-1 min-h-0">
        {loading ? (
          <div className="flex flex-col items-center justify-center h-64 text-brand-muted">
            <RefreshCw className="animate-spin mb-4" size={32} />
            <p className="text-sm font-bold uppercase tracking-widest">Sincronizando Agenda...</p>
          </div>
        ) : loadError ? (
          <div className="flex flex-col items-center justify-center p-16 bg-brand-surface rounded-[3rem] border border-dashed border-red-300 dark:border-red-800/50 text-center">
            <div className="w-16 h-16 bg-red-50 dark:bg-red-900/20 rounded-3xl flex items-center justify-center text-red-500 mb-5">
              <AlertCircle size={32} />
            </div>
            <h4 className="text-xl font-black text-brand-text tracking-tight">Não deu para carregar sua agenda</h4>
            <p className="text-sm text-brand-muted mt-2 font-medium max-w-md">{loadError}</p>
            <p className="text-xs text-brand-muted mt-3 font-medium">Nenhuma aula foi perdida — assim que a tela carregar, as aulas atrasadas continuam aqui para lançar.</p>
            <button
              onClick={fetchTodaySchedule}
              className="mt-6 px-6 py-3 bg-tenant-primary text-white rounded-xl font-black text-xs uppercase tracking-widest flex items-center gap-2"
            >
              <RefreshCw size={14} /> Tentar de novo
            </button>
          </div>
        ) : todayLessons.length > 0 ? (
          <div className="space-y-4">
            {/* Resumo: hoje · atrasadas · já lançadas (confirmação visual) */}
            {(() => {
              const lateCount = todayLessons.filter(l => l.isLate).length;
              const todayCount = todayLessons.length - lateCount;
              return (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[11px] font-black uppercase tracking-widest px-3 py-1.5 rounded-full bg-tenant-primary/10 text-tenant-primary border border-tenant-primary/20">A lançar hoje: {todayCount}</span>
                  {lateCount > 0 && <span className="text-[11px] font-black uppercase tracking-widest px-3 py-1.5 rounded-full bg-amber-100 text-amber-700 border border-amber-200 dark:bg-amber-900/30 dark:text-amber-300">Atrasadas: {lateCount}</span>}
                  <span className="text-[11px] font-black uppercase tracking-widest px-3 py-1.5 rounded-full bg-emerald-100 text-emerald-700 border border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300">✓ Já lançadas hoje: {launchedTodayCount}</span>
                </div>
              );
            })()}

            {/* Faixa explicativa das atrasadas — mata a confusão de "achei que não contou" */}
            {todayLessons.some(l => l.isLate) && (
              <div className="flex items-start gap-3 p-4 rounded-2xl bg-amber-50 dark:bg-amber-900/15 border border-amber-200 dark:border-amber-800/40">
                <Clock size={18} className="text-amber-500 shrink-0 mt-0.5" />
                <p className="text-xs text-amber-800 dark:text-amber-200 font-medium leading-relaxed">
                  Há aulas de <strong>dias anteriores</strong> ainda não lançadas (marcadas como atrasadas). Cada aula só pode ser lançada <strong>uma vez</strong> — lançar aqui <strong>não duplica</strong>. Aulas já lançadas somem desta lista e entram no contador "✓ Já lançadas".
                </p>
              </div>
            )}

            {(() => {
              // Separa as reposições numa seção dedicada — depois de agendadas e feitas, o
              // professor confirma aqui o que aconteceu (presença / falta do aluno / falta do prof).
              const repos = todayLessons.filter(l => l.type === 'REPOSIÇÃO');
              const regular = todayLessons.filter(l => l.type !== 'REPOSIÇÃO');
              return (
                <div className="space-y-6">
                  {regular.length > 0 && (
                    <ClassLogForm
                      items={regular}
                      onSave={handleBulkSave}
                      title="Aulas Programadas para Hoje"
                      loading={isSubmitting}
                    />
                  )}

                  {repos.length > 0 && (
                    <div className="space-y-3">
                      <div className="flex items-center gap-2">
                        <RefreshCw size={16} className="text-tenant-primary" />
                        <h3 className="text-sm font-black text-brand-text uppercase tracking-widest">Reposições a confirmar</h3>
                        <span className="text-[10px] font-black uppercase bg-tenant-primary/10 text-tenant-primary px-3 py-1 rounded-full">{repos.length}</span>
                      </div>
                      <p className="text-xs text-brand-muted">
                        Reposições agendadas e realizadas. Confirme o que aconteceu — presença, falta do aluno ou falta do professor. Reposição feita é sempre paga a quem deu a aula; só não é paga se a aula tiver sido coberta provisoriamente por outro professor.
                      </p>
                      <ClassLogForm
                        items={repos}
                        onSave={handleBulkSave}
                        title="Lançamento de Reposições"
                        loading={isSubmitting}
                      />
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
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
