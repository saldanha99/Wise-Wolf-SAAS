import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { AlertCircle, BookOpen, Trophy, Lock, Check, ChevronRight, Loader2, Sparkles, Play, Star, Target, Briefcase, Plane, GraduationCap, Cpu, Heart, Globe, Crown, Flame, Gem, Medal, RefreshCw } from 'lucide-react';
import { supabase } from '../lib/supabase';
import ActivityPlayer from './ActivityPlayer';
import StreakModal from './StreakModal';
import { gamificationService } from '../services/gamificationService';

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

// Offset horizontal serpenteante (estilo Duolingo) — ciclo de 8 nós.
// Amplitude reduzida para caber no mobile (combinada com o container max-w centralizado abaixo).
const ZIGZAG = [0, 32, 48, 32, 0, -32, -48, -32];

const StudentLearningPaths: React.FC<Props> = ({ userId, tenantId, wolfieConfig }) => {
    const [loading, setLoading] = useState(true);
    const [paths, setPaths] = useState<LearningPath[]>([]);
    const [enrolledPathId, setEnrolledPathId] = useState<string | null>(null);
    const [enrolledPathStatus, setEnrolledPathStatus] = useState<'ACTIVE' | 'COMPLETED' | null>(null);
    const [selectedPath, setSelectedPath] = useState<LearningPath | null>(null);
    const [units, setUnits] = useState<LearningUnit[]>([]);
    const [activitiesByUnit, setActivitiesByUnit] = useState<Record<string, Activity[]>>({});
    const [progress, setProgress] = useState<Record<string, { status: string; score: number | null }>>({});
    const [activeActivity, setActiveActivity] = useState<Activity | null>(null);
    // Gamificação
    const [gami, setGami] = useState<{ xp: number; streak: number; hearts: number; dailyXp: number; dailyGoal: number; practicedToday: boolean }>({ xp: 0, streak: 0, hearts: 5, dailyXp: 0, dailyGoal: 30, practicedToday: false });
    const [leaderboard, setLeaderboard] = useState<{ full_name: string; xp: number }[]>([]);
    const [operationError, setOperationError] = useState('');
    const [retryPath, setRetryPath] = useState<LearningPath | null>(null);
    const [enrollingPathId, setEnrollingPathId] = useState<string | null>(null);
    const [switchRequired, setSwitchRequired] = useState(false);

    useEffect(() => {
        if (userId) { loadPaths(); loadGamification(); }
    }, [userId, tenantId]);

    const loadGamification = async () => {
        try {
            // O servidor regenera vidas e calcula o dia em America/Sao_Paulo.
            const { data: status, error: statusError } = await supabase.rpc('get_student_practice_status');
            if (statusError) throw statusError;
            if (status) {
                setGami({
                    xp: Number(status.xp ?? 0),
                    streak: Number(status.streakCount ?? 0),
                    hearts: Number(status.hearts ?? 5),
                    dailyXp: Number(status.dailyXp ?? 0),
                    dailyGoal: Number(status.dailyXpGoal ?? 30),
                    practicedToday: status.practicedToday === true,
                });
            }
            // Ranking voluntário e pseudônimo, filtrado no servidor. O aluno não
            // consulta o diretório de perfis nem enxerga colegas sem opt-in.
            const { data: lb, error: leaderboardError } = await supabase.rpc(
                'get_student_opt_in_leaderboard',
                { p_limit: 5 },
            );
            if (leaderboardError) throw leaderboardError;
            setLeaderboard((Array.isArray(lb) ? lb : []).map((entry: any, index: number) => ({
                full_name: entry.displayName || `Lobo ${index + 1}`,
                xp: Number(entry.xp ?? 0),
            })));
        } catch (err) {
            console.error('loadGamification error:', err);
        }
    };

    const loadPaths = async () => {
        setLoading(true);
        setOperationError('');
        try {
            const { data: pathsData, error: pathsError } = await supabase
                .from('learning_paths')
                .select('*')
                .eq('active', true)
                .or(`tenant_id.is.null,tenant_id.eq.${tenantId || 'none'}`)
                .order('created_at', { ascending: true });
            if (pathsError) throw pathsError;

            let visiblePaths = pathsData || [];

            // Prefere a matrícula ativa, mas preserva a trilha concluída como
            // revisável. Antes, completed_at=null fazia uma trilha desaparecer
            // depois do último exercício e o card voltava incorretamente a "Iniciar".
            const { data: enrollRows, error: enrollmentError } = await supabase
                .from('student_path_enrollments')
                .select('path_id, current_unit_id, status, completed_at, started_at')
                .eq('student_id', userId)
                .in('status', ['ACTIVE', 'COMPLETED'])
                .order('started_at', { ascending: false })
                .limit(20);
            if (enrollmentError) throw enrollmentError;
            const normalizedEnrollments = Array.isArray(enrollRows) ? enrollRows : [];
            const enrollData = normalizedEnrollments.find((enrollment: any) => (
                String(enrollment.status || 'ACTIVE').toUpperCase() === 'ACTIVE'
                && !enrollment.completed_at
            )) || normalizedEnrollments.find((enrollment: any) => (
                String(enrollment.status || '').toUpperCase() === 'COMPLETED'
                || !!enrollment.completed_at
            )) || null;

            if (enrollData) {
                setEnrolledPathId(enrollData.path_id);
                setEnrolledPathStatus(
                    String(enrollData.status || 'ACTIVE').toUpperCase() === 'COMPLETED'
                    || !!enrollData.completed_at
                        ? 'COMPLETED'
                        : 'ACTIVE',
                );
                let path = visiblePaths.find(p => p.id === enrollData.path_id);
                if (!path && (
                    String(enrollData.status || '').toUpperCase() === 'COMPLETED'
                    || !!enrollData.completed_at
                )) {
                    // A escola pode arquivar uma trilha depois de todos concluírem.
                    // A política do banco mantém apenas essa trilha histórica
                    // revisável para o próprio aluno, sem republicá-la no catálogo.
                    const { data: archivedPath, error: archivedPathError } = await supabase
                        .from('learning_paths')
                        .select('*')
                        .eq('id', enrollData.path_id)
                        .maybeSingle();
                    if (archivedPathError) throw archivedPathError;
                    if (archivedPath) {
                        path = archivedPath;
                        visiblePaths = [...visiblePaths, archivedPath];
                    }
                }
                setPaths(visiblePaths);
                if (path) {
                    await loadPathDetails(path.id);
                    setSelectedPath(path);
                }
            } else {
                setPaths(visiblePaths);
                setEnrolledPathId(null);
                setEnrolledPathStatus(null);
                setSelectedPath(null);
            }
        } catch (err) {
            console.error('loadPaths error:', err);
            setSelectedPath(null);
            setOperationError('Não foi possível carregar suas trilhas. Tente novamente.');
        } finally {
            setLoading(false);
        }
    };

    const loadPathDetails = async (pathId: string) => {
        // O servidor entrega somente a versão pedagógica do conteúdo. Gabaritos de
        // quiz/gramática nunca atravessam esta fronteira nem ficam inspecionáveis
        // no navegador do aluno. O runtime anterior permanece visível durante a
        // recarga: se a rede falhar após uma conclusão, a trilha não desaparece nem
        // libera um nó sem conteúdo.
        const { data: runtime, error: runtimeError } = await supabase.rpc(
            'get_student_learning_path_runtime',
            { p_path_id: pathId },
        );
        if (runtimeError) throw runtimeError;

        const unitsData = Array.isArray(runtime?.units) ? runtime.units as LearningUnit[] : [];
        const activitiesData = Array.isArray(runtime?.activities) ? runtime.activities as Activity[] : [];
        const progressData = Array.isArray(runtime?.progress)
            ? runtime.progress as { activity_id: string; status: string; score: number | null }[]
            : [];

        setUnits(unitsData);

        const grouped: Record<string, Activity[]> = {};
        activitiesData.forEach((activity) => {
            if (!grouped[activity.unit_id]) grouped[activity.unit_id] = [];
            grouped[activity.unit_id].push(activity);
        });
        setActivitiesByUnit(grouped);

        const progMap: Record<string, { status: string; score: number | null }> = {};
        progressData.forEach((item) => {
            progMap[item.activity_id] = { status: item.status, score: item.score };
        });
        setProgress(progMap);
        if (
            activitiesData.length > 0
            && activitiesData.every(activity => progMap[activity.id]?.status === 'COMPLETED')
        ) {
            setEnrolledPathStatus('COMPLETED');
        }
    };

    const openEnrolledPath = async (path: LearningPath) => {
        setOperationError('');
        try {
            await loadPathDetails(path.id);
            setSelectedPath(path);
        } catch (err) {
            console.error('openEnrolledPath error:', err);
            setSelectedPath(null);
            setOperationError('Não foi possível abrir esta trilha. Tente novamente.');
        }
    };

    const enrollInPath = async (path: LearningPath, switchCurrent = false) => {
        if (enrollingPathId) return;
        setEnrollingPathId(path.id);
        setOperationError('');
        setRetryPath(null);
        setSwitchRequired(false);
        try {
            const { error } = await supabase.rpc('enroll_student_learning_path', {
                p_path_id: path.id,
                p_switch_current: switchCurrent,
                p_reason: switchCurrent ? 'STUDENT_REQUESTED_SWITCH' : null,
                p_student_id: null,
            });
            if (error) throw error;
            await loadPathDetails(path.id);
            setEnrolledPathId(path.id);
            setEnrolledPathStatus('ACTIVE');
            setSelectedPath(path);
        } catch (err) {
            console.error('enrollInPath error:', err);
            const requiresSwitch = String((err as any)?.message || '').toLowerCase().includes('active_path_switch_required');
            setOperationError(requiresSwitch
                ? 'Você já está em outra trilha. A troca preserva todo o histórico já conquistado.'
                : 'Não foi possível iniciar esta trilha. Nenhuma matrícula foi alterada.');
            setRetryPath(path);
            setSwitchRequired(requiresSwitch);
        } finally {
            setEnrollingPathId(null);
        }
    };

    const handleActivityComplete = async (_score: number) => {
        setActiveActivity(null);
        // A próxima atividade estava deliberadamente sem conteúdo enquanto
        // bloqueada. Recarregue o runtime sanitizado antes de liberar o novo nó;
        // uma atualização apenas visual abriria a etapa seguinte com content=null.
        if (selectedPath) {
            try {
                await loadPathDetails(selectedPath.id);
                setOperationError('');
            } catch (error) {
                console.error('learning path refresh after completion failed:', error);
                setOperationError('A atividade foi registrada, mas a próxima etapa ainda não pôde ser carregada. Atualize a trilha para continuar.');
            }
        }
        await loadGamification();
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
                <StreakModal userId={userId} streak={gami.streak} practicedToday={gami.practicedToday} />
                {/* Barra de status estilo Duolingo: ofensiva · XP · vidas */}
                <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 sm:gap-x-6 px-3 sm:px-4 py-3 border-b border-slate-100 dark:border-slate-800 bg-white/60 dark:bg-slate-900/60 backdrop-blur-sm">
                    {/* Ofensiva */}
                    <div className="flex items-center gap-1.5" title="Ofensiva (dias seguidos)">
                        <Flame size={20} className={gami.streak > 0 ? 'text-orange-500' : 'text-slate-300'} fill={gami.streak > 0 ? '#f97316' : 'none'} />
                        <span className="font-black text-base text-slate-700 dark:text-slate-200">{gami.streak}</span>
                    </div>
                    <span className="w-px h-5 bg-slate-200 dark:bg-slate-700" />
                    {/* XP / gemas */}
                    <div className="flex items-center gap-1.5" title="XP total">
                        <Gem size={19} className="text-sky-500" fill="#0ea5e9" />
                        <span className="font-black text-base text-slate-700 dark:text-slate-200">{gami.xp}</span>
                    </div>
                    <span className="w-px h-5 bg-slate-200 dark:bg-slate-700" />
                    {/* Vidas */}
                    <div className="flex items-center gap-0.5 sm:gap-1" title="Vidas">
                        {[0, 1, 2, 3, 4].map((i) => (
                            <Heart key={i} size={15} className={i < gami.hearts ? 'text-rose-500' : 'text-slate-200 dark:text-slate-700'} fill={i < gami.hearts ? '#f43f5e' : 'none'} />
                        ))}
                    </div>
                    <span className="w-px h-5 bg-slate-200 dark:bg-slate-700" />
                    {/* Meta diária (anel de progresso) */}
                    <div className="flex items-center gap-1.5" title={`Meta diária: ${gami.dailyXp}/${gami.dailyGoal} XP`}>
                        {(() => {
                            const pct = Math.min(100, Math.round((gami.dailyXp / Math.max(1, gami.dailyGoal)) * 100));
                            const done = gami.dailyXp >= gami.dailyGoal;
                            return (
                                <div className="relative w-7 h-7">
                                    <svg viewBox="0 0 36 36" className="w-7 h-7 -rotate-90">
                                        <circle cx="18" cy="18" r="15" fill="none" strokeWidth="4" className="stroke-slate-200 dark:stroke-slate-700" />
                                        <circle cx="18" cy="18" r="15" fill="none" strokeWidth="4" strokeLinecap="round"
                                            stroke={done ? '#22c55e' : '#f59e0b'}
                                            strokeDasharray={`${(pct / 100) * 94.2} 94.2`} />
                                    </svg>
                                    <span className="absolute inset-0 flex items-center justify-center text-[9px]">{done ? '✅' : '🎯'}</span>
                                </div>
                            );
                        })()}
                        <span className="font-black text-xs text-slate-600 dark:text-slate-300">{gami.dailyXp}/{gami.dailyGoal}</span>
                    </div>
                </div>

                {/* Header sticky com progresso */}
                <div className={`bg-gradient-to-br ${meta.color} p-4 sm:p-6 text-white relative overflow-hidden`}>
                    <div className="absolute -right-8 -top-8 w-40 h-40 rounded-full bg-white/10" />
                    <button
                        onClick={() => setSelectedPath(null)}
                        className="absolute top-4 right-4 text-xs font-bold uppercase tracking-widest opacity-70 hover:opacity-100 transition-opacity z-10"
                    >
                        ← Trilhas
                    </button>
                    <Icon size={28} className="mb-3 opacity-90 relative" />
                    <p className="text-[10px] font-bold uppercase tracking-widest opacity-80 relative">{meta.label} · {selectedPath.target_level}</p>
                    <h2 className="text-xl sm:text-2xl font-black mt-1 relative pr-20">{selectedPath.name}</h2>

                    <div className="mt-5 relative">
                        <div className="flex items-center justify-between mb-2">
                            <span className="text-[10px] font-bold uppercase tracking-widest opacity-80 flex items-center gap-1">
                                <Trophy size={12} /> {completedCount} atividade{completedCount === 1 ? '' : 's'} concluída{completedCount === 1 ? '' : 's'}
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

                {operationError && (
                    <div role="alert" className="mx-4 mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-amber-950 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-100 sm:mx-6">
                        <div className="flex items-start gap-3">
                            <AlertCircle size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
                            <div className="min-w-0 flex-1">
                                <p className="text-sm font-black">{operationError}</p>
                                <button
                                    type="button"
                                    onClick={() => {
                                        setOperationError('');
                                        void loadPathDetails(selectedPath.id).catch((error) => {
                                            console.error('learning path manual refresh failed:', error);
                                            setOperationError('A trilha ainda não pôde ser atualizada. Sua conclusão continua salva; tente novamente em instantes.');
                                        });
                                    }}
                                    className="mt-3 inline-flex items-center gap-2 rounded-xl bg-amber-600 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-white hover:bg-amber-700"
                                >
                                    <RefreshCw size={13} /> Atualizar trilha
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {/* TRILHA */}
                <div className="px-4 py-5 sm:py-8 sm:px-8 max-w-sm sm:max-w-md mx-auto">
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
                                <div className="flex flex-col items-center py-3 w-full max-w-[280px] mx-auto">
                                    {acts.map((a) => {
                                        const flatIdx = flat.findIndex(f => f.activity.id === a.id);
                                        const p = progress[a.id];
                                        const done = p?.status === 'COMPLETED';
                                        const isCurrent = flatIdx === currentIdx;
                                        const locked = !done && !isCurrent && flatIdx > currentIdx;
                                        const awardsVerifiedXp = ['quiz', 'grammar_drill'].includes(a.type) && a.xp_reward > 0;
                                        const offset = ZIGZAG[globalNodeIdx % ZIGZAG.length];
                                        globalNodeIdx++;

                                        return (
                                            <div key={a.id} className="relative flex flex-col items-center shrink-0 max-w-full" style={{ transform: `translateX(${offset}px)` }}>
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
                                                    aria-label={done ? `Revisar ${a.title}` : locked ? `${a.title} bloqueada` : `Abrir ${a.title}`}
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
                                                <div className="mt-2 mb-5 text-center max-w-[112px] sm:max-w-[140px]">
                                                    <p className={`text-[11px] font-bold leading-tight ${locked ? 'text-slate-300 dark:text-slate-600' : 'text-slate-700 dark:text-slate-200'}`}>
                                                        {a.title}
                                                    </p>
                                                    {!locked && (
                                                        <p className="text-[9px] text-slate-400 mt-0.5">
                                                            {awardsVerifiedXp ? `${a.xp_reward} XP` : 'Prática'}
                                                            {done && p?.score != null ? ` · ${p.score}%` : ''}
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

                    {/* ── Liga / Ranking ── */}
                    {leaderboard.length > 0 && (
                        <div className="mt-6 sm:mt-10 max-w-md mx-auto">
                            <div className="rounded-3xl border border-slate-100 dark:border-slate-800 overflow-hidden bg-white dark:bg-slate-900">
                                {(() => {
                                    const div = gamificationService.leagueDivision(gami.xp);
                                    const faltam = div.next != null ? div.next - gami.xp : 0;
                                    return (
                                        <div className="px-5 py-3.5 text-white" style={{ background: `linear-gradient(135deg, ${div.cor}, ${div.cor}cc)` }}>
                                            <div className="flex items-center gap-2">
                                                <span className="text-xl">{div.emoji}</span>
                                                <div className="flex-1">
                                                    <p className="font-black text-sm uppercase tracking-wide">Liga {div.tier}</p>
                                                    {div.next != null
                                                        ? <p className="text-[10px] opacity-90">Faltam {faltam} XP para a próxima divisão</p>
                                                        : <p className="text-[10px] opacity-90">Divisão máxima! 👑</p>}
                                                </div>
                                                <Medal size={18} className="opacity-80" />
                                            </div>
                                        </div>
                                    );
                                })()}
                                <ul className="divide-y divide-slate-50 dark:divide-slate-800">
                                    {leaderboard.map((s, i) => {
                                        const medal = ['🥇', '🥈', '🥉'][i];
                                        return (
                                            <li key={i} className="flex items-center gap-3 px-5 py-2.5">
                                                <span className="w-7 text-center font-black text-sm shrink-0">
                                                    {medal || <span className="text-slate-400">{i + 1}</span>}
                                                </span>
                                                <div className="w-8 h-8 rounded-full bg-violet-100 dark:bg-violet-900/30 flex items-center justify-center text-violet-600 dark:text-violet-300 font-black text-xs shrink-0">
                                                    {(s.full_name || '?').charAt(0).toUpperCase()}
                                                </div>
                                                <span className="flex-1 min-w-0 text-sm font-bold text-slate-700 dark:text-slate-200 truncate">{s.full_name || 'Aluno'}</span>
                                                <span className="flex items-center gap-1 text-sm font-black text-sky-500 shrink-0">
                                                    <Gem size={13} fill="#0ea5e9" /> {s.xp ?? 0}
                                                </span>
                                            </li>
                                        );
                                    })}
                                </ul>
                            </div>
                        </div>
                    )}
                </div>

                {activeActivity && (
                    <ActivityPlayer
                        activity={activeActivity}
                        userId={userId}
                        wolfieConfig={wolfieConfig}
                        hearts={gami.hearts}
                        reviewOnly={progress[activeActivity.id]?.status === 'COMPLETED'}
                        onHeartsChange={(h) => setGami(g => ({ ...g, hearts: h }))}
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
            <StreakModal userId={userId} streak={gami.streak} practicedToday={gami.practicedToday} />
            <div className="p-6 border-b border-slate-100 dark:border-slate-800 flex items-center gap-3">
                <div className="w-10 h-10 bg-violet-100 dark:bg-violet-900/30 rounded-xl flex items-center justify-center">
                    <Target size={20} className="text-violet-600 dark:text-violet-400" />
                </div>
                <div>
                    <h3 className="font-black text-slate-800 dark:text-white text-sm">Trilhas Didáticas</h3>
                    <p className="text-[10px] text-slate-400 uppercase tracking-widest">{paths.length} trilhas disponíveis</p>
                </div>
            </div>

            {operationError && (
                <div role="alert" className="mx-4 mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-amber-950 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-100 sm:mx-6">
                    <div className="flex items-start gap-3">
                        <AlertCircle size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
                        <div className="min-w-0 flex-1">
                            <p className="text-sm font-black">{operationError}</p>
                            <div className="mt-3 flex flex-wrap gap-2">
                                {retryPath && !switchRequired && (
                                    <button type="button" onClick={() => void enrollInPath(retryPath)} disabled={!!enrollingPathId} className="inline-flex items-center gap-2 rounded-xl bg-amber-600 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-white hover:bg-amber-700 disabled:opacity-50">
                                        <RefreshCw size={13} className={enrollingPathId ? 'animate-spin' : ''} /> Tentar novamente
                                    </button>
                                )}
                                {!retryPath && (
                                    <button type="button" onClick={() => void loadPaths()} disabled={loading} className="inline-flex items-center gap-2 rounded-xl bg-amber-600 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-white hover:bg-amber-700 disabled:opacity-50">
                                        <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Tentar novamente
                                    </button>
                                )}
                                {retryPath && switchRequired && (
                                    <button type="button" onClick={() => void enrollInPath(retryPath, true)} disabled={!!enrollingPathId} className="inline-flex items-center gap-2 rounded-xl bg-violet-600 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-white hover:bg-violet-700 disabled:opacity-50">
                                        <RefreshCw size={13} className={enrollingPathId ? 'animate-spin' : ''} /> Trocar de trilha
                                    </button>
                                )}
                                <button type="button" onClick={() => { setOperationError(''); setRetryPath(null); setSwitchRequired(false); }} className="rounded-xl px-3 py-2 text-[10px] font-black uppercase tracking-widest text-amber-800 hover:bg-amber-100 dark:text-amber-200 dark:hover:bg-amber-900/30">
                                    Agora não
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            <div className="p-4 sm:p-6 grid grid-cols-1 md:grid-cols-2 gap-4">
                {paths.length === 0 && !operationError ? (
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
                        const isCompleted = isEnrolled && enrolledPathStatus === 'COMPLETED';

                        return (
                            <button
                                key={path.id}
                                onClick={() => isEnrolled ? void openEnrolledPath(path) : void enrollInPath(path)}
                                disabled={!!enrollingPathId}
                                aria-busy={enrollingPathId === path.id}
                                className={`text-left rounded-2xl border-2 transition-all p-4 sm:p-5 hover:shadow-lg hover:-translate-y-0.5 ${
                                    isEnrolled
                                        ? 'border-violet-500 dark:border-violet-400'
                                        : 'border-slate-100 dark:border-slate-800 hover:border-violet-200 dark:hover:border-violet-700'
                                } disabled:cursor-wait disabled:opacity-60`}
                            >
                                <div className={`w-12 h-12 rounded-2xl bg-gradient-to-br ${meta.color} text-white flex items-center justify-center mb-3`} style={{ boxShadow: `0 4px 0 ${meta.solid}99` }}>
                                    <Icon size={20} />
                                </div>
                                <div className="flex items-center gap-2 mb-2 flex-wrap">
                                    <span className="text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600">{meta.label}</span>
                                    <span className="text-[9px] font-bold uppercase tracking-widest text-violet-500">{path.target_level}</span>
                                    {isEnrolled && (
                                        <span className={`text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full ${isCompleted ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-200' : 'bg-violet-100 text-violet-600 dark:bg-violet-900/30 dark:text-violet-300'}`}>
                                            {isCompleted ? 'Concluída' : 'Em curso'}
                                        </span>
                                    )}
                                </div>
                                <p className="font-black text-slate-800 dark:text-white text-sm">{path.name}</p>
                                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 line-clamp-2">{path.description}</p>
                                <div className="flex items-center justify-between mt-3 text-[10px] text-slate-400">
                                    <span>~{path.estimated_hours}h totais</span>
                                    <span className="text-violet-500 font-bold flex items-center gap-1">
                                        {enrollingPathId === path.id ? 'Iniciando...' : isCompleted ? 'Revisar' : isEnrolled ? 'Continuar' : 'Iniciar'} <ChevronRight size={12} />
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
