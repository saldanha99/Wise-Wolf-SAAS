import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase'; // Adjust path if needed
import {
    Search, Brain, MessageSquare,
    CheckCircle, AlertTriangle, Star,
    User, Calendar, RefreshCw
} from 'lucide-react';

interface WolfieSession {
    id: string;
    created_at: string;
    topic: string;
    student_level: string;
    mode: string;
    overall_score: number | null;
    summary: string | null;
    student: {
        full_name: string;
        avatar_url: string | null;
    };
    wolfie_evaluations: {
        overall_score: number;
        adequacy_to_level: number;
        clarity_of_corrections: number;
        encouragement_and_tone: number;
        textual_feedback_pt: string;
    }[];
}

interface WolfieTurn {
    id: string;
    speaker: 'student' | 'wolfie';
    content: string;
    turn_index: number;
}

interface WolfieCorrection {
    id: string;
    wrong_sentence: string;
    correct_sentence: string;
    explanation_pt: string;
    turn_id: string | null;
}

const WolfieLab: React.FC<{ tenantId?: string }> = ({ tenantId }) => {
    const [sessions, setSessions] = useState<WolfieSession[]>([]);
    const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [detailError, setDetailError] = useState<string | null>(null);
    const [searchTerm, setSearchTerm] = useState('');

    // Detail View State
    const [turns, setTurns] = useState<WolfieTurn[]>([]);
    const [corrections, setCorrections] = useState<WolfieCorrection[]>([]);
    const [detailLoading, setDetailLoading] = useState(false);
    const [insights, setInsights] = useState<any>(null);
    const [showInsights, setShowInsights] = useState(true);

    useEffect(() => {
        fetchSessions();
        (async () => {
            const { data } = await supabase.rpc('wolfie_insights');
            if (data && !data.error) setInsights(data);
        })();
    }, [tenantId]);

    useEffect(() => {
        if (selectedSessionId) {
            fetchSessionDetails(selectedSessionId);
        }
    }, [selectedSessionId]);

    const fetchSessions = async () => {
        setLoading(true);
        setLoadError(null);
        try {
            let query = supabase
                .from('wolfie_sessions')
                .select(`
                    id, created_at, topic, student_level, mode, overall_score, summary,
                    student:profiles!wolfie_sessions_student_id_fkey(full_name, avatar_url),
                    wolfie_evaluations(overall_score, adequacy_to_level, clarity_of_corrections, encouragement_and_tone, textual_feedback_pt)
                `)
                .order('created_at', { ascending: false })
                .limit(50);

            if (tenantId) {
                query = query.eq('tenant_id', tenantId);
            }

            const { data, error } = await query;
            if (error) throw error;
            setSessions(data as any || []);
        } catch (error) {
            console.error("Error fetching sessions:", error);
            setSessions([]);
            setLoadError('Não foi possível carregar as sessões do Wolfie.');
        } finally {
            setLoading(false);
        }
    };

    const fetchSessionDetails = async (sessionId: string) => {
        setDetailLoading(true);
        setDetailError(null);
        try {
            const [turnResult, correctionResult] = await Promise.all([
                supabase
                    .from('wolfie_turns')
                    .select('id, speaker, content, turn_index')
                    .eq('session_id', sessionId)
                    .order('turn_index', { ascending: true }),
                supabase
                    .from('wolfie_corrections')
                    .select('id, wrong_sentence, correct_sentence, explanation_pt, turn_id')
                    .eq('session_id', sessionId),
            ]);

            if (turnResult.error) throw turnResult.error;
            if (correctionResult.error) throw correctionResult.error;

            setTurns((turnResult.data || []) as WolfieTurn[]);
            setCorrections((correctionResult.data || []) as WolfieCorrection[]);
        } catch (e) {
            console.error(e);
            setTurns([]);
            setCorrections([]);
            setDetailError('Não foi possível carregar a conversa e as correções.');
        } finally {
            setDetailLoading(false);
        }
    };

    const renderStars = (score: number) => {
        return (
            <div className="flex gap-0.5">
                {[1, 2, 3, 4, 5].map(i => (
                    <Star
                        key={i}
                        size={12}
                        className={i <= Math.round(score) ? "fill-yellow-400 text-yellow-400" : "text-gray-300"}
                    />
                ))}
            </div>
        );
    };

    const normalizedSearch = searchTerm.trim().toLocaleLowerCase('pt-BR');
    const filteredSessions = normalizedSearch
        ? sessions.filter((session) => (
            session.student?.full_name?.toLocaleLowerCase('pt-BR').includes(normalizedSearch)
            || session.topic.toLocaleLowerCase('pt-BR').includes(normalizedSearch)
        ))
        : sessions;
    const t = insights?.totals || {};
    return (
      <div className="space-y-4 font-sans">
        {/* INSIGHTS PEDAGÓGICOS */}
        {insights && (
          <div className="bg-gradient-to-br from-purple-50 to-indigo-50 dark:from-purple-900/10 dark:to-indigo-900/10 border border-purple-200 dark:border-purple-900/30 rounded-2xl p-4">
            <button onClick={() => setShowInsights(s => !s)} className="w-full flex items-center justify-between">
              <h3 className="text-sm font-bold text-brand-text flex items-center gap-2"><Brain size={16} className="text-purple-600" /> Inteligência do Tutor</h3>
              <span className="text-xs text-brand-muted">{showInsights ? 'ocultar ▲' : 'mostrar ▼'}</span>
            </button>
            {showInsights && (
              <div className="mt-3 space-y-4">
                <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                  <MiniKpi label="Sessões" value={`${t.sessions ?? 0}`} sub={`${t.sessions_7d ?? 0} nos 7 dias`} />
                  <MiniKpi label="Alunos usando" value={`${t.students ?? 0}`} />
                  <MiniKpi label="Nota média" value={t.avg_score != null ? `${t.avg_score}/5` : '—'} />
                  <MiniKpi label="Minutos praticados" value={`${t.minutes ?? 0}`} />
                  <MiniKpi label="Nunca usaram" value={`${insights.never_used ?? 0}`} accent={insights.never_used > 0 ? 'text-amber-600' : undefined} />
                </div>
                <div className="grid md:grid-cols-2 gap-4">
                  {/* Pontos fracos recorrentes */}
                  <div className="bg-brand-surface border border-brand-border rounded-xl p-3">
                    <p className="text-xs font-bold text-brand-text mb-2">Pontos fracos recorrentes</p>
                    {(insights.weak_points || []).length === 0 ? <p className="text-xs text-brand-muted">Sem dados ainda.</p> : (
                      <div className="flex flex-wrap gap-1.5">
                        {(insights.weak_points || []).map((w: any, i: number) => (
                          <span key={i} className="text-[11px] font-bold bg-red-50 dark:bg-red-900/20 text-red-600 px-2 py-1 rounded-lg">{w.error_type} · {w.count}</span>
                        ))}
                      </div>
                    )}
                  </div>
                  {/* Top alunos por uso */}
                  <div className="bg-brand-surface border border-brand-border rounded-xl p-3">
                    <p className="text-xs font-bold text-brand-text mb-2">Mais engajados</p>
                    <div className="space-y-1 max-h-32 overflow-y-auto">
                      {(insights.by_student || []).slice(0, 6).map((s: any, i: number) => (
                        <div key={i} className="flex items-center justify-between text-[11px]">
                          <span className="text-brand-text truncate">{s.name || 'Aluno'}</span>
                          <span className="text-brand-muted shrink-0">{s.sessions} sess. · {s.avg_score ?? '—'}★ · {s.minutes}min</span>
                        </div>
                      ))}
                      {(insights.by_student || []).length === 0 && <p className="text-xs text-brand-muted">Sem dados ainda.</p>}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        <div className="flex min-h-[32rem] flex-col gap-4 xl:h-[calc(100dvh-8rem)] xl:flex-row xl:gap-6">
            {/* LEFT PANEL: LIST */}
            <div className="flex max-h-[32rem] w-full flex-col overflow-hidden rounded-2xl border border-gray-100 bg-brand-surface shadow-sm dark:border-brand-border xl:max-h-none xl:w-1/3">
                <div className="p-4 border-b border-gray-100 dark:border-brand-border">
                    <h2 className="text-lg font-bold text-brand-text flex items-center gap-2">
                        <Brain className="text-purple-600" /> Wolfie Lab
                    </h2>
                    <div className="mt-3 relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 w-4 h-4" />
                        <input
                            type="text"
                            value={searchTerm}
                            onChange={(event) => setSearchTerm(event.target.value)}
                            aria-label="Buscar por aluno ou tópico"
                            placeholder="Buscar aluno ou tópico..."
                            className="w-full pl-9 pr-4 py-2 bg-gray-50 dark:bg-brand-surface-2 rounded-lg text-sm border-none focus:ring-2 focus:ring-purple-500/50"
                        />
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto p-2 space-y-2">
                    {loading ? (
                        <p className="text-center text-gray-400 py-10" role="status">Carregando sessões...</p>
                    ) : loadError ? (
                        <div className="m-2 rounded-xl border border-red-200 bg-red-50 p-4 text-center dark:border-red-900/40 dark:bg-red-950/20" role="alert">
                            <AlertTriangle className="mx-auto mb-2 text-red-500" size={20} />
                            <p className="text-xs font-bold text-red-700 dark:text-red-200">{loadError}</p>
                            <button
                                type="button"
                                onClick={fetchSessions}
                                className="mt-3 inline-flex items-center gap-2 rounded-lg bg-red-600 px-3 py-2 text-xs font-bold text-white hover:bg-red-700"
                            >
                                <RefreshCw size={13} /> Tentar novamente
                            </button>
                        </div>
                    ) : filteredSessions.length === 0 ? (
                        <p className="px-4 py-10 text-center text-sm text-gray-400">
                            {searchTerm ? 'Nenhuma sessão corresponde à busca.' : 'Nenhuma sessão registrada ainda.'}
                        </p>
                    ) : filteredSessions.map(session => (
                        <button
                            type="button"
                            key={session.id}
                            onClick={() => setSelectedSessionId(session.id)}
                            aria-pressed={selectedSessionId === session.id}
                            className={`w-full p-3 text-left rounded-xl cursor-pointer transition-all border ${selectedSessionId === session.id ? 'bg-purple-50 border-purple-200 dark:bg-purple-900/20 dark:border-purple-800' : 'bg-transparent border-transparent hover:bg-gray-50 dark:hover:bg-brand-surface-2'}`}
                        >
                            <div className="flex justify-between items-start mb-1">
                                <div className="flex items-center gap-2">
                                    <div className="w-6 h-6 rounded-full bg-gradient-to-tr from-blue-400 to-purple-400 flex items-center justify-center text-[10px] text-white font-bold">
                                        {session.student?.full_name?.charAt(0) || 'A'}
                                    </div>
                                    <span className="text-sm font-semibold text-brand-text dark:text-gray-200">
                                        {session.student?.full_name || 'Aluno'}
                                    </span>
                                </div>
                                <span className="text-[10px] text-gray-400">
                                    {new Date(session.created_at).toLocaleDateString()}
                                </span>
                            </div>

                            <div className="flex items-center gap-2 mb-1">
                                <span className="text-xs font-medium text-purple-600 bg-purple-100 dark:bg-purple-900/30 px-1.5 py-0.5 rounded">
                                    {session.student_level}
                                </span>
                                <span className="text-xs text-gray-500 truncate max-w-[150px]">
                                    {session.topic}
                                </span>
                            </div>

                            {session.wolfie_evaluations?.[0] && (
                                <div className="flex items-center gap-2 mt-2">
                                    {renderStars(session.wolfie_evaluations[0].overall_score)}
                                    <span className="text-[10px] font-bold text-gray-500">
                                        {session.wolfie_evaluations[0].overall_score}/5
                                    </span>
                                </div>
                            )}
                        </button>
                    ))}
                </div>
            </div>

            {/* RIGHT PANEL: DETAILS */}
            <div className="flex min-h-[30rem] min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-gray-100 bg-brand-surface shadow-sm dark:border-brand-border">
                {selectedSessionId ? (
                    <>
                        {/* Header */}
                        <div className="flex flex-col items-start justify-between gap-3 border-b border-gray-100 bg-gray-50/50 p-4 dark:border-brand-border dark:bg-brand-surface-2/50 sm:p-6 md:flex-row">
                            <div className="min-w-0">
                                <h3 className="text-xl font-bold text-brand-text mb-1">
                                    Detalhes da Sessão
                                </h3>
                                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-gray-500">
                                    <span className="flex items-center gap-1"><User size={14} /> {sessions.find(s => s.id === selectedSessionId)?.student?.full_name}</span>
                                    <span className="flex items-center gap-1"><Calendar size={14} /> {new Date(sessions.find(s => s.id === selectedSessionId)?.created_at || '').toLocaleString()}</span>
                                </div>
                            </div>

                            {/* Score Card */}
                            {sessions.find(s => s.id === selectedSessionId)?.wolfie_evaluations?.[0] && (
                                <div className="bg-brand-surface dark:bg-brand-surface-2 p-3 rounded-xl shadow-sm border border-gray-100 dark:border-brand-border">
                                    <div className="text-xs text-gray-400 uppercase font-bold mb-1">Nota da IA</div>
                                    <div className="flex items-center gap-2">
                                        <span className="text-2xl font-black text-purple-600">
                                            {sessions.find(s => s.id === selectedSessionId)?.wolfie_evaluations[0].overall_score}
                                        </span>
                                        <div className="flex flex-col">
                                            {renderStars(sessions.find(s => s.id === selectedSessionId)?.wolfie_evaluations[0].overall_score || 0)}
                                            <span className="text-[10px] text-gray-400">Avaliação automática</span>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>

                        <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
                            {/* Chat Transcript */}
                            <div className="min-h-[18rem] flex-1 space-y-6 overflow-y-auto bg-brand-surface-2 p-4 dark:bg-slate-950/50 sm:p-6">
                                {detailLoading ? (
                                    <p className="text-center text-gray-400">Carregando conversa...</p>
                                ) : detailError ? (
                                    <div className="mx-auto max-w-md rounded-xl border border-red-200 bg-red-50 p-4 text-center dark:border-red-900/40 dark:bg-red-950/20" role="alert">
                                        <p className="text-sm font-bold text-red-700 dark:text-red-200">{detailError}</p>
                                        <button
                                            type="button"
                                            onClick={() => fetchSessionDetails(selectedSessionId)}
                                            className="mt-3 inline-flex items-center gap-2 rounded-lg bg-red-600 px-3 py-2 text-xs font-bold text-white"
                                        >
                                            <RefreshCw size={13} /> Tentar novamente
                                        </button>
                                    </div>
                                ) : turns.length === 0 ? (
                                    <p className="text-center text-sm text-gray-400">Esta sessão não possui transcrição.</p>
                                ) : turns.map(turn => (
                                    <div key={turn.id} className={`flex ${turn.speaker === 'student' ? 'justify-end' : 'justify-start'}`}>
                                        <div className={`max-w-[70%] p-4 rounded-2xl shadow-sm ${turn.speaker === 'student'
                                                ? 'bg-blue-600 text-white rounded-tr-none'
                                                : 'bg-brand-surface dark:bg-brand-surface-2 text-brand-text dark:text-gray-200 rounded-tl-none border border-gray-100 dark:border-brand-border'
                                            }`}>
                                            <p className="text-sm leading-relaxed whitespace-pre-wrap">{turn.content}</p>
                                        </div>
                                    </div>
                                ))}
                            </div>

                            {/* Sidebar: Corrections & Feedback */}
                            <div className="flex max-h-[24rem] w-full flex-col border-t border-gray-100 bg-brand-surface dark:border-brand-border lg:max-h-none lg:w-80 lg:border-l lg:border-t-0">
                                <div className="p-4 border-b border-gray-100 dark:border-brand-border font-bold text-brand-text dark:text-white flex items-center gap-2">
                                    <CheckCircle size={16} className="text-green-500" />
                                    Correções ({corrections.length})
                                </div>
                                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                                    {corrections.map(corr => (
                                        <div key={corr.id} className="p-3 rounded-lg bg-red-50 dark:bg-red-900/10 border border-red-100 dark:border-red-900/30 text-sm">
                                            <div className="line-through text-red-400 mb-1 opacity-70">"{corr.wrong_sentence}"</div>
                                            <div className="text-green-600 dark:text-green-400 font-medium mb-2">"{corr.correct_sentence}"</div>
                                            <div className="text-xs text-brand-muted italic bg-brand-surface dark:bg-brand-surface-2 p-2 rounded border border-gray-100 dark:border-brand-border">
                                                {corr.explanation_pt}
                                            </div>
                                        </div>
                                    ))}

                                    {/* Evaluation Text */}
                                    {sessions.find(s => s.id === selectedSessionId)?.wolfie_evaluations?.[0]?.textual_feedback_pt && (
                                        <div className="mt-6">
                                            <h4 className="font-bold text-brand-text dark:text-white mb-2 flex items-center gap-2">
                                                <MessageSquare size={16} className="text-purple-500" /> Feedback Geral
                                            </h4>
                                            <p className="text-xs leading-relaxed text-brand-muted bg-purple-50 dark:bg-purple-900/10 p-3 rounded-lg border border-purple-100 dark:border-purple-800">
                                                {sessions.find(s => s.id === selectedSessionId)?.wolfie_evaluations[0].textual_feedback_pt}
                                            </p>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    </>
                ) : (
                    <div className="flex-1 flex flex-col items-center justify-center text-gray-400">
                        <Brain size={48} className="mb-4 opacity-20" />
                        <p>Selecione uma sessão para analisar</p>
                    </div>
                )}
            </div>
        </div>
      </div>
    );
};

const MiniKpi: React.FC<{ label: string; value: string; sub?: string; accent?: string }> = ({ label, value, sub, accent }) => (
    <div className="bg-brand-surface border border-brand-border rounded-xl p-3">
        <p className="text-[9px] font-black text-brand-muted uppercase tracking-wide">{label}</p>
        <p className={`text-lg font-black ${accent || 'text-brand-text'}`}>{value}</p>
        {sub && <p className="text-[9px] text-brand-muted">{sub}</p>}
    </div>
);

export default WolfieLab;
