import React, { useState, useEffect, lazy, Suspense, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X, Check, ChevronRight, ChevronLeft, Loader2, Trophy, BookOpen, RefreshCw, Mic, Heart, Zap } from 'lucide-react';
import { motion } from 'framer-motion';
import { supabase } from '../lib/supabase';
import confetti from 'canvas-confetti';
import type { WolfieTutorSessionSummary } from './wolfieTutorSession';

// WolfieTutor usa wolfie-brain (edge function estável) — substituindo WolfieLiveCallV3
// que dependia de Gemini Live API via WebSocket (instável/não configurado)
const WolfieTutor = lazy(() => import('./WolfieTutor'));

interface ActivityPlayerProps {
    activity: {
        id: string;
        unit_id: string;
        type: string;
        title: string;
        description?: string;
        content: any;
        xp_reward: number;
    };
    userId: string;
    wolfieConfig?: any;
    onComplete: (score: number) => void;
    onClose: () => void;
    hearts?: number;
    onHeartsChange?: (hearts: number) => void;
    reviewOnly?: boolean;
}

interface LearningQuestionFeedback {
    questionId: string;
    questionIndex: number;
    selectedIndex: number;
    correct: boolean;
    correctIndex: number;
    explanation?: string | null;
}

interface LearningActivityResult {
    score: number;
    xpEarned: number;
    leveledUp: boolean;
    newLevel: number;
    passed: boolean;
    questionResults: LearningQuestionFeedback[];
}

