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
  Plus
} from 'lucide-react';
import { MOCK_BOOKINGS } from '../constants';
import { Teacher, Reschedule } from '../types';
import { supabase } from '../lib/supabase';

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
  // ... (existing state)

  // ... (existing code)


  const [selectedTeacher, setSelectedTeacher] = useState<Teacher | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [isAllocating, setIsAllocating] = useState(false);
  const [isAssignmentModalOpen, setIsAssignmentModalOpen] = useState(false);
  const [bookings, setBookings] = useState<Record<string, any>>({});
  const [studentsList, setStudentsList] = useState<any[]>([]);
  const [availableSlots, setAvailableSlots] = useState<Set<string>>(new Set());
  const [editingBooking, setEditingBooking] = useState<any | null>(null);

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

    // 1. Fetch Bookings
    const { data: bookingsData } = await supabase
      .from('bookings')
      .select(`
              id, day_of_week, time_slot, type, module,
              student:student_id(full_name, id, tenant_id, module, occupation, phone, meeting_link)
          `)
      .eq('teacher_id', selectedTeacher.id);

    if (bookingsData) {
      const newBookings: Record<string, any> = {};
      bookingsData.forEach((b: any) => {
        const dayMap: Record<string, number> = {
          'Segunda': 0, 'Terça': 1, 'Quarta': 2, 'Quinta': 3, 'Sexta': 4, 'Sábado': 5
        };
        const dIdx = dayMap[b.day_of_week];
        if (typeof b.time_slot === 'string') {
          const timeKey = b.time_slot.substring(0, 5); // Ensure HH:mm format
          if (dIdx !== undefined) {
            const key = `${dIdx}-${timeKey}`;
            newBookings[key] = {
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
      setBookings(newBookings);
    }

    // 2. Fetch Availability
    const { data: availData } = await supabase
      .from('availabilities')
      .select('*')
      .eq('teacher_id', selectedTeacher.id);

    if (availData) {
      const newAvail = new Set<string>();
      availData.forEach((item: any) => {
        const dayMap: Record<string, number> = {
          'Segunda': 0, 'Terça': 1, 'Quarta': 2, 'Quinta': 3, 'Sexta': 4, 'Sábado': 5
        };
        const dIdx = dayMap[item.day_of_week];
        const timeKey = item.start_time.substring(0, 5);
        if (dIdx !== undefined) {
          newAvail.add(`${dIdx}-${timeKey}`);
        }
      });
      setAvailableSlots(newAvail);
    }

    // 3. Fetch Students
    const { data: stds } = await supabase.from('profiles').select('*').eq('role', 'STUDENT').eq('tenant_id', currentTenantId);
    if (stds) setStudentsList(stds);
  };

  useEffect(() => {
    fetchDetailData();
  }, [selectedTeacher]);

  const handleAssignmentSubmit = async (data: { studentId?: string; isNew: boolean; studentData?: any; days: string[]; timeSlot: string; module: string; startDate?: string }) => {
    if (!selectedTeacher) return;
    setIsAllocating(true);

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
              throw new Error("Este e-mail de aluno já está vinculado a outra escola. Use um e-mail diferente para manter o isolamento de dados.");
            }
            throw authError;
          }
          if (!authData.user) throw new Error("Erro ao criar usuário no Supabase Auth.");
          finalStudentId = authData.user.id;
        }

        // Generate a default meeting link (standard Google Meet format xxx-xxxx-xxx)
        const chars = 'abcdefghijklmnopqrstuvwxyz';
        const rnd = (len: number) => Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
        const meetingLink = `https://meet.google.com/${rnd(3)}-${rnd(4)}-${rnd(3)}`;

        // Create or Update Profile
        const { error: profileError } = await supabase.from('profiles').upsert({
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
          meeting_link: meetingLink
        });

        if (profileError) throw profileError;
      }

      if (!finalStudentId) throw new Error("ID do aluno não definido.");

      const dayMap: Record<string, number> = {
        'Segunda': 0, 'Terça': 1, 'Quarta': 2, 'Quinta': 3, 'Sexta': 4, 'Sábado': 5
      };

      // Check for conflicts
      const conflicts = data.days.filter(day => {
        const key = `${dayMap[day]}-${data.timeSlot}`;
        return !!bookings[key];
      });

      if (conflicts.length > 0) {
        alert(`Conflito: Já existe aluno alocado nos dias: ${conflicts.join(', ')} às ${data.timeSlot}.`);
        setIsAllocating(false);
        return;
      }

      // Insert bookings
      const toInsert = data.days.map(day => ({
        teacher_id: selectedTeacher.id,
        student_id: finalStudentId,
        day_of_week: day,
        time_slot: data.timeSlot,
        module: data.module,
        type: 'Individual',
        tenant_id: currentTenantId || selectedTeacher.tenantId,
        start_date: data.startDate
      }));

      const { error } = await supabase.from('bookings').insert(toInsert);
      if (error) throw error;

      await fetchDetailData();
      if (onRefresh) onRefresh();
      setIsAssignmentModalOpen(false);
      alert("Novo aluno e agendamentos criados com sucesso!");
    } catch (err: any) {
      alert("Erro ao atribuir aluno: " + err.message);
    } finally {
      setIsAllocating(false);
    }
  };

  const handleUpdateStudentProfile = async (profileData: any) => {
    if (!editingBooking?.studentId) return;

    try {
      const { error } = await supabase
        .from('profiles')
        .update({
          full_name: profileData.name,
          module: profileData.levelBadge,
          occupation: profileData.occupation,
          phone: profileData.phone,
          meeting_link: profileData.meeting_link
        })
        .eq('id', editingBooking.studentId);

      if (error) throw error;

      await fetchDetailData();
      setEditingBooking(null);
      alert("Perfil do aluno atualizado!");
    } catch (err: any) {
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

  const filteredTeachers = (teachers || []).filter(t => t.name.toLowerCase().includes(searchTerm.toLowerCase()));

  return (
    <div className="flex flex-col xl:flex-row gap-6 h-[calc(100vh-6rem)] animate-in fade-in duration-500 relative">
      {/* Sidebar: Teacher Selection */}
      <div className="w-full xl:w-72 bg-white dark:bg-slate-900 border border-gray-100 dark:border-slate-800 rounded-[2rem] flex flex-col shadow-sm">
        <div className="p-5 border-b dark:border-slate-800">
          <h3 className="font-black text-gray-800 dark:text-slate-100 text-[10px] uppercase tracking-widest mb-3 flex items-center gap-2">
            <Users size={14} className="text-tenant-primary" /> Corpo Docente
          </h3>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={12} />
            <input
              type="text"
              placeholder="Buscar..."
              className="w-full pl-9 pr-4 py-2 bg-gray-50 dark:bg-slate-800 border dark:border-slate-700 rounded-xl text-[10px] focus:ring-2 focus:ring-tenant-primary outline-none font-medium"
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-2 scrollbar-hide">
          {filteredTeachers.map((teacher) => (
            <button
              key={teacher.id}
              onClick={() => setSelectedTeacher(teacher)}
              className={`w-full p-3 rounded-xl border transition-all flex items-center gap-3 text-left group ${selectedTeacher?.id === teacher.id
                ? 'bg-tenant-primary border-tenant-primary text-white shadow-lg shadow-tenant-primary/20'
                : 'bg-white dark:bg-slate-900 border-gray-50 dark:border-slate-800 hover:border-tenant-primary/30'
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
      <div className="flex-1 bg-white dark:bg-slate-900 border border-gray-100 dark:border-slate-800 rounded-[2rem] flex flex-col shadow-sm overflow-hidden">
        {selectedTeacher ? (
          <>
            {/* Detail Header - Compact */}
            <div className="px-6 py-4 border-b dark:border-slate-800 flex justify-between items-center bg-gray-50/30 dark:bg-slate-800/20">
              <div className="flex items-center gap-4">
                <img src={selectedTeacher.avatar} className="w-12 h-12 rounded-xl shadow-md border-2 border-white dark:border-slate-700" alt="" />
                <div>
                  <h2 className="text-sm font-black text-gray-800 dark:text-slate-100 uppercase tracking-tight leading-none">{selectedTeacher.name}</h2>
                  <p className="text-[10px] text-gray-500 dark:text-slate-400 mt-1 font-bold">
                    Especialista em {selectedTeacher.module}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <button
                  onClick={() => setIsAssignmentModalOpen(true)}
                  className="px-4 py-2.5 bg-tenant-primary text-white rounded-xl font-black text-[10px] uppercase tracking-widest shadow-lg shadow-tenant-primary/20 hover:scale-[1.05] transition-all flex items-center gap-2"
                >
                  <UserPlus size={14} /> Atribuir Aluno
                </button>
                <div className="px-3 py-1.5 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-100 dark:border-yellow-900/30 rounded-lg flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse"></div>
                  <span className="text-[9px] font-black text-yellow-600 dark:text-yellow-400 uppercase tracking-wide">Reposições</span>
                </div>
              </div>
            </div>

            {/* Grid Content */}
            <div className="flex-1 overflow-auto p-4 scrollbar-hide relative">
              <div className="min-w-[700px]">
                <table className="w-full border-separate border-spacing-1">
                  <thead>
                    <tr>
                      <th className="w-14"></th>
                      {DAYS.map(day => (
                        <th key={day} className="p-2 text-[9px] text-gray-400 dark:text-slate-500 font-black uppercase tracking-[0.1em]">{day}</th>
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

                          return (
                            <td key={dIdx} className="h-12 relative">
                              {reschedule ? (
                                <div className="absolute inset-0 m-0.5 bg-yellow-50 dark:bg-yellow-900/10 border border-yellow-300 dark:border-yellow-600/50 rounded-xl p-1.5 flex flex-col justify-center shadow-sm z-10 animate-in zoom-in duration-300 cursor-help" title={`Reposição: ${reschedule.studentName}`}>
                                  <div className="flex items-center gap-1 mb-0.5">
                                    <Clock size={8} className="text-yellow-600 dark:text-yellow-400" />
                                    <span className="text-[7px] font-black text-yellow-600 dark:text-yellow-400 uppercase tracking-wider">Reposição</span>
                                  </div>
                                  <p className="text-[8px] font-black text-gray-800 dark:text-slate-200 truncate leading-tight">{reschedule.studentName}</p>
                                </div>
                              ) : booking ? (
                                <div
                                  onClick={() => setEditingBooking(booking)}
                                  className="w-full h-full bg-white dark:bg-slate-800 border-2 border-tenant-primary/80 rounded-xl p-1.5 flex flex-col justify-center hover:scale-[1.02] transition-transform cursor-pointer shadow-md group/booking"
                                >
                                  <p className="text-[7px] font-black text-gray-800 dark:text-slate-100 uppercase truncate leading-tight group-hover/booking:text-tenant-primary transition-colors">{booking.student}</p>
                                  <div className="flex justify-between items-center mt-0.5">
                                    <p className="text-[6px] font-bold text-tenant-primary uppercase">{booking.module}</p>
                                    <Plus size={8} className="text-gray-300 opacity-0 group-hover/booking:opacity-100 rotate-45" />
                                  </div>
                                </div>
                              ) : isAvailable ? (
                                <div className="w-full h-full bg-emerald-50/20 dark:bg-emerald-900/5 border border-dashed border-emerald-100 dark:border-emerald-800/20 rounded-xl flex items-center justify-center">
                                  <div className="w-1 h-1 rounded-full bg-emerald-200 dark:bg-emerald-900/40" />
                                </div>
                              ) : (
                                <div className="w-full h-full bg-gray-50/30 dark:bg-slate-800/20 rounded-xl flex items-center justify-center">
                                  <div className="w-1 h-1 rounded-full bg-gray-100 dark:bg-slate-700" />
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
          <div className="flex-1 flex flex-col items-center justify-center text-gray-300 dark:text-slate-600">
            <Users size={32} className="mb-3 opacity-50" />
            <p className="text-xs font-bold">Selecione um professor</p>
          </div>
        )}
      </div>

      {/* Assignment Modal */}
      {isAssignmentModalOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-300">
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
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-300">
          <StudentProfileForm
            initialData={{
              name: editingBooking.student,
              levelBadge: editingBooking.module,
              ...editingBooking.fullProfile
            }}
            onSubmit={handleUpdateStudentProfile}
            onCancel={() => setEditingBooking(null)}
            onDelete={(user?.role === 'SCHOOL_ADMIN' || user?.role === 'SUPER_ADMIN') ? handleDeleteBooking : undefined}
            title="Gerenciar Alocação"
          />
        </div>
      )}
    </div>
  );
};

export default TeacherScheduleExplorer;
