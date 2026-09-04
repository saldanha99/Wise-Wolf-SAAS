import React, { useState, useEffect, useRef } from 'react';
import { Search, ExternalLink, Video, Star, MessageCircle, Info, RefreshCw, BookOpen, Briefcase, Phone, Copy, UserPlus, Edit3, Trash2, Users, ChevronRight, Calendar, Folder, CreditCard, AlertCircle, Brain, Eye, AlertTriangle, CalendarCheck, UserCheck, UserX } from 'lucide-react';
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
import { loadAuthorizedProfilePrivate } from '../lib/profilePrivacy';
import { provisionStudentAccount } from '../lib/studentAccountProvisioning';
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
  const [financialFilter, setFinancialFilter] = useState<string>('ALL'); // ALL | RISK | OVERDUE
  const [statusFilter, setStatusFilter] = useState<string>('ALL'); // ALL | ACTIVE | INACTIVE
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
        // Professor responsável: atualiza apenas campos pedagógicos e acadêmicos autorizados
        const { error: updateErr } = await supabase.rpc('update_student_pedagogical_profile', {
          p_student_id: editingStudent.id,
          p_data: {
            full_name: formData.name,
            phone: formData.phone,
            attendance_phone: formData.attendance_phone || null,
            meeting_link: formData.meeting_link,
            occupation: formData.occupation,
            interests: formData.interests,
            private_notes: formData.private_notes,
            fixed_schedule: formData.fixed_schedule,
            is_kids: formData.is_kids,
            status: formData.status,
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
        try {
          await supabase.functions.invoke('school-admin', {
            body: {
              action: 'setStudentLifecycle',
              studentId: editingStudent.id,
              status: targetInactive ? 'suspended' : 'active',
              reason: 'Alterado no formulário de edição do aluno',
            },
          });
        } catch (_) {
          await supabase.rpc('set_student_academic_status', {
            p_student_id: editingStudent.id,
            p_status: formData.status,
          });
        }
      }

      if (contractSigned) {
        alert(`Perfil atualizado! Os dados contratuais (valor, CPF, endereço, etc.) não foram alterados pois o contrato já foi assinado.${placementChanged ? ' O nível pedagógico foi atualizado separadamente.' : ''}`);
      } else {
        alert('Perfil do aluno atualizado com sucesso!');
      }
      setEditingStudent(null);

      // Sincroniza no Asaas apenas campos não-contratuais se já assinou
      try {
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
    if (!window.confirm(msg)) return;

    if (!isDirector) {
      // Professor responsável: altera status diretamente via RPC segura
      try {
        const { error } = await supabase.rpc('set_student_academic_status', {
          p_student_id: student.id,
          p_status: makeInactive ? 'Inativo' : 'Ativo',
          p_reason: makeInactive ? 'Pausado pelo professor responsável' : 'Reativado pelo professor responsável',
        });
        if (error) throw error;
        const newLifecycle = makeInactive ? 'suspended' : 'active';
        setStudents(prev => prev.map(s => s.id === student.id ? {
          ...s,
          status: makeInactive ? 'Inativo' : 'Ativo',
          lifecycle_status: newLifecycle,
        } : s));
        alert(makeInactive ? 'Aluno pausado temporariamente pelo professor.' : 'Aluno reativado com sucesso.');
        fetchStudents();
      } catch (err: any) {
        alert('Erro ao alterar status: ' + (err.message || 'Falha de permissão'));
      }
      return;
    }

    try {
      const { data, error } = await supabase.functions.invoke('school-admin', {
        body: {
          action: 'setStudentLifecycle',
          studentId: student.id,
          status: makeInactive ? 'suspended' : 'active',
          reason: makeInactive ? 'Suspenso pela coordenação' : null,
        },
      });
      if (error || (data && (data as any).ok === false)) {
        throw new Error(error?.message || (data as any)?.error || 'falha');
      }
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
      const { data, error } = await supabase.functions.invoke('school-admin', {
        body: {
          action: 'setStudentLifecycle',
          studentId: offboardingStudent.id,
          status: 'offboarded',
          reason: offboardingReason.trim(),
          billingPolicy: offboardingPolicy,
          effectiveEndDate: offboardingEffectiveDate,
        },
      });
      if (error || (data && (data as any).ok === false)) {
        throw new Error(error?.message || (data as any)?.error || 'falha');
      }
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
  }, [tenantId, students.length]);

  // Níveis disponíveis para o filtro
  const availableLevels = Array.from(new Set(students.map(s => s.levelBadge).filter((x: string) => x && x !== 'N/A'))).sort();

  // Aluno fora do ciclo ativo: lifecycle_status canônico (suspended/offboarded) é a fonte de
  // verdade; mantém fallback nos marcadores legados durante a transição.
  const isInactive = (s: any) =>
    (s?.lifecycle_status && s.lifecycle_status !== 'active')
    || ['Inativo', 'INACTIVE', 'Inactive', 'Arquivado', 'Cancelado', 'Trancado'].includes(s?.status)
    || s?.status_financial === 'ARCHIVED';

  // Filter Logic
  const filteredStudents = students.filter(s => {
    const ov = overviewMap[s.id];
    const matchesSearch = s.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      s.occupation.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesTeacher = selectedTeacherId === 'ALL' || s.assignedTeacherIds.includes(selectedTeacherId);
    const matchesLevel = levelFilter === 'ALL' || s.levelBadge === levelFilter;
    const matchesFinancial = financialFilter === 'ALL'
      || (financialFilter === 'RISK' && ov && ov.risk_level !== 'LOW')
      || (financialFilter === 'OVERDUE' && ov && (ov.overdue_count || 0) > 0)
      || (financialFilter === 'ORPHAN' && ov && ov.has_activity === false);
    const matchesStatus = statusFilter === 'ALL'
      || (statusFilter === 'ACTIVE' && !isInactive(s))
      || (statusFilter === 'INACTIVE' && isInactive(s));
    return matchesSearch && matchesTeacher && matchesLevel && matchesFinancial && matchesStatus;
  });

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

  const showSidebar = user?.role === UserRole.SCHOOL_ADMIN || user?.role === UserRole.SUPER_ADMIN;

  return (
    <div className="flex flex-col xl:flex-row gap-6 h-auto xl:h-[calc(100dvh-6rem)] min-h-0 animate-in fade-in duration-500 relative">

      {/* Sidebar: Teacher Filter (Admins Only) */}
      {showSidebar && (
        <div className="w-full xl:w-72 max-h-[22rem] xl:max-h-none min-h-0 bg-brand-surface border border-brand-border rounded-[2rem] flex flex-col shadow-sm shrink-0">
          <div className="p-5 border-b border-brand-border">
            <h3 className="font-black text-brand-text dark:text-slate-100 text-[10px] uppercase tracking-widest mb-3 flex items-center gap-2">
              <Users size={14} className="text-tenant-primary" /> Filtrar por Professor
            </h3>
            {/* Optional Search inside sidebar could go here */}
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2 custom-scrollbar">
            <button
              onClick={() => setSelectedTeacherId('ALL')}
              className={`w-full p-3 rounded-xl border transition-all flex items-center gap-3 text-left group ${selectedTeacherId === 'ALL'
                ? 'bg-[#002366] bg-tenant-primary border-tenant-primary text-white shadow-lg'
                : 'bg-brand-surface border-slate-50 dark:border-brand-border hover:border-brand-border'
                }`}
            >
              <div className="w-8 h-8 rounded-lg bg-brand-surface-2 dark:bg-brand-surface-2 flex items-center justify-center">
                <Users size={14} className={selectedTeacherId === 'ALL' ? 'text-brand-text' : 'text-brand-muted'} />
              </div>
              <span className={`text-[10px] font-black uppercase tracking-wide flex-1 ${selectedTeacherId === 'ALL' ? 'text-white' : 'text-brand-muted dark:text-brand-muted'}`}>
                Todos os Alunos
              </span>
              {selectedTeacherId === 'ALL' && <ChevronRight size={12} />}
            </button>

            {teachers.map(teacher => (
              <button
                key={teacher.id}
                onClick={() => setSelectedTeacherId(teacher.id)}
                className={`w-full p-3 rounded-xl border transition-all flex items-center gap-3 text-left group ${selectedTeacherId === teacher.id
                  ? 'bg-[#002366] bg-tenant-primary border-tenant-primary text-white shadow-lg shadow-tenant-primary/20'
                  : 'bg-brand-surface border-slate-50 dark:border-brand-border hover:border-tenant-primary/30'
                  }`}
              >
                <img src={teacher.avatar} className="w-8 h-8 rounded-lg border-2 border-white/20" alt="" />
                <div className="flex-1 overflow-hidden">
                  <p className={`text-[10px] font-black truncate leading-tight ${selectedTeacherId === teacher.id ? 'text-white' : 'text-brand-text dark:text-slate-300'}`}>
                    {teacher.name}
                  </p>
                </div>
                {selectedTeacherId === teacher.id && <ChevronRight size={12} />}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 min-w-0 min-h-0 flex flex-col gap-6 overflow-visible xl:overflow-hidden">
        {/* Header Search */}
        <div className="flex flex-col md:flex-row md:flex-wrap xl:flex-nowrap justify-between items-stretch md:items-center gap-3 md:gap-4 bg-brand-surface p-4 rounded-[2rem] border border-brand-border shrink-0">
          <div className="flex items-center gap-4 w-full md:min-w-[18rem] md:flex-1">
            <div className="p-3 bg-brand-surface-2 rounded-full">
              <Search size={20} className="text-brand-muted" />
            </div>
            <input
              className="flex-1 bg-transparent outline-none text-sm font-bold text-brand-text dark:text-slate-200 placeholder:text-brand-muted"
              placeholder="Buscar aluno por nome, profissão..."
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
            />
          </div>
          <div className="flex items-center justify-center gap-2 px-4 py-2 bg-brand-surface-2 rounded-full shrink-0">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-[10px] font-black uppercase text-brand-muted tracking-widest">{filteredStudents.length} Alunos</span>
          </div>

          {/* Filtros avançados */}
          <select value={levelFilter} onChange={e => setLevelFilter(e.target.value)}
            className="w-full sm:w-auto text-xs font-bold bg-brand-surface-2 text-brand-text rounded-full px-3 py-2 outline-none border border-brand-border shrink-0">
            <option value="ALL">Todos os níveis</option>
            {availableLevels.map(l => <option key={l} value={l}>{l}</option>)}
          </select>
          <select value={financialFilter} onChange={e => setFinancialFilter(e.target.value)}
            className="w-full sm:w-auto text-xs font-bold bg-brand-surface-2 text-brand-text rounded-full px-3 py-2 outline-none border border-brand-border shrink-0">
            <option value="ALL">Situação: todas</option>
            <option value="RISK">⚠ Em risco</option>
            <option value="OVERDUE">Inadimplentes</option>
            <option value="ORPHAN">Sem matrícula (testes)</option>
          </select>
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
            className="w-full sm:w-auto text-xs font-bold bg-brand-surface-2 text-brand-text rounded-full px-3 py-2 outline-none border border-brand-border shrink-0">
            <option value="ALL">Status: todos</option>
            <option value="ACTIVE">Ativos</option>
            <option value="INACTIVE">Inativos</option>
          </select>

          {/* ADD BUTTON */}
          <button
            onClick={() => setEditingStudent({} as any)} // Empty object signals creation
            className="w-full md:w-auto p-3 bg-[#002366] bg-tenant-primary text-white rounded-xl md:rounded-full hover:scale-[1.02] md:hover:scale-110 transition-transform shadow-lg shadow-tenant-primary/20 flex items-center justify-center gap-2 shrink-0"
            title="Adicionar Novo Aluno"
            aria-label="Adicionar novo aluno"
          >
            <UserPlus size={20} />
            <span className="md:hidden text-xs font-black uppercase tracking-widest">Adicionar aluno</span>
          </button>
        </div>

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

        {/* Grid */}
        <div className="flex-1 min-h-0 overflow-visible xl:overflow-y-auto pr-0 xl:pr-2 custom-scrollbar">
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6 pb-20">
            {loading ? (
              <div className="col-span-full py-20 flex flex-col items-center justify-center text-brand-muted">
                <RefreshCw className="animate-spin mb-4" size={32} />
                <p className="text-xs font-black uppercase tracking-widest">Carregando Alunos...</p>
              </div>
            ) : filteredStudents.map((student, i) => {
              const ov = overviewMap[student.id];
              const isDirector = user?.role === UserRole.SCHOOL_ADMIN || user?.role === UserRole.SUPER_ADMIN;
              const isTeacher = user?.role === UserRole.TEACHER;
              const isMyStudent = isTeacher && (student.professor_id === user?.id || (student.assignedTeacherIds || []).includes(user?.id));
              const canEdit = isDirector || isMyStudent;
              const inactive = isInactive(student);
              const lifecycleStatus = String(student.lifecycle_status || '').trim().toLowerCase();
              const isSuspended = lifecycleStatus === 'suspended';
              const isOffboarded = lifecycleStatus === 'offboarded';
              return (
              <div key={i} className={`group bg-brand-surface rounded-[2rem] border p-6 hover:shadow-2xl hover:shadow-slate-200/50 dark:hover:shadow-black/40 transition-all duration-300 relative overflow-hidden h-fit ${inactive ? 'border-slate-300 dark:border-slate-700' : 'border-brand-border'}`}>

                {/* Header: Name & Edit */}
                <div className="flex justify-between items-start mb-4">
                  <div className="flex-1 pr-4">
                    <h3 className="font-black text-brand-text text-lg leading-tight tracking-tight mb-1">{student.name}</h3>
                    {ov && ov.risk_level !== 'LOW' && (
                      <span className={`inline-flex items-center gap-1 text-[9px] font-black px-2 py-0.5 rounded-full ${ov.risk_level === 'HIGH' ? 'bg-red-500 text-white' : 'bg-amber-400 text-amber-900'}`}
                        title={(ov.risk_reasons || []).join(' · ')}>
                        <AlertTriangle size={10} /> {ov.risk_level === 'HIGH' ? 'ALTO RISCO' : 'ATENÇÃO'}
                      </span>
                    )}
                    {inactive && (
                      <span className={`inline-flex items-center gap-1 text-[9px] font-black px-2 py-0.5 rounded-full mt-1 ${isOffboarded ? 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300' : isSuspended ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300' : 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300'}`}
                        title={isOffboarded ? 'Matrícula encerrada definitivamente' : isSuspended ? 'Pausa temporária e reversível' : 'Aluno inativo'}>
                        <UserX size={10} /> {isOffboarded ? 'MATRÍCULA ENCERRADA' : isSuspended ? 'PAUSA TEMPORÁRIA' : 'INATIVO'}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <div className="w-8 h-8 rounded-full bg-purple-100 dark:bg-purple-900/30 flex items-center justify-center text-purple-600 dark:text-purple-400 font-black text-xs">
                      {student.levelBadge}
                    </div>
                    {canEdit && (
                      <button
                        onClick={() => void openStudentEditor(student)}
                        className="min-w-11 min-h-11 rounded-full bg-tenant-primary/10 text-tenant-primary flex items-center justify-center hover:bg-tenant-primary hover:text-white transition-all shadow-sm"
                        title="Editar Perfil"
                        aria-label={`Editar perfil de ${student.name}`}
                      >
                        <Edit3 size={14} />
                      </button>
                    )}
                  </div>
                </div>

                {/* Frequência + risco (chips) */}
                {ov && (
                  <div className="flex flex-wrap gap-2 mb-4 text-[10px] font-bold">
                    <span className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-brand-surface-2 text-brand-muted">
                      <CalendarCheck size={11} /> Freq. {ov.attendance_rate != null ? `${ov.attendance_rate}%` : '—'}
                    </span>
                    {(ov.overdue_count || 0) > 0 && (
                      <span className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-red-50 text-red-600 dark:bg-red-900/20">
                        <CreditCard size={11} /> {ov.overdue_count} em atraso
                      </span>
                    )}
                    {ov.days_since_last != null && ov.days_since_last > 30 && (
                      <span className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-orange-50 text-orange-600 dark:bg-orange-900/20">
                        {ov.days_since_last}d sem aula
                      </span>
                    )}
                  </div>
                )}

                {/* Content Sections */}
                <div className="space-y-5">

                  {/* Module & Progress */}
                  <div>
                    <div className="flex justify-between items-end mb-1.5">
                      <h4 className="text-[10px] uppercase font-black text-brand-muted tracking-widest">Progresso do Módulo</h4>
                      <span className="text-[10px] font-bold text-brand-muted dark:text-brand-muted">{student.currentModuleStatus}</span>
                    </div>
                    {/* Fake Progress Bar - Visual Only for now */}
                    <div className="w-full h-1.5 bg-brand-surface-2 dark:bg-brand-surface-2 rounded-full overflow-hidden">
                      <div className="h-full bg-gradient-to-r from-blue-500 to-purple-500 w-[45%]" />
                    </div>
                  </div>

                  {/* Fixed Schedule */}
                  <div>
                    <h4 className="text-[10px] uppercase font-black text-brand-muted tracking-widest mb-1.5 flex items-center gap-1.5">
                      <Calendar size={12} /> Horário Fixo
                    </h4>
                    {student.fixed_schedule ? (
                      <div className="px-3 py-2 bg-brand-surface-2 border border-brand-border dark:border-brand-border rounded-xl text-xs font-black text-brand-text dark:text-slate-300">
                        {student.fixed_schedule}
                      </div>
                    ) : (
                      <div className="px-3 py-2 border border-dashed border-brand-border dark:border-brand-border rounded-xl text-[10px] font-bold text-brand-muted uppercase tracking-widest">
                        -- Não definido --
                      </div>
                    )}
                  </div>

                  {/* Interests */}
                  <div>
                    <h4 className="text-[10px] uppercase font-black text-brand-muted tracking-widest mb-2 flex items-center gap-1.5">
                      <BookOpen size={12} /> Interesses
                    </h4>
                    <div className="flex flex-wrap gap-2">
                      {student.interests.map((interest: string, idx: number) => (
                        <span key={idx} className="px-2.5 py-1 bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400 rounded-md text-[9px] font-bold uppercase tracking-wider">
                          {interest}
                        </span>
                      ))}
                    </div>
                  </div>

                  {/* Occupation */}
                  <div>
                    <h4 className="text-[10px] uppercase font-black text-brand-muted tracking-widest mb-1.5 flex items-center gap-1.5">
                      <Briefcase size={12} /> Ocupação
                    </h4>
                    <p className="text-xs font-bold text-brand-text dark:text-slate-300 uppercase">{student.occupation}</p>
                  </div>

                  {/* Action Buttons */}
                  <div className={`grid grid-cols-2 gap-2 pt-2 ${user?.role === UserRole.TEACHER ? 'sm:grid-cols-5' : 'sm:grid-cols-4'}`}>
                    {/* WhatsApp */}
                    <button
                      onClick={() => {
                        const message = encodeURIComponent(`Olá *${student.name.split(' ')[0]}*! 🐺\n\nSegue o link da sua sala de aula: ${student.meetingLink}\n\nBons estudos! 🚀`);
                        const phone = student.phone?.replace(/\D/g, '') || '';
                        window.open(`https://wa.me/${phone}?text=${message}`, '_blank');
                      }}
                      className="flex flex-col items-center justify-center gap-1 p-2 bg-green-50 hover:bg-green-100 dark:bg-green-900/20 dark:hover:bg-green-900/30 border border-green-100 dark:border-green-900/30 rounded-xl transition-colors group"
                      title="Enviar Link via WhatsApp Manualmente"
                    >
                      <MessageCircle size={18} className="text-green-600 dark:text-green-400 group-hover:scale-110 transition-transform" />
                      <span className="text-[9px] font-black text-green-700 dark:text-green-300 uppercase tracking-wide">WhatsApp</span>
                    </button>

                    {/* Meet */}
                    <button
                      onClick={() => window.open(student.meetingLink, '_blank')}
                      disabled={!student.meetingLink}
                      className="flex flex-col items-center justify-center gap-1 p-2 bg-blue-50 hover:bg-blue-100 dark:bg-blue-900/20 dark:hover:bg-blue-900/30 border border-blue-100 dark:border-blue-900/30 rounded-xl transition-colors group disabled:opacity-50 disabled:cursor-not-allowed"
                      title="Link da Aula"
                    >
                      <Video size={18} className="text-blue-600 dark:text-blue-400 group-hover:scale-110 transition-transform" />
                      <span className="text-[9px] font-black text-blue-700 dark:text-blue-300 uppercase tracking-wide">Sala Aula</span>
                    </button>

                    {/* Materials */}
                    <button
                      onClick={() => setPedagogicalStudent(student)}
                      className="flex flex-col items-center justify-center gap-1 p-2 bg-purple-50 hover:bg-purple-100 dark:bg-purple-900/20 dark:hover:bg-purple-900/30 border border-purple-100 dark:border-purple-900/30 rounded-xl transition-colors group"
                      title="Materiais do Aluno"
                    >
                      <Folder size={18} className="text-purple-600 dark:text-purple-400 group-hover:scale-110 transition-transform" />
                      <span className="text-[9px] font-black text-purple-700 dark:text-purple-300 uppercase tracking-wide">Materiais</span>
                    </button>

                    {/* Wolf Intelligence */}
                    <button
                      onClick={() => setWolfProfileStudent(student)}
                      className="flex flex-col items-center justify-center gap-1 p-2 bg-violet-50 hover:bg-violet-100 dark:bg-violet-900/20 dark:hover:bg-violet-900/30 border border-violet-100 dark:border-violet-900/30 rounded-xl transition-colors group"
                      title="Perfil Wolf Intelligence"
                    >
                      <Brain size={18} className="text-violet-600 dark:text-violet-400 group-hover:scale-110 transition-transform" />
                      <span className="text-[9px] font-black text-violet-700 dark:text-violet-300 uppercase tracking-wide">Wolf AI</span>
                    </button>

                    {user?.role === UserRole.TEACHER && (
                      <button
                        onClick={() => setScheduleStudent(student)}
                        className="flex flex-col items-center justify-center gap-1 p-2 bg-cyan-50 hover:bg-cyan-100 dark:bg-cyan-900/20 dark:hover:bg-cyan-900/30 border border-cyan-100 dark:border-cyan-900/30 rounded-xl transition-colors group"
                        title="Trocar dia ou horário combinado com o aluno"
                      >
                        <CalendarCheck size={18} className="text-cyan-600 dark:text-cyan-400 group-hover:scale-110 transition-transform" />
                        <span className="text-[9px] font-black text-cyan-700 dark:text-cyan-300 uppercase tracking-wide">Agenda</span>
                      </button>
                    )}
                  </div>

                </div>

                {/* Footer */}
                <div className="mt-8 pt-6 border-t border-brand-border grid grid-cols-2 gap-2">
                  <button
                    className="col-span-2 min-h-11 flex items-center justify-center gap-2 px-3 py-3 rounded-2xl bg-tenant-primary/10 text-tenant-primary text-xs font-black uppercase hover:bg-tenant-primary hover:text-white transition-colors"
                    onClick={() => setViewStudentId(student.id)}
                    aria-label={`Ver ficha completa de ${student.name}`}
                  >
                    <Eye size={14} /> Ver Ficha 360°
                  </button>
                  {canEdit && !isOffboarded && (
                    <button
                      className={`${isDirector ? '' : 'col-span-2 '}min-h-11 flex items-center justify-center gap-2 px-3 py-3 rounded-2xl border text-[11px] font-black uppercase transition-colors ${inactive ? 'border-emerald-200 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-900/40 dark:text-emerald-300 dark:hover:bg-emerald-900/20' : 'border-amber-200 text-amber-700 hover:bg-amber-50 dark:border-amber-900/40 dark:text-amber-300 dark:hover:bg-amber-900/20'}`}
                      onClick={() => handleToggleStatus(student)}
                      title={inactive ? 'Reativar matrícula e assinatura' : 'Pausar temporariamente; ação reversível'}
                      aria-label={inactive ? `Reativar matrícula de ${student.name}` : `Pausar temporariamente a matrícula de ${student.name}`}
                    >
                      {inactive ? <UserCheck size={14} /> : <UserX size={14} />}
                      {inactive ? 'Reativar' : 'Pausar'}
                    </button>
                  )}
                  {isDirector && !isOffboarded && (
                    <button
                      className="min-h-11 flex items-center justify-center gap-2 px-3 py-3 rounded-2xl border border-red-200 text-red-700 hover:bg-red-50 dark:border-red-900/40 dark:text-red-300 dark:hover:bg-red-900/20 text-[11px] font-black uppercase transition-colors"
                      onClick={() => handleOffboard(student)}
                      title="Encerrar matrícula definitivamente"
                      aria-label={`Encerrar definitivamente a matrícula de ${student.name}`}
                    >
                      <AlertTriangle size={14} />
                      Encerrar
                    </button>
                  )}
                  {canEdit && (
                    <button
                      className="col-span-2 min-h-11 flex items-center justify-center gap-2 px-3 py-3 rounded-2xl border border-brand-border text-brand-muted text-xs font-black uppercase hover:bg-brand-surface-2 transition-colors"
                      onClick={() => void openStudentEditor(student)}
                      title="Editar Perfil Completo"
                      aria-label={`Editar perfil completo de ${student.name}`}
                    >
                      <Edit3 size={14} /> Editar perfil
                    </button>
                  )}
                </div>

              </div>
              );
            })}
          </div>

          {!loading && !loadError && filteredStudents.length === 0 && (
            <div className="py-24 text-center bg-brand-surface rounded-[3rem] border border-dashed border-brand-border dark:border-brand-border">
              <div className="inline-block p-4 rounded-full bg-brand-surface-2 mb-4">
                <Search size={24} className="text-slate-300" />
              </div>
              <p className="text-brand-muted dark:text-brand-muted font-black uppercase text-xs tracking-widest">Nenhum aluno encontrado para "{searchTerm}"</p>
            </div>
          )}
        </div>
      </div>


      {/* Edit Modal */}
      {editingStudent && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-black/60 backdrop-blur-sm animate-in fade-in duration-300">
          <StudentProfileForm
            initialData={editingStudent}
            onSubmit={handleUpdateStudent}
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

      {/* O professor altera apenas bookings próprios; a função no banco valida
          disponibilidade/conflitos, audita e enfileira o aviso ao grupo. */}
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
          className="fixed inset-0 z-[115] flex items-center justify-center px-3 py-[max(0.75rem,env(safe-area-inset-top))] sm:p-6 bg-slate-950/75 backdrop-blur-md animate-in fade-in duration-200"
        >
          <div
            ref={offboardingDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="offboarding-dialog-title"
            aria-describedby="offboarding-dialog-description"
            tabIndex={-1}
            style={{ maxHeight: 'calc(100dvh - 1.5rem - env(safe-area-inset-top) - env(safe-area-inset-bottom))' }}
            className="w-full max-w-2xl overflow-y-auto rounded-[1.5rem] sm:rounded-[2rem] border border-white/10 bg-brand-surface shadow-2xl outline-none"
          >
            <div className="p-6 sm:p-8 border-b border-brand-border bg-gradient-to-br from-slate-950 to-[#08245f] text-white">
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
                    className="w-full rounded-2xl border border-brand-border bg-brand-surface-2 px-4 py-3 text-sm font-bold text-brand-text focus:outline-none focus:ring-2 focus:ring-tenant-primary/30"
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
                    className="w-full rounded-2xl border border-brand-border bg-brand-surface-2 px-4 py-3 text-sm font-bold text-brand-text focus:outline-none focus:ring-2 focus:ring-tenant-primary/30"
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
        <div className="fixed inset-0 z-[110] flex items-center justify-center p-6 bg-black/80 backdrop-blur-sm animate-in fade-in duration-300">
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