const ActivityPlayer: React.FC<ActivityPlayerProps> = ({ activity, userId, wolfieConfig, onComplete, onClose, hearts: heartsProp = 5, onHeartsChange, reviewOnly = false }) => {
    const [saving, setSaving] = useState(false);
    const [hearts, setHearts] = useState(heartsProp);
    const [result, setResult] = useState<LearningActivityResult | null>(null);
    const [actionError, setActionError] = useState('');
    const [attemptKey, setAttemptKey] = useState(0);
    const dialogRef = useRef<HTMLDivElement>(null);
    const heartsRef = useRef(heartsProp);
    const savingRef = useRef(false);
    const completionRequestKey = useRef(
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : `learning-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );

    const closePlayer = useCallback(() => {
        if (savingRef.current) return;
        // Depois de uma tentativa autoritativa, qualquer forma de saída precisa
        // atualizar a trilha. Caso contrário, o servidor avança mas o próximo nó
        // permanece visualmente bloqueado até um refresh manual.
        if (result) {
            onComplete(result.score);
            return;
        }
        onClose();
    }, [onClose, onComplete, result]);

    useEffect(() => {
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        const dialog = dialogRef.current;
        const focusable = dialog?.querySelector<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])');
        focusable?.focus();

        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                // Enquanto o servidor registra a tentativa, mantenha o player
                // montado para que a resposta autoritativa sempre atualize a
                // trilha. Isso evita reabrir uma atividade que já avançou.
                closePlayer();
                return;
            }
            if (event.key !== 'Tab' || !dialog) return;
            const items = Array.from(dialog.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')) as HTMLElement[];
            if (items.length === 0) return;
            const first = items[0];
            const last = items[items.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        };
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.body.style.overflow = previousOverflow;
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [closePlayer]);

    const consumeServerGradedMistakes = async (wrongAnswers: number) => {
        const boundedWrongAnswers = Math.max(0, Math.min(5, wrongAnswers));
        for (let index = 0; index < boundedWrongAnswers; index += 1) {
            try {
                const { data, error } = await supabase.rpc('consume_student_heart', {
                    // Derivada da tentativa: um replay após resposta HTTP perdida não
                    // desconta a mesma vida duas vezes.
                    p_request_key: `${completionRequestKey.current}-wrong-${index + 1}`,
                    p_reason: 'WRONG_ANSWER',
                });
                if (error) throw error;
                const nextHearts = Math.min(heartsRef.current, Number(data?.hearts ?? heartsRef.current));
                heartsRef.current = nextHearts;
                setHearts(nextHearts);
                onHeartsChange?.(nextHearts);
            } catch (error) {
                console.error('consume_student_heart error:', error);
            }
        }
    };

    // Anti-burla: envia só as respostas; o SERVIDOR recalcula score + XP (RPC grade_quiz)
    const handleQuizSubmit = async (answers: number[]) => {
        if (savingRef.current) return;
        savingRef.current = true;
        setSaving(true);
        setActionError('');
        try {
            const { data, error } = await supabase.rpc('grade_quiz', {
                p_activity_id: activity.id,
                p_answers: answers,
                p_request_key: completionRequestKey.current,
            });
            if (error) throw error;

            const score = Number(data?.score ?? 0);
            const passed = data?.passed === true || (data?.passed !== false && score >= 60);
            const totalQuestions = Number(data?.totalQuestions ?? answers.length);
            const correctAnswers = Number(data?.correctAnswers ?? Math.round((score / 100) * totalQuestions));
            await consumeServerGradedMistakes(totalQuestions - correctAnswers);

            if (data?.leveledUp) {
                confetti({ particleCount: 160, spread: 90, origin: { y: 0.5 }, colors: ['#facc15', '#f59e0b', '#fff'] });
            } else if (score >= 80) {
                confetti({ particleCount: 80, spread: 70, origin: { y: 0.6 }, colors: ['#10b981', '#3b82f6', '#8b5cf6'] });
            }

            setResult({
                score,
                xpEarned: Number(data?.xpEarned ?? 0),
                leveledUp: !!data?.leveledUp,
                newLevel: Number(data?.newLevel ?? 0),
                passed,
                questionResults: Array.isArray(data?.questionResults)
                    ? data.questionResults as LearningQuestionFeedback[]
                    : [],
            });
        } catch (err) {
            console.error('handleQuizSubmit error:', err);
            setActionError('Não foi possível corrigir esta atividade agora. Suas respostas continuam abertas; tente novamente.');
        } finally {
            savingRef.current = false;
            setSaving(false);
        }
    };

    const handleSubmit = async (score: number, additionalEvidence: Record<string, unknown> = {}) => {
        if (savingRef.current) return;
        savingRef.current = true;
        setSaving(true);
        setActionError('');
        try {
            const evidence = {
                activityType: activity.type,
                score,
                completedAt: new Date().toISOString(),
                ...additionalEvidence,
            };
            const { data, error } = await supabase.rpc('complete_learning_activity', {
                p_activity_id: activity.id,
                p_score: score,
                p_evidence: evidence,
                p_request_key: completionRequestKey.current,
            });
            if (error) throw error;
            const passed = data?.passed !== false && String(data?.status || 'COMPLETED') === 'COMPLETED';

            // Celebração
            if (data?.leveledUp) {
                confetti({ particleCount: 160, spread: 90, origin: { y: 0.5 }, colors: ['#facc15', '#f59e0b', '#fff'] });
            } else if (score >= 80) {
                confetti({ particleCount: 80, spread: 70, origin: { y: 0.6 }, colors: ['#10b981', '#3b82f6', '#8b5cf6'] });
            }

            // Mostra a tela de vitória (onComplete só ao clicar Continuar)
            setResult({
                score: Number(data?.score ?? score),
                xpEarned: Number(data?.xpEarned ?? 0),
                leveledUp: data?.leveledUp === true,
                newLevel: Number(data?.newLevel ?? 0),
                passed,
                questionResults: [],
            });
        } catch (err) {
            console.error('handleSubmit error:', err);
            setActionError('Não foi possível finalizar e registrar esta atividade. Seu progresso continua aberto; tente novamente.');
        } finally {
            savingRef.current = false;
            setSaving(false);
        }
    };

    const retryActivity = () => {
        setResult(null);
        setActionError('');
        setAttemptKey(key => key + 1);
        completionRequestKey.current = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : `learning-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    };

    return (
        <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-sm z-[200] flex items-end sm:items-center justify-center p-0 sm:p-4" onMouseDown={(event) => event.target === event.currentTarget && closePlayer()}>
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-busy={saving}
                aria-labelledby={`activity-title-${activity.id}`}
                className="bg-white dark:bg-slate-900 rounded-t-3xl sm:rounded-3xl max-w-3xl w-full max-h-[95dvh] sm:max-h-[90vh] overflow-hidden shadow-2xl flex flex-col safe-bottom"
            >
                {/* Header */}
                <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between shrink-0">
                    <div className="min-w-0">
                        <p className="text-[10px] uppercase tracking-widest text-slate-400 font-bold">{reviewOnly ? 'Modo revisão' : activity.type.replace(/_/g, ' ')}</p>
                        <h2 id={`activity-title-${activity.id}`} className="text-lg font-black text-slate-800 dark:text-white truncate">{activity.title}</h2>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                        {/* Vidas */}
                        {!reviewOnly && (
                            <div className="flex items-center gap-0.5" title={`${hearts} vidas`}>
                                {[0, 1, 2, 3, 4].map((i) => (
                                    <Heart key={i} size={16} className={i < hearts ? 'text-rose-500' : 'text-slate-200 dark:text-slate-700'} fill={i < hearts ? '#f43f5e' : 'none'} />
                                ))}
                            </div>
                        )}
                        <button type="button" onClick={closePlayer} disabled={saving} aria-label={saving ? 'Salvando atividade' : 'Fechar atividade'} className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl disabled:cursor-wait disabled:opacity-40">
                            {saving ? <Loader2 size={20} className="animate-spin" /> : <X size={20} />}
                        </button>
                    </div>
                </div>

                {/* Body */}
                <div className="flex-1 overflow-y-auto p-4 sm:p-6">
                    {reviewOnly ? (
                        <ReviewActivityContent activity={activity} />
                    ) : (
                    <>
                    {actionError && (
                        <div role="alert" className="mb-4 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm font-bold text-rose-800 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-200">
                            {actionError}
                        </div>
                    )}
                    {!result && hearts <= 0 && (
                        <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-xs font-medium leading-relaxed text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-100">
                            Suas vidas acabaram por enquanto, mas seu aprendizado não para: você pode terminar esta prática. As vidas regeneram automaticamente.
                        </div>
                    )}
                    {result ? (
                        <VictoryScreen
                            result={result}
                            onContinue={() => onComplete(result.score)}
                            onRetry={retryActivity}
                        />
                    ) : (
                    <>
                    {activity.type === 'vocab_cards' && <VocabCardsRunner key={attemptKey} content={activity.content} activityId={activity.id} onFinish={handleSubmit} saving={saving} />}
                    {activity.type === 'quiz' && <QuizRunner key={attemptKey} content={activity.content} saving={saving} onSubmitAnswers={handleQuizSubmit} />}
                    {activity.type === 'grammar_drill' && <QuizRunner key={attemptKey} content={{ questions: activity.content.exercises?.map((e: any) => ({ q: e.sentence, options: e.options })) }} rulePt={activity.content.rule_pt} saving={saving} onSubmitAnswers={handleQuizSubmit} />}
                    {activity.type === 'reading' && <ReadingRunner key={attemptKey} content={activity.content} onSubmitAnswers={handleQuizSubmit} saving={saving} />}
                    {activity.type === 'speaking_wolfie' && (
                        <Suspense fallback={<div className="flex items-center justify-center py-12"><Loader2 className="animate-spin text-violet-500" /></div>}>
                            <SpeakingWolfieRunner key={attemptKey} activity={activity} userId={userId} wolfieConfig={wolfieConfig} onFinish={handleSubmit} />
                        </Suspense>
                    )}
                    {!['vocab_cards', 'quiz', 'grammar_drill', 'reading', 'speaking_wolfie'].includes(activity.type) && (
                        <div className="text-center py-12 text-slate-400">
                            <p className="text-sm">Tipo de atividade ainda não suportado: <code>{activity.type}</code></p>
                        </div>
                    )}
                    </>
                    )}
                    </>
                    )}
                </div>
            </div>
        </div>
    );
};

