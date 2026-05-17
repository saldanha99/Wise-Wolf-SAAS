
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
        <div className="flex flex-col items-center justify-center h-96 text-brand-muted">
            <RefreshCw className="animate-spin mb-4 text-brand-accent" size={32} />
            <p className="text-sm font-bold uppercase tracking-widest text-brand-text">Carregando sua agenda...</p>
        </div>
    );

    return (
        <div className="space-y-12 animate-in fade-in duration-700 pb-20">
            <header>
                <h2 className="text-3xl font-[family-name:var(--font-display)] font-extrabold text-brand-text tracking-tight">Minha Agenda</h2>
                <p className="text-brand-muted mt-1 font-medium">Confira sua grade fixa semanal e aulas extras.</p>
            </header>

            {/* SECTION 1: Fixed Schedule */}
            <section>
                <div className="flex items-center gap-3 mb-6">
                    <div className="p-2 bg-blue-500/10 text-blue-500 rounded-lg border border-blue-500/20">
                        <Calendar size={20} />
                    </div>
                    <h3 className="text-xl font-[family-name:var(--font-display)] font-extrabold text-brand-text">Grade Fixa Semanal</h3>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                    {regularLessons.length > 0 ? regularLessons.map((lesson, i) => (
                        <div key={i} className="bg-brand-surface p-6 rounded-[2rem] border border-brand-border shadow-sm hover:shadow-[0_8px_30px_rgba(0,0,0,0.12)] transition-all relative overflow-hidden group">
                            <div className="absolute top-0 right-0 w-24 h-24 bg-blue-500/10 rounded-full blur-2xl -mr-12 -mt-12 group-hover:bg-blue-500/20 transition-colors" />

                            <div className="flex flex-col gap-4 relative z-10">
                                <div className="flex justify-between items-start">
                                    <span className="px-3 py-1 bg-brand-surface-2 text-brand-text rounded-lg text-[10px] font-black uppercase tracking-widest border border-brand-border">
                                        {lesson.day}
                                    </span>
                                    <div className="flex items-center gap-1.5 text-blue-500 bg-blue-500/10 px-2 py-1 rounded-md border border-blue-500/20 shadow-sm">
                                        <Clock size={12} />
                                        <span className="text-xs font-bold">{lesson.time}</span>
                                    </div>
                                </div>

                                <div className="flex items-center gap-3 mt-2">
                                    <div className="w-10 h-10 rounded-xl overflow-hidden bg-brand-surface-2 shrink-0 border border-brand-border shadow-sm">
                                        <img src={lesson.teacherAvatar || `https://ui-avatars.com/api/?name=${lesson.teacher}`} alt={lesson.teacher} className="w-full h-full object-cover" />
                                    </div>
                                    <div className="min-w-0">
                                        <p className="text-[10px] text-brand-muted font-black uppercase tracking-widest truncate">Professor(a)</p>
                                        <p className="text-sm font-bold text-brand-text truncate">{lesson.teacher}</p>
                                    </div>
                                </div>

                                {profile?.meeting_link && (
                                    <a
                                        href={profile.meeting_link}
                                        target="_blank"
                                        className="mt-2 w-full py-3 bg-brand-surface-2 text-brand-text hover:bg-brand-accent hover:text-white rounded-xl font-bold text-[10px] uppercase tracking-widest flex items-center justify-center gap-2 transition-all border border-brand-border hover:border-brand-accent shadow-sm"
                                    >
                                        <Video size={14} /> Entrar
                                    </a>
                                )}
                            </div>
                        </div>
                    )) : (
                        <div className="col-span-full py-12 text-center text-brand-muted bg-brand-surface-2/50 rounded-3xl border-2 border-dashed border-brand-border">
                            <p className="text-sm font-medium">Nenhuma aula fixa configurada.</p>
                        </div>
                    )}
                </div>
            </section>

            {/* SECTION 2: Reschedules & Extras */}
            {reschedules.length > 0 && (
                <section>
                    <div className="flex items-center gap-3 mb-6">
                        <div className="p-2 bg-purple-500/10 text-purple-500 rounded-lg border border-purple-500/20">
                            <RefreshCw size={20} />
                        </div>
                        <h3 className="text-xl font-[family-name:var(--font-display)] font-extrabold text-brand-text">Reposições e Extras</h3>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                        {reschedules.map((lesson, i) => (
                            <div key={i} className="bg-brand-surface p-6 rounded-[2rem] border-2 border-dashed border-purple-500/30 shadow-none hover:border-purple-500/60 transition-all relative group hover:bg-brand-surface-2">
                                <div className="flex justify-between items-start mb-4">
                                    <div className="flex flex-col">
                                        <span className="text-lg font-[family-name:var(--font-display)] font-extrabold text-brand-text capitalize">
                                            {lesson.dateFormatted}
                                        </span>
                                        <span className="text-xs font-bold text-brand-muted flex items-center gap-1 mt-1">
                                            <Clock size={12} className="text-purple-500" /> {lesson.time}
                                        </span>
                                    </div>
                                    <span className="px-3 py-1 bg-purple-500/10 text-purple-500 rounded-full text-[10px] font-black uppercase tracking-widest border border-purple-500/20">
                                        Extra
                                    </span>
                                </div>

                                <div className="flex items-center gap-3 pt-4 border-t border-brand-border">
                                    <div className="w-8 h-8 rounded-full overflow-hidden bg-brand-surface-2 shrink-0 border border-brand-border">
                                        <img src={lesson.teacherAvatar || `https://ui-avatars.com/api/?name=${lesson.teacher}`} alt={lesson.teacher} className="w-full h-full object-cover" />
                                    </div>
                                    <p className="text-xs font-bold text-brand-text truncate">
                                        Com {lesson.teacher}
                                    </p>
                                </div>

                                {profile?.meeting_link && (
                                    <a
                                        href={profile.meeting_link}
                                        target="_blank"
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
