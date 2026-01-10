
import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { Calendar, Clock, MapPin, User, Video, RefreshCw } from 'lucide-react';
import { User as UserType } from '../types';

interface StudentScheduleProps {
    user: UserType;
    tenantId?: string;
}

const StudentSchedule: React.FC<StudentScheduleProps> = ({ user, tenantId }) => {
    const [loading, setLoading] = useState(true);
    const [lessons, setLessons] = useState<any[]>([]);
    const [profile, setProfile] = useState<any>(null);

    useEffect(() => {
        if (user && tenantId) {
            fetchSchedule();
        }
    }, [user, tenantId]);

    const fetchSchedule = async () => {
        setLoading(true);
        try {
            // 1. Fetch Profile for meeting link
            const { data: prof } = await supabase.from('profiles').select('meeting_link').eq('id', user.id).single();
            setProfile(prof);

            // 2. Fetch Regular Bookings
            const { data: bookings } = await supabase
                .from('bookings')
                .select(`
          id, time_slot, day_of_week, module,
          teacher:teacher_id(full_name, avatar_url)
        `)
                .eq('student_id', user.id);

            // 3. Fetch Pending Reschedules
            const { data: reschedules } = await supabase
                .from('reschedules')
                .select(`
          id, date, time,
          teacher:teacher_id(full_name, avatar_url)
        `)
                .eq('student_id', user.id);

            const DAYS_ORDER = ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado', 'Domingo'];

            const formattedBookings = (bookings || []).map(b => ({
                id: b.id,
                title: 'Aula Regular',
                day: b.day_of_week,
                time: (b as any).time_slot,
                teacher: (b.teacher as any)?.full_name,
                teacherAvatar: (b.teacher as any)?.avatar_url,
                module: b.module,
                type: 'REGULAR',
                dayIndex: DAYS_ORDER.indexOf(b.day_of_week)
            }));

            const formattedReschedules = (reschedules || []).map(r => ({
                id: r.id,
                title: 'Reposição',
                day: r.date, // Can be a date YYYY-MM-DD or 'Pendente'
                time: r.time,
                teacher: (r.teacher as any)?.full_name,
                teacherAvatar: (r.teacher as any)?.avatar_url,
                type: 'REPOSIÇÃO',
                dayIndex: 10 // Put reschedules at the end or handle separately
            }));

            setLessons([...formattedBookings, ...formattedReschedules].sort((a, b) => a.dayIndex - b.dayIndex));

        } catch (err) {
            console.error('Schedule Fetch Error:', err);
        } finally {
            setLoading(false);
        }
    };

    if (loading) return (
        <div className="flex flex-col items-center justify-center h-96 text-slate-400">
            <RefreshCw className="animate-spin mb-4" size={32} />
            <p className="text-sm font-bold uppercase tracking-widest">Carregando sua agenda...</p>
        </div>
    );

    return (
        <div className="space-y-8 animate-in fade-in duration-700">
            <header>
                <h2 className="text-3xl font-black text-slate-800 dark:text-white tracking-tight">Minha Agenda</h2>
                <p className="text-slate-500 dark:text-slate-400 mt-1">Confira seus horários semanais e reposições agendadas.</p>
            </header>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {lessons.length > 0 ? lessons.map((lesson, i) => (
                    <div key={i} className="bg-white dark:bg-slate-900 p-6 rounded-[2rem] border border-slate-100 dark:border-slate-800 shadow-sm hover:shadow-md transition-all relative overflow-hidden group">
                        <div className={`absolute top-0 right-0 w-24 h-24 ${lesson.type === 'REGULAR' ? 'bg-blue-500/5' : 'bg-purple-500/5'} rounded-full blur-2xl -mr-12 -mt-12`} />

                        <div className="flex justify-between items-start mb-6">
                            <div className={`px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest ${lesson.type === 'REGULAR' ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400' : 'bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400'}`}>
                                {lesson.title}
                            </div>
                            <div className="flex items-center gap-1 text-slate-400 dark:text-slate-500">
                                <Clock size={14} />
                                <span className="text-sm font-bold">{lesson.time}</span>
                            </div>
                        </div>

                        <div className="space-y-4">
                            <div className="flex items-center gap-3">
                                <div className="w-10 h-10 rounded-xl overflow-hidden bg-slate-100 dark:bg-slate-800">
                                    <img src={lesson.teacherAvatar || `https://ui-avatars.com/api/?name=${lesson.teacher}`} alt={lesson.teacher} className="w-full h-full object-cover" />
                                </div>
                                <div>
                                    <p className="text-[10px] text-slate-400 font-black uppercase tracking-widest">Professor(a)</p>
                                    <p className="text-sm font-bold text-slate-800 dark:text-slate-200">{lesson.teacher}</p>
                                </div>
                            </div>

                            <div className="flex items-center gap-3">
                                <div className="w-10 h-10 rounded-xl bg-slate-50 dark:bg-slate-800 flex items-center justify-center text-slate-400">
                                    <Calendar size={18} />
                                </div>
                                <div>
                                    <p className="text-[10px] text-slate-400 font-black uppercase tracking-widest">Dia</p>
                                    <p className="text-sm font-bold text-slate-800 dark:text-slate-200">{lesson.day}</p>
                                </div>
                            </div>
                        </div>

                        {profile?.meeting_link && (
                            <div className="mt-8 pt-6 border-t border-slate-50 dark:border-slate-800">
                                <a
                                    href={profile.meeting_link}
                                    target="_blank"
                                    className="w-full py-3 bg-tenant-primary text-white rounded-xl font-bold text-xs flex items-center justify-center gap-2 hover:opacity-90 transition-opacity"
                                >
                                    <Video size={16} /> ACESSAR SALA VIRTUAL
                                </a>
                            </div>
                        )}
                    </div>
                )) : (
                    <div className="lg:col-span-3 py-20 bg-slate-50 dark:bg-slate-900/50 rounded-[3rem] border-2 border-dashed border-slate-200 dark:border-slate-800 flex flex-col items-center justify-center text-center">
                        <Calendar size={48} className="text-slate-200 mb-4" />
                        <h3 className="text-lg font-bold text-slate-800 dark:text-slate-200">Nenhuma aula encontrada</h3>
                        <p className="text-sm text-slate-400 max-w-xs mt-2">Você ainda não possui aulas regulares agendadas no sistema.</p>
                    </div>
                )}
            </div>
        </div>
    );
};

export default StudentSchedule;
