import React, { useState, useEffect, useRef } from 'react';
import { AlertCircle, Brain, Check, X, RefreshCw, Loader2 } from 'lucide-react';
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

const VocabReviewCard: React.FC<Props> = ({ userId }) => {
    const [loading, setLoading] = useState(true);
    const [reviews, setReviews] = useState<ReviewItem[]>([]);
    const [idx, setIdx] = useState(0);
    const [flipped, setFlipped] = useState(false);
    const [sessionDone, setSessionDone] = useState(false);
    const [stats, setStats] = useState({ correct: 0, wrong: 0 });
    const [reviewing, setReviewing] = useState(false);
    const [actionError, setActionError] = useState('');
    const [loadError, setLoadError] = useState('');
    const requestKeys = useRef(new Map<string, string>());

    useEffect(() => {
        if (userId) load();
    }, [userId]);

    const load = async () => {
        setLoading(true);
        setLoadError('');
        try {
            const { data, error } = await supabase
                .from('student_vocab_reviews')
                .select('*')
                .eq('student_id', userId)
                .lte('next_review_at', new Date().toISOString())
                .order('next_review_at', { ascending: true })
                .limit(15);
            if (error) throw error;
            setReviews(data || []);
        } catch (err) {
            console.error('VocabReview load:', err);
            setLoadError('Não foi possível carregar sua revisão espaçada agora.');
        } finally {
            setLoading(false);
        }
    };

    const review = async (correct: boolean) => {
        const item = reviews[idx];
        if (!item || reviewing) return;
        setReviewing(true);
        setActionError('');
        let stableRequestKey = requestKeys.current.get(item.id);
        if (!stableRequestKey) {
            stableRequestKey = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
                ? crypto.randomUUID()
                : `vocab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            requestKeys.current.set(item.id, stableRequestKey);
        }

        try {
            const { error } = await supabase.rpc('submit_student_vocab_review', {
                p_review_id: item.id,
                p_correct: correct,
                p_request_key: stableRequestKey,
            });
            if (error) throw error;
        } catch (err) {
            console.error('Review update error:', err);
            setActionError('Não foi possível salvar esta revisão. Sua resposta continua aqui; tente novamente.');
            setReviewing(false);
            return;
        }
        requestKeys.current.delete(item.id);
        setReviewing(false);

        setStats(s => ({ ...s, [correct ? 'correct' : 'wrong']: s[correct ? 'correct' : 'wrong'] + 1 }));

        if (idx === reviews.length - 1) {
            setSessionDone(true);
        } else {
            setIdx(i => i + 1);
            setFlipped(false);
        }
    };

    if (loading) {
        return (
            <div role="status" aria-live="polite" className="overflow-hidden rounded-[2rem] border border-amber-200 bg-brand-surface shadow-sm dark:border-amber-800/30">
                <div className="flex items-center gap-3 border-b border-brand-border bg-amber-50 p-5 dark:bg-amber-900/10">
                    <span className="grid h-10 w-10 place-items-center rounded-xl bg-amber-100 text-amber-600 dark:bg-amber-900/30 dark:text-amber-300"><Loader2 className="animate-spin" size={19} /></span>
                    <div>
                        <p className="text-sm font-black text-brand-text">Preparando sua revisão</p>
                        <p className="mt-0.5 text-[10px] font-bold uppercase tracking-widest text-brand-muted">Buscando palavras no momento certo</p>
                    </div>
                </div>
                <span className="sr-only">Carregando revisão de vocabulário</span>
            </div>
        );
    }

    if (loadError) {
        return (
            <div role="alert" className="flex flex-col gap-3 rounded-[2rem] border border-amber-200 bg-amber-50 p-5 text-amber-950 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-100 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-3">
                    <AlertCircle size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
                    <div>
                        <p className="text-sm font-black">Sua revisão está segura.</p>
                        <p className="mt-1 text-xs font-medium">{loadError}</p>
                    </div>
                </div>
                <button type="button" onClick={() => void load()} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl bg-amber-600 px-4 py-2 text-[10px] font-black uppercase tracking-widest text-white hover:bg-amber-700">
                    <RefreshCw size={13} /> Tentar novamente
                </button>
            </div>
        );
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
                <button
                    type="button"
                    onClick={() => setFlipped(f => !f)}
                    aria-pressed={flipped}
                    className="flex min-h-[200px] w-full items-center justify-center rounded-2xl border border-amber-100 bg-gradient-to-br from-amber-50 to-orange-50 p-8 text-center transition-all hover:shadow-lg focus:outline-none focus-visible:ring-4 focus-visible:ring-amber-200 motion-reduce:transition-none dark:border-amber-800/30 dark:from-amber-900/20 dark:to-orange-900/20"
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
                </button>

                {flipped && (
                    <div className="mt-4">
                        {actionError && <p role="alert" className="mb-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs font-bold text-rose-700">{actionError}</p>}
                        <div className="grid grid-cols-2 gap-3">
                        <button
                            onClick={() => void review(false)}
                            disabled={reviewing}
                            className="py-3 rounded-xl font-bold text-sm border-2 border-rose-200 text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-900/20 transition-colors flex items-center justify-center gap-2"
                        >
                            {reviewing ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />} Errei
                        </button>
                        <button
                            onClick={() => void review(true)}
                            disabled={reviewing}
                            className="py-3 rounded-xl font-bold text-sm bg-emerald-500 text-white hover:bg-emerald-600 transition-colors flex items-center justify-center gap-2"
                        >
                            {reviewing ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Acertei
                        </button>
                        </div>
                    </div>
                )}

                {!flipped && (
                    <p className="text-center text-xs text-slate-400 mt-4">
                        O próximo intervalo será calculado com segurança após sua resposta.
                    </p>
                )}
            </div>
        </div>
    );
};

export default VocabReviewCard;
