
import React, { useState, useEffect } from 'react';
import {
  Save,
  Clock,
  Calendar as CalendarIcon,
  Sparkles,
  TrendingUp,
  Lock,
  Zap,
  Check,
  RefreshCw,
  Plus,
  Copy,
  Eraser,
} from 'lucide-react';
import { Kpi3D, PageHero3D, Towers3D, type Tone } from './depth/Depth3D';
import { compactRows, currentSlot, dayLoads, formatSlots, slotProgress, type GridRow, type SlotReader } from '../lib/scheduleInsights';
import { supabase } from '../lib/supabase';
import { nullableUuid } from '../lib/dbValues';
import { normalizeWeekdayToIndex } from '../lib/weekday';
import { localYMD } from '../lib/dateUtils';
import { dateForDayIndex, weekStartOf } from '../lib/scheduleGrid';
import { coverageAgendaItems, dateWindow, rescheduleAgendaItems, type CoverageAgendaRow, type RescheduleAgendaRow } from '../lib/coverageAgenda';
import { formatHoldDay, parseHoldSlots, parseTermReservedSlots, reservedCellKey, termReservedCaption } from '../lib/scheduleHold';
import StudentProfileForm from './StudentProfileForm';

const DAYS = ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
const TIMES = Array.from({ length: 37 }, (_, i) => {
  const hour = Math.floor(i / 2) + 6;
  const minutes = (i % 2 === 0) ? '00' : '30';
  if (hour === 24) return '00:00';
  return `${hour < 10 ? '0' + hour : hour}:${minutes}`;
});
const LegendItem: React.FC<{ cls: string; label: string }> = ({ cls, label }) => (
  <span className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-brand-muted">
    <span aria-hidden="true" className={`h-3.5 w-5 rounded-md ${cls}`} />
    {label}
  </span>
);

interface TeacherAvailabilityEditorProps {
  teacherId?: string;
  tenantId?: string;
}

