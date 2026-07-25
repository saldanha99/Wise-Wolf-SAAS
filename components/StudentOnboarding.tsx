import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { supabase } from '../lib/supabase';
import { Map, Flame, Trophy, MessageCircle, ArrowRight, Check } from 'lucide-react';

/**
 * Tour de boas-vindas do aluno (1º acesso à plataforma).
 * Carrossel de slides explicando trilhas, gamificação e tutor.
 * Ao concluir, marca profiles.onboarded = true.
 */
interface Props { userId: string; nome?: string; onComplete: () => void; }

const onboardingSessionKey = (userId: string, field: 'completed' | 'step') => (
    `wise-wolf:student-onboarding:${userId}:${field}`
);

const readSessionValue = (key: string): string | null => {
    if (typeof window === 'undefined') return null;
    try {
        return window.sessionStorage.getItem(key);
    } catch {
        return null;
    }
};

const writeSessionValue = (key: string, value: string): void => {
    if (typeof window === 'undefined') return;
    try {
        window.sessionStorage.setItem(key, value);
    } catch {
        // A indisponibilidade do storage não deve bloquear o tour.
    }
};

export const hasCompletedStudentOnboardingThisSession = (userId: string): boolean => (
    readSessionValue(onboardingSessionKey(userId, 'completed')) === 'true'
);

const readStudentOnboardingStep = (userId: string, lastStep: number): number => {
    const storedStep = Number.parseInt(
        readSessionValue(onboardingSessionKey(userId, 'step')) || '',
        10,
    );
    return Number.isInteger(storedStep)
        ? Math.min(Math.max(storedStep, 0), lastStep)
        : 0;
};