const displayReviewText = (value: unknown): string => (
    typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
);

const ReviewActivityContent: React.FC<{ activity: ActivityPlayerProps['activity'] }> = ({ activity }) => {
    const content = activity.content && typeof activity.content === 'object' ? activity.content : {};
    const questions = activity.type === 'grammar_drill'
        ? (Array.isArray(content.exercises) ? content.exercises : [])
        : (Array.isArray(content.questions) ? content.questions : []);
    const readingText = displayReviewText(content.text || content.passage || content.reading_text);
    const instructions = displayReviewText(content.instructions_pt || activity.description);

    return (
        <section aria-labelledby={`review-heading-${activity.id}`} className="space-y-5">
            <div className="rounded-2xl border border-violet-200 bg-violet-50 p-4 text-violet-950 dark:border-violet-800/60 dark:bg-violet-950/30 dark:text-violet-100">
                <div className="flex items-start gap-3">
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-violet-600 text-white" aria-hidden="true">
                        <BookOpen size={19} />
                    </span>
                    <div>
                        <h3 id={`review-heading-${activity.id}`} className="text-sm font-black">Revisão sem alterar seu progresso</h3>
                        <p className="mt-1 text-xs leading-5 text-violet-800 dark:text-violet-200">
                            Esta etapa já foi concluída. Você pode consultar o conteúdo com calma; nenhuma resposta, nota, vida ou XP será enviado novamente.
                        </p>
                    </div>
                </div>
            </div>

            {activity.type === 'vocab_cards' && (
                <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2" aria-label="Vocabulário da atividade">
                    {(Array.isArray(content.cards) ? content.cards : []).map((card: any, index: number) => (
                        <li key={`${displayReviewText(card?.term)}-${index}`} className="rounded-2xl border border-slate-200 p-4 dark:border-slate-700">
                            <p className="text-base font-black text-slate-900 dark:text-white">{displayReviewText(card?.term) || `Card ${index + 1}`}</p>
                            <p className="mt-1 text-sm font-bold text-violet-600 dark:text-violet-300">{displayReviewText(card?.translation)}</p>
                            {displayReviewText(card?.example) && <p className="mt-3 text-xs italic leading-5 text-slate-600 dark:text-slate-300">“{displayReviewText(card.example)}”</p>}
                        </li>
                    ))}
                </ul>
            )}

            {activity.type === 'grammar_drill' && displayReviewText(content.rule_pt) && (
                <div className="rounded-2xl bg-slate-50 p-4 text-sm leading-6 text-slate-700 dark:bg-slate-800/60 dark:text-slate-200">
                    <p className="mb-1 text-[10px] font-black uppercase tracking-widest text-violet-500">Regra</p>
                    {displayReviewText(content.rule_pt)}
                </div>
            )}

            {activity.type === 'reading' && readingText && (
                <div className="rounded-2xl bg-slate-50 p-5 text-sm leading-7 text-slate-700 dark:bg-slate-800/60 dark:text-slate-200 whitespace-pre-line">
                    {readingText}
                </div>
            )}

            {questions.length > 0 && (
                <ol className="space-y-4" aria-label="Questões para revisão">
                    {questions.map((question: any, questionIndex: number) => {
                        const prompt = displayReviewText(question?.q || question?.sentence || question?.question);
                        const options = Array.isArray(question?.options) ? question.options : [];
                        return (
                            <li key={displayReviewText(question?.id) || questionIndex} className="rounded-2xl border border-slate-200 p-4 dark:border-slate-700">
                                <p className="text-sm font-black text-slate-800 dark:text-slate-100">{questionIndex + 1}. {prompt}</p>
                                {options.length > 0 && (
                                    <ul className="mt-3 space-y-2 text-sm text-slate-600 dark:text-slate-300">
                                        {options.map((option: unknown, optionIndex: number) => (
                                            <li key={optionIndex} className="rounded-xl bg-slate-50 px-3 py-2 dark:bg-slate-800/60">
                                                {String.fromCharCode(65 + optionIndex)}. {displayReviewText(option)}
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </li>
                        );
                    })}
                </ol>
            )}

            {activity.type === 'speaking_wolfie' && (
                <div className="rounded-2xl border border-slate-200 p-4 dark:border-slate-700">
                    {instructions && <p className="text-sm leading-6 text-slate-700 dark:text-slate-200">{instructions}</p>}
                    {Array.isArray(content.target_phrases) && content.target_phrases.length > 0 && (
                        <ul className="mt-4 flex flex-wrap gap-2" aria-label="Frases sugeridas">
                            {content.target_phrases.map((phrase: unknown, index: number) => (
                                <li key={index} className="rounded-full bg-violet-100 px-3 py-1.5 text-xs font-bold text-violet-700 dark:bg-violet-900/40 dark:text-violet-200">
                                    {displayReviewText(phrase)}
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}

            {!['vocab_cards', 'quiz', 'grammar_drill', 'reading', 'speaking_wolfie'].includes(activity.type) && (
                <p className="rounded-2xl bg-slate-50 p-5 text-sm leading-6 text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
                    {instructions || 'O conteúdo desta atividade não está disponível para revisão.'}
                </p>
            )}
        </section>
    );
};

// ─────────────────────────────────────────────────────────────
// TELA DE VITÓRIA (celebração ao concluir lição)
// ─────────────────────────────────────────────────────────────
const VictoryScreen: React.FC<{
    result: LearningActivityResult;
    onContinue: () => void;
    onRetry: () => void;
}> = ({ result, onContinue, onRetry }) => {
    const { score, xpEarned, leveledUp, newLevel, passed, questionResults } = result;
    const perfeito = passed && score >= 95;

    const titulo = !passed ? 'Você está quase lá' : leveledUp ? 'Subiu de nível!' : perfeito ? 'Perfeito!' : 'Muito bem!';
    const emoji = !passed ? '💪' : leveledUp ? '👑' : perfeito ? '🌟' : '🎉';

    return (
        <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ type: 'spring', stiffness: 220, damping: 18 }}
            className="text-center py-8"
        >
            {/* Selo principal */}
            <motion.div
                initial={{ scale: 0, rotate: -20 }}
                animate={{ scale: 1, rotate: 0 }}
                transition={{ type: 'spring', stiffness: 260, damping: 14, delay: 0.1 }}
                className="relative mx-auto w-28 h-28 rounded-full flex items-center justify-center mb-5"
                style={{
                    background: leveledUp
                        ? 'linear-gradient(135deg,#fbbf24,#f59e0b)'
                        : passed
                            ? 'linear-gradient(135deg,#8b5cf6,#6366f1)'
                            : 'linear-gradient(135deg,#fb923c,#f97316)',
                    boxShadow: leveledUp ? '0 8px 0 #d97706' : passed ? '0 8px 0 #4f46e5' : '0 8px 0 #c2410c',
                }}
            >
                <span className="text-5xl">{emoji}</span>
                {leveledUp && (
                    <motion.span
                        className="absolute inset-[-8px] rounded-full border-4 border-amber-300/60"
                        animate={{ scale: [1, 1.15, 1], opacity: [0.8, 0, 0.8] }}
                        transition={{ repeat: Infinity, duration: 1.8 }}
                    />
                )}
            </motion.div>

            <h2 className="text-2xl font-black text-slate-800 dark:text-white">{titulo}</h2>
            {!passed && <p className="mx-auto mt-2 max-w-sm text-sm text-slate-500 dark:text-slate-400">Revise o feedback e tente novamente. Sua trilha só avança quando o aprendizado estiver consolidado.</p>}
            {leveledUp && (
                <p className="text-sm font-bold text-amber-500 mt-1 uppercase tracking-widest">Nível {newLevel}</p>
            )}

            {/* Cartões de recompensa */}
            <div className="flex items-center justify-center gap-3 mt-6">
                {/* Score */}
                <div className={`rounded-2xl border-2 px-5 py-3 min-w-[96px] ${passed ? 'border-emerald-200 bg-emerald-50 dark:border-emerald-900/40 dark:bg-emerald-900/10' : 'border-orange-200 bg-orange-50 dark:border-orange-900/40 dark:bg-orange-900/10'}`}>
                    <p className={`text-[10px] font-black uppercase tracking-widest ${passed ? 'text-emerald-600' : 'text-orange-600'}`}>Acertos</p>
                    <p className={`text-2xl font-black ${passed ? 'text-emerald-600' : 'text-orange-600'}`}>{score}%</p>
                </div>
                {xpEarned > 0 ? (
                    <div className="rounded-2xl border-2 border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-900/10 px-5 py-3 min-w-[96px]">
                        <p className="text-[10px] font-black text-amber-600 uppercase tracking-widest flex items-center justify-center gap-1">
                            <Zap size={11} /> XP
                        </p>
                        <p className="text-2xl font-black text-amber-600">+{xpEarned}</p>
                    </div>
                ) : passed ? (
                    <div className="rounded-2xl border-2 border-violet-200 dark:border-violet-900/40 bg-violet-50 dark:bg-violet-900/10 px-5 py-3 min-w-[112px]">
                        <p className="text-[10px] font-black text-violet-600 uppercase tracking-widest">Prática</p>
                        <p className="text-sm font-black text-violet-600 mt-1">Concluída</p>
                    </div>
                ) : null}
            </div>

            {questionResults.length > 0 && (
                <div className="mx-auto mt-6 max-w-lg rounded-2xl border border-slate-200 bg-slate-50 p-4 text-left dark:border-slate-700 dark:bg-slate-800/60">
                    <p className="text-[10px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-400">Feedback da correção</p>
                    <ul className="mt-3 space-y-3">
                        {questionResults.map((feedback, index) => (
                            <li key={feedback.questionId || index} className="flex items-start gap-3 text-sm">
                                <span className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-black text-white ${feedback.correct ? 'bg-emerald-500' : 'bg-amber-500'}`} aria-hidden="true">
                                    {feedback.correct ? '✓' : '!'}
                                </span>
                                <div className="min-w-0 flex-1">
                                    <p className="font-black text-slate-800 dark:text-slate-100">
                                        Questão {Number.isInteger(feedback.questionIndex) ? feedback.questionIndex + 1 : index + 1}
                                        {' · '}sua resposta {String.fromCharCode(65 + feedback.selectedIndex)}
                                        {!feedback.correct && <> · correta {String.fromCharCode(65 + feedback.correctIndex)}</>}
                                    </p>
                                    {feedback.explanation && (
                                        <p className="mt-1 text-xs leading-5 text-slate-600 dark:text-slate-300">{feedback.explanation}</p>
                                    )}
                                </div>
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            <button
                onClick={passed ? onContinue : onRetry}
                className="mt-8 w-full max-w-xs mx-auto block px-6 py-3.5 rounded-2xl bg-violet-500 text-white font-black text-sm uppercase tracking-wider hover:bg-violet-600 transition-colors"
                style={{ boxShadow: '0 5px 0 #6d28d9' }}
            >
                {passed ? 'Continuar' : 'Tentar novamente'}
            </button>
        </motion.div>
    );
};

// ─────────────────────────────────────────────────────────────
// VOCAB CARDS
// ─────────────────────────────────────────────────────────────
const VocabCardsRunner: React.FC<{ content: any; activityId: string; onFinish: (score: number) => void; saving: boolean }> = ({ content, activityId, onFinish, saving }) => {
    const cards = content.cards || [];
    const [idx, setIdx] = useState(0);
    const [flipped, setFlipped] = useState(false);
    const [knownCount, setKnownCount] = useState(0);
    const [reviewSaving, setReviewSaving] = useState(false);
    const [reviewError, setReviewError] = useState('');
    const [pendingFinalScore, setPendingFinalScore] = useState<number | null>(null);
    const pendingFinalScoreRef = useRef<number | null>(null);
    const answeringRef = useRef(false);

    useEffect(() => {
        answeringRef.current = false;
    }, [idx]);

    if (cards.length === 0) return <p className="text-slate-400">Sem cards configurados.</p>;

    const card = cards[idx];
    const isLast = idx === cards.length - 1;

    // SRS: agenda revisao para cards "nao sei ainda" (1 dia depois)
    const scheduleReview = async (card: any) => {
        const { error } = await supabase.rpc('schedule_student_vocab_review', {
            p_activity_id: activityId,
            p_term: card.term,
            p_translation: card.translation,
            p_example: card.example || null,
        });
        if (error) throw error;
    };

    const markKnown = async (known: boolean) => {
        if (answeringRef.current || reviewSaving || saving || pendingFinalScoreRef.current !== null) return;
        answeringRef.current = true;
        setReviewError('');
        if (!known) {
            setReviewSaving(true);
            try {
                await scheduleReview(card);
            } catch (error) {
                console.error('scheduleReview error:', error);
                setReviewError('Não foi possível agendar esta palavra para revisão. Tente novamente.');
                setReviewSaving(false);
                answeringRef.current = false;
                return;
            }
            setReviewSaving(false);
        }
        const nextKnownCount = known ? knownCount + 1 : knownCount;
        if (known) setKnownCount(nextKnownCount);
        if (isLast) {
            const finalScore = Math.round((nextKnownCount / cards.length) * 100);
            // Congela o resultado antes de chamar o servidor. Em uma falha de
            // rede, o botão de retry reapresenta exatamente a mesma nota com a
            // mesma chave idempotente do ActivityPlayer, sem contar o card final
            // uma segunda vez.
            pendingFinalScoreRef.current = finalScore;
            setPendingFinalScore(finalScore);
            onFinish(finalScore);
        } else {
            setIdx(i => i + 1);
            setFlipped(false);
        }
    };

    return (
        <div>
            <div className="text-xs font-bold text-slate-400 mb-3">Card {idx + 1} de {cards.length}</div>
            <div
                onClick={() => setFlipped(f => !f)}
                className="relative bg-gradient-to-br from-violet-50 to-indigo-50 dark:from-violet-900/20 dark:to-indigo-900/20 border border-violet-100 dark:border-violet-800/30 rounded-2xl p-6 sm:p-8 min-h-[200px] sm:min-h-[260px] flex items-center justify-center cursor-pointer hover:shadow-lg transition-all"
            >
                {!flipped ? (
                    <div className="text-center">
                        <p className="text-[10px] uppercase tracking-widest text-violet-400 font-bold mb-2">English</p>
                        <p className="text-3xl font-black text-slate-800 dark:text-white">{card.term}</p>
                        <p className="text-xs text-slate-400 mt-4">Clique para virar</p>
                    </div>
                ) : (
                    <div className="text-center">
                        <p className="text-[10px] uppercase tracking-widest text-violet-400 font-bold mb-2">Português</p>
                        <p className="text-2xl font-black text-slate-800 dark:text-white">{card.translation}</p>
                        {card.example && (
                            <p className="text-sm text-slate-600 dark:text-slate-400 mt-4 italic max-w-md mx-auto">"{card.example}"</p>
                        )}
                    </div>
                )}
            </div>

            {reviewError && <p role="alert" className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs font-bold text-rose-700">{reviewError}</p>}

            {pendingFinalScore !== null ? (
                <button
                    type="button"
                    onClick={() => {
                        if (saving || pendingFinalScoreRef.current === null) return;
                        onFinish(pendingFinalScoreRef.current);
                    }}
                    disabled={saving}
                    className="mt-6 w-full rounded-xl bg-violet-600 py-3 text-sm font-bold text-white transition-colors hover:bg-violet-700 disabled:cursor-wait disabled:opacity-60"
                >
                    {saving ? 'Registrando resultado...' : 'Tentar registrar novamente'}
                </button>
            ) : (
            <div className="grid grid-cols-1 gap-3 mt-6 sm:grid-cols-2">
                <button
                    type="button"
                    onClick={() => void markKnown(false)}
                    disabled={saving || reviewSaving}
                    className="py-3 rounded-xl font-bold text-sm border-2 border-rose-200 text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-900/20 transition-colors disabled:opacity-50"
                >
                    Não sei ainda
                </button>
                <button
                    type="button"
                    onClick={() => void markKnown(true)}
                    disabled={saving || reviewSaving}
                    className="py-3 rounded-xl font-bold text-sm bg-emerald-500 text-white hover:bg-emerald-600 transition-colors disabled:opacity-50"
                >
                    Sei essa! <Check size={14} className="inline ml-1" />
                </button>
            </div>
            )}
        </div>
    );
};

// ─────────────────────────────────────────────────────────────
// QUIZ / GRAMMAR DRILL
// ─────────────────────────────────────────────────────────────
const QuizRunner: React.FC<{ content: any; rulePt?: string; saving: boolean; onSubmitAnswers: (answers: number[]) => void }> = ({ content, rulePt, saving, onSubmitAnswers }) => {
    const questions = content.questions || [];
    const [idx, setIdx] = useState(0);
    const [selected, setSelected] = useState<number | null>(null);
    const [showExp, setShowExp] = useState(false);
    const [answers, setAnswers] = useState<number[]>([]); // respostas para validação no servidor

    if (questions.length === 0) return <p className="text-slate-400">Sem questões configuradas.</p>;

    const q = questions[idx];
    const isLast = idx === questions.length - 1;

    const submit = () => {
        if (selected === null) return;
        setShowExp(true);
        setAnswers(prev => { const cp = [...prev]; cp[idx] = selected; return cp; });
    };

    const next = () => {
        if (isLast) {
            const finais = [...answers]; finais[idx] = selected ?? -1;
            // Anti-burla: servidor recalcula o score a partir do gabarito que
            // nunca é enviado ao navegador.
            onSubmitAnswers(finais);
        } else {
            setIdx(i => i + 1);
            setSelected(null);
            setShowExp(false);
        }
    };

    return (
        <div>
            {rulePt && idx === 0 && (
                <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-100 dark:border-amber-800/30 rounded-2xl p-4 mb-6">
                    <p className="text-[10px] uppercase tracking-widest text-amber-600 font-bold mb-1">Regra</p>
                    <p className="text-sm text-slate-700 dark:text-slate-300">{rulePt}</p>
                </div>
            )}
            <div className="text-xs font-bold text-slate-400 mb-3">Pergunta {idx + 1} de {questions.length}</div>
            <p className="text-lg font-bold text-slate-800 dark:text-white mb-4">{q.q || q.sentence}</p>
            <div className="space-y-2">
                {q.options.map((opt: string, i: number) => {
                    const isSel = selected === i;
                    const showResult = showExp;
                    return (
                        <button
                            key={i}
                            onClick={() => !showExp && setSelected(i)}
                            disabled={showExp}
                            className={`w-full text-left p-3 rounded-xl border-2 transition-all text-sm font-medium ${
                                showResult && isSel
                                        ? 'border-violet-500 bg-violet-50 dark:bg-violet-900/20 text-violet-700 dark:text-violet-300'
                                    : isSel
                                        ? 'border-violet-500 bg-violet-50 dark:bg-violet-900/20 text-violet-700 dark:text-violet-300'
                                        : 'border-slate-200 dark:border-slate-700 hover:border-violet-300 text-slate-700 dark:text-slate-300'
                            }`}
                        >
                            {String.fromCharCode(65 + i)}. {opt}
                        </button>
                    );
                })}
            </div>

            {showExp && (
                <div className="mt-4 rounded-xl border border-violet-100 bg-violet-50 p-4 dark:border-violet-800/40 dark:bg-violet-900/20">
                    <p className="text-xs font-bold uppercase tracking-widest text-violet-600 dark:text-violet-300">Resposta registrada</p>
                    <p className="mt-1 text-sm text-slate-700 dark:text-slate-300">A correção segura aparece ao concluir a atividade.</p>
                </div>
            )}

            <div className="mt-6">
                {!showExp ? (
                    <button
                        onClick={submit}
                        disabled={selected === null}
                        className="w-full py-3 rounded-xl font-bold text-sm bg-violet-600 text-white hover:bg-violet-700 transition-colors disabled:opacity-50"
                    >
                        Confirmar resposta
                    </button>
                ) : (
                    <button
                        onClick={next}
                        disabled={saving}
                        className="w-full py-3 rounded-xl font-bold text-sm bg-slate-800 dark:bg-slate-700 text-white hover:bg-slate-700 transition-colors flex items-center justify-center gap-2"
                    >
                        {isLast ? <>Concluir <Trophy size={14} /></> : <>Próxima <ChevronRight size={14} /></>}
                    </button>
                )}
            </div>
        </div>
    );
};

// ─────────────────────────────────────────────────────────────
// READING
// ─────────────────────────────────────────────────────────────
const ReadingRunner: React.FC<{ content: any; onSubmitAnswers: (answers: number[]) => void; saving: boolean }> = ({ content, onSubmitAnswers, saving }) => {
    const [readStage, setReadStage] = useState<'text' | 'questions'>('text');

    return (
        <div>
            {readStage === 'text' ? (
                <div>
                    <div className="bg-slate-50 dark:bg-slate-800/50 rounded-2xl p-6 mb-4">
                        <BookOpen size={20} className="text-violet-500 mb-3" />
                        <p className="text-sm text-slate-700 dark:text-slate-300 whitespace-pre-line leading-relaxed">{content.text}</p>
                    </div>
                    <button
                        onClick={() => setReadStage('questions')}
                        className="w-full py-3 rounded-xl font-bold text-sm bg-violet-600 text-white hover:bg-violet-700 transition-colors"
                    >
                        Já li, ir para as perguntas
                    </button>
                </div>
            ) : (
                <QuizRunner content={{ questions: content.questions }} onSubmitAnswers={onSubmitAnswers} saving={saving} />
            )}
        </div>
    );
};

// ─────────────────────────────────────────────────────────────
// SPEAKING WOLFIE
// ─────────────────────────────────────────────────────────────
const SpeakingWolfieRunner: React.FC<{ activity: any; userId: string; wolfieConfig: any; onFinish: (score: number, evidence?: Record<string, unknown>) => void }> = ({ activity, userId, wolfieConfig, onFinish }) => {
    const [launched, setLaunched] = useState(false);
    const [practiceNotice, setPracticeNotice] = useState('');

    if (launched) {
        // Monta objeto user compatível com WolfieTutor
        // levelBadge vem do wolfieConfig da atividade (gerado por IA com base no perfil)
        const userForWolfie = {
            id: userId,
            levelBadge: wolfieConfig?.level || 'B1',
            full_name: wolfieConfig?.studentName || '',
            goal: wolfieConfig?.goal || 'practice speaking fluently',
        };

        // Tópico: usa o scenario da atividade ou as instruções como tópico
        const topicForWolfie = activity.content?.scenario
            || activity.content?.topic
            || activity.title
            || 'Speaking Practice';

        // Portal para escapar do overflow:hidden do ActivityPlayer.
        // No Safari/WebKit, position:fixed dentro de um ancestral com overflow:hidden
        // fica preso naquele container (não cobre o viewport). Renderizando no body
        // a Wolfie ocupa a tela inteira corretamente em todos os browsers.
        return createPortal(
            <Suspense fallback={
                <div className="fixed inset-0 z-[200] bg-slate-950 flex items-center justify-center">
                    <Loader2 className="animate-spin text-violet-400" size={32} />
                </div>
            }>
                <WolfieTutor
                    user={userForWolfie}
                    voiceMode={true}
                    topic={topicForWolfie}
                    onClose={(summary: WolfieTutorSessionSummary) => {
                        setLaunched(false);
                        if (!summary.sessionCompleted) {
                            setPracticeNotice('Conclua pelo menos duas participações substantivas e aguarde a confirmação do Wolfie. Fechar antes disso não registra progresso.');
                            return;
                        }
                        setPracticeNotice('');
                        const score = summary.sessionScore === null
                            ? 60
                            : Math.max(60, Math.min(100, summary.sessionScore));
                        onFinish(score, {
                            learnerTurns: summary.learnerTurns,
                            sessionCompleted: true,
                            wolfieSessionScore: summary.sessionScore,
                            wolfieConversationId: summary.conversationId,
                        });
                    }}
                />
            </Suspense>,
            document.body
        );
    }

    return (
        <div>
            {practiceNotice && (
                <p role="alert" className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs font-bold leading-relaxed text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-100">
                    {practiceNotice}
                </p>
            )}
            <div className="bg-gradient-to-br from-violet-50 to-pink-50 dark:from-violet-900/20 dark:to-pink-900/20 border border-violet-100 dark:border-violet-800/30 rounded-2xl p-6 mb-4">
                <Mic size={24} className="text-violet-500 mb-3" />
                <p className="text-[10px] uppercase tracking-widest text-violet-400 font-bold mb-2">Tarefa</p>
                <p className="text-sm text-slate-700 dark:text-slate-300 leading-relaxed">{activity.content?.instructions_pt}</p>
                {activity.content?.target_phrases?.length > 0 && (
                    <div className="mt-4">
                        <p className="text-[10px] uppercase tracking-widest text-slate-400 font-bold mb-2">Tente usar:</p>
                        <div className="flex flex-wrap gap-2">
                            {activity.content.target_phrases.map((p: string, i: number) => (
                                <span key={i} className="px-3 py-1 text-xs font-bold bg-white dark:bg-slate-800 rounded-full text-violet-600 dark:text-violet-300">{p}</span>
                            ))}
                        </div>
                    </div>
                )}
            </div>
            <button
                onClick={() => { setPracticeNotice(''); setLaunched(true); }}
                className="w-full py-3 rounded-xl font-bold text-sm bg-violet-600 text-white hover:bg-violet-700 transition-colors flex items-center justify-center gap-2"
            >
                <Mic size={14} /> Começar com Wolfie
            </button>
        </div>
    );
};

export default ActivityPlayer;
