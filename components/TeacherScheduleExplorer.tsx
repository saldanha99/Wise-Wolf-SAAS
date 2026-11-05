import React, { useState, useEffect } from 'react';
import StudentProfileForm from './StudentProfileForm';
import StudentAssignmentModal from './StudentAssignmentModal';
import {
  Users,
  Search,
  ChevronRight,
  UserPlus,
  TrendingUp,
  Lock,
  CheckCircle2,
  AlertCircle,
  Clock,
  RefreshCw,
  Plus,
  Zap,
  ChevronLeft,
  Sparkles,
} from 'lucide-react';
import { Ring3D, Towers3D, type Tone } from './depth/Depth3D';
import {
  compactRows,
  currentSlot,
  dayLoads,
  formatSlots,
  freeWindows,
  slotProgress,
  type FreeWindow,
  type GridRow,
  type SlotReader,
} from '../lib/scheduleInsights';
import { MOCK_BOOKINGS, TEACHER_SPECIALIZATIONS, PROFILE_SAFE_COLS } from '../constants';
import { Teacher, Reschedule } from '../types';
import {
  dateForDayIndex,
  findRescheduleForSlot,
  findTrialForSlot,
  reschedulesForTeacherGrid,
  trialsForGrid,
  weekStartOf,
  type GridTrial,
} from '../lib/scheduleGrid';
import { localYMD } from '../lib/dateUtils';
import { buildReservedCells, parseHoldSlots, parseTermReservedSlots, type ReservedCell } from '../lib/scheduleHold';
import { nullableUuid } from '../lib/dbValues';
import { FUNCTIONS_URL, supabase } from '../lib/supabase';
import { asaasService } from '../services/asaasService';
import { loadAuthorizedProfilePrivate } from '../lib/profilePrivacy';
import { normalizeWeekdayToIndex } from '../lib/weekday';
import { provisionStudentAccount } from '../lib/studentAccountProvisioning';
import { changeStudentLifecycle } from '../lib/studentLifecycleRequest';

const DAYS = ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
const TIMES = Array.from({ length: 37 }, (_, i) => {
  const hour = Math.floor(i / 2) + 6;
  const minutes = (i % 2 === 0) ? '00' : '30';
  if (hour === 24) return '00:00';
  return `${hour < 10 ? '0' + hour : hour}:${minutes}`;
});

type TeacherSort = 'name' | 'free' | 'busy';

// Aulas fixas e horários livres de cada professor, para a lista lateral mostrar
// quem está cheio e quem tem espaço sem precisar abrir agenda por agenda.
interface TeacherLoad { booked: number; free: number }

const Legend: React.FC<{ label: string; tone?: Tone; ghost?: boolean; well?: boolean; off?: boolean }> = ({ label, tone, ghost, well, off }) => (
  <span className="inline-flex items-center gap-1.5 text-[10px] font-bold text-brand-muted">
    <span
      aria-hidden="true"
      className={`h-3.5 w-5 ${well ? 'ww-well' : off ? 'ww-off border border-brand-border rounded-md' : ghost ? `ww-ghost tone-${tone}` : `ww-block tone-${tone}`}`}
    />
    {label}
  </span>
);

interface TeacherScheduleExplorerProps {
  user?: any; // Added user prop
  teachers: Teacher[];
  initialTeacherName?: string;
  autoAllocate?: boolean;
  reschedules?: Reschedule[];
  currentTenantId?: string;
  onRefresh?: () => void;
}

