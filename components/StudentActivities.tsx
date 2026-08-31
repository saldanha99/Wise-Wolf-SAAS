import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    AlertCircle,
    BookOpen,
    CheckCircle,
    ChevronRight,
    HelpCircle,
    Lock,
    Mic,
    RefreshCw,
    Sparkles,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { ActivityGenerationError, generateActivities } from '../services/geminiService';
import ComplementaryActivityPlayer, {
    type ComplementaryActivity,
    type ComplementaryActivityEvidence,
    type ComplementaryActivitySubmissionResult,
} from './ComplementaryActivityPlayer';

interface StudentActivitiesProps {
    userId: string;
    tenantId?: string;
}

interface StudentActivity extends ComplementaryActivity {
    student_id: string;
    tenant_id: string;
    difficulty?: string | null;
    status: 'PENDING' | 'COMPLETED';
    completed_at?: string | null;
    created_at?: string;
    generated_by_ai?: boolean;
}

interface PendingGenerationRequest {
    requestKey: string;
}

const TYPE_CONFIG = {
    reading: { icon: BookOpen, label: 'Leitura', color: 'text-sky-700', bg: 'bg-sky-50 dark:bg-sky-950/25', border: 'border-sky-200 dark:border-sky-900/40', badge: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200' },
    grammar: { icon: Sparkles, label: 'Gramática', color: 'text-emerald-700', bg: 'bg-emerald-50 dark:bg-emerald-950/25', border: 'border-emerald-200 dark:border-emerald-900/40', badge: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200' },
    quiz: { icon: HelpCircle, label: 'Múltipla escolha', color: 'text-amber-700', bg: 'bg-amber-50 dark:bg-amber-950/25', border: 'border-amber-200 dark:border-amber-900/40', badge: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200' },
    conversation: { icon: Mic, label: 'Conversação', color: 'text-violet-700', bg: 'bg-violet-50 dark:bg-violet-950/25', border: 'border-violet-200 dark:border-violet-900/40', badge: 'bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200' },
};

const DIFF_LABEL: Record<string, string> = {
    BEGINNER: 'Iniciante',
    INTERMEDIATE: 'Intermediário',
    ADVANCED: 'Avançado',
};

const requestKey = (): string => {
    if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.randomUUID === 'function') {
        return globalThis.crypto.randomUUID();
    }
    if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.getRandomValues === 'function') {
        const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
    throw new ActivityGenerationError(
        'Este navegador não oferece a segurança necessária para criar um pacote. Atualize-o e tente novamente.',
        { code: 'SECURE_REQUEST_KEY_UNAVAILABLE', retryable: false },
    );
};

const StudentActivities: React.FC<StudentActivitiesProps> = ({ userId }) => {
    const [activities, setActivities] = useState<StudentActivity[]>([]);
    const [loading, setLoading] = useState(true);
    const [generating, setGenerating] = useState(false);
    const [activeActivity, setActiveActivity] = useState<StudentActivity | null>(null);
    const [generationError, setGenerationError] = useState('');
    const [loadError, setLoadError] = useState('');
    const completionKeys = useRef(new Map<string, string>());
    const pendingGeneration = useRef<PendingGenerationRequest | null>(null);
    const generationInFlight = useRef(false);

    const generateNew = useCallback(async () => {
        if (generationInFlight.current) return;
        generationInFlight.current = true;
        setGenerating(true);
        setGenerationError('');
        try {
            const generationRequest = pendingGeneration.current || {
                requestKey: requestKey(),
            };
            pendingGeneration.current = generationRequest;
            const generatedResult = await generateActivities(generationRequest.requestKey);
            const saved = generatedResult.activities as StudentActivity[];
            if (saved.length > 0) {
                setActivities(previous => {
                    const byId = new Map<string, StudentActivity>(previous.map(activity => [activity.id, activity]));
                    saved.forEach(activity => byId.set(activity.id, activity));
                    return Array.from(byId.values())
                        .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
                        .slice(0, 12);
                });
            }
            pendingGeneration.current = null;
        } catch (error) {
            const activityError = error instanceof ActivityGenerationError ? error : null;
            if (!activityError?.retryable) {
                pendingGeneration.current = null;
            }
            setGenerationError(
                activityError?.message
                || 'Não foi possível criar seu próximo pacote. Tente novamente em instantes.',
            );
            console.error('Complementary activity generation failed:', {
                code: activityError?.code || 'ACTIVITY_SAVE_FAILED',
            });
        } finally {
            generationInFlight.current = false;
            setGenerating(false);
        }
    }, []);

    const fetchActivities = useCallback(async () => {
        setLoading(true);
        setLoadError('');
        try {
            // O runtime do servidor remove gabaritos e explicações antes de
            // entregar o conteúdo objetivo ao navegador do aluno.
            const { data, error } = await supabase.rpc(
                'get_student_complementary_activities',
                { p_limit: 12 },
            );
            if (error) throw error;
            setActivities((Array.isArray(data) ? data : []) as StudentActivity[]);
        } catch (error) {
            console.error('Complementary activities fetch failed:', error);
            setLoadError('Não foi possível carregar suas atividades complementares.');
        } finally {
            setLoading(false);
        }
    }, [userId]);

    useEffect(() => {
        if (userId) void fetchActivities();
    }, [fetchActivities, userId]);

    const submitCompletion = async (evidence: ComplementaryActivityEvidence) => {
        const activityId = evidence.activityId;
        let stableRequestKey = completionKeys.current.get(activityId);
        if (!stableRequestKey) {
            stableRequestKey = requestKey();
            completionKeys.current.set(activityId, stableRequestKey);
        }

        const { data, error } = await supabase.rpc('complete_student_complementary_activity', {
            p_activity_id: activityId,
            p_evidence: evidence,
            p_request_key: stableRequestKey,
        });
        if (error) throw new Error('Não foi possível registrar sua atividade. Tente novamente.');
        if (
            !data
            || typeof data !== 'object'
            || data.activityId !== activityId
            || typeof data.passed !== 'boolean'
            || (data.status !== 'PENDING' && data.status !== 'COMPLETED')
            || (data.passed === true && data.status !== 'COMPLETED')
            || (data.passed === false && data.status !== 'PENDING')
            || !Array.isArray(data.questionResults)
        ) {
            throw new Error('Resposta inválida ao registrar a atividade.');
        }

        const result = data as ComplementaryActivitySubmissionResult;
        // Uma resposta pedagógica definitiva (aprovada ou não) encerra esta
        // tentativa. Falha de rede conserva a chave para replay idempotente.
        completionKeys.current.delete(activityId);
        if (result.passed && result.status === 'COMPLETED') {
            setActivities(previous => previous.map(activity => (
                activity.id === activityId
                    ? { ...activity, status: 'COMPLETED', completed_at: result.completedAt || evidence.completedAt }
                    : activity
            )));
        }
        return result;
    };

    const pending = activities.filter(activity => activity.status === 'PENDING');
    const completed = activities.filter(activity => activity.status === 'COMPLETED');
    const canGenerate = pending.length === 0;

    if (loading) {
        return (
            <div className="rounded-[2.5rem] border border-brand-border bg-brand-surface p-5 sm:p-8">
                <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-100 text-violet-600 dark:bg-violet-900/30"><Sparkles size={20} /></div>
                    <div>
                        <h3 className="text-sm font-black text-brand-text">Atividades complementares</h3>
                        <p className="text-[10px] font-bold uppercase tracking-widest text-brand-muted">Preparando sua prática personalizada</p>
                    </div>
                </div>
                <div className="flex items-center justify-center gap-3 py-12 text-brand-muted" role="status">
                    <RefreshCw className="animate-spin" size={20} />
                    <span className="text-sm font-bold">Carregando desafios...</span>
                </div>
            </div>
        );
    }

    return (
        <section className="overflow-hidden rounded-[2.5rem] border border-brand-border bg-brand-surface shadow-xl shadow-slate-950/5">
            {activeActivity && (
                <ComplementaryActivityPlayer
                    activity={activeActivity}
                    onClose={() => setActiveActivity(null)}
                    onSubmit={submitCompletion}
                />
            )}

            <header className="border-b border-brand-border bg-gradient-to-r from-violet-50 via-brand-surface to-indigo-50 p-5 dark:from-violet-950/30 dark:via-brand-surface dark:to-indigo-950/30 sm:p-6">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 items-center gap-3">
                        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-violet-600 text-white shadow-lg shadow-violet-500/20">
                            <Sparkles size={21} aria-hidden="true" />
                        </div>
                        <div className="min-w-0">
                            <h3 className="text-base font-black text-brand-text">Laboratório de prática</h3>
                            <p className="mt-0.5 text-xs font-medium text-brand-muted">
                                Desafios personalizados com execução, reflexão e feedback — não apenas um botão de concluir.
                            </p>
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={() => void generateNew()}
                        disabled={generating || !canGenerate}
                        title={!canGenerate ? 'Conclua as atividades do pacote atual antes de criar outro.' : undefined}
                        className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-xl bg-violet-600 px-4 py-2.5 text-[10px] font-black uppercase tracking-widest text-white hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-45"
                    >
                        {generating ? <RefreshCw size={13} className="animate-spin" /> : <Sparkles size={13} />}
                        {generating ? 'Criando...' : canGenerate ? 'Criar novo pacote' : 'Pacote em andamento'}
                    </button>
                </div>
                <div className="mt-4 flex flex-wrap gap-2 text-[10px] font-black uppercase tracking-wider">
                    <span className="rounded-full bg-violet-100 px-3 py-1.5 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200">{pending.length} pendentes</span>
                    <span className="rounded-full bg-emerald-100 px-3 py-1.5 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200">{completed.length} concluídas</span>
                </div>
            </header>

            <div className="space-y-4 p-4 sm:p-6">
                {(loadError || generationError) && (
                    <div role="alert" className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-amber-900 dark:border-amber-800/40 dark:bg-amber-900/20 dark:text-amber-100">
                        <div className="flex items-start gap-3">
                            <AlertCircle size={18} className="mt-0.5 shrink-0" />
                            <div>
                                <p className="text-sm font-black">A prática não carregou como esperado.</p>
                                <p className="mt-1 text-xs font-medium">{loadError || generationError}</p>
                                <button type="button" onClick={() => void (loadError ? fetchActivities() : generateNew())} className="mt-3 rounded-xl bg-amber-600 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-white hover:bg-amber-700">
                                    Tentar novamente
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {generating && activities.length === 0 && (
                    <div className="flex items-center justify-center gap-3 rounded-2xl border border-violet-200 bg-violet-50 px-5 py-8 text-center text-violet-800 dark:border-violet-900/40 dark:bg-violet-950/30 dark:text-violet-200" role="status">
                        <RefreshCw size={17} className="animate-spin" />
                        <span className="text-sm font-bold">Criando desafios alinhados ao seu momento...</span>
                    </div>
                )}

                {pending.length === 0 && !generating && !loadError && (
                    <div className="rounded-3xl border border-dashed border-emerald-300 bg-emerald-50 px-5 py-10 text-center dark:border-emerald-900/50 dark:bg-emerald-950/20">
                        <CheckCircle size={34} className="mx-auto text-emerald-600" />
                        <p className="mt-3 text-sm font-black text-brand-text">Pacote concluído!</p>
                        <p className="mt-1 text-xs text-brand-muted">Crie um novo pacote quando quiser continuar praticando.</p>
                    </div>
                )}

                <div className="grid gap-3 lg:grid-cols-2">
                    {pending.map(activity => {
                        const cfg = TYPE_CONFIG[activity.type] || TYPE_CONFIG.reading;
                        const Icon = cfg.icon;
                        return (
                            <button
                                key={activity.id}
                                type="button"
                                onClick={() => setActiveActivity(activity)}
                                className={`group flex min-h-32 w-full items-center gap-4 rounded-2xl border p-4 text-left transition hover:-translate-y-0.5 hover:shadow-lg motion-reduce:transform-none ${cfg.border} ${cfg.bg}`}
                            >
                                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-brand-surface shadow-sm">
                                    <Icon size={20} className={cfg.color} aria-hidden="true" />
                                </div>
                                <div className="min-w-0 flex-1">
                                    <div className="mb-1.5 flex flex-wrap items-center gap-2">
                                        <span className={`rounded-full px-2.5 py-1 text-[9px] font-black uppercase tracking-widest ${cfg.badge}`}>{cfg.label}</span>
                                        {activity.difficulty && <span className="text-[9px] font-bold uppercase text-brand-muted">{DIFF_LABEL[activity.difficulty] || activity.difficulty}</span>}
                                    </div>
                                    <p className="text-sm font-black text-brand-text">{activity.title}</p>
                                    <p className="mt-1 line-clamp-2 text-[11px] font-medium leading-relaxed text-brand-muted">{activity.description}</p>
                                </div>
                                <div className="flex shrink-0 items-center gap-1 text-[10px] font-black uppercase tracking-wider text-violet-600">
                                    Começar <ChevronRight size={14} className="transition-transform group-hover:translate-x-0.5" />
                                </div>
                            </button>
                        );
                    })}
                </div>

                {completed.length > 0 && (
                    <div className="pt-3">
                        <p className="mb-3 flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-brand-muted">
                            <CheckCircle size={13} className="text-emerald-500" /> Histórico recente
                        </p>
                        <div className="space-y-2">
                            {completed.slice(0, 4).map(activity => (
                                <div key={activity.id} className="flex items-center gap-3 rounded-xl border border-brand-border bg-brand-surface-2/60 p-3">
                                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30"><CheckCircle size={14} /></div>
                                    <div className="min-w-0 flex-1">
                                        <p className="truncate text-xs font-bold text-brand-text">{activity.title}</p>
                                        <p className="text-[9px] font-bold uppercase tracking-wider text-brand-muted">Prática com evidência registrada</p>
                                    </div>
                                    <Lock size={12} className="shrink-0 text-brand-muted" aria-label="Registro concluído" />
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </section>
    );
};

export default StudentActivities;
