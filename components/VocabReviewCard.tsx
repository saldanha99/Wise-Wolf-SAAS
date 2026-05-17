import React, { useState, useEffect } from 'react';
import { Brain, Check, X, RefreshCw, Loader2, TrendingUp } from 'lucide-react';
import { supabase } from '../lib/supabase';

interface Props {
    userId: string;
}

interface ReviewItem {
    id: string;
    term: string;
    translation: string;
    example: string;
    interval_days: number;
    consecutive_correct: number;
    total_reviews: number;
    next_review_at: string;
}

// Spaced Repetition: intervalos progressivos quando o aluno acerta
// 1d → 3d → 7d → 14d → 30d → 60d → 120d
const NEXT_INTERVAL = (currentDays: number, correct: boolean): number => {
    if (!correct) return 1; // reseta
    if (currentDays >= 60) return 120;
    if (currentDays >= 30) return 60;
    if (currentDays >= 14) return 30;
    if (currentDays >= 7) return 14;
    if (currentDays >= 3) return 7;
    if (currentDays >= 1) return 3;
    return 1;
};

const VocabReviewCard: React.FC<Props> = ({ userId }) => {
    const [loading, setLoading] = useState(true);
    const [reviews, setReviews] = useState<ReviewItem[]>([]);
    const [idx, setIdx] = useState(0);
    const [flipped, setFlipped] = useState(false);
    const [sessionDone, setSessionDone] = useState(false);
    const [stats, setStats] = useState({ correct: 0, wrong: 0 });

    useEffect(() => {
        if (userId) load();
    }, [userId]);

    const load = async () => {
        setLoading(true);
        try {
            const { data } = await supabase
                .from('student_vocab_reviews')
                .select('*')
                .eq('student_id', userId)
                .lte('next_review_at', new Date().toISOString())
                .order('next_review_at', { ascending: true })
                .limit(15);
            setReviews(data || []);
        } catch (err) {
            console.error('VocabReview load:', err);
        } finally {
            setLoading(false);
        }
    };

    const review = async (correct: boolean) => {
        const item = reviews[idx];
        if (!item) return;

        const newInterval = NEXT_INTERVAL(item.interval_days, correct);
        const nextDate = new Date(Date.now() + newInterval * 24 * 60 * 60 * 1000);

        try {
            await supabase.from('student_vocab_reviews').update({
                interval_days: newInterval,
                consecutive_correct: correct ? item.consecutive_correct + 1 : 0,
                total_reviews: item.total_reviews + 1,
                last_reviewed_at: new Date().toISOString(),
                next_review_at: nextDate.toISOString(),
            }).eq('id', item.id);
        } catch (err) {
            console.error('Review update error:', err);
        }

        setStats(s => ({ ...s, [correct ? 'correct' : 'wrong']: s[correct ? 'correct' : 'wrong'] + 1 }));

        if (idx === reviews.length - 1) {
            setSessionDone(true);
        } else {
            setIdx(i => i + 1);
            setFlipped(false);
        }
    };

    if (loading) {
        return null; // silenciosamente nada
    }

    if (reviews.length === 0) {
        return null; // sem reviews due, nao exibe nada
    }

    if (sessionDone) {
        const total = stats.correct + stats.wrong;
        const accuracy = total > 0 ? Math.round((stats.correct / total) * 100) : 0;
        return (
            <div className="bg-gradient-to-br from-emerald-50 to-cyan-50 dark:from-emerald-900/20 dark:to-cyan-900/20 border border-emerald-100 dark:border-emerald-800/30 rounded-[2.5rem] p-8 text-center">
                <Check size={32} className="text-emerald-500 mx-auto mb-3" />
                <h3 className="text-lg font-black text-slate-800 dark:text-white">Sessão de revisão concluída!</h3>
                <p className="text-sm text-slate-500 mt-1">
                    {stats.correct} acertos · {stats.wrong} a praticar mais
                    {total > 0 && <span> · <b className="text-emerald-600">{accuracy}%</b> de aproveitamento</span>}
                </p>
                <button
                    onClick={() => { setSessionDone(false); load(); setIdx(0); setStats({ correct: 0, wrong: 0 }); }}
                    className="mt-4 text-xs font-bold text-violet-600 hover:text-violet-800 flex items-center gap-1 mx-auto"
                >
                    <RefreshCw size={12} /> Verificar mais
                </button>
            </div>
        );
    }

    const item = reviews[idx];

    return (
        <div className="bg-white dark:bg-slate-900 rounded-[2.5rem] border border-amber-200 dark:border-amber-800/30 overflow-hidden shadow-sm">
            <div className="p-6 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between bg-amber-50 dark:bg-amber-900/10">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-amber-100 dark:bg-amber-900/30 rounded-xl flex items-center justify-center">
                        <Brain size={20} className="text-amber-600 dark:text-amber-400" />
                    </div>
                    <div>
                        <h3 className="font-black text-slate-800 dark:text-white text-sm">Revisão de Vocabulário</h3>
                        <p className="text-[10px] text-slate-400 uppercase tracking-widest">
                            Card {idx + 1} de {reviews.length} · Repetição espaçada
                        </p>
                    </div>
                </div>
                {item.total_reviews > 0 && (
                    <div className="text-right">
                        <p className="text-[10px] uppercase tracking-widest text-slate-400 font-bold">Streak</p>
                        <p className="text-base font-black text-amber-600">🔥 {item.consecutive_correct}</p>
                    </div>
                )}
            </div>

            <div className="p-6">
                <div
                    onClick={() => setFlipped(f => !f)}
                    className="bg-gradient-to-br from-amber-50 to-orange-50 dark:from-amber-900/20 dark:to-orange-900/20 border border-amber-100 dark:border-amber-800/30 rounded-2xl p-8 min-h-[200px] flex items-center justify-center cursor-pointer hover:shadow-lg transition-all"
                >
                    {!flipped ? (
                        <div className="text-center">
                            <p className="text-[10px] uppercase tracking-widest text-amber-400 font-bold mb-2">Você lembra essa?</p>
                            <p className="text-3xl font-black text-slate-800 dark:text-white">{item.term}</p>
                            <p className="text-xs text-slate-400 mt-4">Clique para ver a resposta</p>
                        </div>
                    ) : (
                        <div className="text-center">
                            <p className="text-[10px] uppercase tracking-widest text-amber-400 font-bold mb-2">Tradução</p>
                            <p className="text-2xl font-black text-slate-800 dark:text-white">{item.translation}</p>
                            {item.example && (
                                <p className="text-sm text-slate-600 dark:text-slate-400 mt-4 italic">"{item.example}"</p>
                            )}
                        </div>
                    )}
                </div>

                {flipped && (
                    <div className="grid grid-cols-2 gap-3 mt-4">
                        <button
                            onClick={() => review(false)}
                            className="py-3 rounded-xl font-bold text-sm border-2 border-rose-200 text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-900/20 transition-colors flex items-center justify-center gap-2"
                        >
                            <X size={14} /> Errei
                        </button>
                        <button
                            onClick={() => review(true)}
                            className="py-3 rounded-xl font-bold text-sm bg-emerald-500 text-white hover:bg-emerald-600 transition-colors flex items-center justify-center gap-2"
                        >
                            <Check size={14} /> Acertei
                        </button>
                    </div>
                )}

                {!flipped && (
                    <p className="text-center text-xs text-slate-400 mt-4">
                        Próximo intervalo se acertar: {NEXT_INTERVAL(item.interval_days, true)}d
                    </p>
                )}
            </div>
        </div>
    );
};

export default VocabReviewCard;
