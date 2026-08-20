
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
import { nullableUuid } from '../lib/dbValues';
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
          student:student_id!inner(
            full_name, id, tenant_id, module, occupation, phone, meeting_link,
            interests, private_notes, fixed_schedule, professor_id, avatar_url
          )
      `)
      .eq('teacher_id', teacherId)
      .eq('status', 'SCHEDULED')
      .eq('student.tenant_id', tenantId);

    // 3. Load Experimental Appointments (New)
    // We fetch future experimental/scheduled appointments for this professor
    const { data: appointmentsData } = await supabase
      .from('appointments')
      .select('id, start_time, student_name, student_phone, type, status')
      .eq('professor_id', teacherId)
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
      const loadedProfile = editingProfile.fullProfile || {};
      const updates: any = {};
      const setIfLoaded = (column: string, value: unknown) => {
        if (Object.prototype.hasOwnProperty.call(loadedProfile, column)) {
          updates[column] = value;
        }
      };

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
      <div className="flex flex-col xl:flex-row justify-between items-start xl:items-end gap-6 bg-brand-surface border border-brand-border p-6 rounded-3xl shadow-sm">
        <div>
          <h2 className="text-2xl font-[family-name:var(--font-display)] font-extrabold text-brand-text">Gestão de Horários</h2>
          <p className="text-brand-muted text-sm mt-1 font-medium">
            Defina sua disponibilidade semanal para receber novos alunos.
          </p>
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-4 px-2">
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full bg-brand-accent shadow-[0_0_8px_rgba(var(--brand-accent),0.8)]" />
          <span className="text-xs font-bold text-brand-muted uppercase tracking-wider">Ocupado / Aula</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.8)]" />
          <span className="text-xs font-bold text-brand-muted uppercase tracking-wider">Livre (Disponível)</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full bg-brand-border" />
          <span className="text-xs font-bold text-brand-muted uppercase tracking-wider">Indisponível</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full bg-indigo-500 shadow-[0_0_8px_rgba(99,102,241,0.8)]" />
          <span className="text-xs font-bold text-brand-muted uppercase tracking-wider">Experimental</span>
        </div>
      </div>

      {/* Main Calendar Container */}
      <div className="bg-brand-surface rounded-[32px] border border-brand-border shadow-[0px_4px_20px_rgba(0,0,0,0.2)] overflow-hidden flex flex-col h-[calc(100vh-250px)]">

        {/* Mobile Day Selector */}
        <div className="lg:hidden flex overflow-x-auto gap-2 p-4 border-b border-brand-border custom-scrollbar snap-x">
          {DAYS.map((day, idx) => (
            <button
              key={day}
              onClick={() => setSelectedDay(idx)}
              className={`snap-center shrink-0 px-6 py-2 rounded-xl text-xs font-bold transition-all ${selectedDay === idx
                ? 'bg-brand-accent text-white shadow-[0_0_15px_rgba(var(--brand-accent),0.4)]'
                : 'bg-brand-surface-2 text-brand-muted hover:bg-brand-surface-2 hover:text-brand-text transition-colors'
                }`}
            >
              {day}
            </button>
          ))}
        </div>

        {/* Scrollable Table Area */}
        <div className="flex-1 overflow-auto custom-scrollbar relative">
          <table className="w-full border-collapse">
            <thead className="sticky top-0 z-40 bg-brand-surface/95 backdrop-blur-md border-b border-brand-border shadow-sm">
              <tr>
                <th className="p-4 w-20 text-center border-r border-brand-border">
                  <Clock size={16} className="text-brand-muted mx-auto" />
                </th>
                {DAYS.map((day, idx) => (
                  <th
                    key={day}
                    className={`p-4 min-w-[140px] text-center transition-all border-l border-brand-border/50 ${selectedDay !== idx ? 'hidden lg:table-cell' : 'table-cell'
                      }`}
                  >
                    <span className="text-xs font-black text-brand-text uppercase tracking-widest">{day}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-brand-border/50 bg-brand-bg/30">
              {TIMES.map((time) => (
                <tr key={time} className="group hover:bg-brand-surface-2 transition-colors">
                  <td className="sticky left-0 bg-brand-surface z-10 p-2 w-20 text-center text-[10px] font-bold text-brand-muted border-r border-brand-border group-hover:bg-brand-surface-2 transition-colors font-mono">
                    {time}
                  </td>
                  {DAYS.map((_, dayIdx) => {
                    const key = `${dayIdx}-${time}`;
                    const booking = bookings[key];
                    const isAvailable = availableSlots.has(key);

                    return (
                      <td
                        key={dayIdx}
                        className={`p-1 transition-all h-14 align-top border-l border-brand-border/50 ${selectedDay !== dayIdx ? 'hidden lg:table-cell' : 'table-cell'
                          }`}
                      >
                        {booking ? (
                          <div
                            onClick={() => setEditingProfile(booking)}
                            className={`w-full h-full rounded-lg px-2 flex items-center justify-between cursor-pointer hover:scale-[1.02] transition-transform shadow-sm relative overflow-hidden group/card ${booking.isExperimental
                              ? 'bg-indigo-500/20 text-indigo-400 border border-indigo-500/50 shadow-[0_0_10px_rgba(99,102,241,0.2)]'
                              : booking.type === 'REPOSIÇÃO'
                                ? 'bg-amber-400/20 text-amber-500 border border-amber-400/50 shadow-[0_0_10px_rgba(251,191,36,0.2)]'
                                : 'bg-brand-accent/20 text-brand-text border border-brand-accent shadow-[0_0_10px_rgba(var(--brand-accent),0.3)]'
                              }`}
                          >
                            {/* Glass highlight effect */}
                            <div className="absolute inset-0 bg-gradient-to-tr from-transparent via-white/5 to-transparent pointer-events-none" />
                            <div className="flex items-center gap-1.5 overflow-hidden relative z-10">
                              <div className={`w-5 h-5 rounded-md flex-shrink-0 flex items-center justify-center text-[10px] font-black ${booking.type === 'REPOSIÇÃO' ? 'bg-amber-500 text-amber-950' : booking.isExperimental ? 'bg-indigo-500 text-white' : 'bg-brand-accent text-white'
                                }`}>
                                {booking.student[0]}
                              </div>
                              <span className="text-[10px] font-bold truncate uppercase tracking-wide">
                                {booking.student.split(' ')[0]}
                              </span>
                              {booking.isExperimental && booking.dateLabel && (
                                <span className="text-[8px] opacity-70 font-medium ml-1">{booking.dateLabel}</span>
                              )}
                            </div>
                            {/* Only show badge if space permits or on hover */}
                            {booking.isExperimental && <span className="text-[8px] font-black opacity-80 relative z-10">EXP</span>}
                            {!booking.isExperimental && booking.type === 'REPOSIÇÃO' && <span className="text-[8px] font-black opacity-80 relative z-10">REPO</span>}
                          </div>
                        ) : (
                          <button
                            onClick={() => toggleSlot(dayIdx, time)}
                            className={`w-full h-full rounded-lg border border-dashed transition-all flex flex-col items-center justify-center gap-1 ${isAvailable
                              ? 'bg-emerald-500/10 border-emerald-500/50 hover:bg-emerald-500/20' 
                              : 'bg-transparent border-transparent hover:border-brand-border hover:bg-brand-surface-2' 
                              }`}
                          >
                            {isAvailable && <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 shadow-[0_0_5px_rgba(16,185,129,0.8)]" />}
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
        <div className="p-4 border-t border-brand-border bg-brand-surface sticky bottom-0 z-30 flex justify-between items-center rounded-b-[32px]">
          <div className="flex items-center gap-2 text-xs text-brand-muted">
            <RefreshCw size={12} />
            <span>Alterações não salvas são perdidas ao sair.</span>
          </div>
          <button
            onClick={handlePublish}
            disabled={isPublishing}
            className="bg-brand-accent text-white px-8 py-3 rounded-xl text-xs font-bold uppercase tracking-widest hover:bg-brand-accent-hover transition-all flex items-center gap-2 shadow-[0_0_20px_rgba(var(--brand-accent),0.4)] disabled:opacity-50"
          >
            {isPublishing ? <RefreshCw className="animate-spin" size={16} /> : <Save size={16} />}
            Salvar Agenda
          </button>
        </div>
      </div>

      {editingProfile && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-brand-surface/60 backdrop-blur-sm animate-in fade-in duration-300">
          <StudentProfileForm
            initialData={{
              ...editingProfile.fullProfile,
              id: editingProfile.studentId,
              name: editingProfile.fullProfile?.full_name || editingProfile.student,
              levelBadge: editingProfile.fullProfile?.module?.split(' ')[0] || editingProfile.module,
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
