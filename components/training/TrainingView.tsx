import React, { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { Play, FileText, CheckCircle, Loader2, GraduationCap, Award, ExternalLink, Lock } from 'lucide-react';

interface Module {
    id: string;
    title: string;
    description: string;
    video_url: string;
    pdf_url: string;
    thumbnail_url: string;
    category: string;
    is_mandatory: boolean;
    order_index: number;
    target_roles: string[];
    progress_status: string;
    progress_completed_at: string | null;
}

interface Props {
    user: { id: string };
}

/**
 * Visualização de treinamentos para QUALQUER ROLE.
 * Backend filtra automaticamente pelo role do usuário logado via RPC.
 */
const TrainingView: React.FC<Props> = ({ user }) => {
    const [modules, setModules] = useState<Module[]>([]);
    const [loading, setLoading] = useState(true);
    const [active, setActive] = useState<Module | null>(null);
    const [categoryFilter, setCategoryFilter] = useState<string>('ALL');
    const [marking, setMarking] = useState<string | null>(null);

    useEffect(() => { load(); }, [user.id]);

    const load = async () => {
        setLoading(true);
        const { data, error } = await supabase.rpc('my_training_modules');
        if (error) console.error('Training load error:', error);
        setModules((data || []) as Module[]);
        setLoading(false);
    };

    const markComplete = async (moduleId: string) => {
        setMarking(moduleId);
        try {
            await supabase.rpc('mark_training_complete', { p_module_id: moduleId });
            await load();
            if (active?.id === moduleId) setActive(null);
        } finally { setMarking(null); }
    };

    const categories = Array.from(new Set(modules.map(m => m.category).filter(Boolean)));
    const filtered = categoryFilter === 'ALL' ? modules : modules.filter(m => m.category === categoryFilter);

    const completedCount = modules.filter(m => m.progress_status === 'COMPLETED').length;
    const mandatoryPending = modules.filter(m => m.is_mandatory && m.progress_status !== 'COMPLETED').length;

    if (loading) return <div className="p-12 flex items-center justify-center"><Loader2 className="animate-spin text-violet-500" size={24} /></div>;

    return (
        <div className="space-y-4">
            {/* Header */}
            <div className="bg-white dark:bg-slate-900 rounded-[2.5rem] border border-slate-100 dark:border-slate-800 overflow-hidden">
                <div className="p-6 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between gap-3 flex-wrap">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-violet-100 dark:bg-violet-900/30 rounded-xl flex items-center justify-center">
                            <GraduationCap size={20} className="text-violet-600" />
                        </div>
                        <div>
                            <h3 className="font-black text-slate-800 dark:text-white text-sm">Treinamentos</h3>
                            <p className="text-[10px] text-slate-400 uppercase tracking-widest">
                                {completedCount}/{modules.length} concluídos
                                {mandatoryPending > 0 && <span className="text-rose-500 ml-2">· {mandatoryPending} obrigatório{mandatoryPending === 1 ? '' : 's'} pendente{mandatoryPending === 1 ? '' : 's'}</span>}
                            </p>
                        </div>
                    </div>
                    {categories.length > 1 && (
                        <select value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)}
                            className="px-3 py-2 bg-slate-50 dark:bg-slate-800 rounded-xl text-xs font-bold border border-slate-200 dark:border-slate-700">
                            <option value="ALL">Todas categorias</option>
                            {categories.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                    )}
                </div>

                <div className="p-6">
                    {filtered.length === 0 ? (
                        <div className="text-center py-12 text-slate-400">
                            <GraduationCap size={32} className="mx-auto mb-3 opacity-40" />
                            <p className="text-sm font-bold">Nenhum treinamento disponível ainda</p>
                            <p className="text-xs mt-1">A escola ainda não publicou módulos para você.</p>
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                            {filtered.map(m => {
                                const done = m.progress_status === 'COMPLETED';
                                return (
                                    <button key={m.id} onClick={() => setActive(m)}
                                        className={`text-left rounded-2xl border p-4 hover:shadow-lg transition-all ${done ? 'border-emerald-200 bg-emerald-50/50 dark:bg-emerald-900/10' : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900'}`}>
                                        {m.thumbnail_url && (
                                            <div className="aspect-video rounded-xl bg-slate-100 dark:bg-slate-800 mb-3 overflow-hidden">
                                                <img src={m.thumbnail_url} alt={m.title} className="w-full h-full object-cover" />
                                            </div>
                                        )}
                                        <div className="flex items-center gap-2 mb-2 flex-wrap">
                                            {m.video_url && <Play size={12} className="text-blue-500" />}
                                            {m.pdf_url && <FileText size={12} className="text-rose-500" />}
                                            <span className="text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600">{m.category}</span>
                                            {m.is_mandatory && !done && <span className="text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-600">Obrigatório</span>}
                                            {done && <CheckCircle size={14} className="text-emerald-500 ml-auto" />}
                                        </div>
                                        <p className="text-sm font-black text-slate-800 dark:text-white">{m.title}</p>
                                        <p className="text-xs text-slate-500 dark:text-slate-400 line-clamp-2 mt-1">{m.description}</p>
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>
            </div>

            {/* Player modal */}
            {active && (
                <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-sm z-[200] flex items-end sm:items-center justify-center p-0 sm:p-4">
                    <div className="bg-white dark:bg-slate-900 rounded-t-3xl sm:rounded-3xl max-w-4xl w-full max-h-[95vh] overflow-y-auto shadow-2xl">
                        <div className="p-6 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between sticky top-0 bg-white dark:bg-slate-900 z-10">
                            <div className="flex-1 min-w-0">
                                <p className="text-[10px] uppercase tracking-widest text-slate-400 font-bold">{active.category}</p>
                                <h3 className="font-black text-slate-800 dark:text-white">{active.title}</h3>
                            </div>
                            <button onClick={() => setActive(null)} className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl">✕</button>
                        </div>

                        <div className="p-6 space-y-4">
                            {active.description && <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">{active.description}</p>}

                            {/* Video embed */}
                            {active.video_url && (
                                <div className="aspect-video rounded-2xl overflow-hidden bg-slate-100 dark:bg-slate-800">
                                    {active.video_url.includes('youtube') || active.video_url.includes('youtu.be') ? (
                                        <iframe
                                            src={active.video_url
                                                .replace('youtu.be/', 'youtube.com/embed/')
                                                .replace('watch?v=', 'embed/')}
                                            className="w-full h-full" allowFullScreen
                                            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" />
                                    ) : active.video_url.includes('vimeo') ? (
                                        <iframe src={active.video_url.replace('vimeo.com/', 'player.vimeo.com/video/')}
                                            className="w-full h-full" allowFullScreen />
                                    ) : (
                                        <div className="w-full h-full flex items-center justify-center">
                                            <a href={active.video_url} target="_blank" rel="noreferrer"
                                                className="text-sm font-bold text-violet-600 hover:underline flex items-center gap-2">
                                                Abrir vídeo <ExternalLink size={14} />
                                            </a>
                                        </div>
                                    )}
                                </div>
                            )}

                            {active.pdf_url && (
                                <a href={active.pdf_url} target="_blank" rel="noreferrer"
                                    className="flex items-center gap-3 p-4 rounded-2xl bg-rose-50 dark:bg-rose-900/20 border border-rose-100 dark:border-rose-800/30 hover:brightness-110">
                                    <FileText size={20} className="text-rose-500" />
                                    <div className="flex-1">
                                        <p className="text-sm font-black text-slate-800 dark:text-white">Material complementar (PDF)</p>
                                        <p className="text-[10px] text-slate-500">Clique para abrir</p>
                                    </div>
                                    <ExternalLink size={14} className="text-rose-500" />
                                </a>
                            )}

                            {active.progress_status === 'COMPLETED' ? (
                                <div className="bg-emerald-50 dark:bg-emerald-900/20 rounded-2xl p-4 flex items-center gap-3">
                                    <Award size={20} className="text-emerald-500" />
                                    <div>
                                        <p className="text-sm font-black text-emerald-700 dark:text-emerald-300">Concluído!</p>
                                        <p className="text-xs text-slate-500">{active.progress_completed_at && new Date(active.progress_completed_at).toLocaleDateString('pt-BR')}</p>
                                    </div>
                                </div>
                            ) : (
                                <button onClick={() => markComplete(active.id)} disabled={marking === active.id}
                                    className="w-full py-3 bg-emerald-600 text-white rounded-xl text-xs font-black uppercase tracking-widest hover:brightness-110 disabled:opacity-50 flex items-center justify-center gap-2">
                                    {marking === active.id ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle size={14} />}
                                    Marcar como concluído
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default TrainingView;
