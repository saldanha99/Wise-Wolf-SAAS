import React, { useState, useEffect } from 'react';
import { Search, ExternalLink, Video, Star, MessageCircle, Info, RefreshCw, BookOpen, Briefcase, Phone, Copy, UserPlus, Edit3, Trash2, Users, ChevronRight, Calendar, Folder, CreditCard, AlertCircle, Brain, Eye, AlertTriangle, CalendarCheck, UserCheck, UserX } from 'lucide-react';
import StudentProfileView from './StudentProfileView';
import { supabase } from '../lib/supabase';
import { safeMeetingLink } from '../lib/meetingLink';
import { PROFILE_SAFE_COLS } from '../constants';
import { asaasService } from '../services/asaasService';
import { User as UserType, UserRole, Teacher } from '../types';
import StudentProfileForm from './StudentProfileForm';
import TeacherPedagogicalModal from './TeacherPedagogicalModal';
import StudentProfileEditor from './StudentProfileEditor';

interface StudentsListProps {
  tenantId?: string;
  user?: UserType;
  teachers?: Teacher[];
}

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
  const [editingStudent, setEditingStudent] = useState<any | null>(null);
  const [pedagogicalStudent, setPedagogicalStudent] = useState<any | null>(null);
  const [wolfProfileStudent, setWolfProfileStudent] = useState<any | null>(null);

  // Deletion Modal State
  const [studentToDelete, setStudentToDelete] = useState<any>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    if (tenantId) fetchStudents();
  }, [tenantId, user?.id]);

  const fetchStudents = async () => {
    setLoading(true);
    try {
      // 1. Fetch Students
      let query = supabase
        .from('profiles')
        .select(PROFILE_SAFE_COLS)
        .eq('role', 'STUDENT')
        .eq('tenant_id', tenantId);

      // If teacher, filter students they have bookings with
      if (user?.role === UserRole.TEACHER) {
        const { data: teacherBookings } = await supabase
          .from('bookings')
          .select('student_id')
          .eq('teacher_id', user.id)
          .eq('tenant_id', tenantId);

        const studentIds = Array.from(new Set(teacherBookings?.map(b => b.student_id) || []));
        if (studentIds.length > 0) {
          query = query.in('id', studentIds);
        } else {
          setStudents([]);
          setLoading(false);
          return;
        }
      }

      const { data: studentsData, error: studentError } = await query;
      if (studentError) throw studentError;

      // 2. Fetch Bookings to find teachers and schedule
      // NOTE: Using start_date and time_slot as per schema
      const { data: bookingsData } = await supabase
        .from('bookings')
        .select('student_id, teacher_id, start_date, day_of_week, time_slot, teacher:teacher_id(id, full_name)')
        .eq('tenant_id', tenantId);

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
            currentModuleStatus: s.module || 'Não iniciado',
            interests: s.interests || [],
            correctionPreference: 'PADRÃO',
            occupation: s.occupation || 'Não informado',
            phone: s.phone || '',
            img: s.avatar_url || `https://ui-avatars.com/api/?name=${s.full_name}`,
            meetingLink: s.meeting_link || '',
            fixed_schedule: scheduleDisplay,
            private_notes: s.private_notes,
            assignedTeachers: teacherNames,
            assignedTeacherIds: assignedTeacherIds,
            createdAt: s.created_at,
            cpf: s.cpf,
            postalCode: s.postal_code,
            address: s.address,
            addressNumber: s.address_number,
            asaasCustomerId: s.asaas_customer_id,
            professor_id: s.professor_id,
            monthly_fee: s.monthly_fee,
            due_day: s.due_day,
            accepted_at: s.accepted_at,
            documentation_status: s.documentation_status,
            tenant_id: s.tenant_id,
            status: s.status,
            status_financial: s.status_financial,
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
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateStudent = async (formData: any) => {
    // Se estamos criando um novo aluno (sem ID)
    if (!editingStudent?.id) {
      try {
        const targetTenantId = tenantId || user?.tenantId;

        // 1. Verifica se já existe perfil com este email neste tenant
        const { data: existingInTenant } = await supabase
          .from('profiles')
          .select('id')
          .eq('email', formData.email)
          .eq('tenant_id', targetTenantId)
          .single();

        let finalStudentId = existingInTenant?.id;

        if (!finalStudentId) {
          // Cria o usuário na tabela Auth
          const { data: authData, error: authError } = await supabase.auth.signUp({
            email: formData.email,
            password: '123456',
          });

          if (authError) {
            if (authError.message.includes('already registered')) {
              // Tenta recuperar ID via RPC se já existir
              const { data: recoveredId, error: rpcError } = await supabase
                .rpc('get_user_id_by_email', { email_input: formData.email });

              if (rpcError || !recoveredId) {
                throw new Error("E-mail já cadastrado e não foi possível recuperar o ID.");
              }
              finalStudentId = recoveredId;
            } else {
              throw authError;
            }
          } else if (authData.user) {
            finalStudentId = authData.user.id;
          }
        }

        if (!finalStudentId) throw new Error("Não foi possível gerar ID para o aluno.");

        // Matrícula de dependente: cobrança no CPF do responsável (guardian).
        // O aluno tem perfil/login próprios; profiles.cpf fica NULL p/ não violar
        // profiles_cpf_tenant_key. O CPF de cobrança vai em guardian_cpf.
        const isDependent = !!formData.is_dependent;
        const guardianCpf = isDependent ? (formData.guardian_cpf?.replace(/\D/g, '') || null) : null;
        if (isDependent && !guardianCpf) {
          alert('Informe o CPF do responsável para matrícula de dependente.');
          return;
        }

        // Verifica consistência de CPF para evitar constraint duplicates.
        // Dependente NUNCA reusa o perfil do responsável pelo CPF.
        const studentCpf = isDependent ? null : (formData.cpf?.replace(/\D/g, '') || null);
        if (!isDependent && studentCpf && targetTenantId && !existingInTenant) {
          const { data: existingByCpf } = await supabase
            .from('profiles')
            .select('id')
            .eq('cpf', studentCpf)
            .eq('tenant_id', targetTenantId)
            .single();

          if (existingByCpf) {
            finalStudentId = existingByCpf.id;
          }
        }

        // Resolve o id do responsável: usa o que foi SELECIONADO no formulário
        // (responsável já cadastrado); senão tenta achar pelo CPF no tenant.
        let guardianId: string | null = isDependent ? (formData.guardian_id || null) : null;
        if (isDependent && !guardianId && guardianCpf && targetTenantId) {
          const { data: guardianProfile } = await supabase
            .from('profiles')
            .select('id')
            .eq('cpf', guardianCpf)
            .eq('tenant_id', targetTenantId)
            .maybeSingle();
          guardianId = guardianProfile?.id || null;
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
          email: formData.email,
          role: 'STUDENT',
          tenant_id: targetTenantId,
          module: formData.currentModuleStatus,
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
          professor_id: formData.professor_id || null,
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
          profilePayload.monthly_tuition = formData.monthly_fee;
          profilePayload.monthly_fee = formData.monthly_fee;
          profilePayload.fidelity_plan = formData.planDuration;
          profilePayload.due_day = formData.due_day || 10;
          profilePayload.status_financial = 'ACTIVE';
        }

        const { error: profileError } = await supabase.from('profiles').upsert(profilePayload);
        if (profileError) throw profileError;

        // --- INJEÇÃO NO ASAAS (Idêntico ao Mapa de Aulas) ---
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

            if (subResponse?.id || subResponse?.subscription_id) {
              const confirmedSubId = subResponse.id || subResponse.subscription_id;
              await supabase.from('profiles').update({
                subscription_id: confirmedSubId
              }).eq('id', finalStudentId);
              console.log("✅ Asaas Injetado com Sucesso. ID da assinatura:", confirmedSubId);
            }
          } catch (asaasErr) {
            console.error("⚠️ Erro ao injetar no Asaas (não bloqueante):", asaasErr);
          }
        }

        alert('Aluno criado com sucesso! Integramos com o financeiro Asaas (se aplicável). Senha padrão: 123456');
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
      const studentCpf = formData.cpf?.replace(/\D/g, '') || null;
      const contractSigned = !!(editingStudent.accepted_at || editingStudent.documentation_status === 'APPROVED');

      // Campos que podem sempre ser alterados
      const updatePayload: Record<string, any> = {
        interests: formData.interests,
        occupation: formData.occupation,
        phone: formData.phone,
        attendance_phone: formData.attendance_phone || null,
        meeting_link: formData.meeting_link,
        avatar_url: formData.img,
        fixed_schedule: formData.fixed_schedule,
        private_notes: formData.private_notes,
        professor_id: formData.professor_id,
        guardian_name: formData.guardian_name,
        guardian_phone: formData.guardian_phone,
        is_kids: formData.is_kids,
      };

      // Campos contratuais — só editáveis se o contrato ainda não foi assinado
      if (!contractSigned) {
        updatePayload.full_name = formData.name;
        updatePayload.module = formData.currentModuleStatus;
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

      if (contractSigned) {
        alert('Perfil atualizado! Os dados contratuais (valor, CPF, endereço, etc.) não foram alterados pois o contrato já foi assinado.');
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

  // Suspender (adormecido) ↔ reativar — usa o eixo canônico lifecycle_status via school-admin.
  // Ao suspender, a edge function cancela a assinatura no Asaas (para de gerar mensalidade).
  const handleToggleStatus = async (student: any) => {
    const makeInactive = !isInactive(student);
    const msg = makeInactive
      ? `Suspender ${student.name}?\n\nO aluno entra em modo ADORMECIDO: para de receber mensagens automáticas (aniversário, cobrança, lembrete) e a assinatura no Asaas é cancelada (não gera mais mensalidade). A dívida já vencida é mantida. Você pode reativar quando quiser.`
      : `Reativar ${student.name}?\n\nO aluno volta a receber as notificações automáticas normalmente.`;
    if (!window.confirm(msg)) return;
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
      setStudents(prev => prev.map(s => s.id === student.id ? { ...s, lifecycle_status: newLifecycle } : s));
    } catch (err: any) {
      alert('Erro ao alterar status do aluno: ' + (err.message || 'tente novamente.'));
    }
  };

  // Desligamento definitivo (offboard): tira do ecossistema, cancela assinatura Asaas e
  // anula as faturas FUTURAS — a dívida já vencida fica para cobrança. Reativável depois.
  const handleOffboard = async (student: any) => {
    const reason = window.prompt(
      `Desligar ${student.name} definitivamente?\n\nIsto cancela a assinatura no Asaas, anula as faturas FUTURAS (a dívida vencida é mantida) e remove o aluno de todas as automações. Pode ser reativado depois.\n\nMotivo do desligamento:`,
      ''
    );
    if (reason === null) return;
    try {
      const { data, error } = await supabase.functions.invoke('school-admin', {
        body: {
          action: 'setStudentLifecycle',
          studentId: student.id,
          status: 'offboarded',
          reason: reason || 'Desligado pela coordenação',
        },
      });
      if (error || (data && (data as any).ok === false)) {
        throw new Error(error?.message || (data as any)?.error || 'falha');
      }
      setStudents(prev => prev.map(s => s.id === student.id ? { ...s, lifecycle_status: 'offboarded' } : s));
      alert('Aluno desligado. Assinatura cancelada e faturas futuras anuladas.');
    } catch (err: any) {
      alert('Erro ao desligar aluno: ' + (err.message || 'tente novamente.'));
    }
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
              const canEdit = user?.role === UserRole.SCHOOL_ADMIN || user?.role === UserRole.SUPER_ADMIN;
              const inactive = isInactive(student);
              return (
              <div key={i} className={`group bg-brand-surface rounded-[2rem] border p-6 hover:shadow-2xl hover:shadow-slate-200/50 dark:hover:shadow-black/40 transition-all duration-300 relative overflow-hidden h-fit ${inactive ? 'border-slate-300 dark:border-slate-700 opacity-60 grayscale' : 'border-brand-border'}`}>

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
                      <span className="inline-flex items-center gap-1 text-[9px] font-black px-2 py-0.5 rounded-full bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300 mt-1"
                        title="Aluno inativo: dados mantidos, sem notificações automáticas">
                        <UserX size={10} /> INATIVO · SEM NOTIFICAÇÕES
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <div className="w-8 h-8 rounded-full bg-purple-100 dark:bg-purple-900/30 flex items-center justify-center text-purple-600 dark:text-purple-400 font-black text-xs">
                      {student.levelBadge}
                    </div>
                    {canEdit && (
                      <button
                        onClick={() => setEditingStudent({ ...student, meeting_link: student.meetingLink, fixed_schedule: student.fixed_schedule, private_notes: student.private_notes })}
                        className="w-8 h-8 rounded-full bg-tenant-primary/10 text-tenant-primary flex items-center justify-center hover:bg-tenant-primary hover:text-white transition-all shadow-sm"
                        title="Editar Perfil"
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
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-2">
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
                  </div>

                </div>

                {/* Footer */}
                <div className="mt-8 pt-6 border-t border-brand-border flex gap-2">
                  <button
                    className="flex-1 flex items-center justify-center gap-2 py-3 rounded-2xl bg-tenant-primary/10 text-tenant-primary text-xs font-black uppercase hover:bg-tenant-primary hover:text-white transition-colors"
                    onClick={() => setViewStudentId(student.id)}
                  >
                    <Eye size={14} /> Ver Ficha 360°
                  </button>
                  {canEdit && (
                    <button
                      className={`flex items-center justify-center px-4 py-3 rounded-2xl border text-xs font-black uppercase transition-colors ${inactive ? 'border-emerald-200 text-emerald-600 hover:bg-emerald-50 dark:border-emerald-900/40 dark:hover:bg-emerald-900/20' : 'border-amber-200 text-amber-600 hover:bg-amber-50 dark:border-amber-900/40 dark:hover:bg-amber-900/20'}`}
                      onClick={() => handleToggleStatus(student)}
                      title={inactive ? 'Reativar aluno (volta a receber notificações)' : 'Suspender aluno (adormecido: cancela Asaas, para notificações)'}
                    >
                      {inactive ? <UserCheck size={14} /> : <UserX size={14} />}
                    </button>
                  )}
                  {canEdit && student.lifecycle_status !== 'offboarded' && (
                    <button
                      className="flex items-center justify-center px-4 py-3 rounded-2xl border border-red-200 text-red-600 hover:bg-red-50 dark:border-red-900/40 dark:hover:bg-red-900/20 text-xs font-black uppercase transition-colors"
                      onClick={() => handleOffboard(student)}
                      title="Desligar definitivamente (cancela Asaas e anula faturas futuras)"
                    >
                      <AlertTriangle size={14} />
                    </button>
                  )}
                  {canEdit && (
                    <button
                      className="flex items-center justify-center gap-2 px-4 py-3 rounded-2xl border border-brand-border text-brand-muted text-xs font-black uppercase hover:bg-brand-surface-2 transition-colors"
                      onClick={() => setEditingStudent({ ...student, meeting_link: student.meetingLink, fixed_schedule: student.fixed_schedule, private_notes: student.private_notes })}
                      title="Editar Perfil Completo"
                    >
                      <Edit3 size={14} />
                    </button>
                  )}
                </div>

              </div>
              );
            })}
          </div>

          {!loading && filteredStudents.length === 0 && (
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
