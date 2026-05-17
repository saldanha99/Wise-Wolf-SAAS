import React, { useState, useEffect } from 'react';
import { BookOpen, Trophy, Lock, CheckCircle, ChevronRight, Loader2, Sparkles, Play, Target, Briefcase, Plane, GraduationCap, Cpu, Heart, Globe } from 'lucide-react';
import { supabase } from '../lib/supabase';
import ActivityPlayer from './ActivityPlayer';

interface Props {
    userId: string;
    tenantId?: string;
    wolfieConfig?: any;
}

interface LearningPath {
    id: string;
    name: string;
    description: string;
    target_level: string;
    category: string;
    estimated_hours: number;
}

interface LearningUnit {
    id: string;
    path_id: string;
    order_index: number;
    title: string;
    description: string;
    estimated_minutes: number;
    skill_focus: string[];
}

interface Activity {
    id: string;
    unit_id: string;
    order_index: number;
    type: string;
    title: string;
    description: string;
    content: any;
    xp_reward: number;
    estimated_minutes: number;
}

const CATEGORY_META: Record<string, { icon: React.ElementType; color: string; label: string }> = {
    BUSINESS: { icon: Briefcase, color: 'from-blue-500 to-indigo-600', label: 'Business' },
    TOEFL_IELTS: { icon: GraduationCap, color: 'from-purple-500 to-pink-600', label: 'TOEFL / IELTS' },
    TRAVEL: { icon: Plane, color: 'from-amber-500 to-orange-600', label: 'Viagem' },
    KIDS: { icon: Heart, color: 'from-pink-500 to-rose-600', label: 'Inglês para Crianças' },
    TECH: { icon: Cpu, color: 'from-emerald-500 to-teal-600', label: 'Tecnologia' },
    GENERAL: { icon: Globe, color: 'from-violet-500 to-purple-600', label: 'Geral' },
    CONVERSATION: { icon: Sparkles, color: 'from-cyan-500 to-blue-600', label: 'Conversação' },
};

