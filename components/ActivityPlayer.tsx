import React, { useState, useEffect, lazy, Suspense } from 'react';
import { createPortal } from 'react-dom';
import { X, Check, ChevronRight, ChevronLeft, Loader2, Trophy, BookOpen, RefreshCw, Mic } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { gamificationService } from '../services/gamificationService';
import confetti from 'canvas-confetti';

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
}

const ActivityPlayer: React.FC<ActivityPlayerProps> = ({ activity, userId, wolfieConfig, onComplete, onClose }) => {
    const [saving, setSaving] = useState(false);

    // Mapeia o tipo de atividade para a skill primaria (alem de unit.skill_focus se houver)
    const skillsForActivityType: Record<string, string[]> = {
        vocab_cards: ['vocabulary'],
        quiz: ['grammar', 'vocabulary'],
        grammar_drill: ['grammar'],
        reading: ['reading'],
        speaking_wolfie: ['speaking', 'pronunciation'],
        listening: ['listening'],
        writing: ['writing'],
    };

    const updateSkillScore = async (skill: string, newScore: number) => {
        // EMA (exponential moving average) alpha=0.4 para responder rapido a tendencias recentes
        const { data: existing } = await supabase
            .from('student_skill_scores')
            .select('current_score, total_activities')
            .eq('student_id', userId)
            .eq('skill', skill)
            .maybeSingle();

        const alpha = 0.4;
        const prevScore = Number(existing?.current_score) || 0;
        const ema = existing ? Math.round((alpha * newScore + (1 - alpha) * prevScore) * 10) / 10 : newScore;
        const total = (existing?.total_activities || 0) + 1;

        await supabase.from('student_skill_scores').upsert({
            student_id: userId,
            skill,
            current_score: ema,
            total_activities: total,
            last_updated: new Date().toISOString(),
        }, { onConflict: 'student_id, skill' });
    };

    const handleSubmit = async (score: number) => {
        if (saving) return;
        setSaving(true);
        try {
            // Upsert progress
            await supabase.from('student_activity_progress').upsert({
                student_id: userId,
                activity_id: activity.id,
                unit_id: activity.unit_id,
                status: 'COMPLETED',
                score,
                attempts: 1,
                completed_at: new Date().toISOString(),
                last_attempt_at: new Date().toISOString(),
            }, { onConflict: 'student_id, activity_id' });

            // Atualizar skill scores (skills da unit + skill primaria do tipo)
            try {
                const { data: unitData } = await supabase
                    .from('learning_units')
                    .select('skill_focus')
                    .eq('id', activity.unit_id)
                    .maybeSingle();

                const skillsToUpdate = new Set<string>([
                    ...(unitData?.skill_focus || []),
                    ...(skillsForActivityType[activity.type] || []),
                ]);
                for (const skill of skillsToUpdate) {
                    await updateSkillScore(skill, score);
                }
            } catch (skillErr) {
                console.error('Skill score update failed (non-blocking):', skillErr);
            }

            // Award XP proporcional ao score
            const xpEarned = Math.round((activity.xp_reward || 30) * (score / 100));
            if (xpEarned > 0) {
                const result = await gamificationService.addXP(userId, xpEarned);
                if (result?.leveledUp) {
                    confetti({ particleCount: 100, spread: 60, origin: { y: 0.6 } });
                }
            }
            if (score >= 80) {
                confetti({ particleCount: 60, spread: 70, origin: { y: 0.6 }, colors: ['#10b981', '#3b82f6'] });
            }

            onComplete(score);
        } catch (err) {
            console.error('handleSubmit error:', err);
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-sm z-[200] flex items-end sm:items-center justify-center p-0 sm:p-4">
            <div className="bg-white dark:bg-slate-900 rounded-t-3xl sm:rounded-3xl max-w-3xl w-full max-h-[95vh] sm:max-h-[90vh] overflow-hidden shadow-2xl flex flex-col safe-bottom">
                {/* Header */}
                <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between shrink-0">
                    <div>
                        <p className="text-[10px] uppercase tracking-widest text-slate-400 font-bold">{activity.type.replace(/_/g, ' ')}</p>
                        <h2 className="text-lg font-black text-slate-800 dark:text-white">{activity.title}</h2>
                    </div>
                    <button onClick={onClose} className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl">
                        <X size={20} />
                    </button>
                </div>

                {/* Body */}
                <div className="flex-1 overflow-y-auto p-6">
                    {activity.type === 'vocab_cards' && <VocabCardsRunner content={activity.content} activityId={activity.id} userId={userId} onFinish={handleSubmit} saving={saving} />}
                    {activity.type === 'quiz' && <QuizRunner content={activity.content} onFinish={handleSubmit} saving={saving} />}
                    {activity.type === 'grammar_drill' && <QuizRunner content={{ questions: activity.content.exercises?.map((e: any) => ({ q: e.sentence, options: e.options, correct: e.correct, exp: e.exp })) }} rulePt={activity.content.rule_pt} onFinish={handleSubmit} saving={saving} />}
                    {activity.type === 'reading' && <ReadingRunner content={activity.content} onFinish={handleSubmit} saving={saving} />}
                    {activity.type === 'speaking_wolfie' && (
                        <Suspense fallback={<div className="flex items-center justify-center py-12"><Loader2 className="animate-spin text-violet-500" /></div>}>
                            <SpeakingWolfieRunner activity={activity} userId={userId} wolfieConfig={wolfieConfig} onFinish={handleSubmit} />
                        </Suspense>
                    )}
                    {!['vocab_cards', 'quiz', 'grammar_drill', 'reading', 'speaking_wolfie'].includes(activity.type) && (
                        <div className="text-center py-12 text-slate-400">
                            <p className="text-sm">Tipo de atividade ainda não suportado: <code>{activity.type}</code></p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

// ─────────────────────────────────────────────────────────────
// VOCAB CARDS
// ─────────────────────────────────────────────────────────────
const VocabCardsRunner: React.FC<{ content: any; activityId: string; userId: string; onFinish: (score: number) => void; saving: boolean }> = ({ content, activityId, userId, onFinish, saving }) => {
    const cards = content.cards || [];
    const [idx, setIdx] = useState(0);
    const [flipped, setFlipped] = useState(false);
    const [knownCount, setKnownCount] = useState(0);

    if (cards.length === 0) return <p className="text-slate-400">Sem cards configurados.</p>;

    const card = cards[idx];
    const isLast = idx === cards.length - 1;

    // SRS: agenda revisao para cards "nao sei ainda" (1 dia depois)
    const scheduleReview = async (card: any) => {
        try {
            await supabase.from('student_vocab_reviews').upsert({
                student_id: userId,
                term: card.term,
                translation: card.translation,
                example: card.example,
                source_activity_id: activityId,
                interval_days: 1,
                consecutive_correct: 0,
                next_review_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            }, { onConflict: 'student_id, term', ignoreDuplicates: false });
        } catch (err) {
            console.error('scheduleReview error:', err);
        }
    };

    const markKnown = (known: boolean) => {
        if (known) setKnownCount(k => k + 1);
        else scheduleReview(card); // marca para revisar amanha
        if (isLast) {
            const finalScore = Math.round(((knownCount + (known ? 1 : 0)) / cards.length) * 100);
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
                className="relative bg-gradient-to-br from-violet-50 to-indigo-50 dark:from-violet-900/20 dark:to-indigo-900/20 border border-violet-100 dark:border-violet-800/30 rounded-2xl p-8 min-h-[260px] flex items-center justify-center cursor-pointer hover:shadow-lg transition-all"
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

            <div className="grid grid-cols-2 gap-3 mt-6">
                <button
                    onClick={() => markKnown(false)}
                    disabled={saving}
                    className="py-3 rounded-xl font-bold text-sm border-2 border-rose-200 text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-900/20 transition-colors disabled:opacity-50"
                >
                    Não sei ainda
                </button>
                <button
                    onClick={() => markKnown(true)}
                    disabled={saving}
                    className="py-3 rounded-xl font-bold text-sm bg-emerald-500 text-white hover:bg-emerald-600 transition-colors disabled:opacity-50"
                >
                    Sei essa! <Check size={14} className="inline ml-1" />
                </button>
            </div>
        </div>
    );
};

// ─────────────────────────────────────────────────────────────
// QUIZ / GRAMMAR DRILL
// ─────────────────────────────────────────────────────────────
const QuizRunner: React.FC<{ content: any; rulePt?: string; onFinish: (score: number) => void; saving: boolean }> = ({ content, rulePt, onFinish, saving }) => {
    const questions = content.questions || [];
    const [idx, setIdx] = useState(0);
    const [selected, setSelected] = useState<number | null>(null);
    const [correctCount, setCorrectCount] = useState(0);
    const [showExp, setShowExp] = useState(false);

    if (questions.length === 0) return <p className="text-slate-400">Sem questões configuradas.</p>;

    const q = questions[idx];
    const isLast = idx === questions.length - 1;
    const isCorrect = selected === q.correct;

    const submit = () => {
        if (selected === null) return;
        setShowExp(true);
        if (isCorrect) setCorrectCount(c => c + 1);
    };

    const next = () => {
        if (isLast) {
            const finalCorrect = correctCount + (isCorrect ? (showExp ? 0 : 1) : 0);
            const score = Math.round((finalCorrect / questions.length) * 100);
            onFinish(score);
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
                    const isCorrectOpt = i === q.correct;
                    const showResult = showExp;
                    return (
                        <button
                            key={i}
                            onClick={() => !showExp && setSelected(i)}
                            disabled={showExp}
                            className={`w-full text-left p-3 rounded-xl border-2 transition-all text-sm font-medium ${
                                showResult
                                    ? isCorrectOpt
                                        ? 'border-emerald-400 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300'
                                        : isSel
                                            ? 'border-rose-400 bg-rose-50 dark:bg-rose-900/20 text-rose-700 dark:text-rose-300'
                                            : 'border-slate-200 dark:border-slate-700 text-slate-500'
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

            {showExp && q.exp && (
                <div className={`mt-4 p-4 rounded-xl ${isCorrect ? 'bg-emerald-50 dark:bg-emerald-900/20' : 'bg-rose-50 dark:bg-rose-900/20'}`}>
                    <p className={`text-xs font-bold uppercase tracking-widest mb-1 ${isCorrect ? 'text-emerald-600' : 'text-rose-600'}`}>
                        {isCorrect ? '✓ Correto' : '✗ Não foi dessa vez'}
                    </p>
                    <p className="text-sm text-slate-700 dark:text-slate-300">{q.exp}</p>
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
const ReadingRunner: React.FC<{ content: any; onFinish: (score: number) => void; saving: boolean }> = ({ content, onFinish, saving }) => {
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
                <QuizRunner content={{ questions: content.questions }} onFinish={onFinish} saving={saving} />
            )}
        </div>
    );
};

// ─────────────────────────────────────────────────────────────
// SPEAKING WOLFIE
// ─────────────────────────────────────────────────────────────
const SpeakingWolfieRunner: React.FC<{ activity: any; userId: string; wolfieConfig: any; onFinish: (score: number) => void }> = ({ activity, userId, wolfieConfig, onFinish }) => {
    const [launched, setLaunched] = useState(false);

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
                    onClose={() => {
                        setLaunched(false);
                        onFinish(100);
                    }}
                />
            </Suspense>,
            document.body
        );
    }

    return (
        <div>
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
                onClick={() => setLaunched(true)}
                className="w-full py-3 rounded-xl font-bold text-sm bg-violet-600 text-white hover:bg-violet-700 transition-colors flex items-center justify-center gap-2"
            >
                <Mic size={14} /> Começar com Wolfie
            </button>
        </div>
    );
};

export default ActivityPlayer;
