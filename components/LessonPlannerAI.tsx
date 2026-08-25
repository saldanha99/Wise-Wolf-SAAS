import React, { useEffect, useRef, useState } from 'react';
import {
    AlertCircle,
    Bot,
    BookOpen,
    Brain,
    CheckCircle2,
    Clock3,
    Database,
    History,
    RefreshCw,
    Save,
    Sparkles,
    User,
    Zap,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { User as UserType, UserRole } from '../types';

export interface LessonPlannerAIProps {
    user: UserType;
    tenantId?: string;
    adapter?: LessonPlannerAdapter;
}

export type PlannerTaskMode =
    | 'lesson_plan'
    | 'student_feedback'
    | 'oral_test'
    | 'homework'
    | 'class_script'
    | 'vocabulary'
    | 'presentation_coaching'
    | 'progress_report'
    | 'material_generation';

export interface StudentOption {
    id: string;
    full_name: string | null;
    module: string | null;
}

interface BookingStudentRow {
    student: StudentOption | StudentOption[] | null;
}

export interface StudentProfile {
    id: string;
    module: string | null;
    english_for: string | null;
    occupation: string | null;
    personality: string | null;
    preferred_topics: string[] | null;
}

export interface WolfIntelligence {
    accumulated_context: string | null;
    strong_points: string[] | null;
    weak_points: string[] | null;
    recommended_approach: string | null;
    total_classes_analyzed: number | null;
}

export interface LessonPlanHistoryItem {
    id: string;
    created_at: string;
    objectives: string | null;
    task_mode: PlannerTaskMode | null;
    duration_minutes: number | null;
}

interface PlannerExample {
    english: string;
    portuguese: string;
}

interface PlannerSection {
    title: string;
    minutes: number;
    teacher_guidance: string;
    student_task: string;
    examples: PlannerExample[];
}

interface PlannerVocabularyItem {
    item: string;
    meaning_pt: string;
    example_en: string;
    use_question_en: string;
}

interface PlannerTeacherQuestion {
    question_en: string;
    model_answer_en: string;
    translation_pt: string;
}

interface PlannerCorrection {
    focus: string;
    produced_or_likely_error: string;
    minimal_correction: string;
    natural_version: string;
    advanced_version: string;
    explanation_pt: string;
    micropractice: string[];
}

interface PlannerMaterial {
    title: string;
    usage: string;
}

interface PlannerAssessmentCriterion {
    criterion: string;
    what_to_observe: string;
    rating_guide: string;
}

interface StudentMemoryUpdate {
    lesson_objective: string;
    content_practiced: string[];
    new_vocabulary: string[];
    recurring_errors: string[];
    corrections_mastered: string[];
    strengths_observed: string[];
    homework_assigned: string;
    recommended_next_step: string;
    confidence_level: 'LOW' | 'MEDIUM' | 'HIGH';
    notes_to_verify: string[];
}

export interface PlannerPlan {
    task_mode: PlannerTaskMode;
    title: string;
    objective: string;
    level: string;
    duration_minutes: number;
    bilingual: boolean;
    overview: string;
    sections: PlannerSection[];
    vocabulary: PlannerVocabularyItem[];
    teacher_questions: PlannerTeacherQuestion[];
    expected_corrections: PlannerCorrection[];
    homework: string;
    materials: PlannerMaterial[];
    assessment_criteria: PlannerAssessmentCriterion[];
    strengths: string[];
    priorities: string[];
    next_steps: string[];
    student_memory_update: StudentMemoryUpdate;
    ai_memory_reflection: string;
    warnings: string[];
}

interface PlannerKnowledgeStatus {
    mode: string;
    sources: string[];
    rag_used: boolean;
}

interface GeneratedPlanState {
    runId: string;
    studentId: string;
    plan: PlannerPlan;
    knowledge: PlannerKnowledgeStatus;
    saved: boolean;
}

export interface LessonPlannerLearnerContext {
    profile: StudentProfile;
    intelligence: WolfIntelligence | null;
    history: LessonPlanHistoryItem[];
}

export interface LessonPlannerGenerateInput {
    learnerId: string;
    taskMode: PlannerTaskMode;
    bilingual: boolean;
    durationMinutes: number;
    teacherRequest: string;
}

export interface LessonPlannerAdapter {
    contextKey: string;
    listLearners: () => Promise<StudentOption[]>;
    loadLearnerContext: (learnerId: string) => Promise<LessonPlannerLearnerContext>;
    generate: (input: LessonPlannerGenerateInput) => Promise<unknown>;
    save?: (runId: string) => Promise<void>;
    capabilities?: {
        canPersist?: boolean;
        hasPedagogicalMemory?: boolean;
    };
}

type JsonRecord = Record<string, unknown>;

const TASK_MODE_OPTIONS: Array<{ value: PlannerTaskMode; label: string }> = [
    { value: 'lesson_plan', label: 'Plano de aula' },
    { value: 'student_feedback', label: 'Feedback do aluno' },
    { value: 'oral_test', label: 'Teste oral' },
    { value: 'homework', label: 'Tarefa de casa' },
    { value: 'class_script', label: 'Roteiro da aula' },
    { value: 'vocabulary', label: 'Vocabulário' },
    { value: 'presentation_coaching', label: 'Treino de apresentação' },
    { value: 'progress_report', label: 'Relatório de progresso' },
    { value: 'material_generation', label: 'Gerar material' },
];

const TASK_MODE_LABELS = Object.fromEntries(
    TASK_MODE_OPTIONS.map(({ value, label }) => [value, label]),
) as Record<PlannerTaskMode, string>;

const isRecord = (value: unknown): value is JsonRecord =>
    Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const errorMessage = (error: unknown, fallback: string): string => {
    if (error instanceof Error && error.message) return error.message;
    if (isRecord(error) && typeof error.message === 'string') return error.message;
    return fallback;
};

const apiErrorMessage = (data: unknown): string | null => {
    if (!isRecord(data)) return null;
    if (typeof data.error === 'string' && data.error.trim()) return data.error;
    if (typeof data.message === 'string' && data.message.trim()) return data.message;
    return null;
};

const isPlannerPlan = (value: unknown): value is PlannerPlan =>
    isRecord(value)
    && typeof value.title === 'string'
    && typeof value.objective === 'string'
    && typeof value.overview === 'string'
    && Array.isArray(value.sections)
    && Array.isArray(value.vocabulary)
    && Array.isArray(value.teacher_questions)
    && Array.isArray(value.expected_corrections)
    && Array.isArray(value.materials)
    && Array.isArray(value.assessment_criteria)
    && Array.isArray(value.strengths)
    && Array.isArray(value.priorities)
    && Array.isArray(value.next_steps)
    && isRecord(value.student_memory_update);

const parseKnowledgeStatus = (value: unknown): PlannerKnowledgeStatus => {
    if (!isRecord(value)) {
        return { mode: 'not_configured', sources: [], rag_used: false };
    }

    return {
        mode: typeof value.mode === 'string' ? value.mode : 'not_configured',
        sources: Array.isArray(value.sources)
            ? value.sources.flatMap((source) => {
                if (typeof source === 'string') return [source];
                if (isRecord(source) && typeof source.title === 'string') return [source.title];
                return [];
            })
            : [],
        rag_used: value.rag_used === true || value.vector_store_used === true,
    };
};

const parseGenerateResponse = (value: unknown): Omit<GeneratedPlanState, 'studentId' | 'saved'> => {
    if (!isRecord(value)) throw new Error('Resposta inválida do Planner AI.');
    const serverError = apiErrorMessage(value);
    if (serverError) throw new Error(serverError);
    if (typeof value.run_id !== 'string' || !value.run_id || !isPlannerPlan(value.plan)) {
        throw new Error('O Planner AI não devolveu um plano estruturado válido.');
    }

    return {
        runId: value.run_id,
        plan: value.plan,
        knowledge: parseKnowledgeStatus(value.knowledge),
    };
};

const listHasItems = (items: string[] | null | undefined): items is string[] =>
    Array.isArray(items) && items.length > 0;

const MemoryList: React.FC<{ label: string; items: string[] }> = ({ label, items }) => {
    if (!items.length) return null;
    return (
        <div>
            <p className="text-[9px] font-black uppercase tracking-widest text-brand-muted mb-1">{label}</p>
            <ul className="space-y-1">
                {items.map((item, index) => (
                    <li key={`${label}-${index}`} className="text-xs text-brand-text dark:text-slate-200">
                        • {item}
                    </li>
                ))}
            </ul>
        </div>
    );
};

const LessonPlannerAI: React.FC<LessonPlannerAIProps> = ({ user, tenantId, adapter }) => {
    const activeTenantId = tenantId || user.tenantId;
    const activeContextKey = adapter?.contextKey || activeTenantId;
    const canPersist = adapter?.capabilities?.canPersist ?? true;
    const hasPedagogicalMemory = adapter?.capabilities?.hasPedagogicalMemory ?? true;
    const selectedStudentRef = useRef('');
    const [students, setStudents] = useState<StudentOption[]>([]);
    const [selectedStudent, setSelectedStudent] = useState('');
    const [loading, setLoading] = useState(true);
    const [contextLoading, setContextLoading] = useState(false);
    const [generating, setGenerating] = useState(false);
    const [saving, setSaving] = useState(false);
    const [customPrompt, setCustomPrompt] = useState('');
    const [taskMode, setTaskMode] = useState<PlannerTaskMode>('lesson_plan');
    const [bilingual, setBilingual] = useState(true);
    const [durationMinutes, setDurationMinutes] = useState(30);
    const [generatedPlan, setGeneratedPlan] = useState<GeneratedPlanState | null>(null);
    const [history, setHistory] = useState<LessonPlanHistoryItem[]>([]);
    const [studentProfile, setStudentProfile] = useState<StudentProfile | null>(null);
    const [wolfIntelligence, setWolfIntelligence] = useState<WolfIntelligence | null>(null);
    const [error, setError] = useState('');
    const [statusMessage, setStatusMessage] = useState('');

    useEffect(() => {
        selectedStudentRef.current = '';
        setSelectedStudent('');
        setGeneratedPlan(null);
        setStudentProfile(null);
        setWolfIntelligence(null);
        setHistory([]);
        setStatusMessage('');
    }, [activeContextKey]);

    useEffect(() => {
        let active = true;

        const fetchStudents = async (): Promise<void> => {
            setLoading(true);
            setError('');
            try {
                let nextStudents: StudentOption[] = [];
                if (adapter) {
                    nextStudents = await adapter.listLearners();
                } else if (!activeTenantId) {
                    throw new Error('Selecione uma escola antes de usar o Planner AI.');
                } else if (user.role === UserRole.SCHOOL_ADMIN || user.role === UserRole.SUPER_ADMIN) {
                    const { data, error: queryError } = await supabase
                        .from('profiles')
                        .select('id, full_name, module')
                        .eq('tenant_id', activeTenantId)
                        .eq('role', UserRole.STUDENT)
                        .order('full_name');

                    if (queryError) throw queryError;
                    nextStudents = (data || []) as StudentOption[];
                } else {
                    const { data, error: queryError } = await supabase
                        .from('bookings')
                        .select('student:student_id(id, full_name, module)')
                        .eq('tenant_id', activeTenantId)
                        .eq('teacher_id', user.id)
                        .or('status.eq.SCHEDULED,status.is.null');

                    if (queryError) throw queryError;
                    const rows = (data || []) as unknown as BookingStudentRow[];
                    const uniqueStudents = new Map<string, StudentOption>();
                    for (const row of rows) {
                        const relation = Array.isArray(row.student) ? row.student[0] : row.student;
                        if (relation?.id) uniqueStudents.set(relation.id, relation);
                    }
                    nextStudents = [...uniqueStudents.values()]
                        .sort((left, right) => (left.full_name || '').localeCompare(right.full_name || '', 'pt-BR'));
                }

                if (active) setStudents(nextStudents);
            } catch (queryError: unknown) {
                if (active) {
                    setStudents([]);
                    setError(errorMessage(queryError, 'Não foi possível carregar os alunos.'));
                }
            } finally {
                if (active) setLoading(false);
            }
        };

        void fetchStudents();
        return () => {
            active = false;
        };
    }, [activeContextKey, activeTenantId, adapter, user.id, user.role]);

    useEffect(() => {
        let active = true;

        const fetchStudentContext = async (): Promise<void> => {
            if (!selectedStudent || (!adapter && !activeTenantId)) {
                setStudentProfile(null);
                setWolfIntelligence(null);
                setHistory([]);
                return;
            }

            setContextLoading(true);
            setError('');
            try {
                if (adapter) {
                    const context = await adapter.loadLearnerContext(selectedStudent);
                    if (active) {
                        setStudentProfile(context.profile);
                        setWolfIntelligence(context.intelligence);
                        setHistory(context.history);
                    }
                } else {
                    const [profileRes, wolfRes, historyRes] = await Promise.all([
                        supabase
                            .from('profiles')
                            .select('id, module, english_for, occupation, personality, preferred_topics')
                            .eq('tenant_id', activeTenantId)
                            .eq('id', selectedStudent)
                            .maybeSingle(),
                        supabase
                            .from('wolf_intelligence')
                            .select('accumulated_context, strong_points, weak_points, recommended_approach, total_classes_analyzed')
                            .eq('tenant_id', activeTenantId)
                            .eq('student_id', selectedStudent)
                            .maybeSingle(),
                        supabase
                            .from('lesson_plans')
                            .select('id, created_at, objectives, task_mode, duration_minutes')
                            .eq('tenant_id', activeTenantId)
                            .eq('student_id', selectedStudent)
                            .order('created_at', { ascending: false })
                            .limit(5),
                    ]);

                    if (profileRes.error) throw profileRes.error;
                    if (wolfRes.error) throw wolfRes.error;
                    if (historyRes.error) throw historyRes.error;
                    if (!profileRes.data) throw new Error('Aluno não encontrado nesta escola.');

                    if (active) {
                        setStudentProfile(profileRes.data as StudentProfile);
                        setWolfIntelligence((wolfRes.data as WolfIntelligence | null) || null);
                        setHistory((historyRes.data || []) as LessonPlanHistoryItem[]);
                    }
                }
            } catch (queryError: unknown) {
                if (active) {
                    setStudentProfile(null);
                    setWolfIntelligence(null);
                    setHistory([]);
                    setError(errorMessage(queryError, 'Não foi possível carregar o contexto do aluno.'));
                }
            } finally {
                if (active) setContextLoading(false);
            }
        };

        void fetchStudentContext();
        return () => {
            active = false;
        };
    }, [activeContextKey, activeTenantId, adapter, selectedStudent]);

    const handleStudentChange = (studentId: string): void => {
        selectedStudentRef.current = studentId;
        setSelectedStudent(studentId);
        setGeneratedPlan(null);
        setStudentProfile(null);
        setWolfIntelligence(null);
        setHistory([]);
        setError('');
        setStatusMessage('');
    };

    const handleGeneratePlan = async (): Promise<void> => {
        if (!selectedStudent || generating) return;
        const requestedStudentId = selectedStudent;
        setGenerating(true);
        setError('');
        setStatusMessage('');
        setGeneratedPlan(null);

        try {
            let response: unknown;
            if (adapter) {
                response = await adapter.generate({
                    learnerId: requestedStudentId,
                    taskMode,
                    bilingual,
                    durationMinutes,
                    teacherRequest: customPrompt.trim(),
                });
            } else {
                const { data, error: invokeError } = await supabase.functions.invoke<unknown>('lesson-planner', {
                    body: {
                        action: 'generate',
                        student_id: requestedStudentId,
                        task_mode: taskMode,
                        bilingual,
                        duration_minutes: durationMinutes,
                        teacher_request: customPrompt.trim(),
                    },
                });

                if (invokeError) {
                    throw new Error(apiErrorMessage(data) || invokeError.message || 'Falha ao consultar o Planner AI.');
                }
                response = data;
            }
            const parsed = parseGenerateResponse(response);
            if (selectedStudentRef.current !== requestedStudentId) return;

            setGeneratedPlan({
                ...parsed,
                studentId: requestedStudentId,
                saved: false,
            });
            setStatusMessage(canPersist
                ? 'Plano gerado. Revise antes de salvar.'
                : 'Plano gerado. Revise e use nesta aula.');
        } catch (invokeFailure: unknown) {
            if (selectedStudentRef.current === requestedStudentId) {
                setError(errorMessage(invokeFailure, 'Não foi possível gerar o plano.'));
            }
        } finally {
            setGenerating(false);
        }
    };

    const handleSavePlan = async (): Promise<void> => {
        if (
            !generatedPlan
            || generatedPlan.studentId !== selectedStudent
            || generatedPlan.saved
            || saving
        ) return;

        const runId = generatedPlan.runId;
        setSaving(true);
        setError('');
        setStatusMessage('');
        try {
            if (adapter) {
                if (!adapter.save) throw new Error('Este ambiente ainda não permite salvar planos.');
                await adapter.save(runId);
            } else {
                const { data, error: invokeError } = await supabase.functions.invoke<unknown>('lesson-planner', {
                    body: {
                        action: 'save',
                        run_id: runId,
                    },
                });

                if (invokeError) {
                    throw new Error(apiErrorMessage(data) || invokeError.message || 'Falha ao salvar o plano.');
                }
                const serverError = apiErrorMessage(data);
                if (serverError) throw new Error(serverError);
            }
            if (selectedStudentRef.current !== generatedPlan.studentId) return;

            setGeneratedPlan((current) => (
                current?.runId === runId ? { ...current, saved: true } : current
            ));
            setStatusMessage(hasPedagogicalMemory
                ? 'Plano salvo e memória pedagógica proposta para revisão.'
                : 'Plano salvo neste ambiente.');

            if (adapter) {
                const context = await adapter.loadLearnerContext(generatedPlan.studentId);
                if (selectedStudentRef.current === generatedPlan.studentId) {
                    setStudentProfile(context.profile);
                    setWolfIntelligence(context.intelligence);
                    setHistory(context.history);
                }
            } else {
                const { data: refreshedHistory, error: historyError } = await supabase
                    .from('lesson_plans')
                    .select('id, created_at, objectives, task_mode, duration_minutes')
                    .eq('tenant_id', activeTenantId)
                    .eq('student_id', generatedPlan.studentId)
                    .order('created_at', { ascending: false })
                    .limit(5);

                if (!historyError && selectedStudentRef.current === generatedPlan.studentId) {
                    setHistory((refreshedHistory || []) as LessonPlanHistoryItem[]);
                }
            }
        } catch (saveFailure: unknown) {
            setError(errorMessage(saveFailure, 'Não foi possível salvar o plano.'));
        } finally {
            setSaving(false);
        }
    };

    const planBelongsToSelectedStudent = generatedPlan?.studentId === selectedStudent;
    const canSave = Boolean(
        generatedPlan
        && planBelongsToSelectedStudent
        && !generatedPlan.saved
        && !saving
        && canPersist
        && (!adapter || Boolean(adapter.save)),
    );
    const knowledge = generatedPlan?.knowledge;
    const knowledgeReady = Boolean(knowledge?.rag_used || knowledge?.sources.length);

    return (
        <div className="space-y-8 animate-in fade-in duration-700 pb-20">
            <header className="flex flex-col md:flex-row justify-between items-start md:items-end gap-6">
                <div>
                    <div className="flex items-center gap-3 mb-2">
                        <div className="p-3 bg-tenant-primary/10 rounded-2xl text-tenant-primary">
                            <Bot size={28} />
                        </div>
                        <h2 className="text-4xl font-black text-brand-text tracking-tighter">Planner AI</h2>
                    </div>
                    <p className="text-brand-muted text-sm">
                        Estruture aulas com a metodologia Wise Wolf e o contexto isolado de cada aluno.
                    </p>
                </div>
            </header>

            {(error || statusMessage) && (
                <div
                    role={error ? 'alert' : 'status'}
                    className={`flex items-start gap-3 px-5 py-4 rounded-2xl border text-sm font-semibold ${
                        error
                            ? 'bg-red-50 border-red-200 text-red-700 dark:bg-red-950/30 dark:border-red-900 dark:text-red-300'
                            : 'bg-emerald-50 border-emerald-200 text-emerald-700 dark:bg-emerald-950/30 dark:border-emerald-900 dark:text-emerald-300'
                    }`}
                >
                    {error ? <AlertCircle size={18} /> : <CheckCircle2 size={18} />}
                    <span>{error || statusMessage}</span>
                </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                <div className="space-y-6">
                    <div className="bg-brand-surface p-8 rounded-[2.5rem] border border-brand-border shadow-xl shadow-slate-200/50 dark:shadow-none">
                        <h3 className="text-xs font-black uppercase tracking-widest text-brand-muted mb-6 flex items-center gap-2">
                            <User size={14} /> Configuração
                        </h3>

                        <div className="space-y-6">
                            <div>
                                <label className="block text-[10px] font-black text-brand-muted uppercase tracking-widest mb-2 ml-1">
                                    Selecionar aluno
                                </label>
                                <select
                                    className="w-full px-5 py-4 bg-brand-surface-2 dark:bg-slate-950 border border-brand-border rounded-2xl text-sm font-bold text-brand-text dark:text-slate-200 outline-none focus:ring-4 focus:ring-tenant-primary/10 transition-all"
                                    value={selectedStudent}
                                    onChange={(event) => handleStudentChange(event.target.value)}
                                    disabled={loading}
                                >
                                    <option value="">{loading ? 'Carregando alunos...' : 'Escolha um aluno...'}</option>
                                    {students.map((student) => (
                                        <option key={student.id} value={student.id}>
                                            {student.full_name || 'Aluno sem nome'}{student.module ? ` · ${student.module}` : ''}
                                        </option>
                                    ))}
                                </select>
                            </div>

                            <div>
                                <label className="block text-[10px] font-black text-brand-muted uppercase tracking-widest mb-2 ml-1">
                                    Tipo de planejamento
                                </label>
                                <select
                                    className="w-full px-5 py-4 bg-brand-surface-2 dark:bg-slate-950 border border-brand-border rounded-2xl text-sm font-bold text-brand-text dark:text-slate-200 outline-none focus:ring-4 focus:ring-tenant-primary/10 transition-all"
                                    value={taskMode}
                                    onChange={(event) => setTaskMode(event.target.value as PlannerTaskMode)}
                                >
                                    {TASK_MODE_OPTIONS.map((option) => (
                                        <option key={option.value} value={option.value}>{option.label}</option>
                                    ))}
                                </select>
                            </div>

                            <div className="grid grid-cols-2 gap-3">
                                <label className="p-4 bg-brand-surface-2 dark:bg-slate-950 border border-brand-border rounded-2xl cursor-pointer">
                                    <span className="block text-[9px] font-black uppercase tracking-widest text-brand-muted mb-2">
                                        Idioma
                                    </span>
                                    <span className="flex items-center gap-2 text-xs font-bold text-brand-text dark:text-slate-200">
                                        <input
                                            type="checkbox"
                                            checked={bilingual}
                                            onChange={(event) => setBilingual(event.target.checked)}
                                            className="accent-tenant-primary"
                                        />
                                        Bilíngue
                                    </span>
                                </label>
                                <label className="p-4 bg-brand-surface-2 dark:bg-slate-950 border border-brand-border rounded-2xl">
                                    <span className="block text-[9px] font-black uppercase tracking-widest text-brand-muted mb-2">
                                        Duração
                                    </span>
                                    <span className="flex items-center gap-2">
                                        <Clock3 size={14} className="text-tenant-primary" />
                                        <input
                                            type="number"
                                            min={10}
                                            max={120}
                                            value={durationMinutes}
                                            onChange={(event) => {
                                                const value = Number(event.target.value);
                                                setDurationMinutes(Number.isFinite(value) ? Math.min(120, Math.max(10, value)) : 30);
                                            }}
                                            className="w-14 bg-transparent text-xs font-bold text-brand-text dark:text-slate-200 outline-none"
                                        />
                                        <span className="text-[10px] text-brand-muted">min</span>
                                    </span>
                                </label>
                            </div>

                            {contextLoading && (
                                <div className="flex items-center justify-center gap-2 p-4 text-xs font-bold text-brand-muted">
                                    <RefreshCw size={14} className="animate-spin" /> Carregando contexto...
                                </div>
                            )}

                            {studentProfile && !contextLoading && (
                                <div className="space-y-3">
                                    <div className="p-4 bg-tenant-primary/5 rounded-2xl border border-tenant-primary/10">
                                        <p className="text-[9px] font-black text-tenant-primary uppercase tracking-widest mb-2">
                                            Perfil pedagógico
                                        </p>
                                        <div className="text-xs font-bold text-brand-muted space-y-1">
                                            <span className="block">
                                                Nível: <span className="text-brand-text dark:text-slate-200">{studentProfile.module || 'A confirmar'}</span>
                                            </span>
                                            <span className="block">
                                                Cargo: <span className="text-brand-text dark:text-slate-200">{studentProfile.occupation || 'Não informado'}</span>
                                            </span>
                                            {studentProfile.english_for && (
                                                <span className="block">
                                                    Objetivo: <span className="text-brand-text dark:text-slate-200">{studentProfile.english_for}</span>
                                                </span>
                                            )}
                                            {studentProfile.personality && (
                                                <span className="block">
                                                    Perfil: <span className="text-brand-text dark:text-slate-200">{studentProfile.personality}</span>
                                                </span>
                                            )}
                                            {listHasItems(studentProfile.preferred_topics) && (
                                                <span className="block">
                                                    Tópicos: <span className="text-brand-text dark:text-slate-200">{studentProfile.preferred_topics.join(', ')}</span>
                                                </span>
                                            )}
                                        </div>
                                    </div>

                                    {wolfIntelligence && (
                                        <div className="p-4 bg-violet-50 dark:bg-violet-900/20 rounded-2xl border border-violet-100 dark:border-violet-800">
                                            <p className="text-[9px] font-black text-violet-600 uppercase tracking-widest mb-2 flex items-center gap-1">
                                                <Brain size={10} /> Wolf Intelligence
                                            </p>
                                            {wolfIntelligence.accumulated_context && (
                                                <p className="text-[10px] text-brand-muted leading-relaxed mb-2">
                                                    {wolfIntelligence.accumulated_context}
                                                </p>
                                            )}
                                            {listHasItems(wolfIntelligence.strong_points) && (
                                                <div className="mb-1">
                                                    <p className="text-[9px] font-black text-emerald-600 uppercase">Pontos fortes</p>
                                                    {wolfIntelligence.strong_points.slice(0, 2).map((point) => (
                                                        <p key={point} className="text-[9px] text-brand-muted">• {point}</p>
                                                    ))}
                                                </div>
                                            )}
                                            {listHasItems(wolfIntelligence.weak_points) && (
                                                <div className="mb-1">
                                                    <p className="text-[9px] font-black text-red-500 uppercase">A melhorar</p>
                                                    {wolfIntelligence.weak_points.slice(0, 2).map((point) => (
                                                        <p key={point} className="text-[9px] text-brand-muted">• {point}</p>
                                                    ))}
                                                </div>
                                            )}
                                            {wolfIntelligence.recommended_approach && (
                                                <p className="text-[9px] text-violet-600 dark:text-violet-400 italic mt-1">
                                                    {wolfIntelligence.recommended_approach}
                                                </p>
                                            )}
                                            <p className="text-[8px] text-brand-muted mt-2">
                                                {wolfIntelligence.total_classes_analyzed || 0} aulas analisadas
                                            </p>
                                        </div>
                                    )}
                                </div>
                            )}

                            <div>
                                <label className="block text-[10px] font-black text-brand-muted uppercase tracking-widest mb-2 ml-1">
                                    Pedido ao Planner (opcional)
                                </label>
                                <textarea
                                    placeholder="Ex.: prepare uma apresentação profissional sobre logística e trabalhe transições..."
                                    className="w-full px-5 py-4 bg-brand-surface-2 dark:bg-slate-950 border border-brand-border rounded-2xl text-xs font-medium text-brand-muted outline-none focus:ring-4 focus:ring-tenant-primary/10 transition-all min-h-[110px]"
                                    value={customPrompt}
                                    maxLength={2500}
                                    onChange={(event) => setCustomPrompt(event.target.value)}
                                />
                                <p className="text-right text-[9px] text-brand-muted mt-1">{customPrompt.length}/2500</p>
                            </div>

                            <button
                                type="button"
                                onClick={handleGeneratePlan}
                                disabled={generating || !selectedStudent || contextLoading}
                                className="w-full py-5 bg-tenant-primary text-white rounded-2xl font-black text-xs uppercase tracking-widest hover:scale-[1.02] active:scale-95 transition-all shadow-xl flex items-center justify-center gap-3 disabled:opacity-50 disabled:hover:scale-100"
                            >
                                {generating ? <RefreshCw className="animate-spin" size={18} /> : <Sparkles size={18} />}
                                {generating ? 'Consultando IA...' : 'Gerar planejamento'}
                            </button>
                        </div>
                    </div>

                    <div className="bg-brand-surface p-8 rounded-[2.5rem] border border-brand-border shadow-sm overflow-hidden">
                        <h3 className="text-xs font-black uppercase tracking-widest text-brand-muted mb-6 flex items-center gap-2">
                            <History size={14} /> Planos recentes
                        </h3>
                        <div className="space-y-4">
                            {history.length > 0 ? history.map((plan) => (
                                <div key={plan.id} className="p-4 bg-brand-surface-2/50 rounded-xl border border-brand-border/50">
                                    <div className="flex items-center justify-between gap-2">
                                        <p className="text-[10px] font-black text-brand-muted uppercase">
                                            {new Date(plan.created_at).toLocaleDateString('pt-BR')}
                                        </p>
                                        <p className="text-[9px] font-black text-tenant-primary uppercase">
                                            {plan.task_mode ? TASK_MODE_LABELS[plan.task_mode] : 'Plano'}
                                            {plan.duration_minutes ? ` · ${plan.duration_minutes}min` : ''}
                                        </p>
                                    </div>
                                    <p className="text-xs font-bold text-brand-text dark:text-slate-200 line-clamp-2 mt-1">
                                        {plan.objectives || 'Plano salvo'}
                                    </p>
                                </div>
                            )) : (
                                <p className="text-xs text-brand-muted italic text-center py-4">
                                    {selectedStudent
                                        ? canPersist ? 'Nenhum plano salvo para este aluno.' : 'O histórico não está incluído neste ambiente.'
                                        : 'Selecione um aluno para ver o histórico.'}
                                </p>
                            )}
                        </div>
                    </div>
                </div>

                <div className="lg:col-span-2">
                    {generatedPlan && planBelongsToSelectedStudent ? (
                        <div className="bg-brand-surface rounded-[3rem] border-2 border-tenant-primary/20 shadow-2xl relative overflow-hidden animate-in slide-in-from-right-10 duration-500">
                            <div className="absolute top-0 right-0 p-10 opacity-5">
                                <Zap size={150} className="text-tenant-primary" />
                            </div>

                            <div className="p-6 md:p-10 space-y-8 relative">
                                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                                    <div className="flex flex-wrap gap-2">
                                        <span className="px-4 py-1.5 bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400 rounded-full text-[10px] font-black uppercase tracking-widest">
                                            {generatedPlan.saved ? 'Plano salvo' : 'Novo plano'}
                                        </span>
                                        <span className="px-4 py-1.5 bg-brand-surface-2 text-brand-muted rounded-full text-[10px] font-black uppercase tracking-widest">
                                            {TASK_MODE_LABELS[generatedPlan.plan.task_mode]}
                                        </span>
                                        <span className="px-4 py-1.5 bg-brand-surface-2 text-brand-muted rounded-full text-[10px] font-black uppercase tracking-widest">
                                            {generatedPlan.plan.duration_minutes} min · {generatedPlan.plan.level || 'Nível a confirmar'}
                                        </span>
                                    </div>
                                    {canPersist && (
                                        <button
                                            type="button"
                                            onClick={handleSavePlan}
                                            disabled={!canSave}
                                            className="flex items-center justify-center gap-2 text-tenant-primary font-black text-[10px] uppercase tracking-widest hover:underline disabled:opacity-50 disabled:no-underline"
                                        >
                                            {saving ? <RefreshCw className="animate-spin" size={16} /> : <Save size={16} />}
                                            {saving ? 'Salvando...' : generatedPlan.saved ? 'Salvo' : 'Salvar plano'}
                                        </button>
                                    )}
                                </div>

                                <section>
                                    <h4 className="flex items-center gap-3 text-xs font-black uppercase tracking-[0.2em] text-brand-muted mb-4">
                                        <Target className="text-tenant-primary" size={16} /> {generatedPlan.plan.title}
                                    </h4>
                                    <p className="text-xl font-black text-brand-text leading-tight">
                                        {generatedPlan.plan.objective}
                                    </p>
                                    {generatedPlan.plan.overview && (
                                        <p className="text-sm text-brand-muted leading-relaxed mt-3">
                                            {generatedPlan.plan.overview}
                                        </p>
                                    )}
                                </section>

                                <section>
                                    <h4 className="flex items-center gap-3 text-xs font-black uppercase tracking-[0.2em] text-brand-muted mb-4">
                                        <Clock3 className="text-blue-500" size={16} /> Etapas
                                    </h4>
                                    <div className="space-y-4">
                                        {generatedPlan.plan.sections.map((section, index) => (
                                            <article key={`${section.title}-${index}`} className="p-5 md:p-6 bg-brand-surface-2/50 rounded-3xl border border-brand-border">
                                                <div className="flex items-center justify-between gap-4 mb-3">
                                                    <h5 className="text-sm font-black text-brand-text dark:text-slate-100">
                                                        {index + 1}. {section.title}
                                                    </h5>
                                                    <span className="shrink-0 px-3 py-1 bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300 rounded-full text-[10px] font-black">
                                                        {section.minutes} min
                                                    </span>
                                                </div>
                                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                                                    <div>
                                                        <p className="font-black uppercase tracking-widest text-brand-muted text-[9px] mb-1">Professor</p>
                                                        <p className="text-brand-text dark:text-slate-200 leading-relaxed">{section.teacher_guidance}</p>
                                                    </div>
                                                    <div>
                                                        <p className="font-black uppercase tracking-widest text-brand-muted text-[9px] mb-1">Aluno</p>
                                                        <p className="text-brand-text dark:text-slate-200 leading-relaxed">{section.student_task}</p>
                                                    </div>
                                                </div>
                                                {section.examples.length > 0 && (
                                                    <div className="mt-4 pt-4 border-t border-brand-border space-y-2">
                                                        {section.examples.map((example, exampleIndex) => (
                                                            <div key={`${example.english}-${exampleIndex}`} className="text-xs">
                                                                <p className="font-bold text-brand-text dark:text-slate-100">{example.english}</p>
                                                                {example.portuguese && <p className="text-brand-muted">{example.portuguese}</p>}
                                                            </div>
                                                        ))}
                                                    </div>
                                                )}
                                            </article>
                                        ))}
                                    </div>
                                </section>

                                {generatedPlan.plan.vocabulary.length > 0 && (
                                    <section>
                                        <h4 className="flex items-center gap-3 text-xs font-black uppercase tracking-[0.2em] text-brand-muted mb-4">
                                            <BookOpen className="text-violet-500" size={16} /> Vocabulário e chunks
                                        </h4>
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                            {generatedPlan.plan.vocabulary.map((item, index) => (
                                                <article key={`${item.item}-${index}`} className="p-5 bg-violet-50/70 dark:bg-violet-950/20 rounded-2xl border border-violet-100 dark:border-violet-900">
                                                    <p className="text-sm font-black text-violet-700 dark:text-violet-300">{item.item}</p>
                                                    <p className="text-xs text-brand-muted mt-1">{item.meaning_pt}</p>
                                                    <p className="text-xs font-semibold text-brand-text dark:text-slate-200 mt-3">{item.example_en}</p>
                                                    <p className="text-[10px] text-violet-600 dark:text-violet-400 mt-2">Pergunte: {item.use_question_en}</p>
                                                </article>
                                            ))}
                                        </div>
                                    </section>
                                )}

                                {generatedPlan.plan.teacher_questions.length > 0 && (
                                    <section>
                                        <h4 className="flex items-center gap-3 text-xs font-black uppercase tracking-[0.2em] text-brand-muted mb-4">
                                            <Bot className="text-cyan-500" size={16} /> Perguntas do professor
                                        </h4>
                                        <div className="space-y-3">
                                            {generatedPlan.plan.teacher_questions.map((question, index) => (
                                                <article key={`${question.question_en}-${index}`} className="p-5 bg-cyan-50/70 dark:bg-cyan-950/20 rounded-2xl border border-cyan-100 dark:border-cyan-900">
                                                    <p className="text-sm font-black text-brand-text dark:text-slate-100">{question.question_en}</p>
                                                    {question.translation_pt && <p className="text-xs text-brand-muted mt-1">{question.translation_pt}</p>}
                                                    <p className="text-xs text-cyan-700 dark:text-cyan-300 mt-3">
                                                        Resposta-modelo: {question.model_answer_en}
                                                    </p>
                                                </article>
                                            ))}
                                        </div>
                                    </section>
                                )}

                                {generatedPlan.plan.expected_corrections.length > 0 && (
                                    <section>
                                        <h4 className="flex items-center gap-3 text-xs font-black uppercase tracking-[0.2em] text-brand-muted mb-4">
                                            <AlertCircle className="text-amber-500" size={16} /> Correções prioritárias
                                        </h4>
                                        <div className="space-y-4">
                                            {generatedPlan.plan.expected_corrections.map((correction, index) => (
                                                <article key={`${correction.focus}-${index}`} className="p-5 bg-amber-50/70 dark:bg-amber-950/20 rounded-2xl border border-amber-100 dark:border-amber-900">
                                                    <h5 className="text-sm font-black text-amber-700 dark:text-amber-300">{correction.focus}</h5>
                                                    <div className="mt-3 space-y-1 text-xs text-brand-text dark:text-slate-200">
                                                        {correction.produced_or_likely_error && <p><strong>Produção/risco:</strong> {correction.produced_or_likely_error}</p>}
                                                        <p><strong>Correção mínima:</strong> {correction.minimal_correction}</p>
                                                        <p><strong>Versão natural:</strong> {correction.natural_version}</p>
                                                        {correction.advanced_version && <p><strong>Versão avançada:</strong> {correction.advanced_version}</p>}
                                                        <p className="text-brand-muted pt-1">{correction.explanation_pt}</p>
                                                    </div>
                                                    {correction.micropractice.length > 0 && (
                                                        <div className="mt-3 pt-3 border-t border-amber-200 dark:border-amber-900">
                                                            <p className="text-[9px] font-black uppercase tracking-widest text-amber-700 dark:text-amber-300 mb-1">Microprática</p>
                                                            {correction.micropractice.map((practice, practiceIndex) => (
                                                                <p key={`${practice}-${practiceIndex}`} className="text-xs text-brand-text dark:text-slate-200">• {practice}</p>
                                                            ))}
                                                        </div>
                                                    )}
                                                </article>
                                            ))}
                                        </div>
                                    </section>
                                )}

                                {(generatedPlan.plan.assessment_criteria.length > 0
                                    || generatedPlan.plan.strengths.length > 0
                                    || generatedPlan.plan.priorities.length > 0
                                    || generatedPlan.plan.next_steps.length > 0) && (
                                    <section>
                                        <h4 className="flex items-center gap-3 text-xs font-black uppercase tracking-[0.2em] text-brand-muted mb-4">
                                            <CheckCircle2 className="text-emerald-500" size={16} /> Avaliação e próximos passos
                                        </h4>
                                        {generatedPlan.plan.assessment_criteria.length > 0 && (
                                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-5">
                                                {generatedPlan.plan.assessment_criteria.map((criterion, index) => (
                                                    <article key={`${criterion.criterion}-${index}`} className="p-5 bg-emerald-50/70 dark:bg-emerald-950/20 rounded-2xl border border-emerald-100 dark:border-emerald-900">
                                                        <p className="text-sm font-black text-emerald-700 dark:text-emerald-300">{criterion.criterion}</p>
                                                        <p className="text-xs text-brand-text dark:text-slate-200 mt-2">{criterion.what_to_observe}</p>
                                                        <p className="text-[10px] text-brand-muted mt-2">{criterion.rating_guide}</p>
                                                    </article>
                                                ))}
                                            </div>
                                        )}
                                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                            {generatedPlan.plan.strengths.length > 0 && (
                                                <div className="p-4 bg-brand-surface-2/50 rounded-2xl border border-brand-border">
                                                    <MemoryList label="Pontos fortes" items={generatedPlan.plan.strengths} />
                                                </div>
                                            )}
                                            {generatedPlan.plan.priorities.length > 0 && (
                                                <div className="p-4 bg-brand-surface-2/50 rounded-2xl border border-brand-border">
                                                    <MemoryList label="Prioridades" items={generatedPlan.plan.priorities} />
                                                </div>
                                            )}
                                            {generatedPlan.plan.next_steps.length > 0 && (
                                                <div className="p-4 bg-brand-surface-2/50 rounded-2xl border border-brand-border">
                                                    <MemoryList label="Próximos passos" items={generatedPlan.plan.next_steps} />
                                                </div>
                                            )}
                                        </div>
                                    </section>
                                )}

                                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                    <section className="p-6 bg-brand-surface-2/50 rounded-3xl border border-brand-border">
                                        <h4 className="flex items-center gap-3 text-xs font-black uppercase tracking-[0.2em] text-brand-muted mb-4">
                                            <Zap className="text-amber-500" size={16} /> Materiais
                                        </h4>
                                        {generatedPlan.plan.materials.length > 0 ? (
                                            <div className="space-y-3">
                                                {generatedPlan.plan.materials.map((material) => (
                                                    <div key={material.title}>
                                                        <p className="text-xs font-black text-brand-text dark:text-slate-100">{material.title}</p>
                                                        <p className="text-[10px] text-brand-muted mt-1">{material.usage}</p>
                                                    </div>
                                                ))}
                                            </div>
                                        ) : (
                                            <p className="text-xs text-brand-muted italic">Nenhum material aprovado foi recomendado.</p>
                                        )}
                                    </section>

                                    <section className="p-6 bg-brand-surface-2/50 rounded-3xl border border-brand-border">
                                        <h4 className="flex items-center gap-3 text-xs font-black uppercase tracking-[0.2em] text-brand-muted mb-4">
                                            <Database className={knowledgeReady ? 'text-emerald-500' : 'text-brand-muted'} size={16} /> Base Wise Wolf
                                        </h4>
                                        <p className={`text-xs font-black ${knowledgeReady ? 'text-emerald-600' : 'text-brand-muted'}`}>
                                            {knowledgeReady ? 'RAG consultada' : 'Sem fontes RAG nesta geração'}
                                        </p>
                                        <p className="text-[10px] text-brand-muted mt-1">Status: {knowledge?.mode || 'não configurado'}</p>
                                        {knowledge && knowledge.sources.length > 0 && (
                                            <ul className="mt-3 space-y-1">
                                                {knowledge.sources.map((source) => (
                                                    <li key={source} className="text-xs text-brand-text dark:text-slate-200">• {source}</li>
                                                ))}
                                            </ul>
                                        )}
                                    </section>
                                </div>

                                {generatedPlan.plan.homework && (
                                    <section className="p-6 bg-blue-50 dark:bg-blue-950/20 rounded-3xl border border-blue-100 dark:border-blue-900">
                                        <h4 className="text-xs font-black uppercase tracking-[0.2em] text-blue-600 dark:text-blue-300 mb-3">
                                            Tarefa de casa
                                        </h4>
                                        <p className="text-sm text-brand-text dark:text-slate-200">{generatedPlan.plan.homework}</p>
                                    </section>
                                )}

                                <section className="p-6 bg-slate-950 rounded-[2rem] text-white">
                                    <h4 className="flex items-center gap-3 text-xs font-black uppercase tracking-[0.2em] text-tenant-primary mb-4">
                                        <Brain size={16} /> {hasPedagogicalMemory ? 'Memória proposta' : 'Continuidade sugerida'}
                                    </h4>
                                    <p className="text-xs font-medium text-slate-300 leading-relaxed mb-5">
                                        {generatedPlan.plan.ai_memory_reflection}
                                    </p>
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                        {generatedPlan.plan.student_memory_update.lesson_objective && (
                                            <div>
                                                <p className="text-[9px] font-black uppercase tracking-widest text-slate-500 mb-1">Objetivo</p>
                                                <p className="text-xs text-slate-200">{generatedPlan.plan.student_memory_update.lesson_objective}</p>
                                            </div>
                                        )}
                                        <MemoryList label="Conteúdo praticado" items={generatedPlan.plan.student_memory_update.content_practiced} />
                                        <MemoryList label="Novo vocabulário" items={generatedPlan.plan.student_memory_update.new_vocabulary} />
                                        <MemoryList label="Erros recorrentes" items={generatedPlan.plan.student_memory_update.recurring_errors} />
                                        <MemoryList label="Correções dominadas" items={generatedPlan.plan.student_memory_update.corrections_mastered} />
                                        <MemoryList label="Pontos fortes" items={generatedPlan.plan.student_memory_update.strengths_observed} />
                                        {generatedPlan.plan.student_memory_update.homework_assigned && (
                                            <div>
                                                <p className="text-[9px] font-black uppercase tracking-widest text-slate-500 mb-1">Tarefa registrada</p>
                                                <p className="text-xs text-slate-200">{generatedPlan.plan.student_memory_update.homework_assigned}</p>
                                            </div>
                                        )}
                                        {generatedPlan.plan.student_memory_update.recommended_next_step && (
                                            <div>
                                                <p className="text-[9px] font-black uppercase tracking-widest text-slate-500 mb-1">Próximo passo</p>
                                                <p className="text-xs text-slate-200">{generatedPlan.plan.student_memory_update.recommended_next_step}</p>
                                            </div>
                                        )}
                                        <div>
                                            <p className="text-[9px] font-black uppercase tracking-widest text-slate-500 mb-1">Confiança da proposta</p>
                                            <p className="text-xs text-slate-200">{generatedPlan.plan.student_memory_update.confidence_level}</p>
                                        </div>
                                        <MemoryList label="Confirmar com o professor" items={generatedPlan.plan.student_memory_update.notes_to_verify} />
                                    </div>
                                    <p className="text-[9px] text-slate-500 mt-5">
                                        {hasPedagogicalMemory
                                            ? 'A memória só é enviada para revisão quando o plano é salvo.'
                                            : 'Estas sugestões pertencem somente a esta geração e não atualizam a memória escolar.'}
                                    </p>
                                </section>

                                {generatedPlan.plan.warnings.length > 0 && (
                                    <section className="p-5 bg-red-50 dark:bg-red-950/20 rounded-2xl border border-red-100 dark:border-red-900">
                                        <p className="text-[9px] font-black uppercase tracking-widest text-red-600 dark:text-red-300 mb-2">Avisos</p>
                                        {generatedPlan.plan.warnings.map((warning, index) => (
                                            <p key={`${warning}-${index}`} className="text-xs text-red-700 dark:text-red-200">• {warning}</p>
                                        ))}
                                    </section>
                                )}
                            </div>
                        </div>
                    ) : (
                        <div className="h-full min-h-[500px] flex flex-col items-center justify-center bg-brand-surface-2 dark:bg-brand-surface/30 rounded-[3rem] border-2 border-dashed border-brand-border dark:border-brand-border text-center p-10 group overflow-hidden relative">
                            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-96 h-96 bg-tenant-primary/5 rounded-full blur-[100px] group-hover:bg-tenant-primary/10 transition-all duration-1000" />
                            <Bot size={80} className="text-slate-200 dark:text-brand-text mb-6 group-hover:scale-110 transition-transform duration-500" />
                            <h3 className="text-xl font-bold text-brand-text dark:text-slate-300">Assistente pedagógico Wise Wolf</h3>
                            <p className="text-sm text-brand-muted max-w-sm mt-2 relative z-10">
                                Selecione um aluno e o tipo de planejamento. O sistema usa somente o contexto autorizado desse aluno e os materiais Wise Wolf disponíveis.
                            </p>

                            <div className="mt-10 grid grid-cols-2 gap-3 max-w-sm w-full relative z-10">
                                <div className="p-4 bg-brand-surface rounded-2xl border border-brand-border shadow-sm">
                                    <p className="text-[10px] font-black text-tenant-primary uppercase">Memória isolada</p>
                                    <p className="text-[8px] font-bold text-brand-muted mt-1 uppercase">Um aluno por vez</p>
                                </div>
                                <div className="p-4 bg-brand-surface rounded-2xl border border-brand-border shadow-sm">
                                    <p className="text-[10px] font-black text-blue-500 uppercase">Base Wise Wolf</p>
                                    <p className="text-[8px] font-bold text-brand-muted mt-1 uppercase">Fontes verificáveis</p>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default LessonPlannerAI;

const Target: React.FC<{ className?: string; size?: number }> = ({ className, size }) => (
    <svg
        width={size || 24}
        height={size || 24}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
    >
        <circle cx="12" cy="12" r="10" />
        <circle cx="12" cy="12" r="6" />
        <circle cx="12" cy="12" r="2" />
    </svg>
);
