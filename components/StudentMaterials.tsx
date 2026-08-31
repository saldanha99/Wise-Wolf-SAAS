import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    ArrowLeft,
    ArrowRight,
    Award,
    Check,
    CheckCircle2,
    ClipboardCheck,
    Clock3,
    Loader2,
    LockKeyhole,
    RefreshCw,
    ShieldCheck,
    Sparkles,
    Target,
    X,
} from 'lucide-react';
import confetti from 'canvas-confetti';
import { supabase } from '../lib/supabase';
import { User as UserType } from '../types';
import GamificationHeader from './GamificationHeader';
import { useStudentContext } from './contexts/StudentContext';

interface StudentMaterialsProps {
    user: UserType;
}

interface QuizQuestion {
    id: string;
    question: string;
    options: string[];
}

interface QuizResult {
    score: number;
    totalQuestions: number;
    percentage: number;
    xpEarned: number;
    passed: boolean;
    nextPart: string;
}

const newSubmissionKey = (): string => (
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `evaluation-${Date.now()}-${Math.random().toString(36).slice(2)}`
);

const focusableSelector = [
    'button:not([disabled])',
    '[href]',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
].join(',');

const StudentMaterials: React.FC<StudentMaterialsProps> = ({ user }) => {
    const { data: studentContext, loading: contextLoading, refresh } = useStudentContext();
    const profile = studentContext?.profile;
    const currentModule = profile?.module || 'A1';
    const currentPartKey = profile?.current_book_part || `${currentModule}-1`;
    const evaluationComplete = currentPartKey === 'COMPLETED';
    const evaluationUnlocked = profile?.evaluation_unlocked === true && !evaluationComplete;

    const [showEvaluation, setShowEvaluation] = useState(false);
    const [questions, setQuestions] = useState<QuizQuestion[]>([]);
    const [loadingQuiz, setLoadingQuiz] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [errorMessage, setErrorMessage] = useState('');
    const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
    const [answers, setAnswers] = useState<Array<number | null>>([]);
    const [result, setResult] = useState<QuizResult | null>(null);
    const dialogRef = useRef<HTMLDivElement>(null);
    const previouslyFocusedRef = useRef<HTMLElement | null>(null);
    const submissionRef = useRef<{ fingerprint: string; key: string } | null>(null);
    const submittingRef = useRef(false);

    const draftKey = `wise-wolf:pedagogical-evaluation:${user.id}:${currentPartKey}`;

    const closeEvaluation = useCallback(() => {
        if (submittingRef.current) return;
        setShowEvaluation(false);
    }, []);

    useEffect(() => {
        if (!showEvaluation) return;
        previouslyFocusedRef.current = document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        const focusTimer = window.setTimeout(() => {
            const first = dialogRef.current?.querySelector<HTMLElement>(focusableSelector);
            first?.focus();
        }, 0);

        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                closeEvaluation();
                return;
            }
            if (event.key !== 'Tab' || !dialogRef.current) return;
            const focusable = Array.from(
                dialogRef.current.querySelectorAll(focusableSelector),
            ) as HTMLElement[];
            if (focusable.length === 0) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
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
            window.clearTimeout(focusTimer);
            document.body.style.overflow = previousOverflow;
            document.removeEventListener('keydown', onKeyDown);
            previouslyFocusedRef.current?.focus();
        };
    }, [closeEvaluation, showEvaluation]);

    useEffect(() => {
        if (!showEvaluation || questions.length === 0 || result) return;
        try {
            localStorage.setItem(draftKey, JSON.stringify({ answers, currentQuestionIndex }));
        } catch {
            // A retomada é opcional; alguns navegadores bloqueiam storage privado.
        }
    }, [answers, currentQuestionIndex, draftKey, questions.length, result, showEvaluation]);

    const loadQuiz = useCallback(async () => {
        setLoadingQuiz(true);
        setErrorMessage('');
        setResult(null);
        try {
            const { data, error } = await supabase.functions.invoke('submit-quiz', {
                body: { action: 'load', bookPart: currentPartKey },
            });
            if (error) throw error;
            const loaded = Array.isArray(data?.questions) ? data.questions : [];
            if (loaded.length === 0) throw new Error('quiz_without_questions');

            const normalized: QuizQuestion[] = loaded.map((question: any, index: number) => ({
                id: String(question.id ?? index),
                question: String(question.question ?? ''),
                options: Array.isArray(question.options) ? question.options.map(String) : [],
            }));
            if (normalized.some(question => !question.question || question.options.length < 2)) {
                throw new Error('invalid_quiz_payload');
            }
            setQuestions(normalized);

            let restoredAnswers: Array<number | null> = Array(normalized.length).fill(null);
            let restoredIndex = 0;
            try {
                const raw = localStorage.getItem(draftKey);
                const draft = raw ? JSON.parse(raw) : null;
                if (Array.isArray(draft?.answers)) {
                    restoredAnswers = normalized.map((question, index) => {
                        const answer = draft.answers[index];
                        return Number.isInteger(answer) && answer >= 0 && answer < question.options.length
                            ? answer
                            : null;
                    });
                }
                if (Number.isInteger(draft?.currentQuestionIndex)) {
                    restoredIndex = Math.min(normalized.length - 1, Math.max(0, draft.currentQuestionIndex));
                }
            } catch {
                // Um rascunho inválido não pode bloquear a avaliação.
            }
            setAnswers(restoredAnswers);
            setCurrentQuestionIndex(restoredIndex);
        } catch (error) {
            console.error('Secure quiz load failed:', error);
            setQuestions([]);
            setErrorMessage('Não foi possível abrir esta avaliação agora. Seu progresso anterior continua salvo.');
        } finally {
            setLoadingQuiz(false);
        }
    }, [currentPartKey, draftKey]);

    const openEvaluation = () => {
        if (!evaluationUnlocked) return;
        setShowEvaluation(true);
        void loadQuiz();
    };

    const selectOption = (optionIndex: number) => {
        setAnswers(previous => {
            const next = previous.length === questions.length
                ? [...previous]
                : Array(questions.length).fill(null);
            next[currentQuestionIndex] = optionIndex;
            return next;
        });
        setErrorMessage('');
    };

    const submitQuiz = async () => {
        if (submittingRef.current || answers.some(answer => answer === null)) return;
        submittingRef.current = true;
        setSubmitting(true);
        setErrorMessage('');
        try {
            const fingerprint = JSON.stringify({ bookPart: currentPartKey, answers });
            if (submissionRef.current?.fingerprint !== fingerprint) {
                submissionRef.current = { fingerprint, key: newSubmissionKey() };
            }
            const { data, error } = await supabase.functions.invoke('submit-quiz', {
                body: {
                    action: 'submit',
                    bookPart: currentPartKey,
                    answers: answers as number[],
                    requestKey: submissionRef.current.key,
                },
            });
            if (error) throw error;
            const nextResult: QuizResult = {
                score: Number(data?.score ?? 0),
                totalQuestions: Number(data?.totalQuestions ?? questions.length),
                percentage: Number(data?.percentage ?? 0),
                xpEarned: Number(data?.xpEarned ?? 0),
                passed: data?.passed === true,
                nextPart: String(data?.nextPart ?? currentPartKey),
            };
            setResult(nextResult);
            submissionRef.current = null;
            try { localStorage.removeItem(draftKey); } catch {}
            if (nextResult.passed) {
                if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
                    confetti({ particleCount: 140, spread: 80, origin: { y: 0.62 } });
                }
                await refresh();
            }
        } catch (error) {
            console.error('Secure quiz submission failed:', error);
            setErrorMessage('Não foi possível registrar suas respostas. Elas continuam aqui; tente enviar novamente.');
        } finally {
            submittingRef.current = false;
            setSubmitting(false);
        }
    };

    const retryQuiz = () => {
        submissionRef.current = null;
        setAnswers(Array(questions.length).fill(null));
        setCurrentQuestionIndex(0);
        setResult(null);
        setErrorMessage('');
    };

    if (contextLoading) {
        return (
            <div className="flex min-h-72 flex-col items-center justify-center gap-3 rounded-[2rem] border border-brand-border bg-brand-surface" role="status">
                <Loader2 className="animate-spin text-tenant-primary" size={28} />
                <p className="text-xs font-black uppercase tracking-widest text-brand-muted">Preparando sua jornada...</p>
            </div>
        );
    }

    const answeredCount = answers.filter(answer => answer !== null).length;
    const currentQuestion = questions[currentQuestionIndex];
    const selectedOption = answers[currentQuestionIndex] ?? null;

    return (
        <section className="overflow-hidden rounded-[2.5rem] border border-indigo-200/60 bg-brand-surface shadow-xl shadow-indigo-950/5 dark:border-indigo-900/40">
            <div className="relative overflow-hidden bg-gradient-to-br from-slate-950 via-indigo-950 to-violet-900 px-5 py-7 text-white sm:px-8 sm:py-9">
                <div className="pointer-events-none absolute -right-16 -top-24 h-72 w-72 rounded-full bg-violet-500/25 blur-3xl" />
                <div className="pointer-events-none absolute -bottom-28 left-1/4 h-60 w-60 rounded-full bg-sky-400/15 blur-3xl" />
                <div className="relative flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
                    <div className="max-w-2xl">
                        <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.18em] text-indigo-100 backdrop-blur">
                            <ShieldCheck size={13} aria-hidden="true" /> Jornada pedagógica verificada
                        </div>
                        <h2 className="text-2xl font-black tracking-tight sm:text-3xl">Seu próximo marco no inglês</h2>
                        <p className="mt-2 max-w-xl text-sm font-medium leading-relaxed text-indigo-100/75">
                            Estude os materiais indicados pelo professor e, quando estiver pronto, valide seu domínio em uma avaliação progressiva.
                        </p>
                    </div>
                    <div className="grid grid-cols-2 gap-3 sm:min-w-[330px]">
                        <div className="rounded-2xl border border-white/10 bg-white/10 p-4 backdrop-blur">
                            <p className="text-[10px] font-black uppercase tracking-widest text-indigo-200/70">Nível atual</p>
                            <p className="mt-1 text-2xl font-black">{currentModule}</p>
                        </div>
                        <div className="rounded-2xl border border-white/10 bg-white/10 p-4 backdrop-blur">
                            <p className="text-[10px] font-black uppercase tracking-widest text-indigo-200/70">Próximo marco</p>
                            <p className="mt-1 text-2xl font-black">{evaluationComplete ? '✓' : currentPartKey}</p>
                        </div>
                    </div>
                </div>
            </div>

            <div className="space-y-6 p-5 sm:p-8">
                <GamificationHeader
                    xp={studentContext?.gamification?.xp || 0}
                    level={studentContext?.gamification?.level || 1}
                    streak={studentContext?.gamification?.streak || 0}
                />

                <div className={`relative overflow-hidden rounded-3xl border p-5 sm:p-6 ${
                    evaluationComplete
                        ? 'border-emerald-200 bg-emerald-50 dark:border-emerald-900/40 dark:bg-emerald-900/15'
                        : evaluationUnlocked
                            ? 'border-violet-200 bg-gradient-to-br from-violet-50 to-indigo-50 dark:border-violet-800/40 dark:from-violet-950/40 dark:to-indigo-950/40'
                            : 'border-brand-border bg-brand-surface-2/60'
                }`}>
                    <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
                        <div className="flex min-w-0 items-start gap-4">
                            <div className={`flex shrink-0 items-center justify-center rounded-2xl p-3 ${
                                evaluationComplete
                                    ? 'bg-emerald-500 text-white'
                                    : evaluationUnlocked
                                        ? 'bg-violet-600 text-white shadow-lg shadow-violet-500/25'
                                        : 'bg-brand-surface text-brand-muted'
                            }`}>
                                {evaluationComplete
                                    ? <Award size={26} aria-hidden="true" />
                                    : evaluationUnlocked
                                        ? <ClipboardCheck size={26} aria-hidden="true" />
                                        : <LockKeyhole size={24} aria-hidden="true" />}
                            </div>
                            <div className="min-w-0">
                                <p className="text-[10px] font-black uppercase tracking-[0.18em] text-brand-muted">
                                    {evaluationComplete ? 'Jornada concluída' : `Avaliação ${currentPartKey}`}
                                </p>
                                <h3 className="mt-1 text-lg font-black text-brand-text sm:text-xl">
                                    {evaluationComplete
                                        ? 'Você completou todos os marcos publicados'
                                        : evaluationUnlocked
                                            ? 'Sua avaliação está pronta'
                                            : 'Continue se preparando com seu professor'}
                                </h3>
                                <div className="mt-3 flex flex-wrap gap-2 text-[10px] font-black uppercase tracking-wider text-brand-muted">
                                    {!evaluationComplete && <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-surface px-3 py-1.5"><Target size={12} /> 70% para avançar</span>}
                                    {!evaluationComplete && <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-surface px-3 py-1.5"><Clock3 size={12} /> cerca de 8 min</span>}
                                    <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-surface px-3 py-1.5"><ShieldCheck size={12} /> correção segura</span>
                                </div>
                            </div>
                        </div>

                        {evaluationUnlocked && (
                            <button
                                type="button"
                                onClick={openEvaluation}
                                className="inline-flex min-h-12 shrink-0 items-center justify-center gap-2 rounded-2xl bg-violet-600 px-6 py-3 text-xs font-black uppercase tracking-widest text-white shadow-lg shadow-violet-500/25 transition hover:bg-violet-700 focus:outline-none focus-visible:ring-4 focus-visible:ring-violet-300"
                            >
                                <Sparkles size={16} aria-hidden="true" /> Iniciar avaliação
                            </button>
                        )}
                    </div>
                </div>
            </div>

            {showEvaluation && (
                <div className="fixed inset-0 z-[220] flex items-end justify-center bg-slate-950/80 p-0 backdrop-blur-md sm:items-center sm:p-4" onMouseDown={(event) => {
                    if (event.target === event.currentTarget) closeEvaluation();
                }}>
                    <div
                        ref={dialogRef}
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="secure-evaluation-title"
                        aria-describedby="secure-evaluation-description"
                        className="flex max-h-[96dvh] w-full max-w-3xl flex-col overflow-hidden rounded-t-[2rem] bg-brand-surface shadow-2xl sm:max-h-[92dvh] sm:rounded-[2rem]"
                    >
                        <header className="shrink-0 border-b border-brand-border bg-brand-surface px-4 py-4 sm:px-6">
                            <div className="flex items-center justify-between gap-3">
                                <div className="min-w-0">
                                    <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.16em] text-violet-600">
                                        <ShieldCheck size={13} aria-hidden="true" /> Avaliação progressiva
                                    </div>
                                    <h2 id="secure-evaluation-title" className="mt-1 truncate text-lg font-black text-brand-text sm:text-xl">Marco {currentPartKey}</h2>
                                    <p id="secure-evaluation-description" className="sr-only">Responda todas as questões. Suas respostas são corrigidas com segurança no servidor.</p>
                                </div>
                                <button type="button" onClick={closeEvaluation} disabled={submitting} aria-label="Fechar avaliação e salvar rascunho" className="rounded-xl p-2 text-brand-muted hover:bg-brand-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 disabled:opacity-50">
                                    <X size={20} aria-hidden="true" />
                                </button>
                            </div>
                            {!loadingQuiz && !result && questions.length > 0 && (
                                <div className="mt-4">
                                    <div className="mb-2 flex items-center justify-between text-[10px] font-black uppercase tracking-wider text-brand-muted">
                                        <span>Questão {currentQuestionIndex + 1} de {questions.length}</span>
                                        <span>{answeredCount} respondida{answeredCount === 1 ? '' : 's'}</span>
                                    </div>
                                    <div className="h-2 overflow-hidden rounded-full bg-brand-surface-2" aria-label={`${Math.round((answeredCount / questions.length) * 100)}% respondido`} role="progressbar" aria-valuemin={0} aria-valuemax={questions.length} aria-valuenow={answeredCount}>
                                        <div className="h-full rounded-full bg-gradient-to-r from-violet-600 to-indigo-500 transition-[width] duration-300 motion-reduce:transition-none" style={{ width: `${(answeredCount / questions.length) * 100}%` }} />
                                    </div>
                                </div>
                            )}
                        </header>

                        <div className="flex-1 overflow-y-auto overscroll-contain p-4 sm:p-7">
                            {loadingQuiz ? (
                                <div className="flex min-h-72 flex-col items-center justify-center gap-4 text-center" role="status">
                                    <div className="rounded-3xl bg-violet-100 p-5 text-violet-600 dark:bg-violet-900/30"><Loader2 className="animate-spin" size={32} /></div>
                                    <div>
                                        <p className="font-black text-brand-text">Preparando suas questões</p>
                                        <p className="mt-1 text-sm text-brand-muted">O gabarito permanece protegido durante toda a avaliação.</p>
                                    </div>
                                </div>
                            ) : result ? (
                                <div className="mx-auto max-w-lg py-5 text-center" aria-live="polite">
                                    <div className={`mx-auto flex h-24 w-24 items-center justify-center rounded-full ${result.passed ? 'bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30' : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30'}`}>
                                        {result.passed ? <Award size={46} aria-hidden="true" /> : <RefreshCw size={40} aria-hidden="true" />}
                                    </div>
                                    <p className="mt-6 text-5xl font-black tracking-tight text-brand-text">{result.percentage}%</p>
                                    <h3 className="mt-2 text-xl font-black text-brand-text">{result.passed ? 'Marco conquistado!' : 'Você está perto'}</h3>
                                    <p className="mx-auto mt-3 max-w-md text-sm font-medium leading-relaxed text-brand-muted">
                                        {result.passed
                                            ? `Seu desempenho foi registrado. ${result.nextPart === 'COMPLETED' ? 'Você concluiu todos os marcos publicados.' : `Seu próximo marco será ${result.nextPart}.`}`
                                            : 'Revise o conteúdo indicado e tente novamente. Esta tentativa ficou registrada, mas não bloqueia uma nova chance.'}
                                    </p>
                                    <div className="mt-6 grid grid-cols-2 gap-3">
                                        <div className="rounded-2xl border border-brand-border bg-brand-surface-2 p-4">
                                            <p className="text-[10px] font-black uppercase tracking-widest text-brand-muted">Acertos</p>
                                            <p className="mt-1 text-xl font-black text-brand-text">{result.score}/{result.totalQuestions}</p>
                                        </div>
                                        <div className="rounded-2xl border border-brand-border bg-brand-surface-2 p-4">
                                            <p className="text-[10px] font-black uppercase tracking-widest text-brand-muted">Reconhecimento</p>
                                            <p className="mt-1 text-xl font-black text-brand-text">{result.xpEarned > 0 ? `+${result.xpEarned} XP` : 'Registrado'}</p>
                                        </div>
                                    </div>
                                    <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:justify-center">
                                        {!result.passed && (
                                            <button type="button" onClick={retryQuiz} className="inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl bg-violet-600 px-6 py-3 text-xs font-black uppercase tracking-widest text-white hover:bg-violet-700">
                                                <RefreshCw size={15} /> Tentar novamente
                                            </button>
                                        )}
                                        <button type="button" onClick={closeEvaluation} className="inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl border border-brand-border bg-brand-surface px-6 py-3 text-xs font-black uppercase tracking-widest text-brand-text hover:bg-brand-surface-2">
                                            <CheckCircle2 size={15} /> {result.passed ? 'Continuar jornada' : 'Revisar materiais'}
                                        </button>
                                    </div>
                                </div>
                            ) : questions.length > 0 && currentQuestion ? (
                                <fieldset className="mx-auto max-w-2xl">
                                    <legend className="text-lg font-black leading-relaxed text-brand-text sm:text-xl">{currentQuestion.question}</legend>
                                    <div className="mt-6 space-y-3" role="radiogroup">
                                        {currentQuestion.options.map((option, optionIndex) => {
                                            const selected = selectedOption === optionIndex;
                                            return (
                                                <button
                                                    key={`${currentQuestion.id}-${optionIndex}`}
                                                    type="button"
                                                    role="radio"
                                                    aria-checked={selected}
                                                    onClick={() => selectOption(optionIndex)}
                                                    className={`flex min-h-14 w-full items-center gap-3 rounded-2xl border-2 p-3.5 text-left text-sm font-bold transition focus:outline-none focus-visible:ring-4 focus-visible:ring-violet-200 motion-reduce:transition-none sm:p-4 ${selected ? 'border-violet-500 bg-violet-50 text-violet-800 dark:bg-violet-950/40 dark:text-violet-200' : 'border-brand-border bg-brand-surface text-brand-text hover:border-violet-300 hover:bg-brand-surface-2'}`}
                                                >
                                                    <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-xs font-black ${selected ? 'bg-violet-600 text-white' : 'bg-brand-surface-2 text-brand-muted'}`}>
                                                        {selected ? <Check size={15} aria-hidden="true" /> : String.fromCharCode(65 + optionIndex)}
                                                    </span>
                                                    <span>{option}</span>
                                                </button>
                                            );
                                        })}
                                    </div>
                                </fieldset>
                            ) : (
                                <div className="flex min-h-64 flex-col items-center justify-center gap-4 text-center" role="alert">
                                    <div className="rounded-3xl bg-amber-100 p-5 text-amber-700 dark:bg-amber-900/30"><LockKeyhole size={30} /></div>
                                    <p className="max-w-md text-sm font-bold text-brand-text">{errorMessage || 'Esta avaliação ainda não está disponível.'}</p>
                                    <button type="button" onClick={() => void loadQuiz()} className="inline-flex items-center gap-2 rounded-xl bg-violet-600 px-4 py-2.5 text-xs font-black uppercase tracking-widest text-white hover:bg-violet-700">
                                        <RefreshCw size={14} /> Tentar novamente
                                    </button>
                                </div>
                            )}

                            {errorMessage && questions.length > 0 && !result && (
                                <div role="alert" className="mx-auto mt-5 max-w-2xl rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm font-bold text-amber-900 dark:border-amber-800/40 dark:bg-amber-900/20 dark:text-amber-100">
                                    {errorMessage}
                                </div>
                            )}
                        </div>

                        {!loadingQuiz && !result && questions.length > 0 && (
                            <footer className="shrink-0 border-t border-brand-border bg-brand-surface px-4 py-4 sm:px-6">
                                <div className="mx-auto flex max-w-2xl items-center justify-between gap-3">
                                    <button type="button" onClick={() => setCurrentQuestionIndex(index => Math.max(0, index - 1))} disabled={currentQuestionIndex === 0 || submitting} className="inline-flex min-h-11 items-center gap-2 rounded-xl px-3 py-2 text-xs font-black uppercase tracking-wider text-brand-muted hover:bg-brand-surface-2 disabled:cursor-not-allowed disabled:opacity-30">
                                        <ArrowLeft size={15} /> Anterior
                                    </button>
                                    {currentQuestionIndex < questions.length - 1 ? (
                                        <button type="button" onClick={() => setCurrentQuestionIndex(index => Math.min(questions.length - 1, index + 1))} disabled={selectedOption === null || submitting} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-violet-600 px-5 py-2 text-xs font-black uppercase tracking-wider text-white hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-40">
                                            Próxima <ArrowRight size={15} />
                                        </button>
                                    ) : (
                                        <button type="button" onClick={() => void submitQuiz()} disabled={answers.some(answer => answer === null) || submitting} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-emerald-600 px-5 py-2 text-xs font-black uppercase tracking-wider text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40">
                                            {submitting ? <Loader2 size={15} className="animate-spin" /> : <ShieldCheck size={15} />}
                                            {submitting ? 'Corrigindo...' : 'Enviar com segurança'}
                                        </button>
                                    )}
                                </div>
                            </footer>
                        )}
                    </div>
                </div>
            )}
        </section>
    );
};

export default StudentMaterials;
