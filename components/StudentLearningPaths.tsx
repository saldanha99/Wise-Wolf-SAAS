import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { BookOpen, Trophy, Lock, Check, ChevronRight, Loader2, Sparkles, Play, Star, Target, Briefcase, Plane, GraduationCap, Cpu, Heart, Globe, Crown } from 'lucide-react';
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

const CATEGORY_META: Record<string, { icon: React.ElementType; color: string; solid: string; label: string }> = {
    BUSINESS: { icon: Briefcase, color: 'from-blue-500 to-indigo-600', solid: '#4f46e5', label: 'Business' },
    TOEFL_IELTS: { icon: GraduationCap, color: 'from-purple-500 to-pink-600', solid: '#9333ea', label: 'TOEFL / IELTS' },
    TRAVEL: { icon: Plane, color: 'from-amber-500 to-orange-600', solid: '#f59e0b', label: 'Viagem' },
    KIDS: { icon: Heart, color: 'from-pink-500 to-rose-600', solid: '#ec4899', label: 'Inglês para Crianças' },
    TECH: { icon: Cpu, color: 'from-emerald-500 to-teal-600', solid: '#10b981', label: 'Tecnologia' },
    GENERAL: { icon: Globe, color: 'from-violet-500 to-purple-600', solid: '#8b5cf6', label: 'Geral' },
    CONVERSATION: { icon: Sparkles, color: 'from-cyan-500 to-blue-600', solid: '#06b6d4', label: 'Conversação' },
};

// Offset horizontal serpenteante (estilo Duolingo) — ciclo de 8 nós
const ZIGZAG = [0, 44, 64, 44, 0, -44, -64, -44];

