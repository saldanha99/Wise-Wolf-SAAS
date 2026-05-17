import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase'; // Adjust path if needed
import {
    Search, Filter, Brain, MessageSquare,
    CheckCircle, AlertTriangle, Star,
    ChevronRight, ChevronLeft, User, Calendar
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

    // Detail View State
    const [turns, setTurns] = useState<WolfieTurn[]>([]);
    const [corrections, setCorrections] = useState<WolfieCorrection[]>([]);
    const [detailLoading, setDetailLoading] = useState(false);

    useEffect(() => {
        fetchSessions();
    }, [tenantId]);

    useEffect(() => {
        if (selectedSessionId) {
            fetchSessionDetails(selectedSessionId);
        }
    }, [selectedSessionId]);

    const fetchSessions = async () => {
        setLoading(true);
        try {
            let query = supabase
                .from('wolfie_sessions')
                .select(`
                    id, created_at, topic, student_level, mode, overall_score, summary,
                    student:student_id(full_name, avatar_url),
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
        } finally {
            setLoading(false);
        }
    };

    const fetchSessionDetails = async (sessionId: string) => {
        setDetailLoading(true);
        try {
            const { data: turnData } = await supabase
                .from('wolfie_turns')
                .select('*')
                .eq('session_id', sessionId)
                .order('turn_index', { ascending: true });

            const { data: corrData } = await supabase
                .from('wolfie_corrections')
                .select('*')
                .eq('session_id', sessionId);

            setTurns(turnData || []);
            setCorrections(corrData || []);
        } catch (e) {
            console.error(e);
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

    return (
        <div className="flex h-[calc(100vh-100px)] gap-6 font-sans">
            {/* LEFT PANEL: LIST */}
            <div className="w-1/3 flex flex-col bg-brand-surface rounded-2xl border border-gray-100 dark:border-brand-border shadow-sm overflow-hidden">
                <div className="p-4 border-b border-gray-100 dark:border-brand-border">
                    <h2 className="text-lg font-bold text-brand-text flex items-center gap-2">
                        <Brain className="text-purple-600" /> Wolfie Lab
                    </h2>
                    <div className="mt-3 relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 w-4 h-4" />
                        <input
                            type="text"
                            placeholder="Buscar aluno ou tópico..."
                            className="w-full pl-9 pr-4 py-2 bg-gray-50 dark:bg-brand-surface-2 rounded-lg text-sm border-none focus:ring-2 focus:ring-purple-500/50"
                        />
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto p-2 space-y-2">
                    {loading ? (
                        <p className="text-center text-gray-400 py-10">Carregando sessões...</p>
                    ) : sessions.map(session => (
                        <div
                            key={session.id}
                            onClick={() => setSelectedSessionId(session.id)}
                            className={`p-3 rounded-xl cursor-pointer transition-all border ${selectedSessionId === session.id ? 'bg-purple-50 border-purple-200 dark:bg-purple-900/20 dark:border-purple-800' : 'bg-transparent border-transparent hover:bg-gray-50 dark:hover:bg-brand-surface-2'}`}
                        >
                            <div className="flex justify-between items-start mb-1">
                                <div className="flex items-center gap-2">
                                    <div className="w-6 h-6 rounded-full bg-gradient-to-tr from-blue-400 to-purple-400 flex items-center justify-center text-[10px] text-white font-bold">
                                        {session.student?.full_name?.charAt(0) || 'A'}
                                    </div>
                                    <span className="text-sm font-semibold text-brand-text dark:text-gray-200">
                                        {session.student?.full_name}
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
                        </div>
                    ))}
                </div>
            </div>

            {/* RIGHT PANEL: DETAILS */}
            <div className="flex-1 bg-brand-surface rounded-2xl border border-gray-100 dark:border-brand-border shadow-sm overflow-hidden flex flex-col">
                {selectedSessionId ? (
                    <>
                        {/* Header */}
                        <div className="p-6 border-b border-gray-100 dark:border-brand-border flex justify-between items-start bg-gray-50/50 dark:bg-brand-surface-2/50">
                            <div>
                                <h3 className="text-xl font-bold text-brand-text mb-1">
                                    Detalhes da Sessão
                                </h3>
                                <div className="flex items-center gap-4 text-sm text-gray-500">
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
                                            <span className="text-[10px] text-gray-400">Gemini 2.0 Flash</span>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>

                        <div className="flex-1 flex overflow-hidden">
                            {/* Chat Transcript */}
                            <div className="flex-1 overflow-y-auto p-6 space-y-6 bg-brand-surface-2 dark:bg-slate-950/50">
                                {detailLoading ? (
                                    <p className="text-center text-gray-400">Carregando conversa...</p>
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
                            <div className="w-80 border-l border-gray-100 dark:border-brand-border bg-brand-surface flex flex-col">
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
    );
};

export default WolfieLab;
