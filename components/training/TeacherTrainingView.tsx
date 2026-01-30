import React, { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { Play, CheckCircle, Lock, Award, Clock } from 'lucide-react';

interface TrainingModule {
    id: string;
    title: string;
    description: string;
    video_url: string;
    is_mandatory: boolean;
    category: string;
}

interface TeacherTrainingViewProps {
    tenantId: string;
    teacherId: string;
    onProgressUpdate?: () => void;
}

const TeacherTrainingView: React.FC<TeacherTrainingViewProps> = ({ tenantId, teacherId, onProgressUpdate }) => {
    const [modules, setModules] = useState<TrainingModule[]>([]);
    const [completedIds, setCompletedIds] = useState<string[]>([]);
    const [loading, setLoading] = useState(true);
    const [activeModule, setActiveModule] = useState<TrainingModule | null>(null);

    useEffect(() => {
        fetchData();
    }, [tenantId, teacherId]);

    const fetchData = async () => {
        setLoading(true);
        // 1. Fetch Modules
        const { data: mods } = await supabase
            .from('training_modules')
            .select('*')
            .eq('tenant_id', tenantId)
            .order('is_mandatory', { ascending: false }); // Mandatory first

        // 2. Fetch Progress
        const { data: prog } = await supabase
            .from('training_progress')
            .select('module_id')
            .eq('tenant_id', tenantId)
            .eq('teacher_id', teacherId)
            .eq('status', 'COMPLETED');

        setModules(mods || []);
        setCompletedIds(prog?.map(p => p.module_id) || []);
        setLoading(false);
    };

    const handleMarkComplete = async (moduleId: string) => {
        try {
            const { error } = await supabase
                .from('training_progress')
                .upsert({
                    tenant_id: tenantId,
                    teacher_id: teacherId,
                    module_id: moduleId,
                    status: 'COMPLETED',
                    completed_at: new Date().toISOString()
                }, { onConflict: 'teacher_id, module_id' }); // Require valid unique constraint

            if (error) throw error;

            setCompletedIds(prev => [...prev, moduleId]);
            setActiveModule(null); // Close modal
            if (onProgressUpdate) onProgressUpdate(); // Notify parent to unlock stuff
            alert("Módulo concluído!");

        } catch (error: any) {
            console.error('Error marking complete:', error);
            alert('Erro ao concluir: ' + error.message);
        }
    };

    const progressPercentage = modules.length > 0 ? Math.round((completedIds.length / modules.length) * 100) : 0;
    const mandatoryModules = modules.filter(m => m.is_mandatory);
    const mandatoryCompleted = mandatoryModules.filter(m => completedIds.includes(m.id)).length;
    const isBlocked = mandatoryCompleted < mandatoryModules.length;

    return (
        <div className="space-y-8">
            {/* Header / Progress Status */}
            <div className="bg-gradient-to-r from-slate-900 to-slate-800 rounded-3xl p-8 text-white relative overflow-hidden shadow-2xl">
                <div className="absolute top-0 right-0 w-64 h-64 bg-purple-500/20 rounded-full blur-[80px] -mr-16 -mt-16 pointer-events-none" />

                <div className="relative z-10 flex flex-col md:flex-row gap-8 items-center justify-between">
                    <div>
                        <h2 className="text-3xl font-black mb-2 flex items-center gap-3">
                            <Award className="text-yellow-400" size={32} />
                            Academy
                        </h2>
                        <p className="text-slate-300 max-w-lg">
                            Complete os módulos de treinamento para liberar acesso total às funcionalidades e garantir a excelência no ensino.
                        </p>
                    </div>

                    <div className="bg-white/10 backdrop-blur-md p-6 rounded-2xl min-w-[200px] text-center border border-white/10">
                        <div className="text-4xl font-black mb-1">{progressPercentage}%</div>
                        <div className="text-xs uppercase tracking-widest text-slate-400 font-bold mb-3">Concluído</div>
                        <div className="w-full h-2 bg-slate-700 rounded-full overflow-hidden">
                            <div className="h-full bg-emerald-500 transition-all duration-1000" style={{ width: `${progressPercentage}%` }} />
                        </div>
                    </div>
                </div>
            </div>

            {/* Block Warning */}
            {isBlocked && (
                <div className="bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 p-4 rounded-xl flex items-center gap-3 text-orange-800 dark:text-orange-200">
                    <Lock size={20} />
                    <span className="text-sm font-bold">Você possui {mandatoryModules.length - mandatoryCompleted} módulos obrigatórios pendentes. Complete-os para desbloquear sua área de alunos.</span>
                </div>
            )}

            {/* Modules List */}
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
                {modules.map(module => {
                    const isCompleted = completedIds.includes(module.id);
                    return (
                        <div key={module.id} className={`group relative bg-white dark:bg-slate-900 rounded-2xl border transition-all hover:shadow-lg ${isCompleted ? 'border-emerald-200 dark:border-emerald-900/30' : 'border-slate-100 dark:border-slate-800'}`}>
                            {/* Status Badge */}
                            <div className={`absolute top-3 right-3 z-10 px-2 py-1 rounded-lg text-[10px] font-black uppercase tracking-wider flex items-center gap-1 ${isCompleted ? 'bg-emerald-100 text-emerald-600' : 'bg-slate-100 text-slate-500'}`}>
                                {isCompleted ? <><CheckCircle size={10} /> Concluído</> : <><Clock size={10} /> Pendente</>}
                            </div>

                            {/* Thumbnail */}
                            <div className="aspect-video bg-slate-100 dark:bg-black relative overflow-hidden rounded-t-2xl cursor-pointer" onClick={() => setActiveModule(module)}>
                                {module.video_url.includes('youtube') ? (
                                    <img
                                        src={`https://img.youtube.com/vi/${module.video_url.split('v=')[1]?.split('&')[0]}/mqdefault.jpg`}
                                        className={`w-full h-full object-cover transition-all duration-500 ${isCompleted ? 'grayscale opacity-60' : 'group-hover:scale-105'}`}
                                    />
                                ) : (
                                    <div className="w-full h-full flex items-center justify-center text-slate-300"><Play size={40} /></div>
                                )}
                                <div className="absolute inset-0 bg-black/20 group-hover:bg-black/40 transition-colors flex items-center justify-center">
                                    <div className="w-12 h-12 bg-white/20 backdrop-blur rounded-full flex items-center justify-center hover:scale-110 transition-transform">
                                        <Play fill="white" className="text-white ml-1" />
                                    </div>
                                </div>
                            </div>

                            {/* Content */}
                            <div className="p-5">
                                <div className="flex items-center gap-2 mb-2">
                                    <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">{module.category}</span>
                                    {module.is_mandatory && !isCompleted && <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" title="Obrigatório" />}
                                </div>
                                <h3 className="font-bold text-slate-800 dark:text-white mb-2 line-clamp-2">{module.title}</h3>
                                <p className="text-xs text-slate-500 line-clamp-2">{module.description}</p>
                            </div>
                        </div>
                    );
                })}
            </div>

            {/* Video Modal */}
            {activeModule && (
                <div className="fixed inset-0 z-50 bg-black/90 backdrop-blur-md flex items-center justify-center p-4 animate-in fade-in duration-300">
                    <div className="bg-slate-900 w-full max-w-4xl rounded-3xl overflow-hidden shadow-2xl flex flex-col max-h-[90vh]">
                        {/* Player */}
                        <div className="aspect-video bg-black relative">
                            <iframe
                                src={activeModule.video_url.replace('watch?v=', 'embed/')}
                                className="w-full h-full"
                                allow="autoplay; fullscreen"
                            />
                        </div>

                        {/* Footer / Action */}
                        <div className="p-6 bg-slate-800 flex flex-col md:flex-row justify-between items-center gap-6">
                            <div>
                                <h3 className="text-xl font-bold text-white mb-1">{activeModule.title}</h3>
                                <p className="text-sm text-slate-400 line-clamp-1">{activeModule.description}</p>
                            </div>
                            <div className="flex gap-4">
                                <button
                                    onClick={() => setActiveModule(null)}
                                    className="px-6 py-3 rounded-xl font-bold text-slate-400 hover:text-white transition-colors"
                                >
                                    Fechar
                                </button>
                                <button
                                    onClick={() => handleMarkComplete(activeModule.id)}
                                    className="px-8 py-3 bg-emerald-500 hover:bg-emerald-600 text-white rounded-xl font-black uppercase tracking-wider shadow-lg shadow-emerald-500/20 transform hover:scale-105 transition-all flex items-center gap-2"
                                >
                                    <CheckCircle size={18} />
                                    Marcar como Concluído
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default TeacherTrainingView;
