import React, { useState, useEffect } from 'react';
import { Users, TrendingUp, TrendingDown, Loader2, BarChart3, Search, ChevronDown, ChevronRight, AlertCircle } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { UserRole } from '../types';

interface Props {
    user: { id: string; tenantId?: string; role: UserRole | string };
    tenantId?: string;
}

const SKILLS = [
    { id: 'speaking', label: 'Speaking', color: '#ec4899' },
    { id: 'pronunciation', label: 'Pronúncia', color: '#a855f7' },
    { id: 'listening', label: 'Listening', color: '#3b82f6' },
    { id: 'reading', label: 'Reading', color: '#06b6d4' },
    { id: 'writing', label: 'Writing', color: '#10b981' },
    { id: 'grammar', label: 'Grammar', color: '#f59e0b' },
    { id: 'vocabulary', label: 'Vocab', color: '#ef4444' },
];

const ClassSkillsDashboard: React.FC<Props> = ({ user, tenantId }) => {
    const [loading, setLoading] = useState(true);
    const [students, setStudents] = useState<any[]>([]);
    const [scoresByStudent, setScoresByStudent] = useState<Record<string, Record<string, number>>>({});
    const [search, setSearch] = useState('');
    const [sortBy, setSortBy] = useState<'name' | 'avg' | string>('avg');
    const [expandedStudent, setExpandedStudent] = useState<string | null>(null);

    useEffect(() => {
        if (tenantId) load();
    }, [tenantId, user.id]);

    const load = async () => {
        setLoading(true);
        try {
            const isTeacher = user.role === UserRole.TEACHER || user.role === 'TEACHER' || user.role === 'teacher';

            // 1. Buscar alunos
            let studentsQuery = supabase
                .from('profiles')
                .select('id, full_name, email, module, status, avatar_url')
                .eq('role', 'STUDENT')
                .eq('tenant_id', tenantId);

            if (isTeacher) {
                // Apenas alunos vinculados ao professor via bookings
                const { data: bookings } = await supabase
                    .from('bookings')
                    .select('student_id')
                    .eq('teacher_id', user.id)
                    .eq('tenant_id', tenantId);
                const ids = Array.from(new Set((bookings || []).map(b => b.student_id)));
                if (ids.length === 0) {
                    setStudents([]);
                    setLoading(false);
                    return;
                }
                studentsQuery = studentsQuery.in('id', ids);
            }

            const { data: studs } = await studentsQuery;
            setStudents(studs || []);

            if (studs && studs.length > 0) {
                const { data: scoresData } = await supabase
                    .from('student_skill_scores')
                    .select('student_id, skill, current_score')
                    .in('student_id', studs.map(s => s.id));

                const map: Record<string, Record<string, number>> = {};
                (scoresData || []).forEach(s => {
                    if (!map[s.student_id]) map[s.student_id] = {};
                    map[s.student_id][s.skill] = Number(s.current_score) || 0;
                });
                setScoresByStudent(map);
            }
        } catch (err) {
            console.error('ClassSkills load:', err);
        } finally {
            setLoading(false);
        }
    };

    const getAvg = (studentId: string) => {
        const scores = scoresByStudent[studentId] || {};
        const vals = Object.values(scores).filter((v: number) => v > 0) as number[];
        if (vals.length === 0) return 0;
        return Math.round(vals.reduce((a: number, b: number) => a + b, 0) / vals.length);
    };

    const filtered = students
        .filter(s => !search || (s.full_name || '').toLowerCase().includes(search.toLowerCase()))
        .sort((a, b) => {
            if (sortBy === 'name') return (a.full_name || '').localeCompare(b.full_name || '');
            if (sortBy === 'avg') return getAvg(b.id) - getAvg(a.id);
            // sort by specific skill
            const aScore = scoresByStudent[a.id]?.[sortBy] || 0;
            const bScore = scoresByStudent[b.id]?.[sortBy] || 0;
            return bScore - aScore;
        });

    // Class-level aggregates
    const classAggregates = SKILLS.map(skill => {
        const scores = students
            .map(s => scoresByStudent[s.id]?.[skill.id] || 0)
            .filter(v => v > 0);
        const avg = scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
        const learners = scores.length;
        return { skill, avg, learners };
    });

    const classOverall = (() => {
        const allScores = students.flatMap(s => Object.values(scoresByStudent[s.id] || {})).filter(v => v > 0);
        return allScores.length > 0 ? Math.round(allScores.reduce((a, b) => a + b, 0) / allScores.length) : 0;
    })();

    if (loading) {
        return (
            <div className="bg-white dark:bg-slate-900 rounded-[2.5rem] border border-slate-100 dark:border-slate-800 p-12 flex items-center justify-center">
                <Loader2 className="animate-spin text-violet-500" size={24} />
            </div>
        );
    }

    if (students.length === 0) {
        return (
            <div className="bg-white dark:bg-slate-900 rounded-[2.5rem] border border-slate-100 dark:border-slate-800 p-12 text-center text-slate-400">
                <Users size={32} className="mx-auto mb-3 opacity-40" />
                <p className="text-sm font-bold">Nenhum aluno vinculado</p>
                <p className="text-xs mt-1">Atribua alunos a você no painel de matrículas para vê-los aqui.</p>
            </div>
        );
    }

    return (
        <div className="space-y-4">
            {/* Header com agregados da turma */}
            <div className="bg-white dark:bg-slate-900 rounded-[2.5rem] border border-slate-100 dark:border-slate-800 overflow-hidden">
                <div className="p-6 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-violet-100 dark:bg-violet-900/30 rounded-xl flex items-center justify-center">
                            <BarChart3 size={20} className="text-violet-600 dark:text-violet-400" />
                        </div>
                        <div>
                            <h3 className="font-black text-slate-800 dark:text-white text-sm">Skills da Turma</h3>
                            <p className="text-[10px] text-slate-400 uppercase tracking-widest">
                                {students.length} aluno{students.length > 1 ? 's' : ''} · Média geral {classOverall}/100
                            </p>
                        </div>
                    </div>
                </div>

                <div className="p-6 grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
                    {classAggregates.map(({ skill, avg, learners }) => (
                        <div key={skill.id} className="rounded-2xl bg-slate-50 dark:bg-slate-800/50 p-3 text-center">
                            <div className="w-8 h-8 rounded-full mx-auto mb-2" style={{ background: avg > 0 ? skill.color : '#cbd5e1', opacity: avg > 0 ? 0.2 : 0.6 }} />
                            <p className="text-[10px] uppercase tracking-widest text-slate-500 font-bold">{skill.label}</p>
                            <p className="text-2xl font-black mt-1" style={{ color: avg > 0 ? skill.color : '#94a3b8' }}>{avg}</p>
                            <p className="text-[9px] text-slate-400">{learners > 0 ? `${learners} learner${learners > 1 ? 's' : ''}` : 'sem dados'}</p>
                        </div>
                    ))}
                </div>
            </div>

            {/* Tabela de alunos */}
            <div className="bg-white dark:bg-slate-900 rounded-[2.5rem] border border-slate-100 dark:border-slate-800 overflow-hidden">
                <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-800 flex items-center gap-3 flex-wrap">
                    <div className="flex-1 min-w-[200px] relative">
                        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                        <input
                            type="text"
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            placeholder="Buscar aluno..."
                            className="w-full pl-9 pr-3 py-2 bg-slate-50 dark:bg-slate-800 rounded-xl text-sm border border-slate-200 dark:border-slate-700 focus:outline-none focus:ring-2 focus:ring-violet-500"
                        />
                    </div>
                    <select
                        value={sortBy}
                        onChange={e => setSortBy(e.target.value)}
                        className="px-3 py-2 bg-slate-50 dark:bg-slate-800 rounded-xl text-xs font-bold border border-slate-200 dark:border-slate-700 focus:outline-none focus:ring-2 focus:ring-violet-500"
                    >
                        <option value="avg">Ordenar: Média geral</option>
                        <option value="name">Ordenar: Nome</option>
                        {SKILLS.map(s => <option key={s.id} value={s.id}>Ordenar: {s.label}</option>)}
                    </select>
                </div>

                <div className="divide-y divide-slate-100 dark:divide-slate-800">
                    {filtered.map(s => {
                        const avg = getAvg(s.id);
                        const scores = scoresByStudent[s.id] || {};
                        const isOpen = expandedStudent === s.id;
                        const hasNoData = avg === 0;
                        // Detect "at risk" — média abaixo de 50 com pelo menos 1 atividade
                        const atRisk = !hasNoData && avg < 50;

                        return (
                            <div key={s.id}>
                                <button
                                    onClick={() => setExpandedStudent(isOpen ? null : s.id)}
                                    className="w-full px-6 py-3 flex items-center gap-3 text-left hover:bg-slate-50 dark:hover:bg-slate-800/50"
                                >
                                    <div className="w-9 h-9 rounded-full bg-violet-100 dark:bg-violet-900/30 flex items-center justify-center text-violet-600 font-black text-sm shrink-0">
                                        {(s.full_name || '?').charAt(0).toUpperCase()}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2">
                                            <p className="text-sm font-black text-slate-800 dark:text-white truncate">{s.full_name}</p>
                                            {atRisk && (
                                                <span className="flex items-center gap-1 text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded bg-rose-100 dark:bg-rose-900/30 text-rose-600">
                                                    <AlertCircle size={9} /> em risco
                                                </span>
                                            )}
                                        </div>
                                        <p className="text-[10px] text-slate-400 truncate">{s.email} {s.module ? `· ${s.module}` : ''}</p>
                                    </div>

                                    {/* Skills bars compactas */}
                                    <div className="hidden lg:flex items-center gap-1 shrink-0">
                                        {SKILLS.map(skill => {
                                            const v = scores[skill.id] || 0;
                                            return (
                                                <div key={skill.id} className="flex flex-col items-center gap-0.5" title={`${skill.label}: ${Math.round(v)}/100`}>
                                                    <div className="w-1.5 h-12 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden relative">
                                                        <div className="absolute bottom-0 left-0 right-0 transition-all" style={{ height: `${v}%`, background: skill.color }} />
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>

                                    <div className="text-right shrink-0 ml-2">
                                        <p className={`text-xl font-black ${hasNoData ? 'text-slate-300' : avg < 50 ? 'text-rose-500' : avg < 70 ? 'text-amber-500' : 'text-emerald-500'}`}>
                                            {hasNoData ? '–' : avg}
                                        </p>
                                        <p className="text-[9px] text-slate-400">média</p>
                                    </div>

                                    {isOpen ? <ChevronDown size={16} className="text-slate-400 shrink-0" /> : <ChevronRight size={16} className="text-slate-400 shrink-0" />}
                                </button>

                                {isOpen && (
                                    <div className="px-6 pb-4 grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2">
                                        {SKILLS.map(skill => {
                                            const v = Math.round(scores[skill.id] || 0);
                                            const hasData = v > 0;
                                            return (
                                                <div key={skill.id} className="rounded-xl bg-slate-50 dark:bg-slate-800/50 p-2 text-center">
                                                    <p className="text-[9px] uppercase tracking-widest text-slate-500 font-bold">{skill.label}</p>
                                                    <p className="text-lg font-black mt-1" style={{ color: hasData ? skill.color : '#94a3b8' }}>{hasData ? v : '–'}</p>
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
};

export default ClassSkillsDashboard;