const StudentLearningPaths: React.FC<Props> = ({ userId, tenantId, wolfieConfig }) => {
    const [loading, setLoading] = useState(true);
    const [paths, setPaths] = useState<LearningPath[]>([]);
    const [enrolledPathId, setEnrolledPathId] = useState<string | null>(null);
    const [selectedPath, setSelectedPath] = useState<LearningPath | null>(null);
    const [units, setUnits] = useState<LearningUnit[]>([]);
    const [activitiesByUnit, setActivitiesByUnit] = useState<Record<string, Activity[]>>({});
    const [progress, setProgress] = useState<Record<string, { status: string; score: number | null }>>({});
    const [activeActivity, setActiveActivity] = useState<Activity | null>(null);

    useEffect(() => {
        if (userId) loadPaths();
    }, [userId]);

    const loadPaths = async () => {
        setLoading(true);
        try {
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

    // ════════════════════════════════════════════════════════════
    // VIEW: Trilha selecionada — TRILHA ESTILO DUOLINGO
    // ════════════════════════════════════════════════════════════
    if (selectedPath) {
        const meta = CATEGORY_META[selectedPath.category] || CATEGORY_META.GENERAL;
        const Icon = meta.icon;

        const allActivities = Object.values(activitiesByUnit).flat() as Activity[];
        const completedCount = allActivities.filter(a => progress[a.id]?.status === 'COMPLETED').length;
        const totalCount = allActivities.length;
        const overallProgress = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

        // Flatten ordenado (units → activities) para lógica de desbloqueio sequencial
        const flat: { activity: Activity; unitIdx: number }[] = [];
        units.forEach((u, ui) => {
            (activitiesByUnit[u.id] || []).forEach(a => flat.push({ activity: a, unitIdx: ui }));
        });
        // Índice da primeira atividade não concluída = "atual"
        const currentIdx = flat.findIndex(f => progress[f.activity.id]?.status !== 'COMPLETED');

        let globalNodeIdx = 0; // para o zigzag contínuo

        return (
            <div className="bg-gradient-to-b from-violet-50 to-white dark:from-slate-900 dark:to-slate-950 rounded-[2.5rem] border border-slate-100 dark:border-slate-800 overflow-hidden">
                {/* Header sticky com progresso */}
                <div className={`bg-gradient-to-br ${meta.color} p-6 text-white relative overflow-hidden`}>
                    <div className="absolute -right-8 -top-8 w-40 h-40 rounded-full bg-white/10" />
                    <button
                        onClick={() => setSelectedPath(null)}
                        className="absolute top-4 right-4 text-xs font-bold uppercase tracking-widest opacity-70 hover:opacity-100 transition-opacity z-10"
                    >
                        ← Trilhas
                    </button>
                    <Icon size={28} className="mb-3 opacity-90 relative" />
                    <p className="text-[10px] font-bold uppercase tracking-widest opacity-80 relative">{meta.label} · {selectedPath.target_level}</p>
                    <h2 className="text-2xl font-black mt-1 relative">{selectedPath.name}</h2>

                    <div className="mt-5 relative">
                        <div className="flex items-center justify-between mb-2">
                            <span className="text-[10px] font-bold uppercase tracking-widest opacity-80 flex items-center gap-1">
                                <Trophy size={12} /> {completedCount * 10} XP
                            </span>
                            <span className="text-xs font-black">{completedCount}/{totalCount} · {overallProgress}%</span>
                        </div>
                        <div className="h-2.5 bg-black/20 rounded-full overflow-hidden">
                            <motion.div
                                className="h-full bg-white rounded-full"
                                initial={{ width: 0 }}
                                animate={{ width: `${overallProgress}%` }}
                                transition={{ duration: 0.6, ease: 'easeOut' }}
                            />
                        </div>
                    </div>
                </div>

                {/* TRILHA */}
                <div className="px-4 py-8 sm:px-8">
                    {units.map((unit, unitIdx) => {
                        const acts = activitiesByUnit[unit.id] || [];
                        if (acts.length === 0) return null;
                        const unitCompleted = acts.every(a => progress[a.id]?.status === 'COMPLETED');

                        return (
                            <div key={unit.id} className="mb-4">
                                {/* Banner da unidade (seção) */}
                                <div className={`rounded-2xl px-5 py-3.5 mb-2 flex items-center gap-3 shadow-sm ${
                                    unitCompleted ? 'bg-emerald-500' : ''
                                }`} style={!unitCompleted ? { background: meta.solid } : {}}>
                                    <div className="w-9 h-9 rounded-xl bg-white/20 flex items-center justify-center text-white shrink-0">
                                        {unitCompleted ? <Crown size={18} /> : <span className="font-black text-sm">{unitIdx + 1}</span>}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <p className="text-[10px] font-bold uppercase tracking-widest text-white/70">Unidade {unitIdx + 1}</p>
                                        <p className="text-sm font-black text-white truncate">{unit.title}</p>
                                    </div>
                                    {unit.estimated_minutes > 0 && (
                                        <span className="text-[10px] font-bold text-white/80 shrink-0">{unit.estimated_minutes}min</span>
                                    )}
                                </div>

                                {/* Nós da trilha */}
                                <div className="flex flex-col items-center py-3">
                                    {acts.map((a) => {
                                        const flatIdx = flat.findIndex(f => f.activity.id === a.id);
                                        const p = progress[a.id];
                                        const done = p?.status === 'COMPLETED';
                                        const isCurrent = flatIdx === currentIdx;
                                        const locked = !done && !isCurrent && flatIdx > currentIdx;
                                        const offset = ZIGZAG[globalNodeIdx % ZIGZAG.length];
                                        globalNodeIdx++;

                                        return (
                                            <div key={a.id} className="relative flex flex-col items-center" style={{ transform: `translateX(${offset}px)` }}>
                                                {/* Tooltip COMEÇAR na atividade atual */}
                                                {isCurrent && (
                                                    <motion.div
                                                        initial={{ y: 0 }}
                                                        animate={{ y: [-3, 3, -3] }}
                                                        transition={{ repeat: Infinity, duration: 1.6, ease: 'easeInOut' }}
                                                        className="absolute -top-11 z-20 whitespace-nowrap"
                                                    >
                                                        <div className="px-3 py-1.5 rounded-xl text-[11px] font-black uppercase tracking-wider shadow-lg" style={{ background: '#fff', color: meta.solid }}>
                                                            Começar
                                                            <div className="absolute left-1/2 -translate-x-1/2 -bottom-1.5 w-3 h-3 rotate-45 bg-white" />
                                                        </div>
                                                    </motion.div>
                                                )}

                                                {/* Nó circular 3D */}
                                                <motion.button
                                                    onClick={() => !locked && setActiveActivity(a)}
                                                    disabled={locked}
                                                    whileTap={!locked ? { scale: 0.92, y: 4 } : {}}
                                                    animate={isCurrent ? { scale: [1, 1.06, 1] } : {}}
                                                    transition={isCurrent ? { repeat: Infinity, duration: 1.8, ease: 'easeInOut' } : {}}
                                                    className="relative w-[68px] h-[68px] rounded-full flex items-center justify-center transition-colors disabled:cursor-not-allowed group"
                                                    style={{
                                                        background: done ? '#facc15' : isCurrent ? meta.solid : locked ? '#e2e8f0' : meta.solid,
                                                        boxShadow: locked
                                                            ? '0 5px 0 #cbd5e1'
                                                            : done
                                                            ? '0 5px 0 #ca8a04'
                                                            : `0 5px 0 ${meta.solid}cc, 0 5px 0 rgba(0,0,0,0.15)`,
                                                    }}
                                                    title={a.title}
                                                >
                                                    {done ? (
                                                        <Check size={28} className="text-white" strokeWidth={3.5} />
                                                    ) : locked ? (
                                                        <Lock size={24} className="text-slate-400" strokeWidth={2.5} />
                                                    ) : isCurrent ? (
                                                        <Star size={28} className="text-white" fill="white" strokeWidth={0} />
                                                    ) : (
                                                        <Play size={26} className="text-white" fill="white" strokeWidth={0} />
                                                    )}

                                                    {/* aro de progresso na atual */}
                                                    {isCurrent && (
                                                        <span className="absolute inset-[-6px] rounded-full border-4 border-white/40 animate-ping" />
                                                    )}
                                                </motion.button>

                                                {/* Label da atividade */}
                                                <div className="mt-2 mb-5 text-center max-w-[140px]">
                                                    <p className={`text-[11px] font-bold leading-tight ${locked ? 'text-slate-300 dark:text-slate-600' : 'text-slate-700 dark:text-slate-200'}`}>
                                                        {a.title}
                                                    </p>
                                                    {!locked && (
                                                        <p className="text-[9px] text-slate-400 mt-0.5">
                                                            {a.xp_reward} XP{done && p?.score != null ? ` · ${p.score}%` : ''}
                                                        </p>
                                                    )}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        );
                    })}

                    {/* Troféu final */}
                    <div className="flex flex-col items-center pt-2">
                        <div className={`w-20 h-20 rounded-full flex items-center justify-center ${overallProgress === 100 ? 'bg-amber-400' : 'bg-slate-200 dark:bg-slate-800'}`}
                            style={overallProgress === 100 ? { boxShadow: '0 6px 0 #d97706' } : { boxShadow: '0 6px 0 #cbd5e1' }}>
                            <Trophy size={36} className={overallProgress === 100 ? 'text-white' : 'text-slate-400'} />
                        </div>
                        <p className={`text-xs font-black mt-3 uppercase tracking-widest ${overallProgress === 100 ? 'text-amber-500' : 'text-slate-400'}`}>
                            {overallProgress === 100 ? 'Trilha concluída! 🎉' : 'Complete a trilha'}
                        </p>
                    </div>
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

    // ════════════════════════════════════════════════════════════
    // VIEW: Lista de trilhas disponíveis
    // ════════════════════════════════════════════════════════════
    return (
        <div className="bg-white dark:bg-slate-900 rounded-[2.5rem] border border-slate-100 dark:border-slate-800 overflow-hidden">
            <div className="p-6 border-b border-slate-100 dark:border-slate-800 flex items-center gap-3">
                <div className="w-10 h-10 bg-violet-100 dark:bg-violet-900/30 rounded-xl flex items-center justify-center">
                    <Target size={20} className="text-violet-600 dark:text-violet-400" />
                </div>
                <div>
                    <h3 className="font-black text-slate-800 dark:text-white text-sm">Trilhas Didáticas</h3>
                    <p className="text-[10px] text-slate-400 uppercase tracking-widest">{paths.length} trilhas disponíveis</p>
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
                                className={`text-left rounded-2xl border-2 transition-all p-5 hover:shadow-lg hover:-translate-y-0.5 ${
                                    isEnrolled
                                        ? 'border-violet-500 dark:border-violet-400'
                                        : 'border-slate-100 dark:border-slate-800 hover:border-violet-200 dark:hover:border-violet-700'
                                }`}
                            >
                                <div className={`w-12 h-12 rounded-2xl bg-gradient-to-br ${meta.color} text-white flex items-center justify-center mb-3`} style={{ boxShadow: `0 4px 0 ${meta.solid}99` }}>
                                    <Icon size={20} />
                                </div>
                                <div className="flex items-center gap-2 mb-2 flex-wrap">
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
