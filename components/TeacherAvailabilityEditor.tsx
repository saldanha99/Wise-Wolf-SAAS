
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
  Plus
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import StudentProfileForm from './StudentProfileForm';

const DAYS = ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
const TIMES = Array.from({ length: 37 }, (_, i) => {
  const hour = Math.floor(i / 2) + 6;
  const minutes = (i % 2 === 0) ? '00' : '30';
  if (hour === 24) return '00:00';
  return `${hour < 10 ? '0' + hour : hour}:${minutes}`;
});

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

  const loadData = async () => {
    if (!teacherId || !tenantId) return;

    // 1. Load Availability (New Table)
    const { data: availData } = await supabase
      .from('teacher_availability')
      .select('*')
      .eq('teacher_id', teacherId);

    if (availData) {
      const loaded = new Set<string>();
      availData.forEach((item: any) => {
        // DB uses Integer: 1=Mon, 6=Sat
        // Editor uses Index: 0=Mon, 5=Sat
        // So Editor Index = DB - 1
        const dayIdx = item.day_of_week - 1;

        if (dayIdx >= 0 && dayIdx < DAYS.length) {
          if (typeof item.start_time === 'string') {
            const timeKey = item.start_time.substring(0, 5);
            loaded.add(`${dayIdx}-${timeKey}`);
          }
        }
      });
      setAvailableSlots(loaded);
    }

    // 2. Load Bookings (Fixed Students)
    const { data: bookingsData } = await supabase
      .from('bookings')
      .select(`
          id, day_of_week, time_slot, type, module,
          student:student_id!inner(full_name, id, tenant_id, module, occupation, phone, meeting_link)
      `)
      .eq('teacher_id', teacherId)
      .eq('student.tenant_id', tenantId);

    // 3. Load Experimental Appointments (New)
    // We fetch future experimental/scheduled appointments for this professor
    const { data: appointmentsData } = await supabase
      .from('appointments')
      .select('id, start_time, student_name, student_phone, type, status')
      .eq('teacher_id', teacherId) // Standardised to teacher_id
      .eq('type', 'experimental')
      .in('status', ['scheduled', 'confirmed']); // Adjust status as needed based on ClaimOpportunity

    const newBookings: Record<string, any> = {};

    // Process Fixed Bookings
    if (bookingsData) {
      bookingsData.forEach((b: any) => {
        const dIdx = DAYS.indexOf(b.day_of_week);
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
            type: 'EXPERIMENTAL',
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
      await supabase
        .from('teacher_availability')
        .delete()
        .eq('teacher_id', teacherId);

      if (availableSlots.size > 0) {
        const toInsert = Array.from(availableSlots).map(slotStr => {
          const slot = slotStr as string;
          const dashIdx = slot.indexOf('-');
          const dIdx = parseInt(slot.substring(0, dashIdx));
          const timeKey = slot.substring(dashIdx + 1);
          // DB Integer: Mon=1, Sat=6
          // Editor Index: Mon=0, Sat=5
          // So DB = Index + 1
          return {
            teacher_id: teacherId,
            tenant_id: tenantId,
            day_of_week: dIdx + 1,
            start_time: timeKey
          };
        });

        const { error: insError } = await supabase.from('teacher_availability').insert(toInsert);
        if (insError) throw insError;
      }

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
        professor_id: profileData.professor_id
      };

      if (profileData.monthly_fee !== undefined) updates.monthly_tuition = profileData.monthly_fee;
      if (profileData.due_day !== undefined) updates.due_day = profileData.due_day;
      if (profileData.status_financial !== undefined) updates.status_financial = profileData.status_financial;
      if (profileData.planDuration !== undefined) updates.fidelity_plan = profileData.planDuration;

      const { error } = await supabase
        .from('profiles')
        .update(updates)
        .eq('id', editingProfile.studentId);

      if (error) throw error;

      await loadData();
      setEditingProfile(null);
      alert("Perfil do aluno atualizado!");
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

  const bookedCount = Object.keys(bookings).length;
  const availableCount = availableSlots.size;
  const totalHours = bookedCount + availableCount;
  const occupancyRate = Math.round((bookedCount / (bookedCount + availableCount || 1)) * 100);

  return (
    <div className="space-y-6 md:space-y-8 animate-in fade-in duration-700 font-sans">

      {/* Header & Stats */}
      <div className="flex flex-col xl:flex-row justify-between items-start xl:items-end gap-6">
        <div>
          <h2 className="text-2xl font-bold text-slate-900 dark:text-white">Gestão de Horários</h2>
          <p className="text-slate-500 dark:text-slate-400 text-sm mt-1">
            Defina sua disponibilidade semanal para receber novos alunos.
          </p>
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-4 px-2">
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full bg-tenant-primary text-white" />
          <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">Ocupado / Aula</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
          <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">Livre (Disponível)</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full bg-slate-200 dark:bg-slate-700" />
          <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">Indisponível</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full bg-indigo-600" />
          <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">Experimental</span>
        </div>
      </div>

      {/* Main Calendar Container */}
      <div className="bg-white dark:bg-slate-900 rounded-[32px] border border-slate-200 dark:border-slate-800 shadow-[0px_4px_20px_rgba(0,0,0,0.02)] overflow-hidden flex flex-col h-[calc(100vh-220px)]">

        {/* Mobile Day Selector */}
        <div className="lg:hidden flex overflow-x-auto gap-2 p-4 border-b border-slate-100 dark:border-slate-800 scrollbar-hide snap-x">
          {DAYS.map((day, idx) => (
            <button
              key={day}
              onClick={() => setSelectedDay(idx)}
              className={`snap-center shrink-0 px-6 py-2 rounded-xl text-xs font-bold transition-all ${selectedDay === idx
                ? 'bg-tenant-primary text-white shadow-md'
                : 'bg-slate-50 dark:bg-slate-800/50 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors'
                }`}
            >
              {day}
            </button>
          ))}
        </div>

        {/* Scrollable Table Area */}
        <div className="flex-1 overflow-auto custom-scrollbar relative">
          <table className="w-full border-collapse">
            <thead className="sticky top-0 z-40 bg-white/90 dark:bg-slate-900/95 backdrop-blur-md border-b border-slate-100 dark:border-slate-800 shadow-sm">
              <tr>
                <th className="p-4 w-20 text-center border-r border-slate-100 dark:border-slate-800">
                  <Clock size={16} className="text-slate-400 dark:text-slate-500 mx-auto" />
                </th>
                {DAYS.map((day, idx) => (
                  <th
                    key={day}
                    className={`p-4 min-w-[140px] text-center transition-all ${selectedDay !== idx ? 'hidden lg:table-cell' : 'table-cell'
                      }`}
                  >
                    <span className="text-xs font-black text-slate-500 dark:text-slate-300 uppercase tracking-widest">{day}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50 dark:divide-slate-800/50">
              {TIMES.map((time) => (
                <tr key={time} className="group hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-colors">
                  <td className="sticky left-0 bg-white dark:bg-slate-900 z-10 p-2 w-16 text-center text-[10px] font-bold text-slate-400 dark:text-slate-500 border-r border-slate-100 dark:border-slate-800 group-hover:bg-slate-50/50 dark:group-hover:bg-slate-800/30 transition-colors">
                    {time}
                  </td>
                  {DAYS.map((_, dayIdx) => {
                    const key = `${dayIdx}-${time}`;
                    const booking = bookings[key];
                    const isAvailable = availableSlots.has(key);

                    return (
                      <td
                        key={dayIdx}
                        className={`p-1.5 transition-all h-12 align-top ${selectedDay !== dayIdx ? 'hidden lg:table-cell' : 'table-cell'
                          }`}
                      >
                        {booking ? (
                          <div
                            onClick={() => setEditingProfile(booking)}
                            className={`w-full h-full rounded-md px-2 flex items-center justify-between cursor-pointer hover:scale-[1.02] transition-transform shadow-sm relative overflow-hidden group/card ${booking.isExperimental
                              ? 'bg-indigo-600 text-white'
                              : booking.type === 'REPOSIÇÃO'
                                ? 'bg-amber-400 text-amber-950' // YELLOW for Reposition
                                : 'bg-emerald-500 text-white'   // GREEN for Class
                              }`}
                          >
                            <div className="flex items-center gap-1.5 overflow-hidden">
                              <div className={`w-4 h-4 rounded-full flex-shrink-0 flex items-center justify-center text-[8px] font-bold ${booking.type === 'REPOSIÇÃO' ? 'bg-amber-200 text-amber-900' : 'bg-white/20 text-white'
                                }`}>
                                {booking.student[0]}
                              </div>
                              <span className="text-[10px] font-bold truncate">
                                {booking.student.split(' ')[0]}
                              </span>
                              {booking.isExperimental && booking.dateLabel && (
                                <span className="text-[8px] opacity-70 font-medium">{booking.dateLabel}</span>
                              )}
                            </div>
                            {/* Only show badge if space permits or on hover */}
                            {booking.isExperimental && <span className="text-[8px] font-black opacity-80">EXP</span>}
                            {!booking.isExperimental && booking.type === 'REPOSIÇÃO' && <span className="text-[8px] font-black opacity-80">REPO</span>}
                          </div>
                        ) : (
                          <button
                            onClick={() => toggleSlot(dayIdx, time)}
                            className={`w-full h-full rounded-md border border-dashed transition-all flex flex-col items-center justify-center gap-1 ${isAvailable
                              ? 'bg-emerald-50 dark:bg-emerald-900/10 border-emerald-400 dark:border-emerald-500/50 hover:bg-emerald-100 dark:hover:bg-emerald-900/20' 
                              : 'bg-transparent border-slate-200 dark:border-slate-800 hover:border-tenant-primary/50 hover:bg-slate-50 dark:hover:bg-slate-800/50' 
                              }`}
                          >
                            {isAvailable && <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />}
                          </button>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Action Footer */}
        <div className="p-4 border-t border-slate-100 dark:border-slate-800 bg-white dark:bg-slate-900 sticky bottom-0 z-30 flex justify-between items-center">
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <RefreshCw size={12} />
            <span>Alterações não salvas são perdidas ao sair.</span>
          </div>
          <button
            onClick={handlePublish}
            disabled={isPublishing}
            className="bg-tenant-primary text-white px-8 py-3 rounded-xl text-xs font-bold uppercase tracking-widest hover:opacity-90 transition-all flex items-center gap-2 shadow-lg disabled:opacity-50"
          >
            {isPublishing ? <RefreshCw className="animate-spin" size={16} /> : <Save size={16} />}
            Salvar Agenda
          </button>
        </div>
      </div>

      {editingProfile && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-300">
          <StudentProfileForm
            initialData={{
              name: editingProfile.student,
              levelBadge: editingProfile.module,
              ...editingProfile.fullProfile
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
