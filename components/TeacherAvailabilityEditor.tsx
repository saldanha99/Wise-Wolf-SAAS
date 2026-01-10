
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

    // 1. Load Availability
    const { data: availData } = await supabase
      .from('availabilities')
      .select('*')
      .eq('teacher_id', teacherId);

    if (availData) {
      const loaded = new Set<string>();
      availData.forEach((item: any) => {
        const dayIdx = DAYS.indexOf(item.day_of_week);
        if (dayIdx === -1) return;

        if (typeof item.start_time === 'string') {
          const timeKey = item.start_time.substring(0, 5);
          loaded.add(`${dayIdx}-${timeKey}`);
        }
      });
      setAvailableSlots(loaded);
    }

    // 2. Load Bookings
    const { data: bookingsData } = await supabase
      .from('bookings')
      .select(`
          id, day_of_week, time_slot, type, module,
          student:student_id!inner(full_name, id, tenant_id, module, occupation, phone, meeting_link)
      `)
      .eq('teacher_id', teacherId)
      .eq('student.tenant_id', tenantId);

    if (bookingsData) {
      const newBookings: Record<string, any> = {};
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
              fullProfile: b.student
            };
          }
        }
      });
      setBookings(newBookings);
    }
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
        .from('availabilities')
        .delete()
        .eq('teacher_id', teacherId);

      if (availableSlots.size > 0) {
        const toInsert = Array.from(availableSlots).map(slotStr => {
          const slot = slotStr as string;
          const dashIdx = slot.indexOf('-');
          const dIdx = parseInt(slot.substring(0, dashIdx));
          const timeKey = slot.substring(dashIdx + 1);
          return {
            teacher_id: teacherId,
            day_of_week: DAYS[dIdx],
            start_time: timeKey
          };
        });

        const { error: insError } = await supabase.from('availabilities').insert(toInsert);
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
      const { error } = await supabase
        .from('profiles')
        .update({
          full_name: profileData.name,
          module: profileData.levelBadge,
          occupation: profileData.occupation,
          phone: profileData.phone,
          meeting_link: profileData.meeting_link
        })
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

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 w-full xl:w-auto">
          <div className="bg-white dark:bg-slate-800 p-4 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm flex flex-col justify-center">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Horas Ativas</span>
            <span className="text-xl font-bold text-slate-900 dark:text-white">{totalHours}h</span>
          </div>
          <div className="bg-white dark:bg-slate-800 p-4 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm flex flex-col justify-center">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Ocupação</span>
            <span className="text-xl font-bold text-purple-600">{occupancyRate}%</span>
          </div>
          <div className="bg-white dark:bg-slate-800 p-4 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm flex flex-col justify-center">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Potencial</span>
            <span className="text-xl font-bold text-emerald-600">R$ 2.4k</span>
          </div>
          <button
            onClick={() => { }}
            className="bg-slate-900 dark:bg-white text-white dark:text-slate-900 p-4 rounded-2xl text-[10px] font-black uppercase tracking-widest hover:opacity-90 transition-opacity flex flex-col items-center justify-center gap-1 shadow-lg"
          >
            <Sparkles size={14} className="text-amber-400" />
            Otimizar
          </button>
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-4 px-2">
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full bg-slate-900 dark:bg-white" />
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
      </div>

      {/* Main Calendar Container */}
      <div className="bg-white dark:bg-slate-900 rounded-[32px] border border-slate-200 dark:border-slate-800 shadow-[0px_4px_20px_rgba(0,0,0,0.02)] overflow-hidden flex flex-col h-[600px]">

        {/* Mobile Day Selector */}
        <div className="lg:hidden flex overflow-x-auto gap-2 p-4 border-b border-slate-100 dark:border-slate-800 scrollbar-hide snap-x">
          {DAYS.map((day, idx) => (
            <button
              key={day}
              onClick={() => setSelectedDay(idx)}
              className={`snap-center shrink-0 px-6 py-2 rounded-xl text-xs font-bold transition-all ${selectedDay === idx
                  ? 'bg-slate-900 dark:bg-white text-white dark:text-slate-900 shadow-md'
                  : 'bg-slate-50 dark:bg-slate-800 text-slate-500'
                }`}
            >
              {day}
            </button>
          ))}
        </div>

        {/* Scrollable Table Area */}
        <div className="flex-1 overflow-auto custom-scrollbar relative">
          <table className="w-full border-collapse">
            <thead className="sticky top-0 z-40 bg-white/90 dark:bg-slate-900/90 backdrop-blur-md border-b border-slate-100 dark:border-slate-800">
              <tr>
                <th className="p-4 w-20 text-center border-r border-slate-100 dark:border-slate-800">
                  <Clock size={16} className="text-slate-300 mx-auto" />
                </th>
                {DAYS.map((day, idx) => (
                  <th
                    key={day}
                    className={`p-4 min-w-[140px] text-left transition-all ${selectedDay !== idx ? 'hidden lg:table-cell' : 'table-cell'
                      }`}
                  >
                    <span className="text-xs font-bold text-slate-400 uppercase tracking-widest">{day}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50 dark:divide-slate-800">
              {TIMES.map((time) => (
                <tr key={time} className="group hover:bg-slate-50/50 dark:hover:bg-slate-800/20">
                  <td className="sticky left-0 bg-white dark:bg-slate-900 z-10 p-4 w-20 text-center text-xs font-bold text-slate-400 border-r border-slate-100 dark:border-slate-800 group-hover:bg-slate-50/50 dark:group-hover:bg-slate-800/20 transition-colors">
                    {time}
                  </td>
                  {DAYS.map((_, dayIdx) => {
                    const key = `${dayIdx}-${time}`;
                    const booking = bookings[key];
                    const isAvailable = availableSlots.has(key);

                    return (
                      <td
                        key={dayIdx}
                        className={`p-2 transition-all h-[80px] align-top ${selectedDay !== dayIdx ? 'hidden lg:table-cell' : 'table-cell'
                          }`}
                      >
                        {booking ? (
                          <div
                            onClick={() => setEditingProfile(booking)}
                            className="w-full h-full bg-slate-900 dark:bg-slate-800 rounded-xl p-2.5 cursor-pointer hover:scale-[1.02] transition-transform shadow-md shimmer relative overflow-hidden group/card"
                          >
                            <div className="relative z-10 flex flex-col justify-between h-full">
                              <div className="flex items-center gap-2">
                                <div className="w-5 h-5 rounded-md bg-white/10 flex items-center justify-center text-[9px] text-white font-bold">
                                  {booking.student[0]}
                                </div>
                                <span className="text-xs font-bold text-white truncate w-full">
                                  {booking.student.split(' ')[0]}
                                </span>
                              </div>
                              <span className="text-[9px] text-slate-400 font-medium uppercase tracking-wider truncate">
                                {booking.module} • {booking.type === 'REPOSIÇÃO' ? 'REPO' : 'FIXO'}
                              </span>
                            </div>
                          </div>
                        ) : (
                          <button
                            onClick={() => toggleSlot(dayIdx, time)}
                            className={`w-full h-full rounded-xl border border-dashed transition-all flex flex-col items-center justify-center gap-1 ${isAvailable
                                ? 'bg-emerald-50 dark:bg-emerald-900/10 border-emerald-200 dark:border-emerald-800 text-emerald-600 dark:text-emerald-400'
                                : 'border-slate-200 dark:border-slate-700 text-slate-300 hover:border-slate-300 dark:hover:border-slate-600 hover:bg-slate-50 dark:hover:bg-slate-800'
                              }`}
                          >
                            {isAvailable ? (
                              <>
                                <Check size={14} strokeWidth={3} />
                                <span className="text-[9px] font-bold uppercase tracking-widest">Livre</span>
                              </>
                            ) : (
                              <Plus size={14} className="opacity-0 group-hover:opacity-50 transition-opacity" />
                            )}
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
            className="bg-slate-900 dark:bg-white text-white dark:text-slate-900 px-8 py-3 rounded-xl text-xs font-bold uppercase tracking-widest hover:opacity-90 transition-all flex items-center gap-2 shadow-lg disabled:opacity-50"
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
          />
        </div>
      )}
    </div>
  );
};
export default TeacherAvailabilityEditor;
