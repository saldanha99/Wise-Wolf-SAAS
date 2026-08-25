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
  Zap
} from 'lucide-react';
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
import { nullableUuid } from '../lib/dbValues';
import { FUNCTIONS_URL, supabase } from '../lib/supabase';
import { asaasService } from '../services/asaasService';
import { loadAuthorizedProfilePrivate } from '../lib/profilePrivacy';

const DAYS = ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
const TIMES = Array.from({ length: 37 }, (_, i) => {
  const hour = Math.floor(i / 2) + 6;
  const minutes = (i % 2 === 0) ? '00' : '30';
  if (hour === 24) return '00:00';
  return `${hour < 10 ? '0' + hour : hour}:${minutes}`;
});

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

  const fetchDetailData = async () => {
    if (!selectedTeacher) return;
    const detailTenantId = currentTenantId || selectedTeacher.tenantId;

    // 1. Fetch Bookings, Availability and Trials in Parallel
    const [bookingsRes, availRes, trialsRes, stdsRes] = await Promise.all([
      supabase
        .from('bookings')
        .select('id, day_of_week, time_slot, type, module, student:student_id(full_name, id, tenant_id, module, occupation, phone, meeting_link)')
        .eq('teacher_id', selectedTeacher.id)
        .eq('status', 'SCHEDULED'),
      supabase
        .from('teacher_availability')
        .select('*')
        .eq('teacher_id', selectedTeacher.id),
      // `appointments` guarda o horário em start_time (timestamptz). Não existe
      // coluna `date` nem `time` — ler t.date/t.time devolvia undefined e o
      // bloco da experimental nunca era desenhado.
      supabase
        .from('appointments')
        .select('id, start_time, student_name, status')
        .eq('teacher_id', selectedTeacher.id)
        .eq('type', 'experimental'),
      supabase
        .from('profiles')
        .select(PROFILE_SAFE_COLS)
        .eq('role', 'STUDENT')
        .eq('tenant_id', detailTenantId)
    ]);

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
        const dayMap: Record<string, number> = {
          'Segunda': 0, 'Terça': 1, 'Quarta': 2, 'Quinta': 3, 'Sexta': 4, 'Sábado': 5
        };
        const dIdx = dayMap[b.day_of_week];
        if (typeof b.time_slot === 'string') {
          const timeKey = b.time_slot.substring(0, 5);
          if (dIdx !== undefined) {
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
        const dIdx = item.day_of_week - 1;
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
    setIsAllocating(true);

    // VALIDATION: Ensure Schedule is present
    if (!data.schedule || data.schedule.length === 0) {
      throw new Error("Erro interno: A agenda não foi selecionada corretamente. Tente recarregar a página.");
    }

    const dayMap: Record<string, number> = {
      'Segunda': 0, 'Terça': 1, 'Quarta': 2, 'Quinta': 3, 'Sexta': 4, 'Sábado': 5
    };

    // Check for conflicts BEFORE creating student
    const conflicts: string[] = [];
    data.schedule.forEach(item => {
      const key = `${dayMap[item.day]}-${item.time}`;
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

      // 1. Create New Auth Account and Profile if needed
      if (data.isNew && data.studentData) {
        const targetTenantId = currentTenantId || selectedTeacher.tenantId;

        // Check for existing profile in THIS tenant first
        const { data: existingInTenant } = await supabase
          .from('profiles')
          .select('id')
          .eq('email', data.studentData.email)
          .eq('tenant_id', targetTenantId)
          .single();

        if (existingInTenant) {
          finalStudentId = existingInTenant.id;
        } else {
          // Create Auth User
          const { data: authData, error: authError } = await supabase.auth.signUp({
            email: data.studentData.email,
            password: '123456',
          });

          if (authError) {
            if (authError.message.includes('already registered')) {
              // FALLBACK: User exists in Auth but not in this tenant profile.
              // Fetch the existing User ID to link them to this tenant.
              console.log("User exists in Auth. Fetching ID to link profile...");

              const { data: recoveredId, error: rpcError } = await supabase
                .rpc('get_user_id_by_email', { email_input: data.studentData.email });

              if (rpcError || !recoveredId) {
                console.error("Failed to recover user ID:", rpcError);
                throw new Error("Este e-mail já está cadastrado no sistema global, mas não foi possível recuperar o cadastro. Por favor, contate o suporte.");
              }

              finalStudentId = recoveredId;

            } else {
              throw authError;
            }
          } else if (authData.user) {
            finalStudentId = authData.user.id;
          }
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

        // Generate a default meeting link
        const chars = 'abcdefghijklmnopqrstuvwxyz';
        const rnd = (len: number) => Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
        const meetingLink = `https://meet.google.com/${rnd(3)}-${rnd(4)}-${rnd(3)}`;

        // Check for existing profile by CPF+tenant BEFORE upsert (unique constraint: profiles_cpf_tenant_key)
        const studentCpf = data.studentData.cpf?.replace(/\D/g, '') || null;
        if (studentCpf && targetTenantId) {
          const { data: existingByCpf, error: cpfLookupError } = await supabase.rpc(
            'find_authorized_profile_by_cpf',
            { p_tenant_id: targetTenantId, p_cpf: studentCpf },
          );
          if (cpfLookupError) throw cpfLookupError;

          if (existingByCpf) {
            // A profile with this CPF already exists in this tenant — reuse it
            finalStudentId = existingByCpf;
          }
        }

        // Create or Update Profile
        const profilePayload: any = {
          id: finalStudentId,
          full_name: data.studentData.name,
          email: data.studentData.email,
          role: 'STUDENT',
          tenant_id: targetTenantId,
          module: data.module,
          phone: data.studentData.phone,
          occupation: data.studentData.occupation,
          interests: data.studentData.interests,
          avatar_url: `https://ui-avatars.com/api/?name=${data.studentData.name}`,
          meeting_link: meetingLink,
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
          profilePayload.status_financial = 'ACTIVE';
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

            if (subResponse?.id || subResponse?.subscription_id) {
              const confirmedSubId = subResponse.id || subResponse.subscription_id;
              await supabase.from('profiles').update({
                subscription_id: confirmedSubId
              }).eq('id', finalStudentId);
              console.log("✅ Asaas Injetado com Sucesso. ID:", confirmedSubId);
            }
          } catch (asaasErr) {
            console.error("⚠️ Erro ao injetar no Asaas (não bloqueante):", asaasErr);
            // We do not throw here to allow manual assignment to finish acting as a "contingency airplane"
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
        .select('day_of_week, time_slot')
        .eq('student_id', finalStudentId)
        .eq('teacher_id', selectedTeacher.id)
        .eq('status', 'SCHEDULED');
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

      if (toInsert.length > 0) {
        const { error } = await supabase.from('bookings').insert(toInsert);
        if (error) {
          // ROLLBACK: If booking fails and we just created the student, delete the profile
          if (data.isNew && finalStudentId) {
            console.error("Booking failed. Rolling back created student profile...", error);
            await supabase.from('profiles').delete().eq('id', finalStudentId);
          }
          throw error;
        }
      }

      // --- SEND WHATSAPP NOTIFICATION ---
      try {
        // Fetch phone and name if not already available
        let studentPhone = data.studentData?.phone;
        let studentName = data.studentData?.name;

        if (!studentPhone || !studentName) {
          const { data: stdProfile } = await supabase.from('profiles').select('phone, full_name').eq('id', finalStudentId).single();
          studentPhone = stdProfile?.phone;
          studentName = stdProfile?.full_name;
        }

        if (studentPhone) {
          const { data: { session } } = await supabase.auth.getSession();
          if (!session) throw new Error('Sessão expirada. Entre novamente.');

          const instanceName = selectedTeacher.tenantId === currentTenantId
            ? `prof-${selectedTeacher.name.split(' ')[0].toLowerCase()}-${selectedTeacher.id.substring(0, 4)}`
            : 'wise-wolf';

          const scheduleStr = data.schedule.map(s => `${s.day} às ${s.time}`).join(', ');

          fetch(`${FUNCTIONS_URL}/send-class-notification`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${session.access_token}`
            },
            body: JSON.stringify({
              type: 'CONFIRMATION',
              student_name: studentName,
              student_phone: studentPhone,
              teacher_name: selectedTeacher.name,
              date: scheduleStr,
              time: 'Conforme Agenda',
              instanceName: instanceName,
              meeting_link: selectedTeacher.meetingUrl
            })
          }).catch(err => console.error("Falha ao enviar notificação whatsapp:", err));
        }
      } catch (notifyErr) {
        console.error("Erro no fluxo de notificação:", notifyErr);
      }
      // ----------------------------------

      await fetchDetailData();
      if (onRefresh) onRefresh();
      setIsAssignmentModalOpen(false);
      alert("Novo aluno e agendamentos criados com sucesso! Notificação enviada.");
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

      // Só persiste colunas presentes no snapshot carregado. Assim, uma falha
      // parcial de leitura não transforma campos desconhecidos em string vazia.
      setIfLoaded('full_name', profileData.name);
      setIfLoaded('module', profileData.currentModuleStatus || profileData.levelBadge);
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
      const privateProfile = await loadAuthorizedProfilePrivate(booking.studentId);
      setEditingBooking({
        ...booking,
        fullProfile: {
          ...booking.fullProfile,
          ...privateProfile,
        },
      });
    } catch (error) {
      console.error('Erro ao carregar dados privados do aluno:', error);
      alert('Você não tem permissão para editar os dados privados deste aluno.');
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

  const filteredTeachers = (teachers || []).filter(t => {
    const matchesSearch = t.name.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesSpec = !specFilter || (t.specializations || []).includes(specFilter);
    return matchesSearch && matchesSpec;
  });

  return (
    <div className="flex flex-col xl:flex-row gap-6 xl:h-[calc(100dvh-6rem)] min-h-0 animate-in fade-in duration-500 relative">
      {/* Sidebar: Teacher Selection */}
      <div className="w-full xl:w-72 bg-brand-surface border border-gray-100 dark:border-brand-border rounded-[2rem] flex flex-col shadow-sm shrink-0">
        <div className="p-5 border-b dark:border-brand-border">
          <h3 className="font-black text-gray-800 dark:text-slate-100 text-[10px] uppercase tracking-widest mb-3 flex items-center gap-2">
            <Users size={14} className="text-tenant-primary" /> Corpo Docente
          </h3>
          <div className="relative mb-2">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={12} />
            <input
              type="text"
              placeholder="Buscar por nome..."
              className="w-full pl-9 pr-4 py-2 bg-gray-50 dark:bg-brand-surface-2 border dark:border-brand-border rounded-xl text-[10px] focus:ring-2 focus:ring-tenant-primary outline-none font-medium"
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
            />
          </div>
          <select
            value={specFilter}
            onChange={e => setSpecFilter(e.target.value)}
            className="w-full px-3 py-2 bg-gray-50 dark:bg-brand-surface-2 border dark:border-brand-border rounded-xl text-[10px] font-bold focus:ring-2 focus:ring-tenant-primary outline-none"
          >
            <option value="">Todas as especialidades</option>
            {TEACHER_SPECIALIZATIONS.map(s => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>

        <div className="max-h-60 xl:max-h-none xl:flex-1 overflow-y-auto p-3 space-y-2 scrollbar-hide">
          {filteredTeachers.map((teacher) => (
            <button
              key={teacher.id}
              onClick={() => setSelectedTeacher(teacher)}
              className={`w-full p-3 rounded-xl border transition-all flex items-center gap-3 text-left group ${selectedTeacher?.id === teacher.id
                ? 'bg-[#002366] bg-tenant-primary border-tenant-primary text-white shadow-lg shadow-tenant-primary/20'
                : 'bg-brand-surface border-gray-50 dark:border-brand-border hover:border-tenant-primary/30'
                }`}
            >
              <img src={teacher.avatar} className="w-8 h-8 rounded-lg border-2 border-white/20" alt="" />
              <div className="flex-1 overflow-hidden">
                <p className={`text-[10px] font-black truncate leading-tight ${selectedTeacher?.id === teacher.id ? 'text-white' : 'text-gray-800 dark:text-slate-200'}`}>
                  {teacher.name}
                </p>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className={`text-[8px] font-bold ${selectedTeacher?.id === teacher.id ? 'text-white/80' : 'text-gray-400'}`}>
                    {teacher.module}
                  </span>
                </div>
              </div>
              <ChevronRight size={12} className={selectedTeacher?.id === teacher.id ? 'text-white' : 'text-gray-300'} />
            </button>
          ))}
        </div>
      </div>

      {/* Main Area: Detailed Schedule Explorer */}
      <div className="flex-1 min-h-[70vh] xl:min-h-0 bg-brand-surface border border-gray-100 dark:border-brand-border rounded-[2rem] flex flex-col shadow-sm overflow-hidden">
        {selectedTeacher ? (
          <>
            {/* Detail Header - Compact */}
            <div className="px-4 sm:px-6 py-4 border-b dark:border-brand-border flex flex-col lg:flex-row justify-between items-stretch lg:items-center gap-4 bg-gray-50/30 dark:bg-brand-surface-2/20">
              <div className="flex items-center gap-3 sm:gap-4 min-w-0">
                <img src={selectedTeacher.avatar} className="w-12 h-12 rounded-xl shadow-md border-2 border-white dark:border-brand-border shrink-0" alt="" />
                <div className="min-w-0">
                  <h2 className="text-sm font-black text-gray-800 dark:text-slate-100 uppercase tracking-tight leading-tight truncate">{selectedTeacher.name}</h2>
                  <p className="text-[10px] text-gray-500 dark:text-brand-muted mt-1 font-bold">
                    {selectedTeacher.module}
                  </p>
                  {(selectedTeacher.specializations || []).length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {(selectedTeacher.specializations || []).map(s => (
                        <span key={s} className="px-2 py-0.5 bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400 text-[8px] font-black rounded-full border border-amber-100 dark:border-amber-800 whitespace-nowrap">
                          {s}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="w-full lg:w-auto grid grid-cols-2 sm:grid-cols-3 lg:flex items-stretch lg:items-center gap-3 lg:flex-wrap lg:justify-end">
                {/* Ocupação + alunos distintos + conflitos */}
                {(() => {
                  const occupied = Object.keys(bookings).length;
                  const free = Array.from(availableSlots).filter(k => !bookings[k]).length;
                  const denom = occupied + free;
                  const pct = denom > 0 ? Math.round(100 * occupied / denom) : 0;
                  const distinct = new Set(Object.values(bookings).map((b: any) => b.studentId || b.student)).size;
                  return (
                    <>
                      <div className="px-3 py-1.5 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-100 dark:border-emerald-900/30 rounded-lg text-center min-w-0">
                        <p className="text-[8px] font-black text-emerald-600 uppercase tracking-wide">Ocupação</p>
                        <p className="text-sm font-black text-emerald-700 dark:text-emerald-400 leading-none">{pct}%</p>
                      </div>
                      <div className="px-3 py-1.5 bg-brand-surface-2 border border-brand-border rounded-lg text-center min-w-0">
                        <p className="text-[8px] font-black text-brand-muted uppercase tracking-wide">Aulas · Alunos</p>
                        <p className="text-sm font-black text-brand-text leading-none">{occupied} · {distinct}</p>
                      </div>
                      {conflicts.size > 0 && (
                        <div className="px-3 py-1.5 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-900/40 rounded-lg text-center min-w-0" title="Horários com mais de um aluno">
                          <p className="text-[8px] font-black text-red-600 uppercase tracking-wide">Conflitos</p>
                          <p className="text-sm font-black text-red-600 leading-none">{conflicts.size}</p>
                        </div>
                      )}
                    </>
                  );
                })()}
                {/* Navegação de semana: a grade mostra UMA semana concreta. */}
                <div className="col-span-2 sm:col-span-3 lg:col-span-1 flex items-center gap-1 rounded-lg border border-brand-border bg-brand-surface-2 px-1 py-1">
                  <button
                    type="button"
                    onClick={() => setWeekOffset(w => w - 1)}
                    aria-label="Semana anterior"
                    className="px-2 py-1 rounded-md text-brand-muted hover:bg-brand-surface hover:text-brand-text transition-colors font-black text-xs"
                  >
                    ‹
                  </button>
                  <button
                    type="button"
                    onClick={() => setWeekOffset(0)}
                    title="Voltar para a semana atual"
                    className="flex-1 min-w-0 px-2 text-center"
                  >
                    <span className="block text-[8px] font-black uppercase tracking-wide text-brand-muted">
                      {weekOffset === 0 ? 'Esta semana' : 'Semana'}
                    </span>
                    <span className="block text-[11px] font-black leading-none text-brand-text whitespace-nowrap">{weekLabel}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setWeekOffset(w => w + 1)}
                    aria-label="Próxima semana"
                    className="px-2 py-1 rounded-md text-brand-muted hover:bg-brand-surface hover:text-brand-text transition-colors font-black text-xs"
                  >
                    ›
                  </button>
                </div>
                <input
                  value={slotSearch}
                  onChange={e => setSlotSearch(e.target.value)}
                  placeholder="Localizar aluno na grade…"
                  className="col-span-2 sm:col-span-3 lg:col-span-1 px-3 py-2 text-[11px] font-bold bg-brand-surface-2 border border-brand-border rounded-lg outline-none text-brand-text w-full lg:w-44 min-w-0"
                />
                <button
                  onClick={() => setIsAssignmentModalOpen(true)}
                  className="col-span-2 sm:col-span-3 lg:col-span-1 w-full lg:w-auto px-4 py-2.5 bg-[#002366] bg-tenant-primary text-white rounded-xl font-black text-[10px] uppercase tracking-widest shadow-lg shadow-tenant-primary/20 hover:scale-[1.02] lg:hover:scale-[1.05] transition-all flex items-center justify-center gap-2 shrink-0 whitespace-nowrap"
                >
                  <UserPlus size={14} /> Atribuir Aluno
                </button>
              </div>
            </div>

            {/* Grid Content */}
            <div className="flex-1 overflow-auto p-3 sm:p-4 scrollbar-hide relative">
              {/* MOBILE: lista por dia (a grade larga é inviável no celular) */}
              <div className="md:hidden space-y-3">
                {DAYS.map((day, dIdx) => {
                  const daySlots = TIMES
                    .map(time => ({
                      time,
                      booking: bookings[`${dIdx}-${time}`],
                      reschedule: getRescheduleForSlot(dIdx, time),
                      trial: getTrialForSlot(dIdx, time),
                      conflict: conflicts.has(`${dIdx}-${time}`),
                    }));
                  const dayEntries = daySlots.filter(entry => entry.booking || entry.reschedule || entry.trial);
                  const freeTimes = daySlots
                    .filter(entry => (
                      availableSlots.has(`${dIdx}-${entry.time}`)
                      && !entry.booking
                      && !entry.reschedule
                      && !entry.trial
                    ))
                    .map(entry => entry.time);
                  const dayDate = dateForDayIndex(weekStart, dIdx).split('-').slice(1).reverse().join('/');
                  return (
                    <div key={day} className="bg-brand-surface-2/40 border border-brand-border rounded-xl p-3">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <p className="text-[10px] font-black text-brand-muted uppercase tracking-widest">
                          {day} {dayDate} · {dayEntries.length} compromisso(s)
                        </p>
                        <span className="shrink-0 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[9px] font-black uppercase text-emerald-600 dark:text-emerald-400">
                          {freeTimes.length} livre{freeTimes.length === 1 ? '' : 's'}
                        </span>
                      </div>
                      {dayEntries.length === 0 ? (
                        <p className="text-[11px] text-brand-muted italic">Sem aulas</p>
                      ) : (
                        <div className="space-y-1.5">
                          {dayEntries.map(({ time, booking, reschedule, trial, conflict }) => {
                            const hit = (name?: string) =>
                              slotSearch.trim() !== '' && (name || '').toLowerCase().includes(slotSearch.toLowerCase());
                            const match = hit(reschedule?.studentName) || hit(trial?.studentName) || hit(booking?.student);
                            const dim = slotSearch.trim() !== '' && !match;
                            // Reposição e experimental são de UM dia: aparecem
                            // JUNTO da aula fixa, nunca no lugar dela. Substituir
                            // a célula fazia o aluno regular sumir da tela do
                            // diretor enquanto a reposição estivesse marcada.
                            return (
                              <div key={time} className={`space-y-1 ${dim ? 'opacity-30' : ''}`}>
                                {reschedule && (
                                  <div className={`flex items-center gap-2 rounded-lg border border-dashed border-yellow-400 bg-yellow-100 px-2.5 py-2 text-yellow-900 dark:border-yellow-600 dark:bg-yellow-900/30 dark:text-yellow-100 ${match ? 'ring-2 ring-yellow-400' : ''}`}>
                                    <Clock size={13} aria-hidden="true" className="shrink-0" />
                                    <span className="w-10 shrink-0 font-mono text-[10px] font-bold">{time}</span>
                                    <span className="min-w-0 flex-1 truncate text-[11px] font-black uppercase">{reschedule.studentName}</span>
                                    <span className="text-[9px] font-bold uppercase opacity-80">Reposição · só hoje</span>
                                  </div>
                                )}
                                {trial && (
                                  <div className={`flex items-center gap-2 rounded-lg border border-dashed border-purple-400 bg-purple-100 px-2.5 py-2 text-purple-900 dark:border-purple-600 dark:bg-purple-900/30 dark:text-purple-100 ${match ? 'ring-2 ring-purple-400' : ''}`}>
                                    <Zap size={13} aria-hidden="true" className="shrink-0" />
                                    <span className="w-10 shrink-0 font-mono text-[10px] font-bold">{time}</span>
                                    <span className="min-w-0 flex-1 truncate text-[11px] font-black uppercase">{trial.studentName}</span>
                                    <span className="text-[9px] font-bold uppercase opacity-80">Experimental · só hoje</span>
                                  </div>
                                )}
                                {booking && (
                                  <button
                                    type="button"
                                    onClick={() => void openBookingEditor(booking)}
                                    aria-label={`Editar aula de ${booking.student}, ${day} às ${time}`}
                                    className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left cursor-pointer bg-emerald-500 text-white ${conflict ? 'ring-2 ring-red-400' : ''} ${match ? 'ring-2 ring-yellow-300' : ''}`}
                                  >
                                    <span className="text-[10px] font-mono font-bold w-10 shrink-0">{time}</span>
                                    <span className="text-[11px] font-black uppercase truncate flex-1">{booking.student}</span>
                                    <span className="text-[9px] font-bold opacity-80">{booking.module}</span>
                                  </button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                      {freeTimes.length > 0 && (
                        <details className="group mt-2 rounded-lg border border-emerald-500/25 bg-brand-surface">
                          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-[10px] font-black uppercase tracking-wider text-emerald-600 marker:hidden dark:text-emerald-400">
                            <span>Horários livres</span>
                            <span className="text-[9px] text-brand-muted group-open:hidden">Ver horários</span>
                            <span className="hidden text-[9px] text-brand-muted group-open:inline">Ocultar</span>
                          </summary>
                          <div className="grid grid-cols-3 gap-1.5 border-t border-emerald-500/20 p-2.5">
                            {freeTimes.map(time => (
                              <span
                                key={time}
                                className="rounded-md border border-dashed border-emerald-500/40 bg-emerald-500/5 px-2 py-1.5 text-center font-mono text-[10px] font-bold text-emerald-700 dark:text-emerald-300"
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

              {/* DESKTOP: grade completa */}
              <div className="hidden md:block min-w-[700px]">
                <table className="w-full border-separate border-spacing-1">
                  <thead>
                    <tr>
                      <th className="w-14"></th>
                      {DAYS.map((day, dIdx) => {
                        const ymd = dateForDayIndex(weekStart, dIdx);
                        const isToday = ymd === localYMD(new Date());
                        return (
                          <th key={day} className={`p-2 text-[9px] font-black uppercase tracking-[0.1em] ${isToday ? 'text-tenant-primary' : 'text-gray-400 dark:text-brand-muted'}`}>
                            {day}
                            <span className="block text-[8px] font-bold opacity-70">{ymd.split('-').slice(1).reverse().join('/')}</span>
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {TIMES.map((time, tIdx) => (
                      <tr key={time}>
                        <td className="text-center align-middle">
                          <span className="text-[9px] font-bold text-gray-400 font-mono">{time}</span>
                        </td>
                        {DAYS.map((_, dIdx) => {
                          const key = `${dIdx}-${time}`;
                          const booking = bookings[key];
                          const isAvailable = availableSlots.has(key);
                          const reschedule = getRescheduleForSlot(dIdx, time);
                          const trial = getTrialForSlot(dIdx, time);
                          const isConflict = conflicts.has(key);
                          const hitName = (name?: string) =>
                            slotSearch.trim() !== '' && (name || '').toLowerCase().includes(slotSearch.toLowerCase());
                          const matchSearch = hitName(booking?.student) || hitName(reschedule?.studentName) || hitName(trial?.studentName);
                          const dimmed = slotSearch.trim() !== '' && (booking || reschedule || trial) && !matchSearch;
                          // O evento de UM dia (reposição/experimental) é uma
                          // faixa POR CIMA da célula, não a célula inteira: a
                          // aula fixa daquele horário continua visível embaixo.
                          const overlay = reschedule
                            ? { label: 'Reposição', name: reschedule.studentName, tone: 'yellow' as const }
                            : trial
                              ? { label: 'Experimental', name: trial.studentName, tone: 'purple' as const }
                              : null;

                          return (
                            <td key={dIdx} className="h-8 relative">
                              {overlay && (
                                <div
                                  className={`absolute inset-x-0 top-0 z-20 m-0.5 flex items-center gap-1 rounded-t-md border border-dashed px-1 py-[1px] shadow-sm cursor-help ${overlay.tone === 'yellow'
                                    ? 'bg-yellow-100 border-yellow-500 dark:bg-yellow-900/70 dark:border-yellow-500'
                                    : 'bg-purple-100 border-purple-500 dark:bg-purple-900/70 dark:border-purple-500'}`}
                                  title={`${overlay.label} de ${overlay.name} — só em ${dateForDayIndex(weekStart, dIdx).split('-').reverse().join('/')}, não ocupa este horário nas outras semanas`}
                                >
                                  {overlay.tone === 'yellow'
                                    ? <Clock size={7} className="shrink-0 text-yellow-700 dark:text-yellow-300" />
                                    : <Zap size={7} className="shrink-0 text-purple-700 dark:text-purple-300" />}
                                  <span className={`truncate text-[6px] font-black uppercase tracking-wider ${overlay.tone === 'yellow' ? 'text-yellow-800 dark:text-yellow-200' : 'text-purple-800 dark:text-purple-200'}`}>
                                    {overlay.name}
                                  </span>
                                </div>
                              )}
                              {booking ? (
                                <button
                                  type="button"
                                  onClick={() => void openBookingEditor(booking)}
                                  aria-label={`Editar aula de ${booking.student}, ${DAYS[dIdx]} às ${time}`}
                                  className={`w-full h-full border rounded-md p-1 flex flex-col justify-center transition-all cursor-pointer shadow-md group/booking bg-emerald-500 dark:bg-emerald-600 border-emerald-600 dark:border-emerald-500 hover:scale-[1.02] ${isConflict ? 'ring-2 ring-red-500' : ''} ${matchSearch ? 'ring-2 ring-yellow-300 scale-105 z-10' : ''} ${dimmed ? 'opacity-20' : ''}`}
                                >
                                  <div className="flex items-center gap-1 overflow-hidden">
                                     <p className="text-[7px] font-black text-white uppercase truncate leading-tight">{booking.student}</p>
                                  </div>
                                  <div className="flex justify-between items-center mt-0.5">
                                    <p className="text-[6px] font-bold text-emerald-100 uppercase">{booking.module}</p>
                                  </div>
                                </button>
                              ) : overlay ? (
                                <div className="w-full h-full rounded-md border border-dashed border-brand-border bg-brand-surface" />
                              ) : isAvailable ? (
                                <div className="w-full h-full bg-brand-surface border border-dashed border-emerald-500/50 rounded-md flex items-center justify-center hover:bg-emerald-50 dark:hover:bg-emerald-900/10 transition-colors cursor-default">
                                  <span className="text-[7px] font-bold text-emerald-500/70 uppercase tracking-wider">LIVRE</span>
                                </div>
                              ) : (
                                <div className="w-full h-full bg-slate-950 dark:bg-black rounded-md flex items-center justify-center opacity-80">
                                  {/* Black for Occupied/Blocked */}
                                </div>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-gray-300 dark:text-brand-muted">
            <Users size={32} className="mb-3 opacity-50" />
            <p className="text-xs font-bold">Selecione um professor</p>
          </div>
        )}
      </div>

      {/* Assignment Modal */}
      {isAssignmentModalOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-brand-surface/60 backdrop-blur-sm animate-in fade-in duration-300">
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
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-brand-surface/60 backdrop-blur-sm animate-in fade-in duration-300">
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
