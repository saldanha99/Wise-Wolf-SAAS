import React, { useState, useEffect } from 'react';
import { AlertCircle, RefreshCw, Clock, Calendar } from 'lucide-react';
import ClassLogForm from './ClassLogForm';
import { supabase } from '../lib/supabase';
import { localYMD } from '../lib/dateUtils';
import { logTeacherClasses, calcularXp, ClassLogEntryInput, ClassLogResult, XpBreakdown } from '../lib/classLogging';
import { bookingsAindaNaoLancados } from '../lib/lessonMatching';
import ClassLogReward from './ClassLogReward';
import { User as UserType } from '../types';

interface LessonLauncherProps {
  user: UserType;
  tenantId?: string;
  onRefresh?: () => void;
}

// Uma aula é identificada por AGENDAMENTO + DATA. Usar só o id do booking (como
// era até 13/08/2026) fazia o mesmo agendamento semanal virar N itens com o
// MESMO id dentro da janela de 45 dias: o React repetia a chave, o formulário
// sobrescrevia os campos e o `find` do envio pegava sempre o primeiro. Resultado
// medido na conta do Flávio: 78 itens na tela para 21 agendamentos — ele
// preenchia 6 aulas do mesmo aluno e só 1 era lançada; as outras 5 voltavam.
const lessonRef = (bookingId: string, dateStr: string) => `${bookingId}|${dateStr}`;
const bookingFromRef = (ref: string) => ref.split('|')[0];

interface NotStartedRow {
  bookingId: string;
  name: string;
  time: string;
  dayOfWeek: string;
  startsOn: string;
}