const TeacherAvailabilityEditor: React.FC<TeacherAvailabilityEditorProps> = ({ teacherId, tenantId }) => {
  const [selectedDay, setSelectedDay] = useState(0);
  const [availableSlots, setAvailableSlots] = useState<Set<string>>(new Set());
  const [bookings, setBookings] = useState<Record<string, any>>({});
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const [editingProfile, setEditingProfile] = useState<any | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Grade como está no banco — base para mostrar o que ainda não foi salvo.
  const [savedSlots, setSavedSlots] = useState<Set<string>>(new Set());
  const [onlyMyHours, setOnlyMyHours] = useState(false);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const loadData = async () => {
    if (!teacherId) return;
    setLoadError(null);
    const resolvedTenantId = (typeof tenantId === 'string' ? tenantId.trim() : '');

    // 1. Load Availability (New Table)
    const { data: availData, error: availError } = await supabase
      .from('teacher_availability')
      .select('*')
      .eq('teacher_id', teacherId);

    if (availError) {
      console.error('[TeacherAvailabilityEditor] Falha ao carregar disponibilidade:', availError);
      setLoadError('Não foi possível carregar sua disponibilidade. Tente novamente.');
    }

    if (availData) {
      const loaded = new Set<string>();
      availData.forEach((item: any) => {
        // DB uses Integer: 1=Mon, 6=Sat
        // Editor uses Index: 0=Mon, 5=Sat
        // So Editor Index = DB - 1
        const dayIdx = normalizeWeekdayToIndex(item.day_of_week);

        if (dayIdx >= 0 && dayIdx < DAYS.length) {
          if (typeof item.start_time === 'string') {
            const timeKey = item.start_time.substring(0, 5);
            loaded.add(`${dayIdx}-${timeKey}`);
          }
        }
      });
      setAvailableSlots(loaded);
      setSavedSlots(new Set(loaded));
    }

    // 2. Load Bookings (Fixed Students)
    let bookingsQuery = supabase
      .from('bookings')
      .select(`
          id, day_of_week, time_slot, type, module,
          student:student_id!inner(
            full_name, id, tenant_id, module, occupation, phone, meeting_link,
            interests, fixed_schedule, professor_id, avatar_url
          )
      `)
      .eq('teacher_id', teacherId)
      .in('status', ['SCHEDULED', 'scheduled']);

    if (resolvedTenantId) {
      bookingsQuery = bookingsQuery.eq('student.tenant_id', resolvedTenantId);
    }

    const { data: bookingsData, error: bookingsError } = await bookingsQuery;

    if (bookingsError) {
      console.error('[TeacherAvailabilityEditor] Falha ao carregar agendamentos:', bookingsError);
      setLoadError('Não foi possível carregar os alunos agendados. Tente novamente.');
    }

    // 3. Load Experimental Appointments (New)
    // We fetch future experimental/scheduled appointments for this professor
    const { data: appointmentsData, error: appointmentsError } = await supabase
      .from('appointments')
      .select('id, start_time, student_name, student_phone, type, status')
      .eq('professor_id', teacherId)
      .in('type', ['experimental', 'oral_test'])
      .in('status', ['scheduled', 'confirmed']); // Adjust status as needed based on ClaimOpportunity

    if (appointmentsError) {
      console.warn('[TeacherAvailabilityEditor] Falha ao carregar aulas experimentais:', appointmentsError);
    }

    const newBookings: Record<string, any> = {};

    // Process Fixed Bookings
    if (bookingsData) {
      bookingsData.forEach((b: any) => {
        const dIdx = normalizeWeekdayToIndex(b.day_of_week);
        if (typeof b.time_slot === 'string') {
          const timeKey = b.time_slot.substring(0, 5);
          if (dIdx !== -1) {
            const key = `${dIdx}-${timeKey}`;
            newBookings[key] = {
              id: b.id,
              studentId: b.student?.id,
              student: b.student?.full_name || 'Aluno',
              module: b.module || 'Gen',
              type: b.type,
              avatar: `https://ui-avatars.com/api/?name=${b.student?.full_name}`,
              fullProfile: b.student,
              isExperimental: false
            };
          }
        }
      });
    }

    // Process Experimental Appointments
    if (appointmentsData) {
      appointmentsData.forEach((app: any) => {
        if (!app.start_time) return;

        const dt = new Date(app.start_time);
        // Reserva oral ocupa somente a semana atual desta grade.
        if (app.type === 'oral_test' && (localYMD(dt) < dateForDayIndex(weekStartOf(), 0) || localYMD(dt) > dateForDayIndex(weekStartOf(), 5))) return;

        // FILTER: Hide past experimental classes
        const now = new Date();
        const endTime = new Date(dt.getTime() + 60 * 60 * 1000); // Assume 1h duration
        if (endTime < now) return;

        // Convert JS Day (0=Sun, 1=Mon) to Editor Index (0=Mon, 5=Sat)
        // Sunday (0) is ignored in this grid usually? DAYS=['Segunda'...]
        let jsDay = dt.getDay(); // 0-6
        let editorDayIdx = jsDay - 1; // Mon(1)->0, Sat(6)->5, Sun(0)->-1

        // Valid Days in Grid: 0 to 5
        if (editorDayIdx >= 0 && editorDayIdx < DAYS.length) {
          const hour = String(dt.getHours()).padStart(2, '0');
          const min = String(dt.getMinutes()).padStart(2, '0');
          const timeKey = `${hour}:${min}`; // "15:00"

          const key = `${editorDayIdx}-${timeKey}`;

          // If slot already taken by Fixed, maybe Show Conflict? Or Overwrite?
          // For now, let's just place it. If collision, experimental might overwrite visual or we check.
          // Let's assume experimental takes precedence or we mark it.

          // Format Date for display "27/01"
          const dateStr = dt.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });

          newBookings[key] = {
            id: app.id,
            studentId: 'experimental-' + app.id, // Fake ID for edit safety
            student: app.student_name || 'Exp. Student',
            module: 'EXP', // Badge Type
            type: app.type === 'oral_test' ? 'TESTE ORAL' : 'EXPERIMENTAL',
            readOnly: app.type === 'oral_test',
            avatar: null, // Optional
            fullProfile: {
              full_name: app.student_name,
              phone: app.student_phone,
              module: 'EXPERIMENTAL'
            },
            isExperimental: true,
            dateLabel: dateStr
          };
        }
      });
    }

    // 3b. Reservas de agenda: aluno que já fechou e começa numa data futura. O
    // horário fica segurado (e pago na folha) até o início; quando o aluno
    // assina, o agendamento dele passa a ocupar o mesmo lugar e a reserva some.
    if (resolvedTenantId) {
      const { data: holdData, error: holdError } = await supabase.rpc('list_future_start_holds', {
        p_tenant_id: resolvedTenantId,
        p_teacher_ids: [teacherId],
        p_include_inactive: false,
      });
      if (holdError) {
        console.warn('[TeacherAvailabilityEditor] Falha ao carregar reservas de agenda:', holdError);
      }
      for (const hold of parseHoldSlots(holdData)) {
        const editorDayIdx = hold.day_of_week - 1; // DB 1=Seg … 6=Sáb; editor 0=Seg
        if (editorDayIdx < 0 || editorDayIdx >= DAYS.length) continue;
        const key = `${editorDayIdx}-${hold.class_time.slice(0, 5)}`;
        if (newBookings[key]) continue;
        const startLabel = formatHoldDay(hold.hold_until);
        newBookings[key] = {
          id: hold.hold_id,
          studentId: `hold-${hold.hold_id}`,
          student: hold.student_label || 'Aluno',
          module: 'RES',
          type: 'RESERVA',
          readOnly: true,
          isExperimental: false,
          dateLabel: startLabel,
          caption: `Reservado para ${hold.student_label} — começa em ${startLabel}. A escola paga a reserva na sua folha.`,
        };
      }

      // 3c. Matrícula à espera do termo: a aula ainda não existe, mas o horário
      // está segurado. Sem isto a célula aparecia como LIVRE.
      const { data: termSlotData, error: termSlotError } = await supabase.rpc('list_term_reserved_slots', {
        p_tenant_id: resolvedTenantId,
        p_teacher_ids: [teacherId],
      });
      if (termSlotError) {
        console.warn('[TeacherAvailabilityEditor] Falha ao carregar horários à espera do termo:', termSlotError);
      }
      for (const slot of parseTermReservedSlots(termSlotData)) {
        const key = reservedCellKey(slot.day_of_week, slot.class_time);
        if (!key || newBookings[key]) continue;
        newBookings[key] = {
          id: slot.slot_id,
          studentId: `term-${slot.slot_id}`,
          student: slot.student_label,
          module: 'RES',
          type: 'RESERVA',
          readOnly: true,
          isExperimental: false,
          dateLabel: 'aguarda termo',
          caption: termReservedCaption(slot),
        };
      }
    }

    // 4. Coberturas ASSUMIDAS e reposições dos próximos 7 dias — aulas que são
    // deste professor sem serem agendamento dele. Entram na grade com a data,
    // como a experimental, e não abrem o formulário do aluno: a origem (o
    // agendamento do outro professor / a reposição) não é editada daqui.
    const todayStr = localYMD(new Date());
    const window = dateWindow(todayStr, 7);
    const nowHHMM = `${String(new Date().getHours()).padStart(2, '0')}:${String(new Date().getMinutes()).padStart(2, '0')}`;
    const placeDated = (dateStr: string, timeKey: string, entry: Record<string, unknown>) => {
      if (dateStr === todayStr && timeKey < nowHHMM) return; // já passou hoje
      const [y, m, d] = dateStr.split('-').map(Number);
      const dt = new Date(y, m - 1, d);
      const editorDayIdx = dt.getDay() - 1; // Seg=0 … Sáb=5; domingo fica fora da grade
      if (editorDayIdx < 0 || editorDayIdx >= DAYS.length) return;
      const key = `${editorDayIdx}-${timeKey}`;
      if (newBookings[key] && !newBookings[key].isExperimental) return; // aula fixa tem precedência visual
      newBookings[key] = {
        ...entry,
        dateLabel: dt.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }),
        readOnly: true,
      };
    };

    const { data: coverageRows, error: coverageError } = await supabase
      .from('class_coverages')
      .select(`
        id, booking_id, class_date, class_time, status, notes, original_teacher_id, cover_teacher_id,
        student:student_id(id, full_name, phone, avatar_url, module, meeting_link),
        original_teacher:original_teacher_id(full_name),
        cover_teacher:cover_teacher_id(full_name)
      `)
      .eq('cover_teacher_id', teacherId)
      .eq('status', 'confirmed')
      .gte('class_date', window[0])
      .lte('class_date', window[window.length - 1]);
    if (coverageError) {
      console.warn('[TeacherAvailabilityEditor] Falha ao carregar coberturas:', coverageError);
    }
    for (const item of coverageAgendaItems((coverageRows || []) as unknown as CoverageAgendaRow[], teacherId)) {
      if (item.papel !== 'assumida') continue;
      placeDated(item.classDate, item.time, {
        id: item.coverageId,
        studentId: item.studentId,
        student: item.studentName,
        module: item.studentModule || 'COB',
        type: 'COBERTURA',
        avatar: item.studentAvatar,
        fullProfile: { full_name: item.studentName, phone: item.studentPhone, module: item.studentModule },
        isExperimental: false,
        caption: item.combinedTime
          ? `Cobertura da aula de ${item.otherTeacherName || 'outro professor'} · combinado ${item.combinedTime}`
          : `Cobertura da aula de ${item.otherTeacherName || 'outro professor'}`,
      });
    }

    const { data: rescheduleRows, error: rescheduleError } = await supabase
      .from('reschedules')
      .select('id, date, time, fault_type, used_at, temporary_assignment_id, student:student_id(id, full_name, phone, avatar_url, module, meeting_link)')
      .eq('teacher_id', teacherId)
      .is('used_at', null)
      .gte('date', window[0])
      .lte('date', window[window.length - 1]);
    if (rescheduleError) {
      console.warn('[TeacherAvailabilityEditor] Falha ao carregar reposições:', rescheduleError);
    }
    for (const item of rescheduleAgendaItems((rescheduleRows || []) as unknown as RescheduleAgendaRow[])) {
      placeDated(item.classDate, item.time, {
        id: item.rescheduleId,
        studentId: item.studentId,
        student: item.studentName,
        module: item.studentModule || 'REPO',
        type: 'REPOSIÇÃO',
        avatar: item.studentAvatar,
        fullProfile: { full_name: item.studentName, phone: item.studentPhone, module: item.studentModule },
        isExperimental: false,
        caption: item.temporaryAssignment
          ? 'Reposição · atribuição temporária'
          : item.faultType === 'TEACHER' ? 'Reposição (falta do professor)' : 'Reposição',
      });
    }

    setBookings(newBookings);
  };

  useEffect(() => {
    loadData();
  }, [teacherId, tenantId]);

  const toggleSlot = (dayIdx: number, timeStr: string) => {
    const key = `${dayIdx}-${timeStr}`;
    if (bookings[key]) return;

    const newSlots = new Set(availableSlots);
    if (newSlots.has(key)) newSlots.delete(key);
    else newSlots.add(key);
    setAvailableSlots(newSlots);
  };

  const handlePublish = async () => {
    if (!teacherId) return;
    setIsPublishing(true);

    try {
      const slots = Array.from(availableSlots).map(slotStr => {
        const slot = slotStr as string;
        const dashIdx = slot.indexOf('-');
        const dIdx = parseInt(slot.substring(0, dashIdx));
        const timeKey = slot.substring(dashIdx + 1);
        return {
          // DB: 1=segunda ... 6=sábado. Editor: 0=segunda ... 5=sábado.
          day_of_week: dIdx + 1,
          start_time: timeKey,
        };
      });

      // Uma única operação de banco evita que uma falha entre DELETE e INSERT
      // deixe a agenda do professor vazia ou apenas parcialmente publicada.
      const { data, error } = await supabase.rpc('replace_teacher_availability', {
        p_teacher_id: teacherId,
        p_slots: slots,
      });
      if (error) throw error;
      if (data && (data as any).ok === false) {
        throw new Error((data as any).error || 'Não foi possível publicar a agenda.');
      }

      setSavedSlots(new Set(availableSlots));
      alert("Agenda publicada com sucesso!");
    } catch (err: any) {
      alert("Erro ao publicar agenda: " + err.message);
    } finally {
      setIsPublishing(false);
    }
  };

  const handleUpdateStudentProfile = async (profileData: any) => {
    if (!editingProfile?.studentId) return;

    try {
      const loadedProfile = editingProfile.fullProfile || {};
      const updates: any = {};
      const setIfLoaded = (column: string, value: unknown) => {
        if (Object.prototype.hasOwnProperty.call(loadedProfile, column)) {
          updates[column] = value;
        }
      };
      const previousModule = String(loadedProfile.module || '')
        .trim()
        .toUpperCase()
        .split(/\s+/)[0];
      const requestedModule = String(profileData.levelBadge || '').trim().toUpperCase();
      const placementChanged = Object.prototype.hasOwnProperty.call(loadedProfile, 'module')
        && requestedModule !== ''
        && requestedModule !== previousModule;

      const { error: rpcError } = await supabase.rpc('update_student_pedagogical_profile', {
        p_student_id: editingProfile.studentId,
        p_data: {
          full_name: profileData.name,
          phone: profileData.phone,
          attendance_phone: profileData.attendance_phone || null,
          meeting_link: profileData.meeting_link,
          occupation: profileData.occupation,
          interests: profileData.interests,
          private_notes: profileData.private_notes,
          fixed_schedule: profileData.fixed_schedule,
          // is_kids fica com a direção (migration 20260926200000).
          status: profileData.status,
          module: requestedModule,
        }
      });
      if (rpcError) throw rpcError;
      await loadData();
      setEditingProfile(null);
      alert("Perfil do aluno atualizado com sucesso!");
    } catch (err: any) {
      alert("Erro ao atualizar perfil: " + err.message);
    }
  };

  const handleDeleteBooking = async () => {
    if (!editingProfile?.id) return;
    if (!confirm("Tem certeza que deseja remover este aluno deste horário?")) return;

    try {
      const { error } = await supabase.from('bookings').delete().eq('id', editingProfile.id);
      if (error) throw error;

      await loadData();
      setEditingProfile(null);
    } catch (err: any) {
      alert("Erro ao remover: " + err.message);
    }
  };

  // Cobertura/reposição datada é aula da semana, não ocupação da grade fixa.
  const bookedCount = Object.values(bookings).filter((b: any) => !b?.readOnly).length;
  const availableCount = availableSlots.size;
  const occupancyRate = Math.round((bookedCount / (bookedCount + availableCount || 1)) * 100);

  // O que mudou desde a última leitura/publicação. Sem isso o professor não
  // sabia se ainda precisava clicar em Salvar.
  const pendingChanges = React.useMemo(() => {
    let added = 0;
    let removed = 0;
    availableSlots.forEach(k => { if (!savedSlots.has(k)) added++; });
    savedSlots.forEach(k => { if (!availableSlots.has(k)) removed++; });
    return { added, removed, dirty: added + removed > 0 };
  }, [availableSlots, savedSlots]);

  const readSlot = React.useCallback<SlotReader>((dIdx, time) => {
    const key = `${dIdx}-${time}`;
    const b = bookings[key];
    if (b) return b.readOnly || b.isExperimental ? 'event' : 'booked';
    return availableSlots.has(key) ? 'free' : 'off';
  }, [bookings, availableSlots]);

  const loads = React.useMemo(() => dayLoads(TIMES, DAYS.length, readSlot), [readSlot]);
  // O professor precisa da grade inteira para ABRIR horário novo; recolher é
  // opção dele ("só o meu horário").
  const gridRows = React.useMemo<GridRow[]>(
    () => (onlyMyHours ? compactRows(TIMES, DAYS.length, readSlot) : TIMES.map(time => ({ kind: 'time' as const, time }))),
    [onlyMyHours, readSlot],
  );
  const todayIdx = (() => { const d = now.getDay(); return d === 0 ? -1 : d - 1; })();
  const nowSlot = currentSlot(TIMES, now);

  // Próxima aula a partir de agora (semana corrente da grade).
  const nextLesson = React.useMemo(() => {
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const candidates = Object.entries(bookings)
      .map(([key, b]: [string, any]) => {
        const dash = key.indexOf('-');
        const dIdx = Number(key.slice(0, dash));
        const time = key.slice(dash + 1);
        const [h, m] = time.split(':').map(Number);
        let dayDelta = dIdx - todayIdx;
        if (todayIdx < 0) dayDelta = dIdx + 1;
        if (dayDelta < 0 || (dayDelta === 0 && h * 60 + m < nowMinutes)) dayDelta += 7;
        return { b, dIdx, time, order: dayDelta * 1440 + h * 60 + m, dayDelta };
      })
      .filter(c => c.b.type !== 'RESERVA')
      .sort((a, b) => a.order - b.order);
    return candidates[0] || null;
  }, [bookings, now, todayIdx]);

  // Repete a grade do dia escolhido nos outros dias úteis — quem trabalha no
  // mesmo horário de segunda a sexta não precisa clicar 60 células.
  const copyDayToWeekdays = (fromIdx: number) => {
    const fromTimes = TIMES.filter(t => availableSlots.has(`${fromIdx}-${t}`));
    if (fromTimes.length === 0) {
      alert(`${DAYS[fromIdx]} ainda não tem horário livre marcado para copiar.`);
      return;
    }
    if (!confirm(`Repetir os ${fromTimes.length} horários de ${DAYS[fromIdx]} em todos os dias de segunda a sexta? Horários com aula não mudam. Nada é publicado até você clicar em Salvar agenda.`)) return;
    const next = new Set(availableSlots);
    for (let d = 0; d < 5; d++) {
      if (d === fromIdx) continue;
      TIMES.forEach(t => {
        const key = `${d}-${t}`;
        if (bookings[key]) return;
        if (fromTimes.includes(t)) next.add(key); else next.delete(key);
      });
    }
    setAvailableSlots(next);
  };

  const clearDay = (dIdx: number) => {
    const next = new Set(availableSlots);
    TIMES.forEach(t => next.delete(`${dIdx}-${t}`));
    setAvailableSlots(next);
  };

  const toneFor = (booking: any): Tone => booking.isExperimental
    ? 'violet'
    : booking.type === 'REPOSIÇÃO' || booking.type === 'COBERTURA'
      ? 'amber'
      : booking.type === 'RESERVA'
        ? 'teal'
        : 'brand';
  const badgeFor = (booking: any): string | null => booking.isExperimental
    ? (booking.type === 'TESTE ORAL' ? 'ORAL' : 'EXP')
    : booking.type === 'REPOSIÇÃO' ? 'REPO'
      : booking.type === 'COBERTURA' ? 'COB'
        : booking.type === 'RESERVA' ? 'RES'
          : null;

  return (
    <div className="ww-stage space-y-5 md:space-y-6 animate-in fade-in duration-700 font-sans">

      <PageHero3D
        icon={<CalendarIcon size={26} />}
        eyebrow="Minha agenda"
        title="Gestão de horários"
        subtitle="Toque nos horários em que você pode dar aula. A escola só oferece aluno novo dentro deles."
        actions={
          <button
            onClick={handlePublish}
            disabled={isPublishing}
            className="ww-block tone-brand px-6 py-3 text-xs font-black uppercase tracking-widest flex items-center justify-center gap-2 disabled:opacity-50"
          >
            {isPublishing ? <RefreshCw className="relative animate-spin" size={16} /> : <Save className="relative" size={16} />}
            <span className="relative">Salvar agenda{pendingChanges.dirty ? ` (${pendingChanges.added + pendingChanges.removed})` : ''}</span>
          </button>
        }
      />

      {loadError && (
        <div role="alert" className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-2xl border border-red-500/30 bg-red-500/10 px-5 py-4 text-sm font-semibold text-red-700 dark:text-red-200">
          <span>{loadError}</span>
          <button
            type="button"
            onClick={() => void loadData()}
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-red-400/30 px-3 py-2 text-xs font-bold uppercase tracking-wide hover:bg-red-500/10"
          >
            <RefreshCw size={14} />
            Tentar novamente
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        <Kpi3D
          icon={<TrendingUp size={20} />}
          tone="emerald"
          label="Ocupação da grade"
          value={`${occupancyRate}%`}
          hint={`${bookedCount} aulas fixas em ${bookedCount + availableCount} horários oferecidos`}
          ring={occupancyRate}
        />
        <Kpi3D
          icon={<Clock size={20} />}
          tone="sky"
          label="Horários livres"
          value={formatSlots(availableCount)}
          hint={`${availableCount} horários de 30 min abertos para aluno novo`}
        />
        <Kpi3D
          icon={<Zap size={20} />}
          tone="violet"
          label="Próxima aula"
          value={nextLesson ? nextLesson.b.student.split(' ')[0] : '—'}
          hint={nextLesson
            ? `${nextLesson.dayDelta === 0 ? 'Hoje' : nextLesson.dayDelta === 1 ? 'Amanhã' : DAYS[nextLesson.dIdx]} às ${nextLesson.time}${nextLesson.b.dateLabel ? ` (${nextLesson.b.dateLabel})` : ''}`
            : 'Nenhuma aula marcada'}
        />
        <Kpi3D
          icon={pendingChanges.dirty ? <Sparkles size={20} /> : <Check size={20} />}
          tone={pendingChanges.dirty ? 'amber' : 'teal'}
          label="Alterações"
          value={pendingChanges.dirty ? 'Não salvas' : 'Tudo salvo'}
          hint={pendingChanges.dirty
            ? `${pendingChanges.added} aberto${pendingChanges.added === 1 ? '' : 's'} · ${pendingChanges.removed} fechado${pendingChanges.removed === 1 ? '' : 's'}`
            : 'A escola já vê sua disponibilidade'}
        />
      </div>

      <div data-tour="agenda-week-towers" className="ww-slab p-4 sm:p-5">
        <div className="flex flex-col lg:flex-row lg:items-end gap-4">
          <div className="flex-1 min-w-0">
            <p className="text-[10px] font-black uppercase tracking-[0.16em] text-brand-muted">Sua semana</p>
            <Towers3D
              height={56}
              ariaLabel="Aulas por dia da semana"
              data={loads.map(l => ({
                key: String(l.dayIdx),
                label: DAYS[l.dayIdx].slice(0, 3),
                sublabel: `${l.free} livre${l.free === 1 ? '' : 's'}`,
                value: l.booked + l.events,
                tone: l.dayIdx === todayIdx ? 'brand' : 'emerald',
                highlight: l.dayIdx === todayIdx,
                caption: `${DAYS[l.dayIdx]}: ${l.booked} aulas fixas, ${l.events} com data, ${l.free} horários livres`,
              }))}
            />
          </div>
          <div className="lg:w-72 space-y-2">
            <p className="text-[10px] font-black uppercase tracking-[0.16em] text-brand-muted">Atalhos do dia escolhido</p>
            <select
              value={selectedDay}
              onChange={e => setSelectedDay(Number(e.target.value))}
              aria-label="Dia para os atalhos"
              className="w-full px-3 py-2 bg-brand-surface-2/70 border border-brand-border rounded-xl text-xs font-bold text-brand-text"
            >
              {DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
            </select>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={() => copyDayToWeekdays(selectedDay)} className="ww-lift rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-[10px] font-black uppercase tracking-wider text-emerald-700 dark:text-emerald-300 flex items-center justify-center gap-1.5">
                <Copy size={13} /> Repetir seg–sex
              </button>
              <button type="button" onClick={() => clearDay(selectedDay)} className="ww-lift rounded-xl border border-brand-border bg-brand-surface px-3 py-2 text-[10px] font-black uppercase tracking-wider text-brand-muted flex items-center justify-center gap-1.5">
                <Eraser size={13} /> Fechar o dia
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Legenda */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-1">
        <LegendItem cls="ww-block tone-brand" label="Aula fixa" />
        <LegendItem cls="ww-well" label="Livre (disponível)" />
        <LegendItem cls="ww-off border border-brand-border" label="Indisponível" />
        <LegendItem cls="ww-ghost tone-violet" label="Experimental" />
        <span data-tour="agenda-coverage-legend"><LegendItem cls="ww-ghost tone-amber" label="Cobertura / Reposição (com a data)" /></span>
        <span data-tour="agenda-future-start-hold-legend"><LegendItem cls="ww-ghost tone-teal" label="Reservado (início futuro ou termo pendente)" /></span>
        <label className="ml-auto inline-flex items-center gap-2 text-[11px] font-bold text-brand-muted cursor-pointer select-none">
          <input type="checkbox" checked={onlyMyHours} onChange={e => setOnlyMyHours(e.target.checked)} className="h-4 w-4 rounded" />
          Só o meu horário
        </label>
      </div>

      {/* Grade: rola com a página. Numa caixa de altura fixa, o calendário ficava
          com a rolagem dentro da rolagem. */}
      <div className="ww-slab overflow-clip flex flex-col min-h-[28rem]">

        {/* Seletor de dia no celular */}
        <div className="lg:hidden sticky top-[65px] z-30 bg-brand-surface/95 backdrop-blur-md flex overflow-x-auto gap-2 p-3 border-b border-brand-border custom-scrollbar snap-x">
          {DAYS.map((day, idx) => (
            <button
              key={day}
              onClick={() => setSelectedDay(idx)}
              className={`snap-center shrink-0 px-4 py-2 rounded-xl text-xs font-black transition-all ${selectedDay === idx
                ? 'ww-block tone-brand'
                : 'bg-brand-surface-2 text-brand-muted hover:text-brand-text'
                }`}
            >
              <span className="relative">{day}{idx === todayIdx ? ' · hoje' : ''}</span>
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-x-clip relative p-2">
          {gridRows.length === 0 ? (
            <div className="min-h-60 flex flex-col items-center justify-center gap-2 text-center text-brand-muted p-6">
              <span className="ww-orb tone-sky h-14 w-14"><Clock size={22} /></span>
              <p className="text-sm font-black text-brand-text">Nenhum horário marcado ainda</p>
              <p className="text-xs max-w-xs">Desmarque "Só o meu horário" para ver a grade inteira e tocar nos horários em que você pode dar aula.</p>
            </div>
          ) : (
          <table className="w-full table-fixed border-separate border-spacing-1.5">
            {/* 65 px: altura do topo do app. No celular quem gruda é o seletor de dia. */}
            <thead className="lg:sticky lg:top-[65px] z-20">
              <tr>
                <th className="w-16 rounded-xl bg-brand-surface/90 backdrop-blur-md">
                  <Clock size={15} className="text-brand-muted mx-auto" />
                </th>
                {DAYS.map((day, idx) => (
                  <th
                    key={day}
                    className={`p-2.5 rounded-xl backdrop-blur-md ${selectedDay !== idx ? 'hidden lg:table-cell' : 'table-cell'} ${idx === todayIdx ? 'ww-block tone-brand' : 'bg-brand-surface/90 border border-brand-border'}`}
                  >
                    <span className={`relative block text-[11px] font-black uppercase tracking-[0.16em] ${idx === todayIdx ? 'text-white' : 'text-brand-text'}`}>{day}</span>
                    <span className={`relative block text-[9px] font-bold ${idx === todayIdx ? 'text-white/80' : 'text-brand-muted'}`}>
                      {loads[idx].booked + loads[idx].events} aulas · {loads[idx].free} livres
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {gridRows.map(row => {
                if (row.kind === 'gap') {
                  return (
                    <tr key={`gap-${row.from}`}>
                      <td className="text-center text-[10px] font-bold text-brand-muted font-mono">{row.from}</td>
                      <td colSpan={DAYS.length}>
                        <button type="button" onClick={() => setOnlyMyHours(false)} className="ww-off w-full py-1.5 text-[10px] font-bold text-brand-muted hover:text-brand-text">
                          {row.from} – {row.to} · {formatSlots(row.count)} fora do seu horário — tocar para abrir
                        </button>
                      </td>
                    </tr>
                  );
                }
                const { time } = row;
                const isNowRow = nowSlot === time;
                return (
                  <tr key={time} className="group">
                    <td className={`sticky left-0 z-10 w-16 text-center text-[10px] font-bold font-mono rounded-lg bg-brand-surface/90 ${isNowRow ? 'text-rose-500' : 'text-brand-muted'}`}>
                      {time}
                    </td>
                    {DAYS.map((_, dayIdx) => {
                      const key = `${dayIdx}-${time}`;
                      const booking = bookings[key];
                      const isAvailable = availableSlots.has(key);
                      const isNow = isNowRow && dayIdx === todayIdx;

                      return (
                        <td
                          key={dayIdx}
                          className={`relative h-12 align-top ${selectedDay !== dayIdx ? 'hidden lg:table-cell' : 'table-cell'} ${dayIdx === todayIdx ? 'bg-tenant-primary/[0.04] rounded-xl' : ''}`}
                        >
                          {isNow && <div className="ww-now" style={{ top: `${Math.round(slotProgress(now) * 100)}%` }} aria-hidden="true" />}
                          {booking ? (
                            <div
                              onClick={() => { if (!booking.readOnly) setEditingProfile(booking); }}
                              title={booking.caption || undefined}
                              className={`w-full h-full px-2 flex items-center justify-between gap-1 ${booking.readOnly ? 'cursor-default' : 'cursor-pointer'} ${(booking.isExperimental || booking.readOnly) ? `ww-ghost tone-${toneFor(booking)}` : `ww-block tone-${toneFor(booking)}`}`}
                            >
                              <div className="relative flex items-center gap-1.5 overflow-hidden">
                                <span className={`w-6 h-6 rounded-md shrink-0 grid place-items-center text-[10px] font-black ${(booking.isExperimental || booking.readOnly) ? 'bg-current/15' : 'bg-white/25'}`}>
                                  {booking.student[0]}
                                </span>
                                <span className="min-w-0">
                                  <span className="block text-[10px] font-black truncate uppercase tracking-wide leading-tight">{booking.student.split(' ')[0]}</span>
                                  {booking.dateLabel && <span className="block text-[8px] opacity-75 font-bold">{booking.dateLabel}</span>}
                                </span>
                              </div>
                              {badgeFor(booking) && <span className="relative text-[8px] font-black opacity-80">{badgeFor(booking)}</span>}
                            </div>
                          ) : (
                            <button
                              onClick={() => toggleSlot(dayIdx, time)}
                              aria-pressed={isAvailable}
                              aria-label={`${isAvailable ? 'Fechar' : 'Abrir'} ${DAYS[dayIdx]} às ${time}`}
                              className={`w-full h-full flex items-center justify-center ${isAvailable ? 'ww-well' : 'ww-off hover:outline hover:outline-1 hover:outline-dashed hover:outline-emerald-500/50'}`}
                            >
                              {isAvailable
                                ? <span className="text-[8px] font-black text-emerald-600/80 dark:text-emerald-400/80 uppercase tracking-[0.18em]">livre</span>
                                : <Plus size={12} className="text-brand-muted opacity-0 group-hover:opacity-40" />}
                            </button>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
          )}
        </div>

        {/* Rodapé */}
        <div className={`p-4 border-t border-brand-border bg-brand-surface/80 backdrop-blur-md flex flex-col sm:flex-row justify-between sm:items-center gap-3 ${pendingChanges.dirty ? 'sticky z-30 bottom-[calc(4rem+env(safe-area-inset-bottom,0px))] lg:bottom-0' : ''}`}>
          <div className={`flex items-center gap-2 text-xs font-semibold ${pendingChanges.dirty ? 'text-amber-600 dark:text-amber-400' : 'text-brand-muted'}`}>
            <RefreshCw size={12} />
            <span>{pendingChanges.dirty ? 'Você tem alterações não salvas — elas se perdem ao sair.' : 'Alterações não salvas são perdidas ao sair.'}</span>
          </div>
          <button
            onClick={handlePublish}
            disabled={isPublishing}
            className="ww-block tone-brand px-8 py-3 text-xs font-black uppercase tracking-widest flex items-center justify-center gap-2 disabled:opacity-50"
          >
            {isPublishing ? <RefreshCw className="relative animate-spin" size={16} /> : <Save className="relative" size={16} />}
            <span className="relative">Salvar Agenda</span>
          </button>
        </div>
      </div>

      {editingProfile && (
        <div className="fixed inset-0 z-100 flex items-center justify-center p-4 bg-brand-surface/60 backdrop-blur-xs animate-in fade-in duration-300">
          <StudentProfileForm
            initialData={{
              ...editingProfile.fullProfile,
              id: editingProfile.studentId,
              name: editingProfile.fullProfile?.full_name || editingProfile.student,
              levelBadge: editingProfile.fullProfile?.module?.split(' ')[0] || editingProfile.module || 'A1',
              status: editingProfile.fullProfile?.status || 'Ativo',
              currentModuleStatus: editingProfile.fullProfile?.module || editingProfile.module,
              img: editingProfile.fullProfile?.avatar_url,
              postalCode: editingProfile.fullProfile?.postal_code,
              addressNumber: editingProfile.fullProfile?.address_number,
              planDuration: editingProfile.fullProfile?.fidelity_plan
            }}
            onSubmit={handleUpdateStudentProfile}
            onCancel={() => setEditingProfile(null)}
            onDelete={handleDeleteBooking}
            title="Gerenciar Alocação"
            currentUserRole="TEACHER" // Enforce restricted view in this context
          />
        </div>
      )}
    </div>
  );
};
export default TeacherAvailabilityEditor;
