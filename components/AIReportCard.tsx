import React, { useState, useEffect } from 'react';
import { Sparkles, RefreshCw, BrainCircuit, AlertCircle } from 'lucide-react';
import { supabase } from '../lib/supabase';

interface AIReportCardProps {
    studentId: string;
}

const AIReportCard: React.FC<AIReportCardProps> = ({ studentId }) => {
    const [insight, setInsight] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [lastUpdated, setLastUpdated] = useState<string | null>(null);

    useEffect(() => {
        if (studentId) {
            fetchLatestInsight();
        }
    }, [studentId]);

    const fetchLatestInsight = async () => {
        setLoading(true);
        setError(null);
        try {
            const { data, error } = await supabase
                .from('student_insights')
                .select('*')
                .eq('student_id', studentId)
                .order('created_at', { ascending: false })
                .limit(1);

            if (error) throw error;

            if (data && data.length > 0) {
                setInsight(data[0].content);
                setLastUpdated(new Date(data[0].created_at).toLocaleDateString());
            } else {
                // If no insight exists, generate one automatically first time? 
                // Or wait for user? The prompt says: "Se NÃO existir ... Mostrar Loading ... Chamar generate".
                // Let's generate automatically if none exists.
                generateNewInsight();
                return; // generate handling loading
            }
        } catch (err: any) {
            console.error('Error fetching insight:', err);
            // Don't show error immediately on fetch fail, just generic message or try generate
            setError('Não foi possível carregar o relatório.');
        } finally {
            setLoading(false);
        }
    };

    const generateNewInsight = async () => {
        setLoading(true);
        setInsight(null); // Clear old to show thinking state
        setError(null);

        try {
            const { data, error } = await supabase.functions.invoke('generate-student-insights', {
                body: { student_id: studentId }
            });

            if (error) throw error;
            if (data.error) throw new Error(data.error);

            if (data.insight) {
                setInsight(data.insight.content);
                setLastUpdated(new Date().toLocaleDateString());
            } else if (data.message) {
                // "Dados insuficientes" case
                setInsight(data.message);
            }

        } catch (err: any) {
            console.error('Error generating insight:', err);
            setError('Erro ao gerar novo relatório. Tente novamente mais tarde.');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="bg-gradient-to-br from-tenant-primary to-slate-900 p-8 rounded-[2.5rem] text-white shadow-xl relative overflow-hidden group flex-1 flex flex-col justify-between min-h-[400px]">

            {/* Background Decor */}
            <div className="absolute top-0 right-0 p-8 opacity-10 group-hover:scale-110 transition-transform duration-700">
                <BrainCircuit size={120} />
            </div>

            <div className="relative z-10 w-full">
                <div className="flex items-center gap-2 mb-6">
                    <div className="p-2 bg-brand-surface/20 rounded-xl backdrop-blur-md">
                        <Sparkles size={20} className="text-yellow-300" />
                    </div>
                    <span className="text-[10px] font-black uppercase tracking-widest text-blue-100">Relatório Inteligente (IA)</span>
                </div>

                <h4 className="text-xl font-bold mb-6 tracking-tight">Análise de Desempenho</h4>

                <div className="min-h-[150px] flex items-center">
                    {loading ? (
                        <div className="flex flex-col gap-3 w-full animate-pulse">
                            <div className="flex items-center gap-2 text-blue-200 italic">
                                <RefreshCw size={16} className="animate-spin" />
                                <span className="text-sm font-medium">O Lobo está analisando seus últimos feedbacks...</span>
                            </div>
                            <div className="h-2 bg-brand-surface/10 rounded w-3/4"></div>
                            <div className="h-2 bg-brand-surface/10 rounded w-1/2"></div>
                        </div>
                    ) : error ? (
                        <div className="flex flex-col gap-2 text-red-300 bg-red-900/20 p-4 rounded-xl border border-red-500/30">
                            <div className="flex items-center gap-2 font-bold text-sm">
                                <AlertCircle size={16} /> Ops!
                            </div>
                            <p className="text-xs">{error}</p>
                        </div>
                    ) : (
                        <div className="relative">
                            <span className="absolute -top-2 -left-2 text-4xl text-blue-300/30 font-serif">"</span>
                            <p className="text-blue-50 text-sm leading-relaxed font-medium italic pl-4 border-l-2 border-blue-400/30">
                                {insight}
                            </p>
                            <span className="absolute -bottom-4 right-0 text-4xl text-blue-300/30 font-serif leading-none">"</span>
                        </div>
                    )}
                </div>
            </div>

            <div className="mt-8 pt-6 border-t border-white/10 flex justify-between items-center relative z-10">
                <div>
                    <p className="text-[10px] font-black uppercase tracking-widest text-blue-200/60 mb-1">Última Atualização</p>
                    <p className="text-xs font-bold text-white">{lastUpdated || 'Hoje'}</p>
                </div>

                <button
                    onClick={generateNewInsight}
                    disabled={loading}
                    className="px-4 py-2 bg-brand-surface/10 hover:bg-brand-surface/20 rounded-xl text-[10px] font-black uppercase tracking-widest flex items-center gap-2 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Recalcular
                </button>
            </div>
        </div>
    );
};

export default AIReportCard;