const LessonLauncher: React.FC<LessonLauncherProps> = ({ user, tenantId, onRefresh }) => {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [todayLessons, setTodayLessons] = useState<any[]>([]);
  // Agendamentos que existem mas cuja matrícula ainda não começou: uma linha por
  // agendamento, não uma por dia da janela.
  const [notStarted, setNotStarted] = useState<NotStartedRow[]>([]);
  const [launchedTodayCount, setLaunchedTodayCount] = useState(0); // aulas de hoje já lançadas (confirmação visual)
  const [loadError, setLoadError] = useState<string | null>(null);
  // Recompensa do lançamento: caixa real (servidor) + XP (arcade). Substitui o
  // antigo toast "Aulas registradas com perfeição", que não dizia número nenhum.
  const [reward, setReward] = useState<{ result: ClassLogResult; xp: XpBreakdown } | null>(null);

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
      // Fim da janela = hoje (o lançador só trata aula que já aconteceu).
      const endStr = localYMD(today);

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
        .eq('status', 'SCHEDULED')
        .not('day_of_week', 'is', null);

      // COBERTURAS confirmadas da janela: aula que este professor CEDEU sai da
      // lista dele (ele não deu, não pode lançar nem receber) e aula que ele
      // ASSUMIU entra — mesmo sendo agendamento de outro professor.
      const { data: coverages } = await supabase.rpc('coverages_for_teacher', {
        p_teacher: user.id, p_from: startStr, p_to: endStr,
      });
      const covList = (coverages as any[]) || [];
      const cedidas = new Set(
        covList.filter(c => c.papel === 'cedida').map(c => `${c.booking_id}|${c.class_date}`)
      );
      const assumidas = covList.filter(c => c.papel === 'assumida');

      // Agendamentos assumidos pertencem a OUTRO professor, então não vêm em
      // allBookings — buscamos os que faltam para montar a aula com o aluno certo.
      let assumedBookings: any[] = [];
      if (assumidas.length > 0) {
        const ids = Array.from(new Set(assumidas.map(c => c.booking_id).filter(Boolean)));
        if (ids.length > 0) {
          const { data } = await supabase
            .from('bookings')
            .select('id, time_slot, start_date, day_of_week, student:student_id(id, full_name, email, phone, meeting_link, avatar_url, module, current_topic_id, status)')
            .in('id', ids)
            .eq('status', 'SCHEDULED');
          assumedBookings = (data as any[]) || [];
        }
      }

      const { data: allReschedules } = await supabase
        .from('reschedules')
        .select('id, time, date, fault_type, student:student_id(id, full_name, email, phone, meeting_link, avatar_url, module, current_topic_id, status)')
        .eq('teacher_id', user.id)
        .gte('date', startStr);

      // `student_id` entra aqui porque o casamento por booking_id não basta: quando
      // o agendamento é trocado (aluno muda de horário), o log antigo continua
      // apontando para um booking que não existe mais e a aula JÁ LANÇADA voltava
      // para a lista. Medido no Flávio: 12 aulas de julho nessa situação.
      const { data: allLogs } = await supabase
        .from('class_logs')
        .select('booking_id, reschedule_id, appointment_id, student_id, class_date')
        .eq('teacher_id', user.id)
        .gte('class_date', startStr);

      launchedToday = (allLogs || []).filter((l: any) => l.class_date === todayStr).length;

      const naoIniciados = new Map<string, NotStartedRow>();

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
            id: type === 'REGULAR' ? lessonRef(b.id, dateStr) : `repo-${b.id}`,
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
          const candidatos: any[] = [];
          for (const b of bookings) {
            // Cedida por cobertura: quem dá a aula é outro professor.
            if (cedidas.has(`${b.id}|${dateStr}`)) continue;
            // Matrícula que ainda não começou nesta data: não vira aula a lançar.
            // O professor continua sabendo que o aluno existe — o agendamento é
            // listado UMA vez no bloco "Ainda não começaram", e não uma vez por dia
            // da janela (eram 72 linhas na conta do Flávio, 14 do mesmo aluno).
            if (b.start_date && dateStr < b.start_date) {
              if (!naoIniciados.has(b.id) && b.student) {
                naoIniciados.set(b.id, {
                  bookingId: b.id,
                  name: (b.student as any).full_name || 'Aluno',
                  time: b.time_slot || '',
                  dayOfWeek: b.day_of_week || '',
                  startsOn: b.start_date,
                });
              }
              continue;
            }
            // Hoje: ocultar aulas que ainda não chegou o horário
            if (i === 0 && isStillFutureToday(b.time_slot)) continue;
            if (!b.time_slot) continue; // booking sem horário definido: ignorar
            if (slotSeen.has(b.time_slot)) continue; // horário já coberto neste dia
            slotSeen.add(b.time_slot);
            candidatos.push(b);
          }

          // A regra de "esta aula já foi lançada?" vive em lib/lessonMatching.ts,
          // com teste. Ela cobre o agendamento trocado (log preso no booking
          // antigo, apagado) sem esconder a segunda metade de uma aula de 1h.
          const faltando = bookingsAindaNaoLancados(
            candidatos.map(b => ({ id: b.id, studentId: (b.student as any)?.id ?? null, raw: b })),
            (logs || []) as any[],
          );
          for (const item of faltando) {
            await processLesson(item.raw, 'REGULAR', item.raw.time_slot);
          }
        }

        // Coberturas ASSUMIDAS neste dia: entram na lista de quem vai dar a aula.
        for (const c of assumidas) {
          if (c.class_date !== dateStr) continue;
          const ab = assumedBookings.find(x => x.id === c.booking_id);
          if (!ab) continue;
          if (i === 0 && isStillFutureToday(ab.time_slot || c.class_time)) continue;
          if (logs?.some(l => l.booking_id === ab.id)) continue;
          await processLesson(ab, 'REGULAR', ab.time_slot || c.class_time);
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
      setNotStarted(Array.from(naoIniciados.values()));
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
      setNotStarted([]);
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
      // Só monta a intenção; QUEM DECIDE é o servidor. O subtype da reposição
      // (paga x não paga), a criação da reposição da falta, o consumo da
      // reposição usada, o CRM e a trava anti-duplicata vivem na RPC
      // `log_teacher_classes` — antes eram 4 chamadas soltas daqui, e a aba
      // "Pendentes" tinha uma versão divergente das mesmas regras.
      const entries: ClassLogEntryInput[] = [];
      const lateFlags: boolean[] = [];

      for (const ref of Object.keys(formData)) {
        const item = todayLessons.find(l => String(l.id) === ref);
        if (!item) continue;
        const data = formData[ref];

        const isReschedule = ref.startsWith('repo-');
        const isTrial = ref.startsWith('trial-');

        entries.push({
          ref,
          // O ref carrega agendamento + data (`<booking>|<YYYY-MM-DD>`); o servidor
          // recebe só o agendamento, e a data vem de `item.dateObj`.
          bookingId: (!isReschedule && !isTrial) ? bookingFromRef(ref) : null,
          rescheduleId: isReschedule ? ref.replace('repo-', '') : null,
          appointmentId: isTrial ? ref.replace('trial-', '') : null,
          classDate: item.dateObj,
          presence: data.type || 'COMPLETED',
          absenceReason: data.subtype || null,
          contentCovered: data.lastApplied || null,
          observations: data.observation || null,
          assessmentLevel: item.type === 'AULA EXPERIMENTAL' ? data.assessment_level : null,
          psychologicalProfile: item.type === 'AULA EXPERIMENTAL' ? data.psychological_profile : null,
          teacherVerdict: item.type === 'AULA EXPERIMENTAL' ? data.teacher_verdict : null,
        });
        lateFlags.push(!!item.isLate);
      }

      if (entries.length === 0) return;

      const result = await logTeacherClasses(entries);

      // XP só das que realmente entraram (celebrar aula ignorada seria mentira).
      const lancadas = new Set(result.entries.filter(e => e.status === 'lancada').map(e => e.ref));
      const xp = calcularXp(entries.map((e, i) => lateFlags[i]).filter((_, i) => lancadas.has(entries[i].ref)));

      setReward({ result, xp });
      if (onRefresh) onRefresh();
      await fetchTodaySchedule();
    } catch (err: any) {
      console.error('Save Error:', err);
      alert(`Erro ao lançar: ${err.message || 'tente novamente'}`);
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

      {/* Recompensa: o caixa subindo no momento do lançamento. Substituiu o toast
          "Aulas registradas com perfeição", que não mostrava número nenhum, e o
          aviso de duplicata — agora ambos vivem dentro do mesmo resumo. */}
      {reward && (
        <ClassLogReward
          result={reward.result}
          xp={reward.xp}
          onClose={() => setReward(null)}
        />
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
        ) : (todayLessons.length > 0 || notStarted.length > 0) ? (
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
                  {/* Aluno matriculado com início futuro: fica VISÍVEL (o professor
                      precisa saber que ele existe e quando começa) mas FORA do
                      formulário — uma linha por agendamento, não uma por dia. */}
                  {notStarted.length > 0 && (
                    <div className="rounded-2xl border border-blue-200 bg-blue-50 p-4">
                      <p className="text-xs font-black uppercase tracking-widest text-blue-800">
                        Ainda não começaram ({notStarted.length})
                      </p>
                      <p className="mt-1 text-xs font-medium text-blue-700">
                        Já estão na sua agenda, mas o lançamento abre só na data de início da matrícula.
                      </p>
                      <ul className="mt-3 space-y-1.5">
                        {notStarted.map(l => (
                          <li key={l.bookingId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-white/70 px-3 py-2 text-xs font-bold text-blue-900">
                            <span>{l.name} · {l.dayOfWeek} {l.time}</span>
                            <span className="whitespace-nowrap text-[11px] font-medium">
                              começa em {new Date(`${l.startsOn}T12:00:00`).toLocaleDateString('pt-BR')}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
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
