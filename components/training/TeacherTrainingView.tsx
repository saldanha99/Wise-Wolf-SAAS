import React, { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { Play, CheckCircle, Lock, Award, Clock, FileText, Download, DollarSign } from 'lucide-react';

interface TrainingModule {
    id: string;
    title: string;
    description: string;
    video_url: string;
    pdf_url?: string;
    is_mandatory: boolean;
    category: string;
}

interface Assignment {
    module_id: string;
    status: string;
    completed_at?: string;
}

interface TeacherTrainingViewProps {
    tenantId: string;
    teacherId: string;
    onProgressUpdate?: () => void;
}

const TeacherTrainingView: React.FC<TeacherTrainingViewProps> = ({ tenantId, teacherId, onProgressUpdate }) => {
    const [modules, setModules] = useState<TrainingModule[]>([]);
    const [completedIds, setCompletedIds] = useState<Set<string>>(new Set());
    const [assignments, setAssignments] = useState<Assignment[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetchData();
    }, [tenantId, teacherId]);

    const fetchData = async () => {
        setLoading(true);
        // 1. Fetch all modules for this tenant
        const { data: modulesData } = await supabase
            .from('training_modules')
            .select('*')
            .eq('tenant_id', tenantId)
            .order('created_at', { ascending: true });

        // 2. Fetch completion status
        const { data: completions } = await supabase
            .from('training_completions')
            .select('module_id')
            .eq('teacher_id', teacherId);

        // 3. Fetch assignments for this teacher
        const { data: assignData } = await supabase
            .from('training_assignments')
            .select('module_id, status, completed_at')
            .eq('teacher_id', teacherId);

        setModules(modulesData || []);
        setCompletedIds(new Set(completions?.map(c => c.module_id) || []));
        setAssignments(assignData || []);
        setLoading(false);
    };

    const handleMarkComplete = async (moduleId: string) => {
        try {
            // 1. Mark as completed in training_completions
            const { error: compErr } = await supabase
                .from('training_completions')
                .upsert({
                    teacher_id: teacherId,
                    module_id: moduleId,
                    tenant_id: tenantId,
                    completed_at: new Date().toISOString()
                });

            if (compErr) throw compErr;

            // 2. Update assignment status if exists
            await supabase
                .from('training_assignments')
                .update({
                    status: 'COMPLETED',
                    completed_at: new Date().toISOString()
                })
                .eq('teacher_id', teacherId)
                .eq('module_id', moduleId);

            // 3. Refresh data
            setCompletedIds(prev => new Set([...prev, moduleId]));
            onProgressUpdate?.();

            alert('✅ Treinamento marcado como concluído!');
        } catch (err: any) {
            alert('Erro: ' + err.message);
        }
    };

    const getAssignment = (moduleId: string) => assignments.find(a => a.module_id === moduleId);

    if (loading) {
        return (
            <div className="flex items-center justify-center py-20">
                <div className="w-8 h-8 border-4 border-purple-600 border-t-transparent rounded-full animate-spin" />
            </div>
        );
    }

    const completedCount = modules.filter(m => completedIds.has(m.id)).length;
    const progressPercent = modules.length > 0 ? Math.round((completedCount / modules.length) * 100) : 0;

    return (
        <div className="space-y-6">
            {/* Progress Header */}
            <div className="bg-white dark:bg-slate-900 rounded-2xl p-6 border border-slate-100 dark:border-slate-800 shadow-sm">
                <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-3">
                        <div className="p-2 bg-purple-100 dark:bg-purple-900/30 rounded-xl">
                            <Award size={20} className="text-purple-600" />
                        </div>
                        <div>
                            <h2 className="text-lg font-black text-slate-800 dark:text-white">Meus Treinamentos</h2>
                            <p className="text-xs text-slate-500">{completedCount} de {modules.length} concluídos</p>
                        </div>
                    </div>
                    <span className="text-2xl font-black text-purple-600">{progressPercent}%</span>
                </div>
                <div className="w-full bg-slate-100 dark:bg-slate-800 rounded-full h-3 overflow-hidden">
                    <div
                        className="h-full bg-gradient-to-r from-purple-500 to-indigo-500 rounded-full transition-all duration-1000"
                        style={{ width: `${progressPercent}%` }}
                    />
                </div>
            </div>

            {/* Assigned Training Banner */}
            {assignments.filter(a => a.status === 'PENDING').length > 0 && (
                <div className="bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-900/30 p-4 rounded-2xl flex items-center gap-3">
                    <DollarSign size={20} className="text-amber-600 shrink-0" />
                    <div>
                        <p className="text-sm font-bold text-amber-800 dark:text-amber-400">
                            Você tem {assignments.filter(a => a.status === 'PENDING').length} treinamento(s) atribuído(s)
                        </p>
                        <p className="text-xs text-amber-600 dark:text-amber-300">
                            Complete para receber remuneração pelo valor da sua aula.
                        </p>
                    </div>
                </div>
            )}

            {/* Modules Grid */}
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
                {modules.map(module => {
                    const isCompleted = completedIds.has(module.id);
                    const assignment = getAssignment(module.id);
                    const isPdf = !!module.pdf_url;

                    return (
                        <div
                            key={module.id}
                            className={`bg-white dark:bg-slate-900 border rounded-2xl overflow-hidden shadow-sm transition-all hover:shadow-md ${isCompleted
                                    ? 'border-emerald-200 dark:border-emerald-800'
                                    : assignment?.status === 'PENDING'
                                        ? 'border-amber-300 dark:border-amber-700 ring-2 ring-amber-300/50'
                                        : 'border-slate-100 dark:border-slate-800'
                                }`}
                        >
                            {/* Preview */}
                            <div className="aspect-video bg-slate-100 dark:bg-slate-800 relative flex items-center justify-center">
                                {isPdf ? (
                                    <div className="flex flex-col items-center gap-2">
                                        <FileText size={40} className="text-red-400" />
                                        <span className="text-[10px] font-bold text-slate-400 uppercase">PDF</span>
                                    </div>
                                ) : module.video_url?.includes('youtube') ? (
                                    <img
                                        src={`https://img.youtube.com/vi/${module.video_url.split('v=')[1]?.split('&')[0]}/maxresdefault.jpg`}
                                        className="w-full h-full object-cover"
                                    />
                                ) : (
                                    <Play size={40} className="text-slate-300" />
                                )}

                                {isCompleted && (
                                    <div className="absolute inset-0 bg-emerald-500/20 backdrop-blur-[1px] flex items-center justify-center">
                                        <div className="bg-emerald-500 text-white p-3 rounded-full shadow-lg">
                                            <CheckCircle size={24} />
                                        </div>
                                    </div>
                                )}

                                {assignment?.status === 'PENDING' && !isCompleted && (
                                    <span className="absolute top-2 left-2 bg-amber-500 text-white text-[10px] font-bold px-2 py-1 rounded-full uppercase tracking-wider shadow-sm flex items-center gap-1">
                                        <DollarSign size={10} /> Atribuído
                                    </span>
                                )}

                                {module.is_mandatory && (
                                    <span className="absolute top-2 right-2 bg-red-500 text-white text-[10px] font-bold px-2 py-1 rounded-full uppercase tracking-wider shadow-sm">
                                        Obrigatório
                                    </span>
                                )}
                            </div>

                            {/* Content */}
                            <div className="p-5">
                                <span className="text-[10px] uppercase font-bold text-slate-400 tracking-wider bg-slate-50 dark:bg-slate-800 px-2 py-0.5 rounded mb-2 inline-block">
                                    {module.category}
                                </span>
                                <h3 className="font-bold text-slate-800 dark:text-white mb-1 line-clamp-1">{module.title}</h3>
                                <p className="text-xs text-slate-500 line-clamp-2 min-h-[2.5em]">{module.description || 'Sem descrição.'}</p>

                                <div className="mt-4 pt-4 border-t border-slate-50 dark:border-slate-800 space-y-2">
                                    {/* Action Button */}
                                    <a
                                        href={isPdf ? module.pdf_url : module.video_url}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="block w-full py-2 text-center text-xs font-bold text-purple-600 bg-purple-50 dark:bg-purple-900/20 rounded-lg hover:bg-purple-100 transition-colors"
                                    >
                                        {isPdf ? (
                                            <span className="flex items-center justify-center gap-1"><Download size={12} /> Abrir PDF</span>
                                        ) : (
                                            <span className="flex items-center justify-center gap-1"><Play size={12} /> Assistir</span>
                                        )}
                                    </a>

                                    {/* Mark Complete Button */}
                                    {!isCompleted && (
                                        <button
                                            onClick={() => handleMarkComplete(module.id)}
                                            className="w-full py-2 text-xs font-bold text-emerald-600 bg-emerald-50 dark:bg-emerald-900/20 rounded-lg hover:bg-emerald-100 transition-colors flex items-center justify-center gap-1"
                                        >
                                            <CheckCircle size={12} /> Marcar como Concluído
                                        </button>
                                    )}

                                    {isCompleted && (
                                        <p className="text-center text-[10px] font-bold text-emerald-500 uppercase tracking-wider">✅ Concluído</p>
                                    )}
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>

            {/* Empty State */}
            {modules.length === 0 && (
                <div className="text-center py-20 bg-slate-50 dark:bg-slate-900/50 rounded-3xl border-2 border-dashed border-slate-200 dark:border-slate-800">
                    <Award size={48} className="mx-auto text-slate-300 mb-4" />
                    <h3 className="text-lg font-bold text-slate-600 dark:text-slate-300">Nenhum treinamento disponível</h3>
                    <p className="text-slate-400 text-sm mt-2">Os treinamentos serão exibidos aqui quando forem adicionados pela escola.</p>
                </div>
            )}
        </div>
    );
};

export default TeacherTrainingView;
