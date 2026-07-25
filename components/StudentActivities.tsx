import React, { useState, useEffect } from 'react';
import { BookOpen, MessageSquare, HelpCircle, Mic, Sparkles, CheckCircle, RefreshCw, Lock, AlertCircle } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { ActivityGenerationError, generateActivities } from '../services/geminiService';

interface StudentActivitiesProps {
    userId: string;
    tenantId?: string;
}

const TYPE_CONFIG = {
    reading: { icon: BookOpen, label: 'Leitura', color: 'text-blue-600', bg: 'bg-blue-50 dark:bg-blue-900/20', border: 'border-blue-100 dark:border-blue-800/30', badge: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300' },
    grammar: { icon: BookOpen, label: 'Gramática', color: 'text-emerald-600', bg: 'bg-emerald-50 dark:bg-emerald-900/20', border: 'border-emerald-100 dark:border-emerald-800/30', badge: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300' },
    quiz: { icon: HelpCircle, label: 'Quiz', color: 'text-amber-600', bg: 'bg-amber-50 dark:bg-amber-900/20', border: 'border-amber-100 dark:border-amber-800/30', badge: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' },
    conversation: { icon: Mic, label: 'Conversação', color: 'text-violet-600', bg: 'bg-violet-50 dark:bg-violet-900/20', border: 'border-violet-100 dark:border-violet-800/30', badge: 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300' },
};

const DIFF_LABEL: Record<string, string> = {
    BEGINNER: 'Iniciante',
    INTERMEDIATE: 'Intermediário',
    ADVANCED: 'Avançado',
};

const StudentActivities: React.FC<StudentActivitiesProps> = ({ userId, tenantId }) => {
    const [activities, setActivities] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [generating, setGenerating] = useState(false);
    const [expanded, setExpanded] = useState<string | null>(null);
    const [completing, setCompleting] = useState<string | null>(null);
    const [generationError, setGenerationError] = useState('');

    useEffect(() => {
        if (userId) fetchActivities();
    }, [userId]);

    const fetchActivities = async () => {
        setLoading(true);
        try {
            const { data } = await supabase
                .from('student_activities')
                .select('*')
                .eq('student_id', userId)
                .order('created_at', { ascending: false })
                .limit(8);

            const existing = data || [];
            setActivities(existing);

            // Auto-generate if fewer than 3 pending
            const pending = existing.filter(a => a.status === 'PENDING');
            if (pending.length < 3) {
                await generateNew();
            }
        } catch (err) {
            console.error('fetchActivities error:', err);
        } finally {
            setLoading(false);
        }
    };

    const generateNew = async () => {
        if (generating) return;
        setGenerating(true);
        setGenerationError('');
        try {
            // Fetch profile + wolf intelligence
            const [profileRes, wolfRes] = await Promise.all([
                supabase.from('profiles').select('english_for, student_category, personality, preferred_topics, avoided_topics, short_term_goal, module').eq('id', userId).single(),
                supabase.from('wolf_intelligence').select('accumulated_context, weak_points, recommended_approach').eq('student_id', userId).single(),
            ]);

            const profile: Record<string, any> = profileRes.data || {};
            const wolf = wolfRes.data || undefined;

            const generatedResult = await generateActivities(profile, wolf);
            const generated = generatedResult.activities;

            if (generated.length > 0) {
                const toInsert = generated.map(a => ({
                    student_id: userId,
                    tenant_id: tenantId || '',
                    type: a.type,
                    title: a.title,
                    description: a.description,
                    content: a.content,
                    difficulty: a.difficulty,
                    xp_reward: a.xp_reward,
                    status: 'PENDING',
                    generated_by_ai: generatedResult.source === 'ai',
                    category: profile.english_for || null,
                }));

                const { data: inserted, error: insertError } = await supabase
                    .from('student_activities')
                    .insert(toInsert)
                    .select();
                if (insertError) throw insertError;

                if (inserted) {
                    setActivities(prev => [...inserted, ...prev].slice(0, 8));
                }
            }
        } catch (err) {
            const activityError = err instanceof ActivityGenerationError ? err : null;
            setGenerationError(
                activityError?.message
                || 'Não foi possível salvar as novas atividades. Tente novamente.',
            );
            console.error('generateNew error', {
                code: activityError?.code || 'ACTIVITY_SAVE_FAILED',
            });
        } finally {
            setGenerating(false);
        }
    };

    const handleComplete = async (activity: any) => {
        if (activity.status === 'COMPLETED' || completing) return;
        setCompleting(activity.id);
        try {
            await supabase
                .from('student_activities')
                .update({ status: 'COMPLETED', completed_at: new Date().toISOString() })
                .eq('id', activity.id);

            setActivities(prev => prev.map(a => a.id === activity.id ? { ...a, status: 'COMPLETED' } : a));
            setExpanded(null);
        } catch (err) {
            console.error('handleComplete error:', err);
        } finally {
            setCompleting(null);
        }
    };

    const pending = activities.filter(a => a.status === 'PENDING');
    const completed = activities.filter(a => a.status === 'COMPLETED');

    if (loading) {
        return (
            <div className="bg-white dark:bg-slate-900 rounded-[2.5rem] border border-slate-100 dark:border-slate-800 p-5 sm:p-8">
                <div className="flex items-center gap-3 mb-6">
                    <div className="w-10 h-10 bg-violet-100 dark:bg-violet-900/30 rounded-xl flex items-center justify-center">
                        <Sparkles size={20} className="text-violet-600 dark:text-violet-400" />
                    </div>
                    <div>
                        <h3 className="font-black text-slate-800 dark:text-white text-sm">Atividades Complementares</h3>
                        <p className="text-[10px] text-slate-400 uppercase tracking-widest">Personalizadas para seu perfil</p>
                    </div>
                </div>
                <div className="flex items-center justify-center py-12 gap-3 text-slate-400">
                    <RefreshCw className="animate-spin" size={20} />
                    <span className="text-sm font-bold">Carregando atividades...</span>
                </div>
            </div>
        );
    }

    return (
        <div className="bg-white dark:bg-slate-900 rounded-[2.5rem] border border-slate-100 dark:border-slate-800 overflow-hidden">
            {/* Header */}
            <div className="p-4 sm:p-6 border-b border-slate-100 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                    <div className="w-10 h-10 bg-violet-100 dark:bg-violet-900/30 rounded-xl flex items-center justify-center shrink-0">
                        <Sparkles size={20} className="text-violet-600 dark:text-violet-400" />
                    </div>
                    <div className="min-w-0">
                        <h3 className="font-black text-slate-800 dark:text-white text-sm">Atividades Complementares</h3>
                        <p className="text-[10px] text-slate-400 uppercase tracking-widest">
                            {pending.length} pendentes · {completed.length} concluídas
                        </p>
                    </div>
                </div>
                <button
                    onClick={generateNew}
                    disabled={generating}
                    className="flex items-center gap-2 px-3 sm:px-4 py-2 bg-violet-600 text-white text-[10px] font-black uppercase tracking-widest rounded-xl hover:brightness-110 transition-all disabled:opacity-50 whitespace-nowrap shrink-0"
                >
                    {generating ? <RefreshCw size={12} className="animate-spin" /> : <Sparkles size={12} />}
                    {generating ? 'Gerando...' : 'Gerar Novas'}
                </button>
            </div>

            {/* Activities List */}
            <div className="p-6 space-y-4">
                {generating && activities.length === 0 && (
                    <div className="text-center py-8">
                        <div className="inline-flex items-center gap-3 px-6 py-3 bg-violet-50 dark:bg-violet-900/20 rounded-2xl border border-violet-100 dark:border-violet-800/30">
                            <RefreshCw size={16} className="animate-spin text-violet-500" />
                            <span className="text-sm font-bold text-violet-600 dark:text-violet-400">A IA está criando atividades personalizadas para você...</span>
                        </div>
                    </div>
                )}

                {generationError && !generating && (
                    <div role="alert" className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-amber-900 dark:border-amber-800/40 dark:bg-amber-900/20 dark:text-amber-200">
                        <div className="flex items-start gap-3">
                            <AlertCircle size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
                            <div className="min-w-0">
                                <p className="text-sm font-black">As atividades não carregaram desta vez.</p>
                                <p className="mt-1 text-xs font-medium">{generationError}</p>
                                <button
                                    type="button"
                                    onClick={() => void generateNew()}
                                    className="mt-3 rounded-xl bg-amber-600 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-white hover:bg-amber-700"
                                >
                                    Tentar novamente
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {pending.length === 0 && !generating && !generationError && (
                    <div className="text-center py-8 text-slate-400">
                        <CheckCircle size={32} className="mx-auto mb-3 text-emerald-400" />
                        <p className="text-sm font-bold">Todas as atividades concluídas!</p>
                        <p className="text-xs mt-1">Clique em "Gerar Novas" para receber mais desafios.</p>
                    </div>
                )}

                {/* Pending activities */}
                {pending.map(activity => {
                    const cfg = TYPE_CONFIG[activity.type as keyof typeof TYPE_CONFIG] || TYPE_CONFIG.reading;
                    const Icon = cfg.icon;
                    const isOpen = expanded === activity.id;

                    return (
                        <div
                            key={activity.id}
                            className={`rounded-2xl border ${cfg.border} ${cfg.bg} transition-all duration-300`}
                        >
                            <button
                                onClick={() => setExpanded(isOpen ? null : activity.id)}
                                className="w-full p-4 flex items-center gap-4 text-left"
                            >
                                <div className={`w-10 h-10 rounded-xl flex items-center justify-center bg-white dark:bg-slate-800 shadow-sm shrink-0`}>
                                    <Icon size={18} className={cfg.color} />
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 flex-wrap mb-1">
                                        <span className={`text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full ${cfg.badge}`}>
                                            {cfg.label}
                                        </span>
                                        <span className="text-[9px] font-bold text-slate-400 uppercase">{DIFF_LABEL[activity.difficulty] || activity.difficulty}</span>
                                    </div>
                                    <p className="text-sm font-black text-slate-800 dark:text-white truncate">{activity.title}</p>
                                    <p className="text-[10px] text-slate-500 dark:text-slate-400 line-clamp-1">{activity.description}</p>
                                </div>
                                <div className="shrink-0 flex items-center gap-2">
                                    <div className="flex items-center gap-1 px-2 py-1 bg-white/70 dark:bg-slate-800/70 rounded-lg">
                                        <span className="text-[10px] font-black text-slate-500">Prática livre</span>
                                    </div>
                                </div>
                            </button>

                            {isOpen && (
                                <div className="px-4 pb-4 animate-in slide-in-from-top-2 duration-200">
                                    <div className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-slate-100 dark:border-slate-700 mb-3">
                                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Como fazer</p>
                                        <p className="text-sm text-slate-700 dark:text-slate-300 leading-relaxed">{activity.content}</p>
                                    </div>
                                    <button
                                        onClick={() => handleComplete(activity)}
                                        disabled={!!completing}
                                        className={`w-full py-3 rounded-xl font-black text-xs uppercase tracking-widest flex items-center justify-center gap-2 transition-all shadow-sm ${cfg.color} bg-white dark:bg-slate-800 border ${cfg.border} hover:opacity-80 disabled:opacity-50`}
                                    >
                                        {completing === activity.id ? (
                                            <><RefreshCw size={14} className="animate-spin" /> Registrando...</>
                                        ) : (
                                            <><CheckCircle size={14} /> Marcar como concluída</>
                                        )}
                                    </button>
                                </div>
                            )}
                        </div>
                    );
                })}

                {/* Completed section */}
                {completed.length > 0 && (
                    <div className="mt-6">
                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3 flex items-center gap-2">
                            <CheckCircle size={12} className="text-emerald-500" /> Concluídas
                        </p>
                        <div className="space-y-2">
                            {completed.slice(0, 3).map(activity => {
                                const cfg = TYPE_CONFIG[activity.type as keyof typeof TYPE_CONFIG] || TYPE_CONFIG.reading;
                                const Icon = cfg.icon;
                                return (
                                    <div key={activity.id} className="flex items-center gap-3 p-3 bg-slate-50 dark:bg-slate-800/50 rounded-xl opacity-60">
                                        <div className="w-8 h-8 rounded-lg bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center">
                                            <CheckCircle size={14} className="text-emerald-600" />
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <p className="text-xs font-bold text-slate-600 dark:text-slate-400 truncate">{activity.title}</p>
                                            <p className="text-[9px] text-slate-400">Prática registrada</p>
                                        </div>
                                        <Lock size={12} className="text-slate-300 shrink-0" />
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default StudentActivities;