const TeacherScheduleExplorer: React.FC<TeacherScheduleExplorerProps> = ({ user, teachers = [], initialTeacherName, autoAllocate, reschedules = [], currentTenantId, onRefresh }) => {
  const [selectedTeacher, setSelectedTeacher] = useState<Teacher | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [specFilter, setSpecFilter] = useState<string>('');
  const [isAllocating, setIsAllocating] = useState(false);
  const [isAssignmentModalOpen, setIsAssignmentModalOpen] = useState(false);
  const [bookings, setBookings] = useState<Record<string, any>>({});
  const [studentsList, setStudentsList] = useState<any[]>([]);
  const [availableSlots, setAvailableSlots] = useState<Set<string>>(new Set());
  const [editingBooking, setEditingBooking] = useState<any | null>(null);
  const [conflicts, setConflicts] = useState<Set<string>>(new Set());
  const [slotSearch, setSlotSearch] = useState('');
  // A grade é de uma SEMANA concreta. Sem isso, reposição e experimental — que
  // são eventos de um dia — eram desenhadas num molde perpétuo e ocupavam o
  // horário para sempre. `weekOffset` em semanas a partir da atual.
  const [weekOffset, setWeekOffset] = useState(0);
  const [trials, setTrials] = useState<GridTrial[]>([]);
  const [reservedCells, setReservedCells] = useState<Record<string, ReservedCell>>({});
  const [compactGrid, setCompactGrid] = useState(true);
  const [focusWindow, setFocusWindow] = useState<FreeWindow | null>(null);
  const [teacherSort, setTeacherSort] = useState<TeacherSort>('name');
  const [teacherLoads, setTeacherLoads] = useState<Record<string, TeacherLoad>>({});
  // Relógio da linha "agora": anda de minuto em minuto, não a cada render.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  const canManageAssignments = user?.role === 'SCHOOL_ADMIN' || user?.role === 'SUPER_ADMIN';

  const weekStart = React.useMemo(() => {
    const base = weekStartOf();
    base.setDate(base.getDate() + weekOffset * 7);
    return base;
  }, [weekOffset]);

  useEffect(() => {
    if (teachers && teachers.length > 0) {
      if (initialTeacherName) {
        const target = teachers.find(t => t.name === initialTeacherName);
        if (target) {
          setSelectedTeacher(target);
        }
      } else if (!selectedTeacher) {
        setSelectedTeacher(teachers[0]);
      }
    }
  }, [teachers, initialTeacherName]);

  // Uma consulta para todos: aulas fixas e grade declarada de cada professor.
  // Livre = horário declarado que não tem aula fixa (o mesmo critério da
  // ocupação mostrada na agenda aberta).
  const teacherIdsKey = (teachers || []).map(t => t.id).sort().join(',');
  useEffect(() => {
    const ids = teacherIdsKey ? teacherIdsKey.split(',') : [];
    if (ids.length === 0) return;
    let cancelled = false;
    void (async () => {
      const [bk, av] = await Promise.all([
        supabase.from('bookings').select('teacher_id, day_of_week, time_slot').in('teacher_id', ids).in('status', ['SCHEDULED', 'scheduled']),
        supabase.from('teacher_availability').select('teacher_id, day_of_week, start_time').in('teacher_id', ids),
      ]);
      if (cancelled || bk.error || av.error) return;
      const slotKey = (day: unknown, time: unknown) => {
        const d = normalizeWeekdayToIndex(day as string);
        return d >= 0 && typeof time === 'string' ? `${d}-${time.slice(0, 5)}` : null;
      };
      const booked = new Map<string, Set<string>>();
      for (const row of (bk.data || []) as { teacher_id: string; day_of_week: unknown; time_slot: unknown }[]) {
        const k = slotKey(row.day_of_week, row.time_slot);
        if (!k) continue;
        if (!booked.has(row.teacher_id)) booked.set(row.teacher_id, new Set());
        booked.get(row.teacher_id)!.add(k);
      }
      const free = new Map<string, number>();
      for (const row of (av.data || []) as { teacher_id: string; day_of_week: unknown; start_time: unknown }[]) {
        const k = slotKey(row.day_of_week, row.start_time);
        if (!k || booked.get(row.teacher_id)?.has(k)) continue;
        free.set(row.teacher_id, (free.get(row.teacher_id) || 0) + 1);
      }
      const next: Record<string, TeacherLoad> = {};
      for (const id of ids) next[id] = { booked: booked.get(id)?.size || 0, free: free.get(id) || 0 };
      setTeacherLoads(next);
    })();
    return () => { cancelled = true; };
  }, [teacherIdsKey]);

  const fetchDetailData = async () => {
    if (!selectedTeacher) return;
    const detailTenantId = currentTenantId || selectedTeacher.tenantId;

    // 1. Fetch Bookings, Availability and Trials in Parallel
    const noReservations = Promise.resolve({ data: [] as unknown, error: null });
    const [bookingsRes, availRes, trialsRes, stdsRes, holdsRes, termSlotsRes] = await Promise.all([
      supabase
        .from('bookings')
        .select('id, day_of_week, time_slot, type, module, student:student_id(full_name, id, tenant_id, module, occupation, phone, meeting_link)')
        .eq('teacher_id', selectedTeacher.id)
        .in('status', ['SCHEDULED', 'scheduled']),
      supabase
        .from('teacher_availability')
        .select('*')
        .eq('teacher_id', selectedTeacher.id),
      // `appointments` guarda o horário em start_time (timestamptz). Não existe
      // coluna `date` nem `time` — ler t.date/t.time devolvia undefined e o
      // bloco da experimental nunca era desenhado.
      supabase
        .from('appointments')
        .select('id, start_time, student_name, status, type')
        .eq('teacher_id', selectedTeacher.id)
        .in('type', ['experimental', 'oral_test'])
        .eq('status', 'scheduled'),
      supabase
        .from('profiles')
        .select(PROFILE_SAFE_COLS)
        .eq('role', 'STUDENT')
        .eq('tenant_id', detailTenantId),
      // Horário segurado (início futuro ou termo pendente) não é horário livre.
      detailTenantId
        ? supabase.rpc('list_future_start_holds', { p_tenant_id: detailTenantId, p_teacher_ids: [selectedTeacher.id], p_include_inactive: false })
        : noReservations,
      detailTenantId
        ? supabase.rpc('list_term_reserved_slots', { p_tenant_id: detailTenantId, p_teacher_ids: [selectedTeacher.id] })
        : noReservations,
    ]);

    setReservedCells(buildReservedCells(parseHoldSlots(holdsRes.data), parseTermReservedSlots(termSlotsRes.data)));

    // A relação embutida acima é propositalmente pequena para a grade. O modal
    // de edição, porém, precisa do perfil completo; caso contrário os defaults
    // vazios do formulário podem apagar dados que nunca foram carregados.
    const profilesById = new Map(
      ((stdsRes.data || []) as any[]).map(profile => [String(profile.id), profile])
    );
    const newBookings: Record<string, any> = {};
    const conflictKeys = new Set<string>();

    if (bookingsRes.data) {
      bookingsRes.data.forEach((b: any) => {
        const fullProfile = profilesById.get(String(b.student?.id)) || b.student;
        const dIdx = normalizeWeekdayToIndex(b.day_of_week);
        if (typeof b.time_slot === 'string') {
          const timeKey = b.time_slot.substring(0, 5);
          if (dIdx >= 0) {
             // Conflito: dois alunos no mesmo horário deste professor
             if (newBookings[`${dIdx}-${timeKey}`] && newBookings[`${dIdx}-${timeKey}`].studentId !== b.student?.id) {
               conflictKeys.add(`${dIdx}-${timeKey}`);
             }
             newBookings[`${dIdx}-${timeKey}`] = {
              id: b.id,
              studentId: b.student?.id,
              student: fullProfile?.full_name || 'Aluno',
              module: fullProfile?.module || b.module || 'Gen',
              type: b.type,
              avatar: fullProfile?.avatar_url || `https://ui-avatars.com/api/?name=${fullProfile?.full_name}`,
              fullProfile
            };
          }
        }
      });
    }

    // A experimental NÃO entra em `bookings`: ela é evento de um dia e antes
    // sobrescrevia a célula, apagando o aluno fixo daquele horário. Vai para um
    // estado próprio e é desenhada como camada temporária, filtrada por semana.
    setTrials((trialsRes.data as unknown as GridTrial[]) || []);

    setBookings(newBookings);
    setConflicts(conflictKeys);

    if (availRes.data) {
      const newAvail = new Set<string>();
      availRes.data.forEach((item: any) => {
        const dIdx = normalizeWeekdayToIndex(item.day_of_week);
        if (item.start_time) {
          const timeKey = item.start_time.substring(0, 5);
          if (dIdx >= 0 && dIdx <= 5) {
            newAvail.add(`${dIdx}-${timeKey}`);
          }
        }
      });
      setAvailableSlots(newAvail);
    }

    if (stdsRes.data) {
      setStudentsList(stdsRes.data);
    }
  };

  useEffect(() => {
    fetchDetailData();
  }, [selectedTeacher]);

  const handleAssignmentSubmit = async (data: {
    studentId?: string;
    isNew: boolean;
    studentData?: any;
    schedule: { day: string, time: string }[];
    module: string;
    startDate?: string;
    contractFile?: File;
    financial?: {
      price: number;
      planName: string;
      duration: number;
    }
  }) => {
    if (!selectedTeacher) return;
    if (!canManageAssignments) {
      alert('Atribuições de aluno são exclusivas da direção da escola.');
      return;
    }
    // VALIDATION: Ensure Schedule is present
    if (!data.schedule || data.schedule.length === 0) {
      alert('A agenda não foi selecionada corretamente. Recarregue a página e tente novamente.');
      return;
    }

    setIsAllocating(true);

    // Check for conflicts BEFORE creating student
    const conflicts: string[] = [];
    data.schedule.forEach(item => {
      const dayIdx = normalizeWeekdayToIndex(item.day);
      if (dayIdx < 0) return;
      const key = `${dayIdx}-${item.time}`;
      if (bookings[key]) {
        conflicts.push(`${item.day} às ${item.time}`);
      }
    });

    if (conflicts.length > 0) {
      alert(`Conflito: Já existe aluno alocado em: ${conflicts.join(', ')}.`);
      setIsAllocating(false);
      return;
    }

    try {
      let finalStudentId = data.studentId;
      let activationSent = false;
      let billingConfirmed = !data.financial;
      let billingFailure = '';

      // 1. Create New Auth Account and Profile if needed
      if (data.isNew && data.studentData) {
        const targetTenantId = currentTenantId || selectedTeacher.tenantId;
        if (!targetTenantId) throw new Error('Selecione uma escola antes de criar o aluno.');
        const normalizedEmail = String(data.studentData.email || '').trim().toLowerCase();
        if (!normalizedEmail) throw new Error('Informe o e-mail do aluno.');

        // Check for existing profile in THIS tenant first
        const { data: existingInTenant, error: existingLookupError } = await supabase
          .from('profiles')
          .select('id, role, lifecycle_status')
          .eq('email', normalizedEmail)
          .eq('tenant_id', targetTenantId)
          .maybeSingle();
        if (existingLookupError) throw existingLookupError;

        if (existingInTenant && existingInTenant.role !== 'STUDENT') {
          throw new Error('Este e-mail já pertence a outro tipo de acesso nesta escola.');
        }
        if (
          existingInTenant &&
          String(existingInTenant.lifecycle_status || '').trim().toLowerCase() !== 'active'
        ) {
          throw new Error('Este aluno está desativado. Reative o cadastro existente antes de matriculá-lo.');
        }

        // CPF e e-mail são resolvidos antes de criar Auth. Isso impede que um
        // cadastro já existente produza um segundo usuário sem perfil.
        const studentCpf = data.studentData.cpf?.replace(/\D/g, '') || null;
        finalStudentId = existingInTenant?.id;
        if (!finalStudentId && studentCpf) {
          const { data: existingByCpf, error: cpfLookupError } = await supabase.rpc(
            'find_authorized_profile_by_cpf',
            { p_tenant_id: targetTenantId, p_cpf: studentCpf },
          );
          if (cpfLookupError) throw cpfLookupError;
          if (existingByCpf) {
            const { data: cpfProfile, error: cpfProfileError } = await supabase
              .from('profiles')
              .select('id, role, lifecycle_status, email')
              .eq('id', existingByCpf)
              .maybeSingle();
            if (cpfProfileError) throw cpfProfileError;
            if (
              !cpfProfile ||
              cpfProfile.role !== 'STUDENT' ||
              String(cpfProfile.lifecycle_status || '').trim().toLowerCase() !== 'active'
            ) {
              throw new Error('O CPF informado pertence a um cadastro que não pode ser reutilizado.');
            }
            if (String(cpfProfile.email || '').trim().toLowerCase() !== normalizedEmail) {
              throw new Error('Este CPF já pertence a outro aluno. Edite o cadastro existente.');
            }
            finalStudentId = cpfProfile.id;
          }
        }

        if (!finalStudentId) {
          // A criação do Auth ocorre com credencial administrativa na Edge
          // Function. Isso preserva a sessão do diretor no navegador.
          const provisioned = await provisionStudentAccount(supabase, {
            name: data.studentData.name,
            email: normalizedEmail,
            tenantId: targetTenantId,
            phone: data.studentData.phone,
            professorId: selectedTeacher.id,
            monthlyFee: data.financial?.price || 0,
            dueDay: 10,
          });
          finalStudentId = provisioned.userId;
          activationSent = provisioned.activationSent;
        }

        // Handle Contract Upload if present
        let contractUrl = null;
        if (data.contractFile) {
          const fileName = `${targetTenantId}/${finalStudentId}/contract_${Date.now()}.pdf`;
          const { data: uploadData, error: uploadError } = await supabase.storage
            .from('contracts')
            .upload(fileName, data.contractFile);

          if (uploadError) {
            console.error("Erro ao subir contrato:", uploadError);
            alert("Atenção: Falha ao subir o arquivo de contrato. O aluno será criado sem o vínculo do arquivo.");
          } else {
            // Bucket 'contracts' é privado: guardamos apenas o path; a visualização
            // (ContractView) gera uma signed URL na hora de exibir.
            contractUrl = fileName;
          }
        }

        // Create or Update Profile
        const profilePayload: any = {
          id: finalStudentId,
          full_name: data.studentData.name,
          email: normalizedEmail,
          role: 'STUDENT',
          tenant_id: targetTenantId,
          module: data.module,
          phone: data.studentData.phone,
          occupation: data.studentData.occupation,
          interests: data.studentData.interests,
          avatar_url: `https://ui-avatars.com/api/?name=${data.studentData.name}`,
          cpf: studentCpf, // null instead of empty string to avoid unique constraint issues
          address: data.studentData.address,
          address_number: data.studentData.addressNumber,
          postal_code: data.studentData.postalCode,
          contract_url: contractUrl,
          contract_accepted: !!contractUrl
        };

        // Add Financial Data if present
        if (data.financial) {
          // `monthly_tuition` é espelho mantido pelo banco (trg_mirror_monthly_tuition).
          profilePayload.monthly_fee = data.financial.price;
          profilePayload.fidelity_plan = data.financial.planName;
          profilePayload.due_day = 10; // Default due day
          profilePayload.status_financial = 'PENDING';
        }

        const { error: profileError } = await supabase.from('profiles').upsert(profilePayload);

        if (profileError) throw profileError;

        // --- INJECT TO ASAAS ---
        if (data.financial) {
          try {
            console.log("Injetando dados do aluno manual no Asaas...");

            // 1. Sync Student (Creates/Updates Customer)
            const syncResponse = await asaasService.syncStudent({
              user_id: finalStudentId,
              name: profilePayload.full_name,
              email: profilePayload.email,
              cpf: studentCpf || '',
              phone: profilePayload.phone || '',
              postalCode: profilePayload.postal_code || '',
              address: profilePayload.address || '',
              addressNumber: profilePayload.address_number || '',
              tenant_id: targetTenantId,
              monthly_fee: data.financial.price,
              due_day: 10,
              contract_accepted: !!contractUrl,
              documentation_status: 'APPROVED'
            });

            // 2. Create Subscription
            const durationEnum = data.financial.duration === 12 ? 'ANNUAL' : data.financial.duration === 6 ? 'SEMESTER' : 'RECURRENT';

            const subResponse = await asaasService.createSubscription({
              user_id: finalStudentId,
              customer: syncResponse?.asaas_customer_id,
              value: data.financial.price,
              dueDay: 10,
              billingType: 'PIX', // Padrão para manual
              planDuration: durationEnum
            });

            const confirmedSubId = subResponse?.id || subResponse?.subscription_id;
            if (!confirmedSubId) throw new Error('O Asaas não confirmou a assinatura.');
            const { error: bindingError } = await supabase.from('profiles').update({
              subscription_id: confirmedSubId,
              status_financial: 'ACTIVE',
            }).eq('id', finalStudentId);
            if (bindingError) throw bindingError;
            billingConfirmed = true;
            console.log("✅ Asaas Injetado com Sucesso. ID:", confirmedSubId);
          } catch (asaasErr) {
            billingFailure = asaasErr instanceof Error ? asaasErr.message : 'falha não identificada';
            console.error("⚠️ Erro ao injetar no Asaas; aluno mantido como pendente:", asaasErr);
          }
        }
        // --- END ASAAS INJECTION ---

      }

      if (!finalStudentId) throw new Error("ID do aluno não definido.");

      // Insert bookings with Rollback.
      // Anti-duplicação (3 camadas):
      // 1) dedup do array (mesmo dia/hora repetido no payload);
      // 2) filtro contra agendamentos ATIVOS já existentes do aluno (re-submit vira no-op);
      // 3) índice único no banco (uq_bookings_no_dup_active) como rede final.
      const seenSlots = new Set<string>();
      let desired = data.schedule.filter((item: any) => {
        const key = `${item.day}|${item.time}`;
        if (seenSlots.has(key)) return false;
        seenSlots.add(key);
        return true;
      });

      const { data: existing } = await supabase
        .from('bookings')
        .select('id, day_of_week, time_slot')
        .eq('student_id', finalStudentId)
        .eq('teacher_id', selectedTeacher.id)
        .eq('tenant_id', currentTenantId || selectedTeacher.tenantId)
        .in('status', ['SCHEDULED', 'scheduled']);
      const existingKeys = new Set((existing || []).map((b: any) => `${b.day_of_week}|${b.time_slot}`));

      const toInsert = desired
        .filter((item: any) => !existingKeys.has(`${item.day}|${item.time}`))
        .map((item: any) => ({
          teacher_id: selectedTeacher.id,
          student_id: finalStudentId,
          day_of_week: item.day,
          time_slot: item.time,
          module: data.module,
          type: 'Individual',
          tenant_id: currentTenantId || selectedTeacher.tenantId,
          start_date: data.startDate
        }));

      let notificationBookingId = (existing || [])[0]?.id as string | undefined;
      if (toInsert.length > 0) {
        const { data: inserted, error } = await supabase
          .from('bookings').insert(toInsert).select('id');
        if (error) {
          // A conta é mantida em estado recuperável. Apagar só o perfil deixava
          // Auth, contrato e eventual assinatura órfãos; o retry é idempotente.
          console.error("Booking failed; student account kept for safe retry", error);
          throw error;
        }
        notificationBookingId = inserted?.[0]?.id || notificationBookingId;
      }

      // --- SEND WHATSAPP NOTIFICATION ---
      let notificationConfirmed = false;
      let notificationFailure = '';
      try {
        if (!notificationBookingId) {
          throw new Error('occurrence_identity_unavailable');
        }
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) throw new Error('Sessão expirada. Entre novamente.');

        const response = await fetch(`${FUNCTIONS_URL}/send-class-notification`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`
          },
          body: JSON.stringify({
            action: 'SCHEDULE_CONFIRMATION',
            source_id: notificationBookingId,
            source_type: 'BOOKING',
            class_date: localYMD(new Date()),
          })
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || result?.error) {
          throw new Error(result?.error || `status_${response.status}`);
        }
        if (
          result?.delivery !== 'accepted' ||
          typeof result?.provider_message_id !== 'string' ||
          !result.provider_message_id.trim()
        ) {
          throw new Error('delivery_not_confirmed');
        }
        notificationConfirmed = true;
      } catch (notifyErr) {
        console.error("Erro no fluxo de notificação:", notifyErr);
        notificationFailure = notifyErr instanceof Error
          ? notifyErr.message
          : 'delivery_not_confirmed';
      }
      // ----------------------------------

      await fetchDetailData();
      if (onRefresh) onRefresh();
      setIsAssignmentModalOpen(false);
      const outcome = ['Aluno e agendamentos salvos com segurança.'];
      if (data.isNew && activationSent) outcome.push('Convite de acesso enviado para definição da senha.');
      if (data.financial) {
        outcome.push(billingConfirmed
          ? 'Financeiro confirmado.'
          : `Cobrança pendente para revisão (${billingFailure || 'confirmação ausente'}).`);
      }
      outcome.push(notificationConfirmed
        ? 'WhatsApp confirmado.'
        : `O WhatsApp não confirmou o envio (${notificationFailure}).`);
      alert(outcome.join(' '));
    } catch (err: any) {
      alert("Erro ao atribuir aluno: " + err.message);
    } finally {
      setIsAllocating(false);
    }
  };

  const handleUpdateStudentProfile = async (profileData: any) => {
    if (!editingBooking?.studentId) return;

    try {
      const loadedProfile = editingBooking.fullProfile || {};
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

      // Só persiste colunas presentes no snapshot carregado. Assim, uma falha
      // parcial de leitura não transforma campos desconhecidos em string vazia.
      const isDirector = user?.role === 'SCHOOL_ADMIN' || user?.role === 'SUPER_ADMIN';
      if (!isDirector) {
        const { error: rpcError } = await supabase.rpc('update_student_pedagogical_profile', {
          p_student_id: editingBooking.studentId,
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
            module: requestedModule,
          }
        });
        if (rpcError) throw rpcError;
        await fetchDetailData();
        setEditingBooking(null);
        alert("Perfil pedagógico do aluno atualizado com sucesso!");
        return;
      }

      setIfLoaded('full_name', profileData.name);
      setIfLoaded('occupation', profileData.occupation);
      setIfLoaded('phone', profileData.phone);
      setIfLoaded('meeting_link', profileData.meeting_link);
      setIfLoaded('cpf', profileData.cpf);
      setIfLoaded('address', profileData.address);
      setIfLoaded('address_number', profileData.addressNumber);
      setIfLoaded('postal_code', profileData.postalCode);
      setIfLoaded('interests', profileData.interests);
      setIfLoaded('private_notes', profileData.private_notes);
      setIfLoaded('fixed_schedule', profileData.fixed_schedule);
      setIfLoaded('professor_id', nullableUuid(profileData.professor_id));

      // Only update financial data if present and user has permission (implicit by checking if fields exist in data)
      // Since StudentProfileForm only shows these fields to Directors, we can trust the data if present,
      // but RLS will ultimately block it if unauthorized.
      // A mensalidade é `monthly_fee`. `monthly_tuition` virou espelho mantido
      // pelo banco (trg_mirror_monthly_tuition) — gravar aqui recria a divergência.
      setIfLoaded('monthly_fee', profileData.monthly_fee);
      setIfLoaded('due_day', profileData.due_day);
      setIfLoaded('status_financial', profileData.status_financial);
      setIfLoaded('fidelity_plan', profileData.planDuration);

      if (Object.keys(updates).length === 0) {
        throw new Error('Os dados completos do aluno não foram carregados. Reabra o perfil e tente novamente.');
      }

      const { error } = await supabase
        .from('profiles')
        .update(updates)
        .eq('id', editingBooking.studentId);

      if (error) throw error;

      if (placementChanged) {
        const { error: placementError } = await supabase.rpc(
          'set_student_pedagogical_placement',
          {
            p_student_id: editingBooking.studentId,
            p_module: requestedModule,
            p_reason: 'Reposicionamento pedagógico autorizado na gestão de agenda',
          },
        );
        if (placementError) throw placementError;
      }

      // Atualiza status se alterado no formulário
      if (profileData.status && profileData.status !== (loadedProfile.status || 'Ativo')) {
        await changeStudentLifecycle(supabase, {
          studentId: editingBooking.studentId,
          status: ['Inativo', 'Trancado'].includes(profileData.status) ? 'suspended' : 'active',
          reason: 'Alterado no formulário da gestão de agenda',
        });
      }

      await fetchDetailData();
      setEditingBooking(null);
      alert("Perfil do aluno atualizado com sucesso!");
    } catch (err: any) {
      console.error("Error updating profile:", err);
      alert("Erro ao atualizar perfil: " + err.message);
    }
  };

  const openBookingEditor = async (booking: any) => {
    try {
      const isDirector = user?.role === 'SCHOOL_ADMIN' || user?.role === 'SUPER_ADMIN';
      let privateProfile = {};
      if (isDirector) {
        try {
          privateProfile = await loadAuthorizedProfilePrivate(booking.studentId);
        } catch (_) {}
      }
      setEditingBooking({
        ...booking,
        fullProfile: {
          ...booking.fullProfile,
          ...privateProfile,
          name: booking.fullProfile?.full_name || booking.student,
          phone: booking.fullProfile?.phone || '',
          attendance_phone: booking.fullProfile?.attendance_phone || '',
          levelBadge: booking.fullProfile?.module?.split(' ')[0] || booking.module || 'A1',
          status: booking.fullProfile?.status || 'Ativo',
        },
      });
    } catch (error) {
      console.error('Erro ao abrir editor do aluno:', error);
      setEditingBooking(booking);
    }
  };

  const handleDeleteBooking = async () => {
    if (!editingBooking?.id) return;
    if (!confirm("Tem certeza que deseja remover este aluno deste horário?")) return;

    try {
      const { error } = await supabase.from('bookings').delete().eq('id', editingBooking.id);
      if (error) throw error;

      await fetchDetailData();
      setEditingBooking(null);
    } catch (err: any) {
      alert("Erro ao remover: " + err.message);
    }
  };

  // A grade mostra SÓ as reposições do professor selecionado (regra e motivos em
  // lib/scheduleGrid.ts). Antes varria a lista inteira da escola, e como a célula
  // desenha a reposição ANTES do booking, a reposição de um professor escondia o
  // aluno real do outro naquele horário.
  const teacherReschedules = React.useMemo(
    () => reschedulesForTeacherGrid(reschedules, selectedTeacher?.id, weekStart),
    [reschedules, selectedTeacher, weekStart],
  );

  const weekTrials = React.useMemo(() => trialsForGrid(trials, weekStart), [trials, weekStart]);

  const getRescheduleForSlot = (dayIdx: number, hour: number | string) =>
    findRescheduleForSlot(teacherReschedules, dayIdx, typeof hour === 'number' ? `${hour}:00` : hour, weekStart);

  const getTrialForSlot = (dayIdx: number, hour: number | string) =>
    findTrialForSlot(weekTrials, dayIdx, typeof hour === 'number' ? `${hour}:00` : hour, weekStart);

  // Rótulo da semana exibida ("11/08 – 16/08"), para a grade nunca parecer um
  // molde perpétuo.
  const weekLabel = React.useMemo(() => {
    const fmt = (ymd: string) => ymd.split('-').slice(1).reverse().join('/');
    return `${fmt(dateForDayIndex(weekStart, 0))} – ${fmt(dateForDayIndex(weekStart, 5))}`;
  }, [weekStart]);

  // Estado de cada célula, na mesma precedência que a grade desenha: aula fixa,
  // depois evento de um dia, depois horário livre declarado.
  const readSlot = React.useCallback<SlotReader>((dIdx, time) => {
    const key = `${dIdx}-${time}`;
    if (bookings[key]) return 'booked';
    if (reservedCells[key] || findRescheduleForSlot(teacherReschedules, dIdx, time, weekStart) || findTrialForSlot(weekTrials, dIdx, time, weekStart)) return 'event';
    if (availableSlots.has(key)) return 'free';
    return 'off';
  }, [bookings, reservedCells, availableSlots, teacherReschedules, weekTrials, weekStart]);

  const gridRows = React.useMemo<GridRow[]>(
    () => (compactGrid ? compactRows(TIMES, DAYS.length, readSlot) : TIMES.map(time => ({ kind: 'time' as const, time }))),
    [compactGrid, readSlot],
  );
  const loads = React.useMemo(() => dayLoads(TIMES, DAYS.length, readSlot), [readSlot]);
  const windows = React.useMemo(() => freeWindows(TIMES, DAYS.length, readSlot).slice(0, 4), [readSlot]);
  const todayYMD = localYMD(now);
  const nowSlot = weekOffset === 0 ? currentSlot(TIMES, now) : null;
  const inFocusWindow = (dIdx: number, time: string) =>
    !!focusWindow && focusWindow.dayIdx === dIdx && time >= focusWindow.start && time < focusWindow.end;

  const stats = React.useMemo(() => {
    const occupied = Object.keys(bookings).length;
    const free = Array.from(availableSlots).filter(k => !bookings[k]).length;
    const denom = occupied + free;
    return {
      occupied,
      free,
      pct: denom > 0 ? Math.round(100 * occupied / denom) : 0,
      distinct: new Set(Object.values(bookings).map((b: any) => b.studentId || b.student)).size,
    };
  }, [bookings, availableSlots]);

  const filteredTeachers = (teachers || [])
    .filter(t => {
      const matchesSearch = t.name.toLowerCase().includes(searchTerm.toLowerCase());
      const matchesSpec = !specFilter || (t.specializations || []).includes(specFilter);
      return matchesSearch && matchesSpec;
    })
    .sort((a, b) => {
      if (teacherSort === 'name') return a.name.localeCompare(b.name, 'pt-BR');
      const la = teacherLoads[a.id];
      const lb = teacherLoads[b.id];
      if (teacherSort === 'free') return (lb?.free ?? -1) - (la?.free ?? -1) || a.name.localeCompare(b.name, 'pt-BR');
      return (lb?.booked ?? -1) - (la?.booked ?? -1) || a.name.localeCompare(b.name, 'pt-BR');
    });

  const initials = (name?: string) => (name || '?').split(' ').filter(Boolean).slice(0, 2).map(p => p[0]).join('').toUpperCase();
  const ddmm = (ymd: string) => ymd.split('-').slice(1).reverse().join('/');

  return (
    // A página inteira rola. Com altura fixa aqui, o retrato da semana ficava preso
    // em cima e sobravam duas linhas de grade numa tela de notebook.
    <div data-tour="director-schedule-change" className="ww-stage flex flex-col xl:flex-row xl:items-start gap-5 animate-in fade-in duration-500 relative">
      {/* Corpo docente: cada professor com o quanto da agenda dele está ocupado */}
      <aside data-tour="schedule-teacher-loads" className="ww-slab w-full xl:w-80 flex flex-col shrink-0 overflow-hidden xl:sticky! xl:top-20 xl:max-h-[calc(100dvh-6rem)]">
        <div className="p-5 pb-4 border-b border-brand-border/60">
          <div className="flex items-center justify-between gap-2 mb-3">
            <h3 className="font-black text-brand-text text-[11px] uppercase tracking-[0.18em] flex items-center gap-2">
              <span className="ww-orb tone-brand h-7 w-7 rounded-lg"><Users size={14} /></span> Corpo docente
            </h3>
            <span className="text-[10px] font-black text-brand-muted">{filteredTeachers.length}</span>
          </div>
          <div className="relative mb-2">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-brand-muted" size={13} />
            <input
              type="text"
              placeholder="Buscar por nome..."
              className="w-full pl-9 pr-4 py-2.5 bg-brand-surface-2/70 border border-brand-border rounded-xl text-xs focus:ring-2 focus:ring-tenant-primary outline-hidden font-semibold text-brand-text"
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <select
              value={specFilter}
              onChange={e => setSpecFilter(e.target.value)}
              aria-label="Filtrar por especialidade"
              className="w-full px-3 py-2 bg-brand-surface-2/70 border border-brand-border rounded-xl text-[11px] font-bold text-brand-text focus:ring-2 focus:ring-tenant-primary outline-hidden"
            >
              <option value="">Todas as especialidades</option>
              {TEACHER_SPECIALIZATIONS.map(s => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <select
              value={teacherSort}
              onChange={e => setTeacherSort(e.target.value as TeacherSort)}
              aria-label="Ordenar professores"
              className="w-full px-3 py-2 bg-brand-surface-2/70 border border-brand-border rounded-xl text-[11px] font-bold text-brand-text focus:ring-2 focus:ring-tenant-primary outline-hidden"
            >
              <option value="name">Nome (A–Z)</option>
              <option value="free">Mais horários livres</option>
              <option value="busy">Mais aulas</option>
            </select>
          </div>
        </div>

        <div className="max-h-72 xl:max-h-none xl:flex-1 xl:min-h-0 overflow-y-auto p-3 space-y-2 scrollbar-hide">
          {filteredTeachers.map((teacher) => {
            const active = selectedTeacher?.id === teacher.id;
            const load = teacherLoads[teacher.id];
            const fill = load && load.booked + load.free > 0 ? Math.round(100 * load.booked / (load.booked + load.free)) : 0;
            return (
              <button
                key={teacher.id}
                onClick={() => { setSelectedTeacher(teacher); setFocusWindow(null); }}
                aria-pressed={active}
                className={`ww-lift w-full p-3 rounded-2xl border flex items-center gap-3 text-left ${active
                  ? 'ww-block tone-brand border-transparent'
                  : 'bg-brand-surface/70 border-brand-border hover:border-tenant-primary/40'
                  }`}
              >
                {teacher.avatar
                  ? <img src={teacher.avatar} className={`w-10 h-10 rounded-xl object-cover shrink-0 ${active ? 'ring-2 ring-white/40' : 'shadow-md'}`} alt="" />
                  : <span className="ww-orb tone-brand w-10 h-10 shrink-0 text-xs font-black">{initials(teacher.name)}</span>}
                <div className="flex-1 min-w-0 relative">
                  <p className={`text-xs font-black truncate leading-tight ${active ? 'text-white' : 'text-brand-text'}`}>{teacher.name}</p>
                  <p className={`text-[10px] font-semibold truncate mt-0.5 ${active ? 'text-white/75' : 'text-brand-muted'}`}>
                    {load ? `${load.booked} aulas · ${load.free} livres` : teacher.module}
                  </p>
                  {load && (
                    <div className={`mt-1.5 h-1.5 rounded-full overflow-hidden ${active ? 'bg-white/25' : 'bg-brand-surface-2'}`}>
                      <div className={`h-full rounded-full ${active ? 'bg-white' : 'bg-linear-to-r from-emerald-400 to-emerald-600'}`} style={{ width: `${fill}%` }} />
                    </div>
                  )}
                </div>
                <ChevronRight size={14} className={`shrink-0 relative ${active ? 'text-white' : 'text-brand-muted'}`} />
              </button>
            );
          })}
          {filteredTeachers.length === 0 && (
            <p className="py-8 text-center text-xs font-bold text-brand-muted">Nenhum professor com esse filtro.</p>
          )}
        </div>
      </aside>

      {/* Agenda do professor selecionado */}
      <section className="ww-slab flex-1 min-w-0 min-h-[70vh] flex flex-col overflow-clip">
        {selectedTeacher ? (
          <>
            <div className="px-4 sm:px-6 pt-5 pb-4 border-b border-brand-border/60 space-y-4">
              <div className="flex flex-col lg:flex-row justify-between lg:items-center gap-4">
                <div className="flex items-center gap-4 min-w-0">
                  {selectedTeacher.avatar
                    ? <img src={selectedTeacher.avatar} className="w-14 h-14 rounded-2xl object-cover shadow-xl ring-4 ring-white/70 dark:ring-white/10 shrink-0" alt="" />
                    : <span className="ww-orb tone-brand w-14 h-14 shrink-0 text-base font-black">{initials(selectedTeacher.name)}</span>}
                  <div className="min-w-0">
                    <p className="text-[10px] font-black uppercase tracking-[0.2em] text-brand-muted">Agenda de</p>
                    <h2 className="text-lg sm:text-xl font-black text-brand-text tracking-tight leading-tight truncate">{selectedTeacher.name}</h2>
                    <div className="flex flex-wrap items-center gap-1.5 mt-1">
                      <span className="text-[10px] font-bold text-brand-muted">{selectedTeacher.module}</span>
                      {(selectedTeacher.specializations || []).map(s => (
                        <span key={s} className="px-2 py-0.5 bg-amber-500/10 text-amber-600 dark:text-amber-400 text-[9px] font-black rounded-full border border-amber-500/25 whitespace-nowrap">
                          {s}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                  {/* Navegação de semana: a grade mostra UMA semana concreta. */}
                  <div className="w-full sm:w-auto flex items-center justify-between gap-1 rounded-2xl border border-brand-border bg-brand-surface-2/70 p-1 shadow-inner">
                    <button
                      type="button"
                      onClick={() => setWeekOffset(w => w - 1)}
                      aria-label="Semana anterior"
                      className="h-8 w-8 grid place-items-center rounded-xl text-brand-muted hover:bg-brand-surface hover:text-brand-text transition-colors"
                    >
                      <ChevronLeft size={16} />
                    </button>
                    <button
                      type="button"
                      onClick={() => setWeekOffset(0)}
                      title="Voltar para a semana atual"
                      className="min-w-[7.5rem] px-2 text-center"
                    >
                      <span className="block text-[9px] font-black uppercase tracking-wider text-brand-muted">
                        {weekOffset === 0 ? 'Esta semana' : weekOffset > 0 ? `+${weekOffset} semana${weekOffset > 1 ? 's' : ''}` : `${weekOffset} semana${weekOffset < -1 ? 's' : ''}`}
                      </span>
                      <span className="block text-xs font-black leading-none text-brand-text whitespace-nowrap">{weekLabel}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setWeekOffset(w => w + 1)}
                      aria-label="Próxima semana"
                      className="h-8 w-8 grid place-items-center rounded-xl text-brand-muted hover:bg-brand-surface hover:text-brand-text transition-colors"
                    >
                      <ChevronRight size={16} />
                    </button>
                  </div>
                  <div className="relative w-full sm:w-auto">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-brand-muted" size={13} />
                    <input
                      value={slotSearch}
                      onChange={e => setSlotSearch(e.target.value)}
                      placeholder="Localizar aluno na grade…"
                      className="pl-8 pr-3 py-2.5 text-xs font-bold bg-brand-surface-2/70 border border-brand-border rounded-xl outline-hidden text-brand-text w-full sm:w-52 min-w-0 focus:ring-2 focus:ring-tenant-primary"
                    />
                  </div>
                  {canManageAssignments && (
                    <button
                      onClick={() => setIsAssignmentModalOpen(true)}
                      className="ww-block tone-brand w-full sm:w-auto px-4 py-2.5 font-black text-[11px] uppercase tracking-widest flex items-center justify-center gap-2 whitespace-nowrap"
                    >
                      <UserPlus size={15} className="relative" /> <span className="relative">Atribuir aluno</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Retrato da semana: números, carga por dia e onde cabe aluno novo */}
              <div data-tour="schedule-week-portrait" className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1.4fr)_minmax(0,1.2fr)] gap-3">
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-2xl border border-brand-border bg-brand-surface/60 p-3 flex items-center gap-3 col-span-2">
                    <Ring3D value={stats.pct} tone="emerald" size={52} label={`Ocupação de ${stats.pct}%`} />
                    <div className="min-w-0">
                      <p className="text-[9px] font-black uppercase tracking-[0.16em] text-brand-muted">Ocupação da grade</p>
                      <p className="text-sm font-black text-brand-text">{stats.occupied} aulas · {stats.distinct} alunos</p>
                      <p className="text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">{formatSlots(stats.free)} livres na semana</p>
                    </div>
                  </div>
                  {conflicts.size > 0 && (
                    <div className="col-span-2 rounded-2xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 flex items-center gap-2" title="Horários com mais de um aluno">
                      <AlertCircle size={16} className="text-rose-500 shrink-0" />
                      <p className="text-[11px] font-black text-rose-600 dark:text-rose-400">
                        {conflicts.size} conflito{conflicts.size > 1 ? 's' : ''} — dois alunos no mesmo horário
                      </p>
                    </div>
                  )}
                </div>

                <div className="rounded-2xl border border-brand-border bg-brand-surface/60 px-3 pt-2 pb-3">
                  <p className="text-[9px] font-black uppercase tracking-[0.16em] text-brand-muted">Carga por dia</p>
                  <Towers3D
                    height={52}
                    ariaLabel="Aulas por dia da semana"
                    data={loads.map(l => {
                      const ymd = dateForDayIndex(weekStart, l.dayIdx);
                      return {
                        key: String(l.dayIdx),
                        label: DAYS[l.dayIdx].slice(0, 3),
                        sublabel: `${l.free} livre${l.free === 1 ? '' : 's'}`,
                        value: l.booked + l.events,
                        tone: l.fill >= 0.85 ? 'rose' : l.fill >= 0.5 ? 'amber' : 'emerald',
                        highlight: ymd === todayYMD,
                        caption: `${DAYS[l.dayIdx]} ${ddmm(ymd)}: ${l.booked} aulas fixas, ${l.events} eventos, ${l.free} horários livres`,
                      };
                    })}
                  />
                </div>

                <div className="rounded-2xl border border-brand-border bg-brand-surface/60 p-3">
                  <p className="text-[9px] font-black uppercase tracking-[0.16em] text-brand-muted flex items-center gap-1.5">
                    <Sparkles size={11} className="text-violet-500" /> Onde cabe aluno novo
                  </p>
                  {windows.length === 0 ? (
                    <p className="mt-2 text-[11px] font-semibold text-brand-muted">Nenhum bloco de 1 h livre nesta semana.</p>
                  ) : (
                    <div className="mt-2 grid grid-cols-2 gap-1.5">
                      {windows.map(w => {
                        const selected = focusWindow?.dayIdx === w.dayIdx && focusWindow.start === w.start;
                        return (
                          <button
                            key={`${w.dayIdx}-${w.start}`}
                            type="button"
                            onClick={() => setFocusWindow(selected ? null : w)}
                            aria-pressed={selected}
                            className={`ww-lift rounded-xl px-2.5 py-1.5 text-left border ${selected ? 'border-emerald-500 bg-emerald-500/15' : 'border-emerald-500/25 bg-emerald-500/5 hover:bg-emerald-500/10'}`}
                          >
                            <span className="block text-[10px] font-black text-brand-text">{DAYS[w.dayIdx].slice(0, 3)} {w.start}–{w.end}</span>
                            <span className="block text-[9px] font-bold text-emerald-600 dark:text-emerald-400">{formatSlots(w.slots)} seguidas</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <Legend tone="emerald" label="Aula fixa" />
                <Legend tone="amber" label="Reposição" ghost />
                <Legend tone="violet" label="Experimental / teste oral" ghost />
                <Legend tone="teal" label="Reservado (início futuro ou termo pendente)" ghost />
                <Legend well label="Livre" />
                <Legend off label="Fora da grade" />
                <label className="ml-auto inline-flex items-center gap-2 text-[11px] font-bold text-brand-muted cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={compactGrid}
                    onChange={e => setCompactGrid(e.target.checked)}
                    className="h-4 w-4 rounded accent-[rgb(var(--tenant-primary-rgb))]"
                  />
                  Esconder horas sem agenda
                </label>
              </div>
            </div>

            {/* Grade: overflow-clip e overflow-x-clip não criam rolagem própria, então
                os dias da semana grudam no topo da página enquanto ela rola. */}
            <div className="flex-1 overflow-x-clip p-3 sm:p-4 relative">
              {gridRows.length === 0 && (
                <div className="h-full min-h-60 flex flex-col items-center justify-center text-center gap-2 text-brand-muted">
                  <span className="ww-orb tone-slate h-14 w-14"><Clock size={22} /></span>
                  <p className="text-sm font-black text-brand-text">Agenda vazia nesta semana</p>
                  <p className="text-xs max-w-xs">Este professor ainda não declarou horários livres nem tem aulas marcadas.</p>
                </div>
              )}

              {/* CELULAR: lista por dia (a grade larga é inviável no celular) */}
              <div className="md:hidden space-y-3">
                {gridRows.length > 0 && DAYS.map((day, dIdx) => {
                  const daySlots = TIMES
                    .map(time => ({
                      time,
                      booking: bookings[`${dIdx}-${time}`],
                      reschedule: getRescheduleForSlot(dIdx, time),
                      trial: getTrialForSlot(dIdx, time),
                      reserved: reservedCells[`${dIdx}-${time}`],
                      conflict: conflicts.has(`${dIdx}-${time}`),
                    }));
                  const dayEntries = daySlots.filter(entry => entry.booking || entry.reschedule || entry.trial || entry.reserved);
                  const freeTimes = daySlots
                    .filter(entry => (
                      availableSlots.has(`${dIdx}-${entry.time}`)
                      && !entry.booking
                      && !entry.reschedule
                      && !entry.trial
                      && !entry.reserved
                    ))
                    .map(entry => entry.time);
                  const ymd = dateForDayIndex(weekStart, dIdx);
                  const isToday = ymd === todayYMD;
                  return (
                    <div key={day} className={`rounded-2xl border p-3 ${isToday ? 'border-tenant-primary/50 bg-tenant-primary/5' : 'border-brand-border bg-brand-surface/60'}`}>
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <p className="text-[11px] font-black text-brand-text uppercase tracking-widest">
                          {day} <span className="text-brand-muted">{ddmm(ymd)}</span>
                          {isToday && <span className="ml-1.5 rounded-full bg-tenant-primary px-1.5 py-0.5 text-[8px] text-white">hoje</span>}
                        </p>
                        <span className="shrink-0 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[9px] font-black uppercase text-emerald-600 dark:text-emerald-400">
                          {dayEntries.length} aula{dayEntries.length === 1 ? '' : 's'} · {freeTimes.length} livre{freeTimes.length === 1 ? '' : 's'}
                        </span>
                      </div>
                      {dayEntries.length === 0 ? (
                        <p className="text-[11px] text-brand-muted italic">Sem aulas</p>
                      ) : (
                        <div className="space-y-1.5">
                          {dayEntries.map(({ time, booking, reschedule, trial, reserved, conflict }) => {
                            const hit = (name?: string) =>
                              slotSearch.trim() !== '' && (name || '').toLowerCase().includes(slotSearch.toLowerCase());
                            const match = hit(reschedule?.studentName) || hit(trial?.studentName) || hit(booking?.student) || hit(reserved?.student);
                            const dim = slotSearch.trim() !== '' && !match;
                            // Reposição e experimental são de UM dia: aparecem
                            // JUNTO da aula fixa, nunca no lugar dela. Substituir
                            // a célula fazia o aluno regular sumir da tela do
                            // diretor enquanto a reposição estivesse marcada.
                            return (
                              <div key={time} className={`space-y-1 ${dim ? 'opacity-30' : ''}`}>
                                {reschedule && (
                                  <div className={`ww-ghost tone-amber flex items-center gap-2 px-2.5 py-2 ${match ? 'ring-2 ring-amber-400' : ''}`}>
                                    <Clock size={13} aria-hidden="true" className="shrink-0" />
                                    <span className="w-10 shrink-0 font-mono text-[10px] font-bold">{time}</span>
                                    <span className="min-w-0 flex-1 truncate text-[11px] font-black uppercase">{reschedule.studentName}</span>
                                    <span className="text-[9px] font-bold uppercase opacity-80">Reposição · só hoje</span>
                                  </div>
                                )}
                                {trial && (
                                  <div className={`ww-ghost tone-violet flex items-center gap-2 px-2.5 py-2 ${match ? 'ring-2 ring-violet-400' : ''}`}>
                                    <Zap size={13} aria-hidden="true" className="shrink-0" />
                                    <span className="w-10 shrink-0 font-mono text-[10px] font-bold">{time}</span>
                                    <span className="min-w-0 flex-1 truncate text-[11px] font-black uppercase">{trial.studentName}</span>
                                    <span className="text-[9px] font-bold uppercase opacity-80">{trial.type === 'oral_test' ? 'Teste oral · só hoje' : 'Experimental · só hoje'}</span>
                                  </div>
                                )}
                                {reserved && !booking && (
                                  <div title={reserved.caption} className={`ww-ghost tone-teal flex items-center gap-2 px-2.5 py-2 ${match ? 'ring-2 ring-teal-400' : ''}`}>
                                    <Lock size={13} aria-hidden="true" className="shrink-0" />
                                    <span className="w-10 shrink-0 font-mono text-[10px] font-bold">{time}</span>
                                    <span className="min-w-0 flex-1 truncate text-[11px] font-black uppercase">{reserved.student}</span>
                                    <span className="text-[9px] font-bold uppercase opacity-80">{reserved.label}</span>
                                  </div>
                                )}
                                {booking && (
                                  <button
                                    type="button"
                                    onClick={() => void openBookingEditor(booking)}
                                    aria-label={`Editar aula de ${booking.student}, ${day} às ${time}`}
                                    className={`ww-block tone-emerald flex w-full items-center gap-2 px-2.5 py-2 text-left cursor-pointer ${conflict ? 'ring-2 ring-rose-400' : ''} ${match ? 'ring-2 ring-yellow-300' : ''}`}
                                  >
                                    <span className="relative text-[10px] font-mono font-bold w-10 shrink-0">{time}</span>
                                    <span className="relative text-[11px] font-black uppercase truncate flex-1">{booking.student}</span>
                                    <span className="relative text-[9px] font-bold opacity-80">{booking.module}</span>
                                  </button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                      {freeTimes.length > 0 && (
                        <details className="group mt-2 rounded-xl border border-emerald-500/25 bg-brand-surface">
                          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-[10px] font-black uppercase tracking-wider text-emerald-600 marker:hidden dark:text-emerald-400">
                            <span>Horários livres</span>
                            <span className="text-[9px] text-brand-muted group-open:hidden">Ver horários</span>
                            <span className="hidden text-[9px] text-brand-muted group-open:inline">Ocultar</span>
                          </summary>
                          <div className="grid grid-cols-3 gap-1.5 border-t border-emerald-500/20 p-2.5">
                            {freeTimes.map(time => (
                              <span
                                key={time}
                                className="ww-well px-2 py-1.5 text-center font-mono text-[10px] font-bold text-emerald-700 dark:text-emerald-300"
                              >
                                {time}
                              </span>
                            ))}
                          </div>
                        </details>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* COMPUTADOR: grade completa */}
              {gridRows.length > 0 && (
              <div className="hidden md:block">
                <table className="w-full table-fixed border-separate border-spacing-1.5">
                  {/* 65 px: altura do topo do app, que também gruda no <main>. */}
                  <thead className="sticky top-[65px] z-40">
                    <tr>
                      <th className="w-14 bg-brand-surface/90 backdrop-blur-md rounded-xl" aria-label="Horário"></th>
                      {DAYS.map((day, dIdx) => {
                        const ymd = dateForDayIndex(weekStart, dIdx);
                        const isToday = ymd === todayYMD;
                        const load = loads[dIdx];
                        return (
                          <th key={day} className={`p-2 rounded-xl backdrop-blur-md ${isToday ? 'ww-block tone-brand' : 'bg-brand-surface/90 border border-brand-border'}`}>
                            <span className={`relative block text-[10px] font-black uppercase tracking-[0.16em] ${isToday ? 'text-white' : 'text-brand-text'}`}>{day}</span>
                            <span className={`relative block text-[10px] font-bold ${isToday ? 'text-white/80' : 'text-brand-muted'}`}>
                              {ddmm(ymd)}{isToday ? ' · hoje' : ''}
                            </span>
                            <span className={`relative mx-auto mt-1.5 block h-1 w-16 rounded-full overflow-hidden ${isToday ? 'bg-white/25' : 'bg-brand-surface-2'}`}>
                              <span className={`block h-full rounded-full ${isToday ? 'bg-white' : 'bg-emerald-500'}`} style={{ width: `${Math.round(load.fill * 100)}%` }} />
                            </span>
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {gridRows.map(row => {
                      if (row.kind === 'gap') {
                        return (
                          <tr key={`gap-${row.from}`}>
                            <td className="text-center align-middle">
                              <span className="text-[9px] font-bold text-brand-muted font-mono">{row.from}</span>
                            </td>
                            <td colSpan={DAYS.length}>
                              <button
                                type="button"
                                onClick={() => setCompactGrid(false)}
                                className="ww-off w-full py-1.5 text-[10px] font-bold text-brand-muted hover:text-brand-text"
                                title="Mostrar todos os horários"
                              >
                                {row.from} – {row.to} · {formatSlots(row.count)} sem agenda em nenhum dia
                              </button>
                            </td>
                          </tr>
                        );
                      }
                      const { time } = row;
                      const isNowRow = nowSlot === time;
                      return (
                        <tr key={time}>
                          <td className="text-center align-middle">
                            <span className={`text-[10px] font-bold font-mono ${isNowRow ? 'text-rose-500' : 'text-brand-muted'}`}>{time}</span>
                          </td>
                          {DAYS.map((_, dIdx) => {
                            const key = `${dIdx}-${time}`;
                            const booking = bookings[key];
                            const isAvailable = availableSlots.has(key);
                            const reschedule = getRescheduleForSlot(dIdx, time);
                            const trial = getTrialForSlot(dIdx, time);
                            const reservedCell = reservedCells[key];
                            const isConflict = conflicts.has(key);
                            const hitName = (name?: string) =>
                              slotSearch.trim() !== '' && (name || '').toLowerCase().includes(slotSearch.toLowerCase());
                            const matchSearch = hitName(booking?.student) || hitName(reschedule?.studentName) || hitName(trial?.studentName) || hitName(reservedCell?.student);
                            const dimmed = slotSearch.trim() !== '' && (booking || reschedule || trial || reservedCell) && !matchSearch;
                            const isTodayCol = dateForDayIndex(weekStart, dIdx) === todayYMD;
                            const focused = inFocusWindow(dIdx, time);
                            // O evento de UM dia (reposição/experimental) é uma
                            // faixa POR CIMA da célula, não a célula inteira: a
                            // aula fixa daquele horário continua visível embaixo.
                            const overlay = reschedule
                              ? { label: 'Reposição', name: reschedule.studentName, tone: 'amber' as const }
                              : trial
                                ? { label: trial.type === 'oral_test' ? 'Teste oral' : 'Experimental', name: trial.studentName, tone: 'violet' as const }
                                : null;

                            return (
                              <td key={dIdx} className={`h-11 relative ${isTodayCol ? 'bg-tenant-primary/[0.04] rounded-xl' : ''}`}>
                                {isNowRow && isTodayCol && (
                                  <div className="ww-now" style={{ top: `${Math.round(slotProgress(now) * 100)}%` }} aria-hidden="true" />
                                )}
                                {overlay && (
                                  <div
                                    className={`ww-ghost tone-${overlay.tone} absolute inset-x-0 top-0 z-20 m-0.5 flex items-center gap-1 px-1.5 py-0.5 cursor-help bg-brand-surface`}
                                    title={`${overlay.label} de ${overlay.name} — só em ${dateForDayIndex(weekStart, dIdx).split('-').reverse().join('/')}, não ocupa este horário nas outras semanas`}
                                  >
                                    {overlay.tone === 'amber' ? <Clock size={9} className="shrink-0" /> : <Zap size={9} className="shrink-0" />}
                                    <span className="truncate text-[8px] font-black uppercase tracking-wider">
                                      {overlay.label} · {overlay.name}
                                    </span>
                                  </div>
                                )}
                                {booking ? (
                                  <button
                                    type="button"
                                    onClick={() => void openBookingEditor(booking)}
                                    aria-label={`Editar aula de ${booking.student}, ${DAYS[dIdx]} às ${time}`}
                                    title={`${booking.student} · ${booking.module}`}
                                    className={`ww-block tone-emerald w-full h-full px-1.5 flex items-center gap-1.5 text-left cursor-pointer ${isConflict ? 'tone-rose ring-2 ring-rose-400' : ''} ${matchSearch ? 'ring-2 ring-yellow-300 z-10' : ''} ${dimmed ? 'opacity-20' : ''}`}
                                  >
                                    <span className="relative hidden 2xl:grid h-6 w-6 shrink-0 place-items-center rounded-md bg-white/20 text-[9px] font-black">{initials(booking.student)}</span>
                                    <span className="relative min-w-0">
                                      <span className="block text-[9px] font-black uppercase truncate leading-tight">{booking.student}</span>
                                      <span className="block text-[8px] font-bold text-white/75 uppercase truncate">{booking.module}</span>
                                    </span>
                                  </button>
                                ) : reservedCell ? (
                                  <div
                                    title={reservedCell.caption}
                                    className={`ww-ghost tone-teal w-full h-full px-1.5 flex flex-col justify-center cursor-help ${matchSearch ? 'ring-2 ring-yellow-300 z-10' : ''} ${dimmed ? 'opacity-20' : ''}`}
                                  >
                                    <span className="block truncate text-[9px] font-black uppercase leading-tight">{reservedCell.student}</span>
                                    <span className="block truncate text-[8px] font-bold uppercase opacity-80">{reservedCell.label}</span>
                                  </div>
                                ) : overlay ? (
                                  <div className="w-full h-full ww-off" />
                                ) : isAvailable ? (
                                  <div className={`ww-well w-full h-full flex items-center justify-center ${focused ? 'ring-2 ring-emerald-500 bg-emerald-500/20' : ''}`}>
                                    <span className="text-[8px] font-black text-emerald-600/70 dark:text-emerald-400/70 uppercase tracking-[0.18em]">livre</span>
                                  </div>
                                ) : (
                                  <div className="ww-off w-full h-full" title="Fora da grade de horários deste professor" />
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-brand-muted gap-3">
            <span className="ww-orb tone-brand h-16 w-16"><Users size={26} /></span>
            <p className="text-sm font-black text-brand-text">Selecione um professor</p>
          </div>
        )}
      </section>

      {/* Assignment Modal */}
      {isAssignmentModalOpen && (
        <div className="fixed inset-0 z-100 flex items-center justify-center p-4 bg-brand-surface/60 backdrop-blur-xs animate-in fade-in duration-300">
          <StudentAssignmentModal
            students={studentsList || []}
            availableSlots={availableSlots}
            onClose={() => setIsAssignmentModalOpen(false)}
            onAssign={handleAssignmentSubmit}
            isLoading={isAllocating}
          />
        </div>
      )}

      {/* Edit Student Modal */}
      {editingBooking && (
        <div className="fixed inset-0 z-100 flex items-center justify-center p-4 bg-brand-surface/60 backdrop-blur-xs animate-in fade-in duration-300">
          <StudentProfileForm
            initialData={{
              ...editingBooking.fullProfile,
              id: editingBooking.studentId,
              name: editingBooking.fullProfile?.full_name || editingBooking.student,
              levelBadge: editingBooking.fullProfile?.module?.split(' ')[0] || editingBooking.module,
              currentModuleStatus: editingBooking.fullProfile?.module || editingBooking.module,
              img: editingBooking.fullProfile?.avatar_url,
              postalCode: editingBooking.fullProfile?.postal_code,
              addressNumber: editingBooking.fullProfile?.address_number,
              planDuration: editingBooking.fullProfile?.fidelity_plan
            }}
            onSubmit={handleUpdateStudentProfile}
            onScheduleChanged={() => {
              void fetchDetailData();
              onRefresh?.();
            }}
            onCancel={() => setEditingBooking(null)}
            onDelete={(user?.role === 'SCHOOL_ADMIN' || user?.role === 'SUPER_ADMIN') ? handleDeleteBooking : undefined}
            currentUserRole={user?.role}
            teachers={teachers}
            tenantId={currentTenantId || editingBooking.fullProfile?.tenant_id || selectedTeacher?.tenantId}
            title="Gerenciar Alocação"
          />
        </div>
      )}
    </div>
  );
};

export default TeacherScheduleExplorer;
