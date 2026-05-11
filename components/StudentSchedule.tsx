
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
    const [regularLessons, setRegularLessons] = useState<any[]>([]);
    const [reschedules, setReschedules] = useState<any[]>([]);
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
            const { data: rescheds } = await supabase
                .from('reschedules')
                .select(`
          id, date, time,
          teacher:teacher_id(full_name, avatar_url)
        `)
                .eq('student_id', user.id);

            const DAYS_ORDER = ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado', 'Domingo'];

            // PROCESS REGULAR: Unique slots based on Day + Time
            const processedRegular = (bookings || []).map(b => ({
                id: b.id,
                title: 'Aula Fixa',
                day: b.day_of_week,
                time: (b as any).time_slot,
                teacher: (b.teacher as any)?.full_name,
                teacherAvatar: (b.teacher as any)?.avatar_url,
                module: b.module,
                dayIndex: DAYS_ORDER.indexOf(b.day_of_week)
            }));

            // Deduplicate (Simple approach: key = day+time)
            // Ideally bookings shouldn't have duplicates for same slot, but safe to handle.
            const uniqueRegular = processedRegular.filter((lesson, index, self) =>
                index === self.findIndex((t) => (
                    t.day === lesson.day && t.time === lesson.time
                ))
            ).sort((a, b) => a.dayIndex - b.dayIndex);

            // PROCESS RESCHEDULES
            const processedReschedules = (rescheds || []).map(r => ({
                id: r.id,
                title: 'Reposição/Extra',
                dateRaw: r.date,
                dateFormatted: r.date === 'Pendente' ? 'Data a definir' : new Date(r.date + 'T12:00:00').toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short' }),
                time: r.time,
                teacher: (r.teacher as any)?.full_name,
                teacherAvatar: (r.teacher as any)?.avatar_url,
            })).sort((a, b) => {
                if (a.dateRaw === 'Pendente') return 1;
                if (b.dateRaw === 'Pendente') return -1;
                return new Date(a.dateRaw).getTime() - new Date(b.dateRaw).getTime();
            });

            setRegularLessons(uniqueRegular);
            setReschedules(processedReschedules);

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
        <div className="space-y-12 animate-in fade-in duration-700 pb-20">
            <header>
                <h2 className="text-3xl font-black text-slate-800 dark:text-white tracking-tight">Minha Agenda</h2>
                <p className="text-slate-500 dark:text-slate-400 mt-1">Confira sua grade fixa semanal e aulas extras.</p>
            </header>

            {/* SECTION 1: Fixed Schedule */}
            <section>
                <div className="flex items-center gap-3 mb-6">
                    <div className="p-2 bg-blue-50 dark:bg-blue-900/20 text-blue-600 rounded-lg">
                        <Calendar size={20} />
                    </div>
                    <h3 className="text-xl font-bold text-slate-900 dark:text-white">Grade Fixa Semanal</h3>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                    {regularLessons.length > 0 ? regularLessons.map((lesson, i) => (
                        <div key={i} className="bg-white dark:bg-slate-900 p-6 rounded-[2rem] border border-slate-100 dark:border-slate-800 shadow-sm hover:shadow-md transition-all relative overflow-hidden group">
                            <div className="absolute top-0 right-0 w-24 h-24 bg-blue-500/5 rounded-full blur-2xl -mr-12 -mt-12" />

                            <div className="flex flex-col gap-4 relative z-10">
                                <div className="flex justify-between items-start">
                                    <span className="px-3 py-1 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 rounded-lg text-[10px] font-black uppercase tracking-widest">
                                        {lesson.day}
                                    </span>
                                    <div className="flex items-center gap-1.5 text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 px-2 py-1 rounded-md">
                                        <Clock size={12} />
                                        <span className="text-xs font-bold">{lesson.time}</span>
                                    </div>
                                </div>

                                <div className="flex items-center gap-3 mt-2">
                                    <div className="w-10 h-10 rounded-xl overflow-hidden bg-slate-100 dark:bg-slate-800 shrink-0">
                                        <img src={lesson.teacherAvatar || `https://ui-avatars.com/api/?name=${lesson.teacher}`} alt={lesson.teacher} className="w-full h-full object-cover" />
                                    </div>
                                    <div className="min-w-0">
                                        <p className="text-[10px] text-slate-400 font-black uppercase tracking-widest truncate">Professor(a)</p>
                                        <p className="text-sm font-bold text-slate-800 dark:text-slate-200 truncate">{lesson.teacher}</p>
                                    </div>
                                </div>

                                {profile?.meeting_link && (
                                    <a
                                        href={profile.meeting_link}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="mt-2 w-full py-3 bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-tenant-primary hover:text-white dark:hover:bg-tenant-primary dark:hover:text-white rounded-xl font-bold text-[10px] uppercase tracking-widest flex items-center justify-center gap-2 transition-all"
                                    >
                                        <Video size={14} /> Entrar
                                    </a>
                                )}
                            </div>
                        </div>
                    )) : (
                        <div className="col-span-full py-12 text-center text-slate-400 bg-slate-50 dark:bg-slate-800/50 rounded-3xl border-2 border-dashed border-slate-200 dark:border-slate-800">
                            <p className="text-sm font-medium">Nenhuma aula fixa configurada.</p>
                        </div>
                    )}
                </div>
            </section>

            {/* SECTION 2: Reschedules & Extras */}
            {reschedules.length > 0 && (
                <section>
                    <div className="flex items-center gap-3 mb-6">
                        <div className="p-2 bg-purple-50 dark:bg-purple-900/20 text-purple-600 rounded-lg">
                            <RefreshCw size={20} />
                        </div>
                        <h3 className="text-xl font-bold text-slate-900 dark:text-white">Reposições e Extras</h3>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                        {reschedules.map((lesson, i) => (
                            <div key={i} className="bg-white dark:bg-slate-900 p-6 rounded-[2rem] border-2 border-dashed border-purple-100 dark:border-purple-900/30 shadow-none hover:border-purple-300 transition-all relative group">
                                <div className="flex justify-between items-start mb-4">
                                    <div className="flex flex-col">
                                        <span className="text-lg font-black text-slate-800 dark:text-white capitalize">
                                            {lesson.dateFormatted}
                                        </span>
                                        <span className="text-xs font-bold text-slate-400 dark:text-slate-500 flex items-center gap-1 mt-1">
                                            <Clock size={12} /> {lesson.time}
                                        </span>
                                    </div>
                                    <span className="px-3 py-1 bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-300 rounded-full text-[10px] font-black uppercase tracking-widest">
                                        Extra
                                    </span>
                                </div>

                                <div className="flex items-center gap-3 pt-4 border-t border-slate-50 dark:border-slate-800">
                                    <div className="w-8 h-8 rounded-full overflow-hidden bg-slate-100 dark:bg-slate-800 shrink-0">
                                        <img src={lesson.teacherAvatar || `https://ui-avatars.com/api/?name=${lesson.teacher}`} alt={lesson.teacher} className="w-full h-full object-cover" />
                                    </div>
                                    <p className="text-xs font-bold text-slate-600 dark:text-slate-300 truncate">
                                        Com {lesson.teacher}
                                    </p>
                                </div>

                                {profile?.meeting_link && (
                                    <a
                                        href={profile.meeting_link}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="absolute inset-0 z-10"
                                        title="Acessar Aula"
                                    />
                                )}
                            </div>
                        ))}
                    </div>
                </section>
            )}
        </div>
    );
};

export default StudentSchedule;