const StudentOnboarding: React.FC<Props> = ({ userId, nome, onComplete }) => {
    const lastStep = 4;
    const [step, setStep] = useState(() => readStudentOnboardingStep(userId, lastStep));
    const [saving, setSaving] = useState(false);
    const dialogRef = useRef<HTMLDivElement>(null);
    const titleRef = useRef<HTMLHeadingElement>(null);

    const slides = [
        {
            icon: <Map size={40} />, cor: '#8b5cf6',
            titulo: `Bem-vindo${nome ? `, ${nome.split(' ')[0]}` : ''}! 🐺`,
            texto: 'Aqui você aprende inglês numa trilha divertida, no seu ritmo. Vamos te mostrar como funciona em 30 segundos.',
        },
        {
            icon: <Map size={40} />, cor: '#6366f1',
            titulo: 'Siga a trilha',
            texto: 'Cada lição é um passo na sua jornada. Complete uma para desbloquear a próxima — como num jogo.',
        },
        {
            icon: <Flame size={40} />, cor: '#f97316',
            titulo: 'Mantenha a ofensiva 🔥',
            texto: 'Pratique todos os dias para acender sua chama. Ganhe XP, suba de nível e cuide das suas 5 vidas ❤️.',
        },
        {
            icon: <Trophy size={40} />, cor: '#f59e0b',
            titulo: 'Dispute a liga',
            texto: 'Ganhe XP e suba de divisão: Bronze → Prata → Ouro → Platina → Diamante. Compare com seus colegas!',
        },
        {
            icon: <MessageCircle size={40} />, cor: '#10b981',
            titulo: 'Converse com o Wolfie',
            texto: 'Seu tutor de IA está pronto pra praticar conversação com você a qualquer hora. Bora começar?',
        },
    ];

    const isLast = step === slides.length - 1;

    useEffect(() => {
        writeSessionValue(onboardingSessionKey(userId, 'step'), String(step));
    }, [step, userId]);

    useLayoutEffect(() => {
        const previousOverflow = document.body.style.overflow;
        const previousFocus = document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        document.body.style.overflow = 'hidden';

        const focusFrame = window.requestAnimationFrame(() => {
            titleRef.current?.focus({ preventScroll: true });
        });
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Tab' || !dialogRef.current) return;
            const focusable = (Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
                'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
            )) as HTMLElement[]).filter(element => element.getClientRects().length > 0);
            if (focusable.length === 0) {
                event.preventDefault();
                titleRef.current?.focus({ preventScroll: true });
                return;
            }

            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            const focusOutside = !dialogRef.current.contains(document.activeElement);
            if (event.shiftKey && (document.activeElement === first || focusOutside)) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && (document.activeElement === last || focusOutside)) {
                event.preventDefault();
                first.focus();
            }
        };
        document.addEventListener('keydown', handleKeyDown);

        return () => {
            window.cancelAnimationFrame(focusFrame);
            document.removeEventListener('keydown', handleKeyDown);
            document.body.style.overflow = previousOverflow;
            if (previousFocus?.isConnected) {
                previousFocus.focus({ preventScroll: true });
            }
        };
    }, []);

    const finish = async () => {
        if (saving) return;
        setSaving(true);
        try {
            const { error } = await supabase
                .from('profiles')
                .update({ onboarded: true })
                .eq('id', userId);
            if (error) {
                console.error('Não foi possível persistir a conclusão do tour.', {
                    code: error.code || 'ONBOARDING_UPDATE_FAILED',
                });
            }
        } catch {
            console.error('Não foi possível persistir a conclusão do tour.', {
                code: 'ONBOARDING_UPDATE_FAILED',
            });
        } finally {
            writeSessionValue(onboardingSessionKey(userId, 'completed'), 'true');
            setSaving(false);
            onComplete();
        }
    };

    const s = slides[step];

    return createPortal(
        <div className="fixed inset-0 z-[400] overflow-y-auto bg-slate-900/80 p-3 backdrop-blur-sm sm:p-4">
            <div className="flex min-h-full items-center justify-center">
                <motion.div
                    ref={dialogRef}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="student-onboarding-title"
                    aria-describedby="student-onboarding-description"
                    initial={{ scale: 0.9, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    className="max-h-[calc(100dvh-1.5rem)] w-full max-w-md overflow-y-auto rounded-3xl bg-white p-5 text-center shadow-2xl dark:bg-slate-900 sm:max-h-[calc(100dvh-2rem)] sm:p-8"
                >
                    <AnimatePresence mode="wait">
                        <motion.div
                            key={step}
                            initial={{ x: 40, opacity: 0 }}
                            animate={{ x: 0, opacity: 1 }}
                            exit={{ x: -40, opacity: 0 }}
                            transition={{ duration: 0.25 }}
                        >
                            <div
                                className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-3xl text-white sm:mb-5 sm:h-20 sm:w-20"
                                style={{ background: s.cor, boxShadow: `0 8px 0 ${s.cor}99` }}
                            >
                                {s.icon}
                            </div>
                            <h2
                                id="student-onboarding-title"
                                ref={titleRef}
                                tabIndex={-1}
                                className="mb-2 text-xl font-black text-slate-800 outline-none dark:text-white sm:mb-3 sm:text-2xl"
                            >
                                {s.titulo}
                            </h2>
                            <p
                                id="student-onboarding-description"
                                className="text-sm leading-relaxed text-slate-500 dark:text-slate-400 sm:text-base"
                            >
                                {s.texto}
                            </p>
                        </motion.div>
                    </AnimatePresence>

                    {/* Dots */}
                    <div className="mt-5 flex justify-center gap-2 sm:mt-7" aria-label="Etapas do tour">
                        {slides.map((slide, i) => (
                            <button
                                key={slide.titulo}
                                type="button"
                                onClick={() => setStep(i)}
                                aria-label={`Ir para a etapa ${i + 1} de ${slides.length}`}
                                aria-current={i === step ? 'step' : undefined}
                                className="h-2 rounded-full transition-all"
                                style={{ width: i === step ? 24 : 8, background: i === step ? s.cor : '#cbd5e1' }}
                            />
                        ))}
                    </div>

                    {/* CTA */}
                    <button
                        type="button"
                        onClick={() => isLast ? void finish() : setStep(step + 1)}
                        disabled={saving}
                        className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl py-3.5 text-sm font-black uppercase tracking-wider text-white transition-colors disabled:opacity-60 sm:mt-7"
                        style={{ background: s.cor, boxShadow: `0 5px 0 ${s.cor}99` }}
                    >
                        {isLast ? <>Começar agora <Check size={16} /></> : <>Próximo <ArrowRight size={16} /></>}
                    </button>

                    {!isLast && (
                        <button
                            type="button"
                            onClick={() => void finish()}
                            disabled={saving}
                            className="mt-3 text-xs font-bold text-slate-400 hover:text-slate-600 disabled:opacity-60"
                        >
                            Pular tour
                        </button>
                    )}
                </motion.div>
            </div>
        </div>,
        document.body,
    );
};

export default StudentOnboarding;
