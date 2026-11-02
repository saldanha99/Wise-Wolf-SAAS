import React, { useState, useEffect, useRef } from 'react';
import { Search, Info, RefreshCw, UserPlus, Trash2, Users, AlertCircle, AlertTriangle, LayoutGrid, List as ListIcon, X } from 'lucide-react';
import StudentProfileView from './StudentProfileView';
import { supabase } from '../lib/supabase';
import { nullableUuid } from '../lib/dbValues';
import { safeMeetingLink } from '../lib/meetingLink';
import { PROFILE_SAFE_COLS } from '../constants';
import { asaasService } from '../services/asaasService';
import { User as UserType, UserRole, Teacher } from '../types';
import StudentProfileForm from './StudentProfileForm';
import TeacherPedagogicalModal from './TeacherPedagogicalModal';
import StudentProfileEditor from './StudentProfileEditor';
import TeacherStudentScheduleEditor from './TeacherStudentScheduleEditor';
import StudentRosterCard from './students/StudentRosterCard';
import StudentRosterTable from './students/StudentRosterTable';
import {
  isTeacherOf,
  matchesQuickFilter,
  quickFilterOptions,
  rosterPermissions,
  rosterStage,
  scheduleSlotsFromBookings,
  sortRoster,
  type QuickFilter,
  type RosterSort,
} from '../lib/studentRoster';
import { loadAuthorizedProfilePrivate } from '../lib/profilePrivacy';
import { provisionStudentAccount } from '../lib/studentAccountProvisioning';
import { changeStudentLifecycle } from '../lib/studentLifecycleRequest';
import {
  canPreserveExactlyOneCurrentMonthInvoice,
  isConfirmedOrReceivedCurrentMonthStatus,
  isLiveCurrentMonthInvoiceStatus,
  isOpenRecurringPaymentStatus,
  noNewChargePolicy,
  saoPauloCalendarDate,
  type StudentOffboardingPolicy,
} from '../lib/studentLifecycleUi';

interface StudentsListProps {
  tenantId?: string;
  user?: UserType;
  teachers?: Teacher[];
}

type OffboardingInvoicePreview = {
  id: string;
  value: number;
  dueDate: string;
  status: string;
  providerStatus: string;
  asaasPaymentId: string;
  legacyAsaasPaymentId: string;
};

const BRL_FORMATTER = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
});