const StudentLearningPaths: React.FC<Props> = ({ userId, tenantId, wolfieConfig }) => {
    const [loading, setLoading] = useState(true);
    const [paths, setPaths] = useState<LearningPath[]>([]);
    const [enrolledPathId, setEnrolledPathId] = useState<string | null>(null);
    const [selectedPath, setSelectedPath] = useState<LearningPath | null>(null);
    const [units, setUnits] = useState<LearningUnit[]>([]);
    const [activitiesByUnit, setActivitiesByUnit] = useState<Record<string, Activity[]>>({});
    const [progress, setProgress] = useState<Record<string, { status: string; score: number | null }>>({});
    const [activeActivity, setActiveActivity] = useState<Activity | null>(null);
    const [expandedUnit, setExpandedUnit] = useState<string | null>(null);

    useEffect(() => {
        if (userId) loadPaths();
    }, [userId]);

    const loadPaths = async () => {
        setLoading(true);
        try {
            // Paths globais OU do tenant do aluno
            const { data: pathsData } = await supabase
                .from('learning_paths')
                .select('*')
                .eq('active', true)
                .or(`tenant_id.is.null,tenant_id.eq.${tenantId || 'none'}`)
                .order('created_at', { ascending: true });

            setPaths(pathsData || []);

            const { data: enrollData } = await supabase
                .from('student_path_enrollments')
                .select('path_id, current_unit_id')
                .eq('student_id', userId)
                .is('completed_at', null)
                .maybeSingle();

            if (enrollData) {
                setEnrolledPathId(enrollData.path_id);
                const path = pathsData?.find(p => p.id === enrollData.path_id);
                if (path) {
                    setSelectedPath(path);
                    await loadPathDetails(path.id);
                }
            }
        } catch (err) {
            console.error('loadPaths error:', err);
        } finally {
            setLoading(false);
        }
    };

    const loadPathDetails = async (pathId: string) => {
        const { data: unitsData } = await supabase
            .from('learning_units')
            .select('*')
            .eq('path_id', pathId)
            .order('order_index', { ascending: true });

        setUnits(unitsData || []);

        if (unitsData && unitsData.length > 0) {
            const unitIds = unitsData.map(u => u.id);
            const { data: actData } = await supabase
                .from('unit_activities')
                .select('*')
                .in('unit_id', unitIds)
                .order('order_index', { ascending: true });

            const grouped: Record<string, Activity[]> = {};
            (actData || []).forEach(a => {
                if (!grouped[a.unit_id]) grouped[a.unit_id] = [];
                grouped[a.unit_id].push(a);
            });
            setActivitiesByUnit(grouped);

            // Carregar progresso do aluno
            const activityIds = (actData || []).map(a => a.id);
            if (activityIds.length > 0) {
                const { data: progressData } = await supabase
                    .from('student_activity_progress')
                    .select('activity_id, status, score')
                    .eq('student_id', userId)
                    .in('activity_id', activityIds);

                const progMap: Record<string, { status: string; score: number | null }> = {};
                (progressData || []).forEach(p => {
                    progMap[p.activity_id] = { status: p.status, score: p.score };
                });
                setProgress(progMap);
            }

            // Expandir a primeira unit nao concluida
            const firstIncomplete = unitsData.find(u => {
                const acts = grouped[u.id] || [];
                return acts.some(a => progress[a.id]?.status !== 'COMPLETED');
            });
            setExpandedUnit(firstIncomplete?.id || unitsData[0]?.id || null);
        }
    };

    const enrollInPath = async (path: LearningPath) => {
        try {
            await supabase.from('student_path_enrollments').upsert({
                student_id: userId,
                path_id: path.id,
                tenant_id: tenantId,
                current_unit_id: null,
                started_at: new Date().toISOString(),
            }, { onConflict: 'student_id, path_id' });
            setEnrolledPathId(path.id);
            setSelectedPath(path);
            await loadPathDetails(path.id);
        } catch (err) {
            console.error('enrollInPath error:', err);
        }
    };

    const handleActivityComplete = async (score: number) => {
        if (activeActivity) {
            setProgress(prev => ({ ...prev, [activeActivity.id]: { status: 'COMPLETED', score } }));
        }
        setActiveActivity(null);
    };

    if (loading) {
        return (
            <div className="bg-white dark:bg-slate-900 rounded-[2.5rem] border border-slate-100 dark:border-slate-800 p-12 flex flex-col items-center justify-center">
                <Loader2 className="animate-spin text-violet-500" size={28} />
                <p className="text-sm text-slate-400 mt-3 font-bold">Carregando trilhas...</p>
            </div>
        );
    }

    // ── VIEW: Path selecionado (detalhe + units) ──
    if (selectedPath) {
        const meta = CATEGORY_META[selectedPath.category] || CATEGORY_META.GENERAL;
        const Icon = meta.icon;

        const allActivities = Object.values(activitiesByUnit).flat() as Activity[];
        const completedCount = allActivities.filter(a => progress[a.id]?.status === 'COMPLETED').length;
        const totalCount = allActivities.length;
        const overallProgress = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

        return (
            <div className="bg-white dark:bg-slate-900 rounded-[2.5rem] border border-slate-100 dark:border-slate-800 overflow-hidden">
                {/* Header */}
                <div className={`bg-gradient-to-br ${meta.color} p-6 text-white relative overflow-hidden`}>
                    <button
                        onClick={() => setSelectedPath(null)}
                        className="absolute top-4 right-4 text-xs font-bold uppercase tracking-widest opacity-70 hover:opacity-100"
                    >
                        ← Trilhas
                    </button>
                    <Icon size={28} className="mb-3 opacity-90" />
                    <p className="text-[10px] font-bold uppercase tracking-widest opacity-80">{meta.label} · {selectedPath.target_level}</p>
                    <h2 className="text-2xl font-black mt-1">{selectedPath.name}</h2>
                    <p className="text-sm opacity-90 mt-2 max-w-xl">{selectedPath.description}</p>

                    {/* Progress bar */}
                    <div className="mt-5">
                        <div className="flex items-center justify-between mb-2">
                            <span className="text-[10px] font-bold uppercase tracking-widest opacity-80">Progresso</span>
                            <span className="text-xs font-black">{completedCount}/{totalCount} · {overallProgress}%</span>
                        </div>
                        <div className="h-2 bg-white/20 rounded-full overflow-hidden">
                            <div className="h-full bg-white transition-all duration-500" style={{ width: `${overallProgress}%` }} />
                        </div>
                    </div>
                </div>

                {/* Units */}
                <div className="p-6 space-y-3">
                    {units.map((unit, unitIdx) => {
                        const acts = activitiesByUnit[unit.id] || [];
                        const unitCompleted = acts.length > 0 && acts.every(a => progress[a.id]?.status === 'COMPLETED');
                        const unitInProgress = acts.some(a => progress[a.id]?.status === 'COMPLETED') && !unitCompleted;
                        const isOpen = expandedUnit === unit.id;

                        return (
                            <div key={unit.id} className={`rounded-2xl border transition-all ${
                                unitCompleted
                                    ? 'border-emerald-200 bg-emerald-50/50 dark:bg-emerald-900/10'
                                    : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900'
                            }`}>
                                <button
                                    onClick={() => setExpandedUnit(isOpen ? null : unit.id)}
                                    className="w-full p-4 flex items-center gap-4 text-left"
                                >
                                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                                        unitCompleted ? 'bg-emerald-500 text-white' :
                                        unitInProgress ? 'bg-violet-500 text-white' :
                                        'bg-slate-100 dark:bg-slate-800 text-slate-400'
                                    }`}>
                                        {unitCompleted ? <CheckCircle size={18} /> : <span className="text-sm font-black">{unitIdx + 1}</span>}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <p className="text-sm font-black text-slate-800 dark:text-white">{unit.title}</p>
                                        <p className="text-xs text-slate-500 dark:text-slate-400 truncate">{unit.description}</p>
                                        <div className="flex items-center gap-2 mt-1">
                                            <span className="text-[10px] text-slate-400">{acts.length} atividades · {unit.estimated_minutes}min</span>
                                            {unit.skill_focus?.map(s => (
                                                <span key={s} className="text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500">{s}</span>
                                            ))}
                                        </div>
                                    </div>
                                    <ChevronRight size={16} className={`text-slate-400 shrink-0 transition-transform ${isOpen ? 'rotate-90' : ''}`} />
                                </button>

                                {isOpen && acts.length > 0 && (
                                    <div className="px-4 pb-4 space-y-2 border-t border-slate-100 dark:border-slate-800 pt-3">
                                        {acts.map((a, i) => {
                                            const p = progress[a.id];
                                            const done = p?.status === 'COMPLETED';
                                            return (
                                                <button
                                                    key={a.id}
                                                    onClick={() => setActiveActivity(a)}
                                                    className={`w-full flex items-center gap-3 p-3 rounded-xl text-left transition-all ${
                                                        done
                                                            ? 'bg-emerald-50 dark:bg-emerald-900/10 hover:bg-emerald-100 dark:hover:bg-emerald-900/20'
                                                            : 'hover:bg-slate-50 dark:hover:bg-slate-800/50'
                                                    }`}
                                                >
                                                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                                                        done
                                                            ? 'bg-emerald-500 text-white'
                                                            : 'bg-slate-100 dark:bg-slate-800 text-slate-500'
                                                    }`}>
                                                        {done ? <CheckCircle size={14} /> : <Play size={12} />}
                                                    </div>
                                                    <div className="flex-1 min-w-0">
                                                        <div className="flex items-center gap-2">
                                                            <p className="text-xs font-black text-slate-700 dark:text-slate-200 truncate">{a.title}</p>
                                                            <span className="text-[9px] font-bold uppercase tracking-widest text-slate-400">{a.type.replace(/_/g, ' ')}</span>
                                                        </div>
                                                        <div className="flex items-center gap-2 mt-0.5 text-[10px] text-slate-400">
                                                            <span>{a.estimated_minutes}min</span>
                                                            <span>· {a.xp_reward} XP</span>
                                                            {done && p?.score !== null && (
                                                                <span className="font-bold text-emerald-600">· {p.score}%</span>
                                                            )}
                                                        </div>
                                                    </div>
                                                </button>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>

                {activeActivity && (
                    <ActivityPlayer
                        activity={activeActivity}
                        userId={userId}
                        wolfieConfig={wolfieConfig}
                        onComplete={handleActivityComplete}
                        onClose={() => setActiveActivity(null)}
                    />
                )}
            </div>
        );
    }

    // ── VIEW: Lista de trilhas disponíveis ──
    return (
        <div className="bg-white dark:bg-slate-900 rounded-[2.5rem] border border-slate-100 dark:border-slate-800 overflow-hidden">
            <div className="p-6 border-b border-slate-100 dark:border-slate-800 flex items-center gap-3">
                <div className="w-10 h-10 bg-violet-100 dark:bg-violet-900/30 rounded-xl flex items-center justify-center">
                    <Target size={20} className="text-violet-600 dark:text-violet-400" />
                </div>
                <div>
                    <h3 className="font-black text-slate-800 dark:text-white text-sm">Trilhas Didáticas</h3>
                    <p className="text-[10px] text-slate-400 uppercase tracking-widest">
                        {paths.length} trilhas disponíveis
                    </p>
                </div>
            </div>

            <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-4">
                {paths.length === 0 ? (
                    <div className="col-span-full text-center py-12 text-slate-400">
                        <BookOpen size={32} className="mx-auto mb-3 opacity-40" />
                        <p className="text-sm font-bold">Nenhuma trilha disponível ainda</p>
                        <p className="text-xs mt-1">Peça à sua escola para criar trilhas didáticas personalizadas.</p>
                    </div>
                ) : (
                    paths.map(path => {
                        const meta = CATEGORY_META[path.category] || CATEGORY_META.GENERAL;
                        const Icon = meta.icon;
                        const isEnrolled = enrolledPathId === path.id;

                        return (
                            <button
                                key={path.id}
                                onClick={() => isEnrolled ? (setSelectedPath(path), loadPathDetails(path.id)) : enrollInPath(path)}
                                className={`text-left rounded-2xl border-2 transition-all p-5 hover:shadow-lg ${
                                    isEnrolled
                                        ? 'border-violet-500 dark:border-violet-400'
                                        : 'border-slate-100 dark:border-slate-800 hover:border-violet-200 dark:hover:border-violet-700'
                                }`}
                            >
                                <div className={`w-10 h-10 rounded-xl bg-gradient-to-br ${meta.color} text-white flex items-center justify-center mb-3`}>
                                    <Icon size={18} />
                                </div>
                                <div className="flex items-center gap-2 mb-2">
                                    <span className="text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600">{meta.label}</span>
                                    <span className="text-[9px] font-bold uppercase tracking-widest text-violet-500">{path.target_level}</span>
                                    {isEnrolled && (
                                        <span className="text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full bg-violet-100 dark:bg-violet-900/30 text-violet-600 dark:text-violet-300">Em curso</span>
                                    )}
                                </div>
                                <p className="font-black text-slate-800 dark:text-white text-sm">{path.name}</p>
                                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 line-clamp-2">{path.description}</p>
                                <div className="flex items-center justify-between mt-3 text-[10px] text-slate-400">
                                    <span>~{path.estimated_hours}h totais</span>
                                    <span className="text-violet-500 font-bold flex items-center gap-1">
                                        {isEnrolled ? 'Continuar' : 'Iniciar'} <ChevronRight size={12} />
                                    </span>
                                </div>
                            </button>
                        );
                    })
                )}
            </div>
        </div>
    );
};

export default StudentLearningPaths;
