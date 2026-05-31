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
import { MOCK_BOOKINGS, TEACHER_SPECIALIZATIONS } from '../constants';
import { Teacher, Reschedule } from '../types';
import { supabase } from '../lib/supabase';
import { asaasService } from '../services/asaasService';

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

    // 1. Fetch Bookings, Availability and Trials in Parallel
    const [bookingsRes, availRes, trialsRes, stdsRes] = await Promise.all([
      supabase
        .from('bookings')
        .select('id, day_of_week, time_slot, type, module, student:student_id(full_name, id, tenant_id, module, occupation, phone, meeting_link)')
        .eq('teacher_id', selectedTeacher.id),
      supabase
        .from('teacher_availability')
        .select('*')
        .eq('teacher_id', selectedTeacher.id),
      supabase
        .from('appointments')
        .select('*')
        .eq('teacher_id', selectedTeacher.id)
        .eq('type', 'experimental'),
      supabase
        .from('profiles')
        .select('*')
        .eq('role', 'STUDENT')
        .eq('tenant_id', currentTenantId)
    ]);

    const newBookings: Record<string, any> = {};
    const conflictKeys = new Set<string>();

    if (bookingsRes.data) {
      bookingsRes.data.forEach((b: any) => {
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
              student: b.student?.full_name || 'Aluno',
              module: b.student?.module || b.module || 'Gen',
              type: b.type,
              avatar: `https://ui-avatars.com/api/?name=${b.student?.full_name}`,
              fullProfile: b.student
            };
          }
        }
      });
    }

    if (trialsRes.data) {
      trialsRes.data.forEach((t: any) => {
        const dateObj = new Date(t.date);
        const day = dateObj.getDay(); 
        const dIdx = day === 0 ? -1 : day - 1; 

        if (dIdx >= 0 && dIdx <= 5 && t.time) {
          const timeKey = t.time.substring(0, 5);
          newBookings[`${dIdx}-${timeKey}`] = {
            id: `trial-${t.id}`,
            student: t.student_name || 'Aula Experimental',
            module: 'TRIAL',
            type: 'AULA EXPERIMENTAL',
            isTrial: true
          };
        }
      });
    }

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
            const { data: publicUrlData } = supabase.storage.from('contracts').getPublicUrl(fileName);
            contractUrl = publicUrlData.publicUrl;
          }
        }

        // Generate a default meeting link
        const chars = 'abcdefghijklmnopqrstuvwxyz';
        const rnd = (len: number) => Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
        const meetingLink = `https://meet.google.com/${rnd(3)}-${rnd(4)}-${rnd(3)}`;

        // Check for existing profile by CPF+tenant BEFORE upsert (unique constraint: profiles_cpf_tenant_key)
        const studentCpf = data.studentData.cpf?.replace(/\D/g, '') || null;
        if (studentCpf && targetTenantId) {
          const { data: existingByCpf } = await supabase
            .from('profiles')
            .select('id')
            .eq('cpf', studentCpf)
            .eq('tenant_id', targetTenantId)
            .single();

          if (existingByCpf) {
            // A profile with this CPF already exists in this tenant — reuse it
            finalStudentId = existingByCpf.id;
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
          profilePayload.monthly_tuition = data.financial.price;
          profilePayload.monthly_fee = data.financial.price; // Billing page reads this column
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

      // Insert bookings with Rollback
      const toInsert = data.schedule.map(item => ({
        teacher_id: selectedTeacher.id,
        student_id: finalStudentId,
        day_of_week: item.day,
        time_slot: item.time,
        module: data.module,
        type: 'Individual',
        tenant_id: currentTenantId || selectedTeacher.tenantId,
        start_date: data.startDate
      }));

      const { error } = await supabase.from('bookings').insert(toInsert);

      if (error) {
        // ROLLBACK: If booking fails and we just created the student, delete the profile
        if (data.isNew && finalStudentId) {
          console.error("Booking failed. Rolling back created student profile...", error);
          await supabase.from('profiles').delete().eq('id', finalStudentId);
        }
        throw error;
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
          const instanceName = selectedTeacher.tenantId === currentTenantId
            ? `prof-${selectedTeacher.name.split(' ')[0].toLowerCase()}-${selectedTeacher.id.substring(0, 4)}`
            : 'wise-wolf';

          const scheduleStr = data.schedule.map(s => `${s.day} às ${s.time}`).join(', ');

          fetch('https://dvalxbtngopxopzcbfdm.supabase.co/functions/v1/send-class-notification', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY}`
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
      const updates: any = {
        full_name: profileData.name,
        module: profileData.levelBadge,
        occupation: profileData.occupation,
        phone: profileData.phone,
        meeting_link: profileData.meeting_link,
        cpf: profileData.cpf,
        address: profileData.address,
        address_number: profileData.addressNumber,
        postal_code: profileData.postalCode,
        interests: profileData.interests,
        private_notes: profileData.private_notes,
        fixed_schedule: profileData.fixed_schedule,
        correction_preference: profileData.correctionPreference,
        // Professor Link
        professor_id: profileData.professor_id
      };

      // Only update financial data if present and user has permission (implicit by checking if fields exist in data)
      // Since StudentProfileForm only shows these fields to Directors, we can trust the data if present,
      // but RLS will ultimately block it if unauthorized.
      if (profileData.monthly_fee !== undefined) updates.monthly_tuition = profileData.monthly_fee;
      if (profileData.due_day !== undefined) updates.due_day = profileData.due_day;
      if (profileData.status_financial !== undefined) updates.status_financial = profileData.status_financial;
      if (profileData.planDuration !== undefined) updates.fidelity_plan = profileData.planDuration;

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

  const getRescheduleForSlot = (dayIdx: number, hour: number | string) => {
    if (!reschedules) return null;
    return reschedules.find(r => {
      let dateObj: Date;
      if (r.date.includes('/')) {
        const parts = r.date.split('/');
        dateObj = new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
      } else {
        dateObj = new Date(r.date);
      }
      const rDay = dateObj.getDay();
      const mappedDayIdx = rDay === 0 ? -1 : rDay - 1;
      if (mappedDayIdx !== dayIdx) return false;

      const timeStr = typeof hour === 'number' ? `${hour}:00` : hour;
      return (r as any).time ? (r as any).time.startsWith(timeStr.substring(0, 5)) : hour === 14;
    });
  };

  const filteredTeachers = (teachers || []).filter(t => {
    const matchesSearch = t.name.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesSpec = !specFilter || (t.specializations || []).includes(specFilter);
    return matchesSearch && matchesSpec;
  });

  return (
    <div className="flex flex-col xl:flex-row gap-6 h-[calc(100vh-6rem)] animate-in fade-in duration-500 relative">
      {/* Sidebar: Teacher Selection */}
      <div className="w-full xl:w-72 bg-brand-surface border border-gray-100 dark:border-brand-border rounded-[2rem] flex flex-col shadow-sm">
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

        <div className="flex-1 overflow-y-auto p-3 space-y-2 scrollbar-hide">
          {filteredTeachers.map((teacher) => (
            <button
              key={teacher.id}
              onClick={() => setSelectedTeacher(teacher)}
              className={`w-full p-3 rounded-xl border transition-all flex items-center gap-3 text-left group ${selectedTeacher?.id === teacher.id
                ? 'bg-tenant-primary border-tenant-primary text-white shadow-lg shadow-tenant-primary/20'
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
      <div className="flex-1 bg-brand-surface border border-gray-100 dark:border-brand-border rounded-[2rem] flex flex-col shadow-sm overflow-hidden">
        {selectedTeacher ? (
          <>
            {/* Detail Header - Compact */}
            <div className="px-6 py-4 border-b dark:border-brand-border flex justify-between items-center bg-gray-50/30 dark:bg-brand-surface-2/20">
              <div className="flex items-center gap-4">
                <img src={selectedTeacher.avatar} className="w-12 h-12 rounded-xl shadow-md border-2 border-white dark:border-brand-border" alt="" />
                <div>
                  <h2 className="text-sm font-black text-gray-800 dark:text-slate-100 uppercase tracking-tight leading-none">{selectedTeacher.name}</h2>
                  <p className="text-[10px] text-gray-500 dark:text-brand-muted mt-1 font-bold">
                    {selectedTeacher.module}
                  </p>
                  {(selectedTeacher.specializations || []).length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {(selectedTeacher.specializations || []).map(s => (
                        <span key={s} className="px-2 py-0.5 bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400 text-[8px] font-black rounded-full border border-amber-100 dark:border-amber-800">
                          {s}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-3 flex-wrap justify-end">
                {/* Ocupação + alunos distintos + conflitos */}
                {(() => {
                  const occupied = Object.keys(bookings).length;
                  const free = Array.from(availableSlots).filter(k => !bookings[k]).length;
                  const denom = occupied + free;
                  const pct = denom > 0 ? Math.round(100 * occupied / denom) : 0;
                  const distinct = new Set(Object.values(bookings).map((b: any) => b.studentId || b.student)).size;
                  return (
                    <>
                      <div className="px-3 py-1.5 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-100 dark:border-emerald-900/30 rounded-lg text-center">
                        <p className="text-[8px] font-black text-emerald-600 uppercase tracking-wide">Ocupação</p>
                        <p className="text-sm font-black text-emerald-700 dark:text-emerald-400 leading-none">{pct}%</p>
                      </div>
                      <div className="px-3 py-1.5 bg-brand-surface-2 border border-brand-border rounded-lg text-center">
                        <p className="text-[8px] font-black text-brand-muted uppercase tracking-wide">Aulas · Alunos</p>
                        <p className="text-sm font-black text-brand-text leading-none">{occupied} · {distinct}</p>
                      </div>
                      {conflicts.size > 0 && (
                        <div className="px-3 py-1.5 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-900/40 rounded-lg text-center" title="Horários com mais de um aluno">
                          <p className="text-[8px] font-black text-red-600 uppercase tracking-wide">Conflitos</p>
                          <p className="text-sm font-black text-red-600 leading-none">{conflicts.size}</p>
                        </div>
                      )}
                    </>
                  );
                })()}
                <input
                  value={slotSearch}
                  onChange={e => setSlotSearch(e.target.value)}
                  placeholder="Localizar aluno na grade…"
                  className="px-3 py-2 text-[11px] font-bold bg-brand-surface-2 border border-brand-border rounded-lg outline-none text-brand-text w-44"
                />
                <button
                  onClick={() => setIsAssignmentModalOpen(true)}
                  className="px-4 py-2.5 bg-tenant-primary text-white rounded-xl font-black text-[10px] uppercase tracking-widest shadow-lg shadow-tenant-primary/20 hover:scale-[1.05] transition-all flex items-center gap-2"
                >
                  <UserPlus size={14} /> Atribuir Aluno
                </button>
              </div>
            </div>

            {/* Grid Content */}
            <div className="flex-1 overflow-auto p-4 scrollbar-hide relative">
              {/* MOBILE: lista por dia (a grade larga é inviável no celular) */}
              <div className="md:hidden space-y-3">
                {DAYS.map((day, dIdx) => {
                  const dayBookings = TIMES
                    .map(time => ({ time, b: bookings[`${dIdx}-${time}`], conflict: conflicts.has(`${dIdx}-${time}`) }))
                    .filter(x => x.b);
                  return (
                    <div key={day} className="bg-brand-surface-2/40 border border-brand-border rounded-xl p-3">
                      <p className="text-[10px] font-black text-brand-muted uppercase tracking-widest mb-2">{day} · {dayBookings.length} aula(s)</p>
                      {dayBookings.length === 0 ? (
                        <p className="text-[11px] text-brand-muted italic">Sem aulas</p>
                      ) : (
                        <div className="space-y-1.5">
                          {dayBookings.map(({ time, b, conflict }) => {
                            const match = slotSearch.trim() !== '' && (b.student || '').toLowerCase().includes(slotSearch.toLowerCase());
                            const dim = slotSearch.trim() !== '' && !match;
                            return (
                              <div key={time} onClick={() => !b.isTrial && setEditingBooking(b)}
                                className={`flex items-center gap-2 rounded-lg px-2.5 py-2 cursor-pointer ${b.isTrial ? 'bg-purple-600 text-white' : 'bg-emerald-500 text-white'} ${conflict ? 'ring-2 ring-red-400' : ''} ${match ? 'ring-2 ring-yellow-300' : ''} ${dim ? 'opacity-30' : ''}`}>
                                <span className="text-[10px] font-mono font-bold w-10 shrink-0">{time}</span>
                                <span className="text-[11px] font-black uppercase truncate flex-1">{b.student}</span>
                                <span className="text-[9px] font-bold opacity-80">{b.module}</span>
                              </div>
                            );
                          })}
                        </div>
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
                      {DAYS.map(day => (
                        <th key={day} className="p-2 text-[9px] text-gray-400 dark:text-brand-muted font-black uppercase tracking-[0.1em]">{day}</th>
                      ))}
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
                          const isConflict = conflicts.has(key);
                          const matchSearch = slotSearch.trim() !== '' && booking && (booking.student || '').toLowerCase().includes(slotSearch.toLowerCase());
                          const dimmed = slotSearch.trim() !== '' && booking && !matchSearch;

                          return (
                            <td key={dIdx} className="h-8 relative">
                              {reschedule ? (
                                <div className="absolute inset-0 m-0.5 bg-yellow-100 dark:bg-yellow-900/30 border border-yellow-400 dark:border-yellow-600 rounded-md p-1 flex flex-col justify-center shadow-sm z-10 cursor-help group/reschedule" title={`Reposição: ${reschedule.studentName}`}>
                                  <div className="flex items-center gap-1">
                                    <Clock size={8} className="text-yellow-700 dark:text-yellow-400" />
                                    <span className="text-[7px] font-black text-yellow-700 dark:text-yellow-400 uppercase tracking-wider truncate">Reposição</span>
                                  </div>
                                  <p className="text-[7px] font-bold text-yellow-800 dark:text-yellow-200 truncate leading-none mt-0.5">{reschedule.studentName}</p>
                                </div>
                              ) : booking ? (
                                <div
                                  onClick={() => !booking.isTrial && setEditingBooking(booking)}
                                  className={`w-full h-full border rounded-md p-1 flex flex-col justify-center transition-all cursor-pointer shadow-md group/booking ${booking.isTrial
                                    ? 'bg-purple-600 dark:bg-purple-700 border-purple-700 dark:border-purple-600 animate-pulse hover:scale-105'
                                    : 'bg-emerald-500 dark:bg-emerald-600 border-emerald-600 dark:border-emerald-500 hover:scale-[1.02]'} ${isConflict ? 'ring-2 ring-red-500' : ''} ${matchSearch ? 'ring-2 ring-yellow-300 scale-105 z-10' : ''} ${dimmed ? 'opacity-20' : ''}`}
                                >
                                  <div className="flex items-center gap-1 overflow-hidden">
                                     {booking.isTrial && <Zap size={6} className="text-white fill-current shrink-0" />}
                                     <p className="text-[7px] font-black text-white uppercase truncate leading-tight">{booking.student}</p>
                                  </div>
                                  <div className="flex justify-between items-center mt-0.5">
                                    <p className="text-[6px] font-bold text-emerald-100 uppercase">{booking.module}</p>
                                  </div>
                                </div>
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
              name: editingBooking.student,
              levelBadge: editingBooking.module,
              ...editingBooking.fullProfile
            }}
            onSubmit={handleUpdateStudentProfile}
            onCancel={() => setEditingBooking(null)}
            onDelete={(user?.role === 'SCHOOL_ADMIN' || user?.role === 'SUPER_ADMIN') ? handleDeleteBooking : undefined}
            currentUserRole={user?.role}
            title="Gerenciar Alocação"
          />
        </div>
      )}
    </div>
  );
};

export default TeacherScheduleExplorer;