const StudentsList: React.FC<StudentsListProps> = ({ tenantId, user, teachers = [] }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedTeacherId, setSelectedTeacherId] = useState<string | 'ALL'>('ALL');
  const [levelFilter, setLevelFilter] = useState<string>('ALL');
  // Abre nos ativos: encerrado e pausado continuam a um clique, sem poluir o dia a dia.
  const [quickFilter, setQuickFilter] = useState<QuickFilter>('ACTIVE');
  const [sortBy, setSortBy] = useState<RosterSort>('PRIORITY');
  const [viewMode, setViewMode] = useState<'cards' | 'table'>(() => {
    try {
      return window.localStorage.getItem(`wisewolf.studentsView.${user?.id || ''}`) === 'table' ? 'table' : 'cards';
    } catch {
      return 'cards';
    }
  });
  const [overviewMap, setOverviewMap] = useState<Record<string, any>>({});
  const [viewStudentId, setViewStudentId] = useState<string | null>(null);

  const [students, setStudents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editingStudent, setEditingStudent] = useState<any | null>(null);
  const [pedagogicalStudent, setPedagogicalStudent] = useState<any | null>(null);
  const [wolfProfileStudent, setWolfProfileStudent] = useState<any | null>(null);
  const [scheduleStudent, setScheduleStudent] = useState<any | null>(null);
  const [offboardingStudent, setOffboardingStudent] = useState<any | null>(null);
  const [offboardingReason, setOffboardingReason] = useState('');
  const [offboardingPolicy, setOffboardingPolicy] = useState<StudentOffboardingPolicy | null>(null);
  const [offboardingEffectiveDate, setOffboardingEffectiveDate] = useState('');
  const [isOffboarding, setIsOffboarding] = useState(false);
  const [offboardingInvoices, setOffboardingInvoices] = useState<OffboardingInvoicePreview[]>([]);
  const [offboardingPaymentIdentityAvailable, setOffboardingPaymentIdentityAvailable] = useState(false);
  const [offboardingPreviewLoading, setOffboardingPreviewLoading] = useState(false);
  const [offboardingPreviewError, setOffboardingPreviewError] = useState<string | null>(null);
  const offboardingPreviewRequestId = useRef(0);
  const offboardingDialogRef = useRef<HTMLDivElement>(null);
  const offboardingPreviousFocusRef = useRef<HTMLElement | null>(null);
  const isOffboardingRef = useRef(false);

  // Deletion Modal State
  const [studentToDelete, setStudentToDelete] = useState<any>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    if (tenantId) fetchStudents();
  }, [tenantId, user?.id]);

  useEffect(() => {
    isOffboardingRef.current = isOffboarding;
  }, [isOffboarding]);

  useEffect(() => {
    if (!offboardingStudent) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusFrame = window.requestAnimationFrame(() => offboardingDialogRef.current?.focus());

    const dismiss = () => {
      if (isOffboardingRef.current) return;
      offboardingPreviewRequestId.current += 1;
      setOffboardingStudent(null);
      setOffboardingInvoices([]);
      setOffboardingPaymentIdentityAvailable(false);
      setOffboardingPreviewLoading(false);
      setOffboardingPreviewError(null);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        dismiss();
        return;
      }
      if (event.key !== 'Tab') return;

      const dialog = offboardingDialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )) as HTMLElement[];
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      offboardingPreviousFocusRef.current?.focus();
      offboardingPreviousFocusRef.current = null;
    };
  }, [offboardingStudent]);

  const fetchStudents = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      // 1. Fetch Students
      const query = supabase
        .from('profiles')
        .select(PROFILE_SAFE_COLS)
        .eq('role', 'STUDENT')
        .eq('tenant_id', tenantId);

      // profiles_scoped_read_p1 resolve o vínculo professor-aluno no banco.
      const { data: studentsData, error: studentError } = await query;
      if (studentError) throw studentError;

      // 2. Fetch Bookings to find teachers and schedule
      // NOTE: Using start_date and time_slot as per schema
      let bookingsQuery = supabase
        .from('bookings')
        .select('student_id, teacher_id, start_date, day_of_week, time_slot, teacher:teacher_id(id, full_name)')
        .eq('tenant_id', tenantId)
        .in('status', ['SCHEDULED', 'scheduled']);
      if (user?.role === UserRole.TEACHER) {
        bookingsQuery = bookingsQuery.eq('teacher_id', user.id);
      }
      const { data: bookingsData } = await bookingsQuery;

      if (studentsData) {
        const mappedStudents = studentsData.map(s => {
          // Normalize IDs to string for comparison safety
          const sId = String(s.id);
          const studentBookings = bookingsData?.filter(b => String(b.student_id) === sId) || [];

          const assignedTeacherIds = Array.from(new Set(studentBookings.map(b => String(b.teacher_id))));
          const teacherNames = Array.from(new Set(studentBookings.map(b => (b.teacher as any)?.full_name))).filter(Boolean);

          // Format Schedule (e.g. "Seg/Qua - 19:00")
          let scheduleDisplay = s.fixed_schedule; // Default to manual from DB

          if (studentBookings.length > 0) {
            // Helper to get day string from Date accurately avoiding timezone shifts
            const getDayFromDate = (dateStr: string) => {
              if (!dateStr) return '';
              // Split YYYY-MM-DD
              const parts = dateStr.split('-');
              if (parts.length !== 3) return '';
              // Create date at NOON (12:00) to avoid any timezone shift to previous/next day
              const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]), 12, 0, 0);
              const dayIndex = d.getDay(); // 0 = Sun, 1 = Mon...
              const days = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
              return days[dayIndex];
            };

            const dayOrder = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

            // We want to find the DISTINCT pattern of classes.
            // If they have 50 bookings, but they are all "Seg 19h" and "Qua 19h", we want "Seg/Qua - 19:00"
            // Dictionary to map full day names to short names
            const dayMap: Record<string, string> = {
              'Segunda': 'Seg', 'Terça': 'Ter', 'Quarta': 'Qua',
              'Quinta': 'Qui', 'Sexta': 'Sex', 'Sábado': 'Sáb', 'Domingo': 'Dom'
            };

            const scheduleItems = studentBookings.map(b => {
              // PRIORITY: Use explicit day_of_week column if available
              if (b.day_of_week && dayMap[b.day_of_week]) {
                return { day: dayMap[b.day_of_week], time: b.time_slot?.slice(0, 5) || '' };
              }

              // FALLBACK: Calculate from date (only for legacy records without day_of_week)
              const day = getDayFromDate(b.start_date);
              const time = b.time_slot?.slice(0, 5) || '';
              return { day, time };
            }).filter(x => x.day && x.time);

            // Deduplicate
            const uniqueItems = Array.from(new Set(scheduleItems.map(item => JSON.stringify(item)))).map(str => JSON.parse(str));

            // Extract unique times
            const uniqueTimes = Array.from(new Set(uniqueItems.map(i => i.time)));

            if (uniqueTimes.length === 1) {
              // Same time across days
              const days = uniqueItems.map(i => i.day);
              const sortedDays = Array.from(new Set(days)).sort((a, b) => dayOrder.indexOf(a) - dayOrder.indexOf(b));
              scheduleDisplay = `${sortedDays.join('/')} - ${uniqueTimes[0]}`;
            } else if (uniqueTimes.length > 0) {
              // Different times, complex string
              const sortedItems = uniqueItems.sort((a, b) => {
                return dayOrder.indexOf(a.day) - dayOrder.indexOf(b.day);
              });
              scheduleDisplay = sortedItems.map(i => `${i.day} ${i.time}`).join(' / ');
            }
          }

          return {
            id: s.id,
            name: s.full_name || 'Nome Indefinido',
            scheduleSlots: scheduleSlotsFromBookings(studentBookings),
            levelBadge: s.module?.split(' ')[0] || 'N/A',
            currentModuleStatus: s.current_book_part || s.module || 'Não iniciado',
            interests: s.interests || [],
            occupation: s.occupation || 'Não informado',
            phone: s.phone || '',
            img: s.avatar_url || `https://ui-avatars.com/api/?name=${s.full_name}`,
            meetingLink: s.meeting_link || '',
            fixed_schedule: scheduleDisplay,
            assignedTeachers: teacherNames,
            assignedTeacherIds: assignedTeacherIds,
            createdAt: s.created_at,
            professor_id: s.professor_id,
            accepted_at: s.accepted_at,
            documentation_status: s.documentation_status,
            tenant_id: s.tenant_id,
            status: s.status,
            lifecycle_status: s.lifecycle_status,
            attendance_phone: s.attendance_phone,
            is_test_account: s.is_test_account === true,
            module: s.module,
          };
        });
        setStudents(mappedStudents);
      }
    } catch (err) {
      console.error('Error fetching students:', err);
      setLoadError('Não foi possível carregar os alunos com segurança. Atualize o sistema e tente novamente.');
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateStudent = async (formData: any) => {
    // Se estamos criando um novo aluno (sem ID)
    if (!editingStudent?.id) {
      try {
        const targetTenantId = tenantId || user?.tenantId;
        if (!targetTenantId) {
          throw new Error('Selecione uma escola antes de criar o aluno.');
        }
        const normalizedEmail = String(formData.email || '').trim().toLowerCase();
        if (!normalizedEmail) throw new Error('Informe o e-mail do aluno.');

        // 1. Verifica se já existe perfil com este email neste tenant
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

        // Matrícula de dependente: cobrança no CPF do responsável (guardian).
        // O aluno tem perfil/login próprios; profiles.cpf fica NULL p/ não violar
        // profiles_cpf_tenant_key. O CPF de cobrança vai em guardian_cpf.
        const isDependent = !!formData.is_dependent;
        const guardianCpf = isDependent ? (formData.guardian_cpf?.replace(/\D/g, '') || null) : null;
        if (isDependent && !guardianCpf) {
          alert('Informe o CPF do responsável para matrícula de dependente.');
          return;
        }

        // Resolva identidades existentes antes de criar Auth. Assim, um CPF já
        // cadastrado nunca deixa para trás um segundo usuário sem perfil.
        const studentCpf = isDependent ? null : (formData.cpf?.replace(/\D/g, '') || null);

        let finalStudentId = existingInTenant?.id;
        let activationSent = false;

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
          // Auth Admin roda exclusivamente na Edge Function. Assim, criar o
          // aluno nunca substitui a sessão atual do diretor no navegador.
          const provisioned = await provisionStudentAccount(supabase, {
            name: formData.name,
            email: normalizedEmail,
            tenantId: targetTenantId,
            phone: formData.phone,
            professorId: nullableUuid(formData.professor_id),
            monthlyFee: Number(formData.monthly_fee) || 0,
            dueDay: Number(formData.due_day) || 10,
          });
          finalStudentId = provisioned.userId;
          activationSent = provisioned.activationSent;
        }

        if (!finalStudentId) throw new Error("Não foi possível gerar ID para o aluno.");

        // Resolve o id do responsável: usa o que foi SELECIONADO no formulário
        // (responsável já cadastrado); senão tenta achar pelo CPF no tenant.
        let guardianId: string | null = isDependent ? (formData.guardian_id || null) : null;
        if (isDependent && !guardianId && guardianCpf && targetTenantId) {
          const { data: guardianProfileId, error: guardianLookupError } = await supabase.rpc(
            'find_authorized_profile_by_cpf',
            { p_tenant_id: targetTenantId, p_cpf: guardianCpf },
          );
          if (guardianLookupError) throw guardianLookupError;
          guardianId = guardianProfileId || null;
        }

        // NÃO inventamos link de reunião. O gerador anterior criava códigos
        // aleatórios do Meet que não correspondiam a sala nenhuma — quem
        // clicasse recebia "código inválido" do Google, e ninguém ficava
        // sabendo. Sem link informado, o campo fica vazio e a interface avisa.
        const meetingLink = safeMeetingLink(formData.meeting_link);

        // Cria ou atualiza o perfil (com TODOS os dados)
        const profilePayload: any = {
          id: finalStudentId,
          full_name: formData.name,
          email: normalizedEmail,
          role: 'STUDENT',
          tenant_id: targetTenantId,
          phone: formData.phone,
          attendance_phone: formData.attendance_phone || null,
          occupation: formData.occupation,
          interests: formData.interests,
          avatar_url: formData.img || `https://ui-avatars.com/api/?name=${formData.name}`,
          meeting_link: meetingLink,
          cpf: studentCpf,
          address: formData.address,
          address_number: formData.addressNumber,
          postal_code: formData.postalCode,
          professor_id: nullableUuid(formData.professor_id),
          fixed_schedule: formData.fixed_schedule,
          private_notes: formData.private_notes,
        };

        // Dependente: grava dados do responsável financeiro (contratante/cobrança)
        if (isDependent) {
          profilePayload.guardian_cpf = guardianCpf;
          profilePayload.guardian_name = formData.guardian_name || null;
          profilePayload.guardian_email = formData.guardian_email || null;
          profilePayload.guardian_phone = formData.guardian_phone?.replace(/\D/g, '') || null;
          profilePayload.guardian_id = guardianId;
        }

        // Adiciona dados financeiros se existir valor
        if (formData.monthly_fee > 0) {
          // `monthly_tuition` é espelho mantido pelo banco (trg_mirror_monthly_tuition).
          profilePayload.monthly_fee = formData.monthly_fee;
          profilePayload.fidelity_plan = formData.planDuration;
          profilePayload.due_day = formData.due_day || 10;
          profilePayload.status_financial = 'PENDING';
        }

        const { error: profileError } = await supabase.from('profiles').upsert(profilePayload);
        if (profileError) throw profileError;

        // O nível pedagógico não é mais um campo solto do perfil. Para um novo
        // cadastro, o RPC define o primeiro marco publicado e registra o ator.
        const { error: placementError } = await supabase.rpc(
          'set_student_pedagogical_placement',
          {
            p_student_id: finalStudentId,
            p_module: formData.levelBadge,
            p_reason: 'Atualização autorizada no cadastro do aluno',
          },
        );
        if (placementError) throw placementError;

        // --- INJEÇÃO NO ASAAS (Idêntico ao Mapa de Aulas) ---
        let billingConfirmed = !(formData.monthly_fee > 0);
        let billingFailure = '';
        if (formData.monthly_fee > 0) {
          try {
            console.log("Injetando dados do aluno recém-criado no Asaas...");
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
              monthly_fee: formData.monthly_fee,
              due_day: profilePayload.due_day,
              documentation_status: 'APPROVED',
              // Dependente: cobrança no CPF do responsável (novo customer ASAAS)
              is_dependent: isDependent,
              guardian_cpf: guardianCpf || undefined,
              guardian_name: formData.guardian_name || undefined,
              guardian_email: formData.guardian_email || undefined,
              guardian_phone: formData.guardian_phone || undefined,
              guardian_id: guardianId,
            });

            const durationEnum = formData.planDuration || 'RECURRENT';

            const subResponse = await asaasService.createSubscription({
              user_id: finalStudentId,
              customer: syncResponse?.asaas_customer_id,
              value: formData.monthly_fee,
              dueDay: profilePayload.due_day,
              billingType: formData.billingType || 'PIX',
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
            console.log("✅ Asaas Injetado com Sucesso. ID da assinatura:", confirmedSubId);
          } catch (asaasErr) {
            billingFailure = asaasErr instanceof Error ? asaasErr.message : 'falha não identificada';
            console.error("⚠️ Erro ao injetar no Asaas; aluno mantido como pendente:", asaasErr);
          }
        }

        const accessMessage = activationSent
          ? 'Convite seguro enviado para o aluno definir a própria senha.'
          : 'O acesso do aluno já existia nesta escola.';
        const billingMessage = billingConfirmed
          ? 'Financeiro confirmado.'
          : `A cobrança ainda não foi ativada (${billingFailure || 'confirmação ausente'}). O aluno permanece pendente para revisão.`;
        alert(`Aluno salvo com segurança. ${accessMessage} ${billingMessage}`);
        setEditingStudent(null);
        fetchStudents();
        return;

      } catch (err: any) {
        console.error(err);
        alert('Erro ao criar aluno: ' + err.message);
        return;
      }
    }

    // UPDATE LÓGICA (Para aluno já existente)
    try {
      const isDirector = user?.role === UserRole.SCHOOL_ADMIN || user?.role === UserRole.SUPER_ADMIN;
      const studentCpf = formData.cpf?.replace(/\D/g, '') || null;
      const contractSigned = !!(editingStudent.accepted_at || editingStudent.documentation_status === 'APPROVED');
      const previousModule = String(editingStudent.module || editingStudent.levelBadge || '')
        .trim()
        .toUpperCase()
        .split(/\s+/)[0];
      const requestedModule = String(formData.levelBadge || '').trim().toUpperCase();
      const placementChanged = requestedModule !== '' && requestedModule !== previousModule;

      if (!isDirector) {
        // Professor responsável: atualiza somente campos pedagógicos. Status e
        // ciclo da matrícula pertencem exclusivamente à gestão.
        const { error: updateErr } = await supabase.rpc('update_student_pedagogical_profile', {
          p_student_id: editingStudent.id,
          p_data: {
            full_name: formData.name,
            occupation: formData.occupation,
            interests: formData.interests,
            private_notes: formData.private_notes,
            fixed_schedule: formData.fixed_schedule,
            // is_kids fica com a direção (migration 20260926200000).
            module: requestedModule,
          }
        });
        if (updateErr) throw updateErr;

        alert('Perfil do aluno atualizado com sucesso!');
        setEditingStudent(null);
        fetchStudents();
        return;
      }

      // Diretor: atualização completa
      const updatePayload: Record<string, any> = {
        interests: formData.interests,
        occupation: formData.occupation,
        phone: formData.phone,
        attendance_phone: formData.attendance_phone || null,
        meeting_link: formData.meeting_link,
        avatar_url: formData.img,
        fixed_schedule: formData.fixed_schedule,
        private_notes: formData.private_notes,
        professor_id: nullableUuid(formData.professor_id),
        guardian_name: formData.guardian_name,
        guardian_phone: formData.guardian_phone,
        is_kids: formData.is_kids,
      };

      // Campos contratuais — só editáveis se o contrato ainda não foi assinado
      if (!contractSigned) {
        updatePayload.full_name = formData.name;
        updatePayload.cpf = studentCpf;
        updatePayload.postal_code = formData.postalCode;
        updatePayload.address = formData.address;
        updatePayload.address_number = formData.addressNumber;
        updatePayload.monthly_fee = formData.monthly_fee;
        updatePayload.due_day = formData.due_day;
      }

      const { error } = await supabase
        .from('profiles')
        .update(updatePayload)
        .eq('id', editingStudent.id);

      if (error) throw error;

      if (placementChanged) {
        const { error: placementError } = await supabase.rpc(
          'set_student_pedagogical_placement',
          {
            p_student_id: editingStudent.id,
            p_module: requestedModule,
            p_reason: 'Reposicionamento pedagógico autorizado no cadastro do aluno',
          },
        );
        if (placementError) throw placementError;
      }

      // Atualiza status se alterado no formulário
      if (formData.status && formData.status !== (editingStudent.status || (isInactive(editingStudent) ? 'Inativo' : 'Ativo'))) {
        const targetInactive = formData.status === 'Inativo' || formData.status === 'Trancado';
        await changeStudentLifecycle(supabase, {
          studentId: editingStudent.id,
          status: targetInactive ? 'suspended' : 'active',
          reason: 'Alterado no formulário de edição do aluno',
        });
      }

      if (contractSigned) {
        alert(`Perfil atualizado! Os dados contratuais (valor, CPF, endereço, etc.) não foram alterados pois o contrato já foi assinado.${placementChanged ? ' O nível pedagógico foi atualizado separadamente.' : ''}`);
      } else {
        alert('Perfil do aluno atualizado com sucesso!');
      }
      setEditingStudent(null);

      // Matrícula inativa não volta ao fluxo de criação/sincronização de cobrança.
      const statusAfterEdit = formData.status || editingStudent.status || (isInactive(editingStudent) ? 'Inativo' : 'Ativo');
      if (statusAfterEdit === 'Ativo') try {
        await asaasService.syncStudent({
          user_id: editingStudent.id,
          name: contractSigned ? editingStudent.name : formData.name,
          email: formData.email || 'email@placeholder.com',
          cpf: contractSigned ? (editingStudent.cpf || '') : (studentCpf || ''),
          phone: formData.phone,
          postalCode: contractSigned ? (editingStudent.postalCode || '') : formData.postalCode,
          address: contractSigned ? (editingStudent.address || '') : formData.address,
          addressNumber: contractSigned ? (editingStudent.addressNumber || '') : formData.addressNumber,
          monthly_fee: contractSigned ? editingStudent.monthly_fee : formData.monthly_fee,
          due_day: contractSigned ? editingStudent.due_day : formData.due_day,
        } as any);
      } catch (asaasError) {
        console.error("Asaas Sync Error", asaasError);
      }

      fetchStudents();
    } catch (err: any) {
      alert('Erro ao atualizar aluno: ' + err.message);
    }
  };

  const openStudentEditor = async (student: any) => {
    try {
      const isDirector = user?.role === UserRole.SCHOOL_ADMIN || user?.role === UserRole.SUPER_ADMIN;
      if (!isDirector) {
        // Professor responsável: carrega apenas os dados permitidos, sem PII sensível (CPF, email, preço)
        setEditingStudent({
          ...student,
          name: student.name,
          phone: student.phone || '',
          attendance_phone: student.attendance_phone || '',
          levelBadge: student.levelBadge || 'A1',
          currentModuleStatus: student.currentModuleStatus || '',
          status: student.status || (isInactive(student) ? 'Inativo' : 'Ativo'),
          lifecycle_status: student.lifecycle_status || (isInactive(student) ? 'suspended' : 'active'),
          interests: student.interests || [],
          occupation: student.occupation || '',
          meeting_link: student.meetingLink || '',
          fixed_schedule: student.fixed_schedule || '',
          private_notes: student.private_notes || '',
          professor_id: student.professor_id || '',
          email: '',
          cpf: '',
          monthly_fee: 0,
          due_day: 10,
        });
        return;
      }

      const privateProfile = await loadAuthorizedProfilePrivate(student.id);
      setEditingStudent({
        ...student,
        ...privateProfile,
        status: student.status || (isInactive(student) ? 'Inativo' : 'Ativo'),
        meeting_link: student.meetingLink,
        fixed_schedule: student.fixed_schedule,
        postalCode: privateProfile.postal_code || '',
        addressNumber: privateProfile.address_number || '',
        asaasCustomerId: privateProfile.asaas_customer_id || '',
      });
    } catch (error) {
      console.error('Erro ao carregar dados do aluno:', error);
      alert('Você não tem permissão para abrir os dados privados deste aluno.');
    }
  };

  // Suspender (adormecido) ↔ reativar — usa o eixo canônico lifecycle_status via school-admin ou RPC pedagógica.
  const handleToggleStatus = async (student: any) => {
    const makeInactive = !isInactive(student);
    const isDirector = user?.role === UserRole.SCHOOL_ADMIN || user?.role === UserRole.SUPER_ADMIN;
    const msg = makeInactive
      ? `Pausar temporariamente a matrícula de ${student.name}?\n\nPAUSA: é reversível. O acesso e as mensagens automáticas são interrompidos, a assinatura fica inativa no Asaas, a competência atual é preservada e cobranças abertas dos meses seguintes são canceladas. Os horários fixos serão liberados da agenda do professor.\n\nPara uma saída definitiva, use “Encerrar”.`
      : `Reativar a matrícula de ${student.name}?\n\nO acesso, a assinatura e as notificações automáticas voltam ao fluxo ativo. Os horários liberados durante a pausa não voltam automaticamente: será preciso escolher e agendar novos horários.`;
    // Pausa e reativação passam pelo school-admin, que confere o Asaas; o banco
    // recusa a troca de status por qualquer outro caminho (20261027114059).
    if (!isDirector) return;
    if (!window.confirm(msg)) return;

    try {
      const data = await changeStudentLifecycle(supabase, {
        studentId: student.id,
        status: makeInactive ? 'suspended' : 'active',
        reason: makeInactive ? 'Suspenso pela coordenação' : null,
      });
      const newLifecycle = makeInactive ? 'suspended' : 'active';
      setStudents(prev => prev.map(s => s.id === student.id ? {
        ...s,
        status: makeInactive ? 'Inativo' : 'Ativo',
        lifecycle_status: newLifecycle,
      } : s));
      if (makeInactive) {
        const billing = (data as any)?.billing || {};
        alert(
          `Matrícula pausada com segurança. ${Number(billing.schedulesCancelled || 0)} horário(s) liberado(s) e ${Number(billing.notificationsQueued || 0)} aviso(s) preparado(s).`,
        );
      } else {
        alert('Matrícula reativada com sucesso.');
      }
      fetchStudents();
    } catch (err: any) {
      alert('Erro ao alterar status do aluno: ' + err.message);
    }
  };

  // O encerramento exige uma decisão explícita para a competência da saída.
  // A confirmação final é processada e auditada no servidor junto com o Asaas.
  const handleOffboard = async (student: any) => {
    const requestId = ++offboardingPreviewRequestId.current;
    offboardingPreviousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setOffboardingStudent(student);
    setOffboardingReason('');
    setOffboardingPolicy(null);
    setOffboardingEffectiveDate(saoPauloCalendarDate());
    setOffboardingInvoices([]);
    setOffboardingPaymentIdentityAvailable(false);
    setOffboardingPreviewError(null);
    setOffboardingPreviewLoading(true);
    try {
      if (!tenantId) {
        throw new Error('Escola não identificada para a conferência financeira.');
      }
      const identityPreview = await supabase
        .from('student_payments')
        .select('id,value,due_date,status,provider_status,asaas_payment_id,asaas_id')
        .eq('tenant_id', tenantId)
        .eq('student_id', student.id)
        .eq('payment_type', 'SUBSCRIPTION')
        .gte('due_date', '2020-01-01')
        .order('due_date', { ascending: true });
      let data = identityPreview.data;
      let identityAvailable = !identityPreview.error;
      if (identityPreview.error) {
        // Algumas instalações antigas não expõem os identificadores Asaas no
        // SELECT administrativo. A decisão de dispensa continua disponível,
        // mas a UI não oferece preservar uma cobrança cuja identidade não
        // conseguiu provar localmente.
        const fallbackPreview = await supabase
          .from('student_payments')
          .select('id,value,due_date,status')
          .eq('tenant_id', tenantId)
          .eq('student_id', student.id)
          .eq('payment_type', 'SUBSCRIPTION')
          .gte('due_date', '2020-01-01')
          .order('due_date', { ascending: true });
        if (fallbackPreview.error) throw fallbackPreview.error;
        data = (fallbackPreview.data || []).map(payment => ({
          ...payment,
          provider_status: null,
          asaas_payment_id: null,
          asaas_id: null,
        }));
        identityAvailable = false;
      }
      if (requestId !== offboardingPreviewRequestId.current) return;
      setOffboardingInvoices((data || []).map((payment: any) => ({
        id: String(payment.id),
        value: Number(payment.value || 0),
        dueDate: String(payment.due_date || ''),
        status: String(payment.status || '').toUpperCase(),
        providerStatus: String(payment.provider_status || payment.status || '').toUpperCase(),
        asaasPaymentId: String(payment.asaas_payment_id || '').trim(),
        legacyAsaasPaymentId: String(payment.asaas_id || '').trim(),
      })));
      setOffboardingPaymentIdentityAvailable(identityAvailable);
    } catch (error) {
      if (requestId !== offboardingPreviewRequestId.current) return;
      console.error('Erro ao preparar prévia do desligamento:', error);
      setOffboardingPreviewError('Não foi possível conferir as cobranças. Tente novamente antes de encerrar.');
    } finally {
      if (requestId === offboardingPreviewRequestId.current) {
        setOffboardingPreviewLoading(false);
      }
    }
  };

  const confirmOffboarding = async () => {
    if (!offboardingStudent) return;
    if (!offboardingReason.trim()) {
      alert('Informe o motivo do encerramento.');
      return;
    }
    if (!offboardingEffectiveDate) {
      alert('Informe o último dia do aluno.');
      return;
    }
    if (!offboardingPolicy) {
      alert('Escolha conscientemente como tratar a mensalidade do mês da saída.');
      return;
    }
    if (offboardingPolicy === 'WAIVE_CURRENT_MONTH' && hasConfirmedOrReceivedCurrentInvoice) {
      alert('Há uma cobrança confirmada ou recebida neste mês. Preserve o registro atual para evitar estorno implícito e cancele somente as cobranças futuras.');
      return;
    }
    if (offboardingPolicy === 'CHARGE_CURRENT_MONTH' && !canPreserveCurrentInvoice) {
      alert('A prévia não comprovou uma única cobrança atual com identidade Asaas consistente. Faça a conciliação financeira antes de preservar este mês.');
      return;
    }
    if (offboardingPreviewLoading || offboardingPreviewError) {
      alert('Aguarde a conferência das cobranças antes de encerrar a matrícula.');
      return;
    }
    isOffboardingRef.current = true;
    setIsOffboarding(true);
    try {
      const data = await changeStudentLifecycle(supabase, {
        studentId: offboardingStudent.id,
        status: 'offboarded',
        reason: offboardingReason.trim(),
        billingPolicy: offboardingPolicy,
        effectiveEndDate: offboardingEffectiveDate,
      });
      const billing = (data as any)?.billing || {};
      setStudents(prev => prev.map(s => s.id === offboardingStudent.id ? { ...s, status: 'Inativo', lifecycle_status: 'offboarded' } : s));
      offboardingPreviewRequestId.current += 1;
      setOffboardingStudent(null);
      alert(
        `Matrícula encerrada com segurança. ${Number(billing.paymentsCancelled || 0)} cobrança(s) anulada(s), ${Number(billing.schedulesCancelled || 0)} horário(s) liberado(s) e ${Number(billing.notificationsQueued || 0)} aviso(s) preparado(s).`,
      );
    } catch (err: any) {
      alert('Erro ao desligar aluno: ' + (err.message || 'tente novamente.'));
    } finally {
      isOffboardingRef.current = false;
      setIsOffboarding(false);
    }
  };

  const closeOffboarding = () => {
    if (isOffboardingRef.current) return;
    offboardingPreviewRequestId.current += 1;
    setOffboardingStudent(null);
    setOffboardingInvoices([]);
    setOffboardingPaymentIdentityAvailable(false);
    setOffboardingPreviewLoading(false);
    setOffboardingPreviewError(null);
  };

  const handleDeleteStudentClick = () => {
    if (!editingStudent) return;
    setStudentToDelete(editingStudent);
  };

  const confirmDelete = async () => {
    if (!studentToDelete) return;
    setIsDeleting(true);

    try {
      // Usar Edge Function para garantir a remoção correta do Auth User (que fará cascade) e Asaas
      const { data, error } = await supabase.functions.invoke('delete-student-account', {
        body: {
          studentId: studentToDelete.id
        }
      });

      if (error) {
        throw new Error(error.message || 'Erro ao remover aluno via função.');
      }

      if (data?.success !== true) {
        throw new Error(data.error);
      }

      alert('Conta de teste removida do acesso, do perfil e do Asaas.');

      setStudentToDelete(null);
      setEditingStudent(null);
      fetchStudents();
    } catch (err: any) {
      alert('Erro ao remover aluno: ' + err.message);
    } finally {
      setIsDeleting(false);
    }
  };

  // Busca métricas consolidadas (risco/frequência/atraso) — RPC com escopo por papel
  useEffect(() => {
    (async () => {
      const { data } = await supabase.rpc('list_students_overview');
      if (Array.isArray(data)) {
        const map: Record<string, any> = {};
        data.forEach((r: any) => { map[r.student_id] = r; });
        setOverviewMap(map);
      }
    })();
  }, [tenantId, students]);

  // Níveis disponíveis para o filtro
  const availableLevels = Array.from(new Set(students.map(s => s.levelBadge).filter((x: string) => x && x !== 'N/A'))).sort();

  // Aluno fora do ciclo ativo: lifecycle_status canônico (suspended/offboarded) é a fonte de
  // verdade; mantém fallback nos marcadores legados durante a transição.
  const isInactive = (s: any) =>
    (s?.lifecycle_status && s.lifecycle_status !== 'active')
    || ['Inativo', 'INACTIVE', 'Inactive', 'Arquivado', 'Cancelado', 'Trancado'].includes(s?.status)
    || s?.status_financial === 'ARCHIVED';

  const isDirectorUser = user?.role === UserRole.SCHOOL_ADMIN || user?.role === UserRole.SUPER_ADMIN;
  const permissionsFor = (student?: any) => rosterPermissions(user?.role, user?.id, student);
  const normalize = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

  // Busca, professor e nível recortam a base; os atalhos contam dentro desse recorte.
  const scopedStudents = students.filter(s => {
    const term = normalize(searchTerm.trim());
    const matchesSearch = !term
      || normalize(s.name).includes(term)
      || normalize(s.occupation || '').includes(term)
      || (s.assignedTeachers || []).some((t: string) => normalize(t || '').includes(term));
    const matchesTeacher = selectedTeacherId === 'ALL' || s.assignedTeacherIds.includes(selectedTeacherId);
    const matchesLevel = levelFilter === 'ALL' || s.levelBadge === levelFilter;
    return matchesSearch && matchesTeacher && matchesLevel;
  });
  const quickOptions = quickFilterOptions(scopedStudents, overviewMap, permissionsFor(undefined).canSeeMoney);
  const filteredStudents = sortRoster(
    scopedStudents.filter(s => matchesQuickFilter(s, overviewMap[s.id], quickFilter)),
    overviewMap,
    sortBy,
  );
  // Quantos alunos ativos cada professor tem — mostrado ao lado do nome no filtro.
  const activeCountByTeacher = students.reduce<Record<string, number>>((acc, s) => {
    if (rosterStage(s) !== 'active') return acc;
    for (const id of s.assignedTeacherIds as string[]) acc[id] = (acc[id] || 0) + 1;
    return acc;
  }, {});
  const hasNarrowing = !!searchTerm.trim() || selectedTeacherId !== 'ALL' || levelFilter !== 'ALL';
  const changeViewMode = (mode: 'cards' | 'table') => {
    setViewMode(mode);
    try {
      window.localStorage.setItem(`wisewolf.studentsView.${user?.id || ''}`, mode);
    } catch {
      // Preferência de exibição: sem armazenamento, só não é lembrada.
    }
  };

  const offboardingPeriodStart = /^\d{4}-\d{2}-\d{2}$/.test(offboardingEffectiveDate)
    ? `${offboardingEffectiveDate.slice(0, 7)}-01`
    : `${saoPauloCalendarDate().slice(0, 7)}-01`;
  const [offboardingYear, offboardingMonth] = offboardingPeriodStart.split('-').map(Number);
  const offboardingNextPeriodStart = new Date(Date.UTC(offboardingYear, offboardingMonth, 1))
    .toISOString().slice(0, 10);
  const offboardingCurrentInvoiceCandidates = offboardingInvoices.filter(payment =>
    payment.dueDate >= offboardingPeriodStart && payment.dueDate < offboardingNextPeriodStart
  );
  const offboardingCurrentInvoices = offboardingCurrentInvoiceCandidates.filter(payment =>
    isLiveCurrentMonthInvoiceStatus(payment.status)
  );
  const offboardingFutureInvoices = offboardingInvoices.filter(payment =>
    payment.dueDate >= offboardingNextPeriodStart && isOpenRecurringPaymentStatus(payment.status)
  );
  const offboardingCurrentTotal = offboardingCurrentInvoices.reduce((sum, payment) => sum + payment.value, 0);
  const offboardingFutureTotal = offboardingFutureInvoices.reduce((sum, payment) => sum + payment.value, 0);
  const hasConfirmedOrReceivedCurrentInvoice = offboardingCurrentInvoices.some(payment =>
    isConfirmedOrReceivedCurrentMonthStatus(payment.status)
  );
  const canPreserveCurrentInvoice = offboardingPaymentIdentityAvailable
    && canPreserveExactlyOneCurrentMonthInvoice(offboardingCurrentInvoiceCandidates);
  const noNewChargeSelectionPolicy = noNewChargePolicy(
    hasConfirmedOrReceivedCurrentInvoice,
    canPreserveCurrentInvoice,
  );

  const showSidebar = isDirectorUser && teachers.length > 0;
  const activeOption = quickOptions.find(o => o.id === quickFilter);
  const attentionCount = quickOptions.find(o => o.id === 'ATTENTION')?.count || 0;
  const activeCount = quickOptions.find(o => o.id === 'ACTIVE')?.count || 0;
  const selectedTeacher = teachers.find(t => t.id === selectedTeacherId);
  const toneClass: Record<string, string> = {
    blue: 'data-[on=true]:bg-blue-600 data-[on=true]:border-blue-600 text-blue-700 dark:text-blue-300',
    rose: 'data-[on=true]:bg-rose-600 data-[on=true]:border-rose-600 text-rose-700 dark:text-rose-300',
    orange: 'data-[on=true]:bg-orange-500 data-[on=true]:border-orange-500 text-orange-700 dark:text-orange-300',
    violet: 'data-[on=true]:bg-violet-600 data-[on=true]:border-violet-600 text-violet-700 dark:text-violet-300',
    red: 'data-[on=true]:bg-red-600 data-[on=true]:border-red-600 text-red-700 dark:text-red-300',
    amber: 'data-[on=true]:bg-amber-500 data-[on=true]:border-amber-500 text-amber-700 dark:text-amber-300',
    slate: 'data-[on=true]:bg-slate-600 data-[on=true]:border-slate-600 text-slate-700 dark:text-slate-300',
  };

  return (
    <div data-tour="student-schedule-change" className="flex flex-col xl:flex-row gap-6 h-auto xl:h-[calc(100dvh-6rem)] min-h-0 animate-in fade-in duration-500 relative">

      {/* Filtro por professor (direção) */}
      {showSidebar && (
        <aside className="hidden xl:flex w-72 min-h-0 bg-brand-surface border border-brand-border rounded-3xl flex-col shrink-0 overflow-hidden">
          <div className="p-5 border-b border-brand-border">
            <h3 className="font-black text-brand-text text-[11px] uppercase tracking-widest flex items-center gap-2">
              <Users size={14} className="text-tenant-primary" /> Por professor
            </h3>
            <p className="mt-1 text-[11px] text-brand-muted">Alunos ativos na agenda de cada um.</p>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-1.5 custom-scrollbar">
            <button
              type="button"
              onClick={() => setSelectedTeacherId('ALL')}
              data-on={selectedTeacherId === 'ALL'}
              className="w-full flex items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors hover:bg-brand-surface-2 data-[on=true]:bg-tenant-primary data-[on=true]:text-white"
            >
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-surface-2 text-brand-muted"><Users size={16} /></span>
              <span className="flex-1 text-xs font-black">Todos os alunos</span>
              <span className="text-[11px] font-black opacity-80">{students.filter(s => rosterStage(s) === 'active').length}</span>
            </button>
            {[...teachers].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')).map(teacher => (
              <button
                type="button"
                key={teacher.id}
                onClick={() => setSelectedTeacherId(teacher.id)}
                data-on={selectedTeacherId === teacher.id}
                className="w-full flex items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors hover:bg-brand-surface-2 data-[on=true]:bg-tenant-primary data-[on=true]:text-white"
              >
                <img src={teacher.avatar} className="h-9 w-9 rounded-xl object-cover" alt="" />
                <span className="flex-1 min-w-0 truncate text-xs font-bold">{teacher.name}</span>
                <span className={`min-w-6 rounded-full px-1.5 py-0.5 text-center text-[11px] font-black ${activeCountByTeacher[teacher.id] ? 'bg-brand-surface-2 text-brand-text' : 'text-brand-muted'}`}>
                  {activeCountByTeacher[teacher.id] || 0}
                </span>
              </button>
            ))}
          </div>
        </aside>
      )}

      <div className="flex-1 min-w-0 min-h-0 flex flex-col gap-4 overflow-visible xl:overflow-hidden">
        {/* Cabeçalho */}
        <section className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-[#0b1f4d] via-[#14306e] to-[#2a1f6b] p-5 text-white shadow-[0_30px_60px_-36px_rgba(30,58,138,0.9)] shrink-0 md:p-6">
          <div className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-white/10 blur-3xl" />
          <div className="relative flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.24em] text-blue-200">
                {isDirectorUser ? 'Alunos da escola' : 'Meus alunos'}
              </p>
              <h2 className="mt-1 text-2xl font-black tracking-tight md:text-3xl">
                {activeCount} ativo{activeCount === 1 ? '' : 's'}
                {attentionCount > 0 && <span className="text-rose-300"> · {attentionCount} pedem atenção</span>}
              </h2>
              <p className="mt-1 max-w-xl text-xs leading-relaxed text-blue-100/80">
                {isDirectorUser
                  ? 'Toque num atalho para ver só quem precisa de você. Pausar e encerrar conferem a assinatura no Asaas antes de valer.'
                  : 'Aqui ficam os alunos com aula na sua agenda. Você edita o pedagógico e troca horário em Agenda; valores e matrícula ficam com a direção.'}
              </p>
            </div>
            {permissionsFor(undefined).canCreate && (
              <button
                type="button"
                onClick={() => setEditingStudent({} as any)} // Objeto vazio = criação
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-2xl bg-white px-5 text-xs font-black uppercase tracking-wide text-[#0b1f4d] shadow-lg transition-transform hover:scale-[1.03]"
                aria-label="Adicionar novo aluno"
              >
                <UserPlus size={17} /> Novo aluno
              </button>
            )}
          </div>
        </section>

        {/* Busca e ordenação */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center shrink-0">
          <label className="flex min-h-11 flex-1 items-center gap-3 rounded-2xl border border-brand-border bg-brand-surface px-4 focus-within:ring-2 focus-within:ring-tenant-primary/30">
            <Search size={17} className="text-brand-muted" />
            <input
              className="flex-1 bg-transparent text-sm font-semibold text-brand-text outline-hidden placeholder:text-brand-muted"
              placeholder={isDirectorUser ? 'Buscar por aluno, professor ou profissão' : 'Buscar aluno'}
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              aria-label="Buscar aluno"
            />
            {searchTerm && (
              <button type="button" onClick={() => setSearchTerm('')} aria-label="Limpar busca" className="text-brand-muted hover:text-brand-text"><X size={16} /></button>
            )}
          </label>
          <div className="grid grid-cols-2 gap-2 sm:flex">
            {showSidebar && (
              <select
                value={selectedTeacherId}
                onChange={e => setSelectedTeacherId(e.target.value)}
                className="xl:hidden col-span-2 min-h-11 rounded-2xl border border-brand-border bg-brand-surface px-3 text-xs font-bold text-brand-text"
                aria-label="Filtrar por professor"
              >
                <option value="ALL">Todos os professores</option>
                {teachers.map(t => <option key={t.id} value={t.id}>{t.name} ({activeCountByTeacher[t.id] || 0})</option>)}
              </select>
            )}
            <select
              value={levelFilter}
              onChange={e => setLevelFilter(e.target.value)}
              className="min-h-11 rounded-2xl border border-brand-border bg-brand-surface px-3 text-xs font-bold text-brand-text"
              aria-label="Filtrar por nível"
            >
              <option value="ALL">Todos os níveis</option>
              {availableLevels.map(l => <option key={l} value={l}>{l}</option>)}
            </select>
            <select
              value={sortBy}
              onChange={e => setSortBy(e.target.value as RosterSort)}
              className="min-h-11 rounded-2xl border border-brand-border bg-brand-surface px-3 text-xs font-bold text-brand-text"
              aria-label="Ordenar alunos"
            >
              <option value="PRIORITY">Prioridade</option>
              <option value="LAST_CLASS">Mais tempo sem aula</option>
              <option value="NAME">Nome (A–Z)</option>
            </select>
            <div className="col-span-2 flex rounded-2xl border border-brand-border bg-brand-surface p-1" role="group" aria-label="Modo de exibição">
              {([['cards', LayoutGrid, 'Cartões'], ['table', ListIcon, 'Lista']] as const).map(([mode, Icon, label]) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => changeViewMode(mode)}
                  aria-pressed={viewMode === mode}
                  className={`flex flex-1 items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-[11px] font-black transition-colors ${viewMode === mode ? 'bg-tenant-primary text-white' : 'text-brand-muted hover:text-brand-text'}`}
                >
                  <Icon size={14} /> {label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Atalhos: cada um é um filtro com a contagem */}
        <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 shrink-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" role="tablist" aria-label="Situação dos alunos">
          {quickOptions.map(option => (
            <button
              key={option.id}
              type="button"
              role="tab"
              aria-selected={quickFilter === option.id}
              data-on={quickFilter === option.id}
              onClick={() => setQuickFilter(option.id)}
              title={option.hint}
              className={`group flex shrink-0 items-center gap-2 rounded-2xl border border-brand-border bg-brand-surface px-3.5 py-2 transition-all hover:-translate-y-0.5 data-[on=true]:text-white data-[on=true]:shadow-lg ${toneClass[option.tone]}`}
            >
              <span className="text-lg font-black leading-none">{option.count}</span>
              <span className="text-[11px] font-bold leading-tight text-brand-text group-data-[on=true]:text-white">{option.label}</span>
            </button>
          ))}
          <button
            type="button"
            role="tab"
            aria-selected={quickFilter === 'ALL'}
            data-on={quickFilter === 'ALL'}
            onClick={() => setQuickFilter('ALL')}
            className="flex shrink-0 items-center gap-2 rounded-2xl border border-dashed border-brand-border px-3.5 py-2 text-[11px] font-bold text-brand-muted transition-colors hover:text-brand-text data-[on=true]:border-solid data-[on=true]:bg-brand-surface-2 data-[on=true]:text-brand-text"
          >
            Todos · {scopedStudents.length}
          </button>
        </div>

        {(hasNarrowing || selectedTeacher) && (
          <div className="flex flex-wrap items-center gap-2 text-[11px] font-bold text-brand-muted shrink-0">
            <span>Mostrando {filteredStudents.length} de {scopedStudents.length}</span>
            {selectedTeacher && <span className="rounded-full bg-brand-surface-2 px-2 py-1 text-brand-text">{selectedTeacher.name}</span>}
            {levelFilter !== 'ALL' && <span className="rounded-full bg-brand-surface-2 px-2 py-1 text-brand-text">{levelFilter}</span>}
            <button
              type="button"
              onClick={() => { setSearchTerm(''); setSelectedTeacherId('ALL'); setLevelFilter('ALL'); }}
              className="text-tenant-primary underline-offset-2 hover:underline"
            >
              Limpar filtros
            </button>
          </div>
        )}

        {loadError && (
          <div
            className="flex flex-col gap-3 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-amber-950 sm:flex-row sm:items-center sm:justify-between"
            role="alert"
          >
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 shrink-0" size={20} />
              <div>
                <p className="text-sm font-black">Os alunos não foram ocultados nem removidos.</p>
                <p className="mt-1 text-xs font-semibold leading-5">{loadError}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => void fetchStudents()}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-amber-950 px-4 text-xs font-black uppercase tracking-wider text-white"
            >
              <RefreshCw size={15} />
              Tentar novamente
            </button>
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-visible xl:overflow-y-auto pr-0 xl:pr-2 pb-20 custom-scrollbar">
          {loading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-4" aria-busy="true" aria-label="Carregando alunos">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-80 animate-pulse rounded-3xl border border-brand-border bg-brand-surface" />
              ))}
            </div>
          ) : viewMode === 'table' ? (
            <StudentRosterTable
              students={filteredStudents}
              overviewMap={overviewMap}
              showTeachers={isDirectorUser}
              canSeeMoney={permissionsFor(undefined).canSeeMoney}
              onOpenProfile={(s) => setViewStudentId(s.id)}
            />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-4">
              {filteredStudents.map(student => (
                <StudentRosterCard
                  key={student.id}
                  student={student}
                  overview={overviewMap[student.id]}
                  permissions={permissionsFor(student)}
                  showTeachers={isDirectorUser || !isTeacherOf(student, user?.id)}
                  onOpenProfile={() => setViewStudentId(student.id)}
                  onEdit={() => void openStudentEditor(student)}
                  onMaterials={() => setPedagogicalStudent(student)}
                  onWolf={() => setWolfProfileStudent(student)}
                  onSchedule={() => setScheduleStudent(student)}
                  onToggleStatus={() => handleToggleStatus(student)}
                  onOffboard={() => handleOffboard(student)}
                />
              ))}
            </div>
          )}

          {!loading && !loadError && filteredStudents.length === 0 && (
            <div className="py-20 text-center bg-brand-surface rounded-3xl border border-dashed border-brand-border">
              <div className="inline-block p-4 rounded-full bg-brand-surface-2 mb-4">
                <Search size={24} className="text-brand-muted" />
              </div>
              <p className="text-brand-text font-black text-sm">
                {students.length === 0
                  ? (isDirectorUser ? 'Nenhum aluno cadastrado ainda.' : 'Nenhum aluno com aula na sua agenda.')
                  : searchTerm.trim()
                    ? `Nenhum aluno encontrado para “${searchTerm.trim()}”.`
                    : `Nenhum aluno em “${activeOption?.label || 'Todos'}” por aqui.`}
              </p>
              {students.length > 0 && quickFilter !== 'ALL' && (
                <button type="button" onClick={() => setQuickFilter('ALL')} className="mt-3 text-xs font-black text-tenant-primary hover:underline">
                  Ver todos os alunos
                </button>
              )}
            </div>
          )}
        </div>
      </div>


      {/* Edit Modal */}
      {editingStudent && (
        <div className="fixed inset-0 z-100 flex items-center justify-center p-6 bg-black/60 backdrop-blur-xs animate-in fade-in duration-300">
          <StudentProfileForm
            initialData={editingStudent}
            onSubmit={handleUpdateStudent}
            onScheduleChanged={fetchStudents}
            onCancel={() => setEditingStudent(null)}
            onDelete={
              editingStudent.is_test_account === true &&
              (user?.role === 'SCHOOL_ADMIN' || user?.role === 'SUPER_ADMIN')
                ? handleDeleteStudentClick
                : undefined
            }
            title={editingStudent.name}
            teachers={teachers}
            currentUserRole={user?.role}
            tenantId={tenantId || user?.tenantId}
          />
        </div>
      )}

      {/* Ficha 360° do aluno */}
      {viewStudentId && (
        <StudentProfileView studentId={viewStudentId} user={user as any} onClose={() => setViewStudentId(null)} />
      )}

      {/* Materiais / Pedagógico do aluno */}
      {pedagogicalStudent && (
        <TeacherPedagogicalModal student={pedagogicalStudent} onClose={() => setPedagogicalStudent(null)} />
      )}

      {/* Wolf Intelligence Profile Editor */}
      {wolfProfileStudent && (
        <StudentProfileEditor
          studentId={wolfProfileStudent.id}
          studentName={wolfProfileStudent.name}
          onClose={() => setWolfProfileStudent(null)}
          onSaved={fetchStudents}
        />
      )}

      {/* O professor altera apenas bookings próprios; a função no banco barra
          choque de agenda, preserva o horário antigo nas datas passadas, audita e
          avisa o grupo da Gestão. */}
      {scheduleStudent && user?.role === UserRole.TEACHER && tenantId && (
        <TeacherStudentScheduleEditor
          studentId={scheduleStudent.id}
          studentName={scheduleStudent.name}
          tenantId={tenantId}
          teacherId={user.id}
          onClose={() => setScheduleStudent(null)}
          onChanged={fetchStudents}
        />
      )}

      {offboardingStudent && (
        <div
          className="fixed inset-0 z-115 flex items-center justify-center px-3 py-[max(0.75rem,env(safe-area-inset-top))] sm:p-6 bg-slate-950/75 backdrop-blur-md animate-in fade-in duration-200"
        >
          <div
            ref={offboardingDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="offboarding-dialog-title"
            aria-describedby="offboarding-dialog-description"
            tabIndex={-1}
            style={{ maxHeight: 'calc(100dvh - 1.5rem - env(safe-area-inset-top) - env(safe-area-inset-bottom))' }}
            className="w-full max-w-2xl overflow-y-auto rounded-3xl sm:rounded-4xl border border-white/10 bg-brand-surface shadow-2xl outline-hidden"
          >
            <div className="p-6 sm:p-8 border-b border-brand-border bg-linear-to-br from-slate-950 to-[#08245f] text-white">
              <div className="flex items-start gap-4">
                <div className="shrink-0 w-12 h-12 rounded-2xl bg-white/10 border border-white/15 flex items-center justify-center">
                  <AlertTriangle size={23} className="text-amber-300" />
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-[0.24em] font-black text-blue-200 mb-2">Encerramento auditado</p>
                  <h3 id="offboarding-dialog-title" className="text-2xl font-black tracking-tight">Encerrar matrícula de {offboardingStudent.name}</h3>
                  <p id="offboarding-dialog-description" className="mt-2 text-sm text-slate-300 leading-relaxed">Este é o encerramento definitivo. Para uma interrupção reversível, volte e use “Pausar”. Aqui, assinatura, cobranças, previsões e agendas serão sincronizadas em uma única operação.</p>
                </div>
              </div>
            </div>

            <div className="p-6 sm:p-8 space-y-6">
              <div className="grid sm:grid-cols-2 gap-4">
                <label className="space-y-2">
                  <span className="text-[10px] uppercase tracking-widest font-black text-brand-muted">Último dia do aluno</span>
                  <input
                    type="date"
                    value={offboardingEffectiveDate}
                    min="2020-01-01"
                    max={saoPauloCalendarDate()}
                    required
                    onChange={(event) => {
                      setOffboardingEffectiveDate(event.target.value);
                      setOffboardingPolicy(null);
                    }}
                    className="w-full rounded-2xl border border-brand-border bg-brand-surface-2 px-4 py-3 text-sm font-bold text-brand-text focus:outline-hidden focus:ring-2 focus:ring-tenant-primary/30"
                  />
                </label>
                <label className="space-y-2">
                  <span className="text-[10px] uppercase tracking-widest font-black text-brand-muted">Motivo obrigatório</span>
                  <input
                    value={offboardingReason}
                    onChange={(event) => setOffboardingReason(event.target.value)}
                    maxLength={500}
                    required
                    placeholder="Ex.: encerramento solicitado pelo aluno"
                    className="w-full rounded-2xl border border-brand-border bg-brand-surface-2 px-4 py-3 text-sm font-bold text-brand-text focus:outline-hidden focus:ring-2 focus:ring-tenant-primary/30"
                  />
                </label>
              </div>

              <div className="rounded-2xl border border-brand-border bg-brand-surface-2 p-4 sm:p-5" aria-live="polite" aria-busy={offboardingPreviewLoading}>
                <div className="flex items-center justify-between gap-3 mb-4">
                  <div>
                    <p className="text-[10px] uppercase tracking-widest font-black text-brand-muted">Conferência financeira</p>
                    <p className="mt-1 text-sm font-bold text-brand-text">Valores que esta decisão pode afetar</p>
                  </div>
                  {offboardingPreviewLoading && <RefreshCw size={18} className="animate-spin text-tenant-primary" />}
                </div>
                {offboardingPreviewError ? (
                  <p className="rounded-xl bg-red-50 px-3 py-2 text-sm font-bold text-red-700">{offboardingPreviewError}</p>
                ) : offboardingPreviewLoading ? (
                  <p className="text-sm text-brand-muted">Consultando as cobranças registradas…</p>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="rounded-xl border border-brand-border bg-brand-surface p-3">
                      <p className="text-[9px] font-black uppercase tracking-wider text-brand-muted">Mês da saída</p>
                      <p className="mt-1 text-lg font-black text-brand-text">{BRL_FORMATTER.format(offboardingCurrentTotal)}</p>
                      <p className="text-[11px] text-brand-muted">{offboardingCurrentInvoices.length} cobrança(s)</p>
                    </div>
                    <div className="rounded-xl border border-brand-border bg-brand-surface p-3">
                      <p className="text-[9px] font-black uppercase tracking-wider text-brand-muted">Meses seguintes</p>
                      <p className="mt-1 text-lg font-black text-brand-text">{BRL_FORMATTER.format(offboardingFutureTotal)}</p>
                      <p className="text-[11px] text-brand-muted">{offboardingFutureInvoices.length} cobrança(s)</p>
                    </div>
                    {hasConfirmedOrReceivedCurrentInvoice && canPreserveCurrentInvoice && (
                      <p className="sm:col-span-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-bold leading-relaxed text-emerald-900" id="confirmed-current-month-note">
                        Há uma cobrança confirmada pelo provedor ou já recebida neste mês. O registro atual será preservado, sem estorno e sem nova cobrança; somente as cobranças futuras serão canceladas.
                      </p>
                    )}
                    {hasConfirmedOrReceivedCurrentInvoice && !canPreserveCurrentInvoice && (
                      <p className="sm:col-span-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-bold leading-relaxed text-amber-950" id="current-month-identity-note">
                        Há uma cobrança confirmada ou recebida, mas a prévia não comprovou exatamente um registro atual com identidade Asaas consistente. O encerramento automático fica protegido até a conciliação financeira.
                      </p>
                    )}
                  </div>
                )}
              </div>

              <fieldset className="space-y-3">
                <legend className="text-[10px] uppercase tracking-widest font-black text-brand-muted mb-3">Como tratar a mensalidade do mês da saída?</legend>
                <label className={`block rounded-2xl border p-5 transition-all ${offboardingPreviewLoading || !!offboardingPreviewError || !noNewChargeSelectionPolicy ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'} ${noNewChargeSelectionPolicy && offboardingPolicy === noNewChargeSelectionPolicy ? 'border-emerald-400 bg-emerald-50/70 dark:bg-emerald-950/20 ring-2 ring-emerald-400/15' : 'border-brand-border hover:border-emerald-300'}`}>
                  <div className="flex gap-3">
                    <input
                      type="radio"
                      name="offboarding-policy"
                      checked={Boolean(noNewChargeSelectionPolicy) && offboardingPolicy === noNewChargeSelectionPolicy}
                      disabled={offboardingPreviewLoading || !!offboardingPreviewError || !noNewChargeSelectionPolicy}
                      onChange={() => {
                        if (noNewChargeSelectionPolicy) setOffboardingPolicy(noNewChargeSelectionPolicy);
                      }}
                      aria-describedby={hasConfirmedOrReceivedCurrentInvoice
                        ? `${canPreserveCurrentInvoice ? 'confirmed-current-month-note' : 'current-month-identity-note'} no-new-charge-description`
                        : 'no-new-charge-description'}
                      className="mt-1 accent-emerald-600"
                    />
                    <div>
                      <p className="font-black text-brand-text">Não fazer nova cobrança</p>
                      <p id="no-new-charge-description" className="mt-1 text-sm text-brand-muted leading-relaxed">
                        {hasConfirmedOrReceivedCurrentInvoice
                          ? canPreserveCurrentInvoice
                            ? 'A cobrança atual, confirmada ou recebida, será mantida. Não haverá estorno nem outra cobrança; somente os meses seguintes serão cancelados e retirados da previsão.'
                            : 'Disponível após a conciliação comprovar uma única cobrança atual vinculada ao Asaas. Nenhuma operação insegura será enviada enquanto isso.'
                          : 'Anula cobranças ainda não pagas deste mês e dos meses seguintes, remove esses valores da previsão e preserva o histórico.'}
                      </p>
                    </div>
                  </div>
                </label>
                {!hasConfirmedOrReceivedCurrentInvoice && canPreserveCurrentInvoice && (
                  <label className={`block rounded-2xl border p-5 transition-all ${offboardingPreviewLoading || !!offboardingPreviewError ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'} ${offboardingPolicy === 'CHARGE_CURRENT_MONTH' ? 'border-blue-400 bg-blue-50/70 dark:bg-blue-950/20 ring-2 ring-blue-400/15' : 'border-brand-border hover:border-blue-300'}`}>
                    <div className="flex gap-3">
                      <input
                        type="radio"
                        name="offboarding-policy"
                        checked={offboardingPolicy === 'CHARGE_CURRENT_MONTH'}
                        disabled={offboardingPreviewLoading || !!offboardingPreviewError}
                        onChange={() => setOffboardingPolicy('CHARGE_CURRENT_MONTH')}
                        aria-describedby="charge-current-month-description"
                        className="mt-1 accent-blue-600"
                      />
                      <div>
                        <p className="font-black text-brand-text">Manter a cobrança deste mês</p>
                        <p id="charge-current-month-description" className="mt-1 text-sm text-brand-muted leading-relaxed">Mantém a mensalidade já emitida deste mês, pausa a assinatura para não gerar novas cobranças e anula somente os meses seguintes.</p>
                      </div>
                    </div>
                  </label>
                )}
              </fieldset>

              <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950 flex gap-3">
                <Info size={18} className="shrink-0 mt-0.5" />
                <p><strong>Esta tela não faz estorno nem cobra duas vezes.</strong> Uma cobrança confirmada pelo provedor pode ainda estar aguardando crédito no caixa; cobranças já recebidas também são preservadas. Em ambos os casos, o status real é mantido e somente o futuro é cancelado.</p>
              </div>

              <div className="flex flex-col-reverse sm:flex-row gap-3 pt-2">
                <button
                  type="button"
                  onClick={closeOffboarding}
                  disabled={isOffboarding}
                  className="flex-1 rounded-2xl bg-brand-surface-2 px-5 py-3.5 text-sm font-black text-brand-muted hover:bg-slate-200 dark:hover:bg-slate-700 disabled:opacity-50"
                >
                  Voltar
                </button>
                <button
                  type="button"
                  onClick={confirmOffboarding}
                  disabled={isOffboarding || offboardingPreviewLoading || !!offboardingPreviewError || !offboardingPolicy || (offboardingPolicy === 'WAIVE_CURRENT_MONTH' && hasConfirmedOrReceivedCurrentInvoice) || (offboardingPolicy === 'CHARGE_CURRENT_MONTH' && !canPreserveCurrentInvoice) || !offboardingReason.trim() || !offboardingEffectiveDate}
                  aria-busy={isOffboarding}
                  className="flex-[1.4] rounded-2xl bg-red-600 px-5 py-3.5 text-sm font-black text-white shadow-lg shadow-red-600/20 hover:bg-red-700 disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {isOffboarding ? <RefreshCw size={18} className="animate-spin" /> : <AlertTriangle size={18} />}
                  {isOffboarding ? 'Sincronizando tudo…' : 'Confirmar encerramento'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Exclusão permanente existe apenas para fixtures E2E marcadas. */}
      {studentToDelete && (
        <div className="fixed inset-0 z-110 flex items-center justify-center p-6 bg-black/80 backdrop-blur-xs animate-in fade-in duration-300">
          <div className="bg-brand-surface rounded-3xl w-full max-w-md p-8 shadow-2xl border border-red-100 dark:border-red-900/30">
            <div className="w-16 h-16 bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 rounded-full flex items-center justify-center mb-6 mx-auto">
              <AlertCircle size={32} />
            </div>

            <h3 className="text-2xl font-black text-center text-brand-text mb-2 tracking-tight">
              Excluir conta de teste?
            </h3>
            <p className="text-center text-brand-muted text-sm mb-6">
              Você está prestes a excluir a fixture <strong>{studentToDelete.name}</strong>. O acesso, os registros locais e os recursos de teste no Asaas serão removidos.
            </p>

            <div className="bg-amber-50 p-5 rounded-2xl mb-6 border border-amber-200 text-sm text-amber-900">
              Esta ação é definitiva e só aparece para contas marcadas pelo sistema como teste. Alunos reais devem ser desligados para preservar contratos e histórico financeiro.
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setStudentToDelete(null)}
                disabled={isDeleting}
                className="flex-1 py-3 bg-brand-surface-2 hover:bg-slate-200 dark:bg-brand-surface-2 dark:hover:bg-slate-700 text-brand-muted font-bold rounded-xl transition-colors disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                onClick={confirmDelete}
                disabled={isDeleting}
                className="flex-1 py-3 bg-red-600 hover:bg-red-700 text-white font-bold rounded-xl transition-all shadow-lg shadow-red-500/30 flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {isDeleting ? <RefreshCw className="animate-spin" size={20} /> : <Trash2 size={20} />}
                {isDeleting ? 'Excluindo...' : 'Sim, Excluir'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default StudentsList;
