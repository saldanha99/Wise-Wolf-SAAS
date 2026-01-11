import React, { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { Plus, Trash2, Video, CheckCircle, AlertCircle, Play, MoreVertical } from 'lucide-react';

interface TrainingModule {
    id: string;
    title: string;
    description: string;
    video_url: string;
    is_mandatory: boolean;
    category: string;
}

interface TeacherTrainingAdminProps {
    tenantId: string;
}

const TeacherTrainingAdmin: React.FC<TeacherTrainingAdminProps> = ({ tenantId }) => {
    const [modules, setModules] = useState<TrainingModule[]>([]);
    const [loading, setLoading] = useState(true);
    const [isAdding, setIsAdding] = useState(false);

    // New Module Form
    const [newModule, setNewModule] = useState({
        title: '',
        description: '',
        video_url: '',
        is_mandatory: true,
        category: 'Methodology'
    });

    useEffect(() => {
        fetchModules();
    }, [tenantId]);

    const fetchModules = async () => {
        setLoading(true);
        const { data, error } = await supabase
            .from('training_modules')
            .select('*')
            .eq('tenant_id', tenantId)
            .order('created_at', { ascending: false });

        if (error) console.error('Error fetching modules:', error);
        else setModules(data || []);
        setLoading(false);
    };

    const handleAddModule = async (e: React.FormEvent) => {
        e.preventDefault();
        const { error } = await supabase
            .from('training_modules')
            .insert({
                tenant_id: tenantId,
                ...newModule
            });

        if (error) {
            alert('Erro ao adicionar módulo: ' + error.message);
        } else {
            setNewModule({ title: '', description: '', video_url: '', is_mandatory: true, category: 'Methodology' });
            setIsAdding(false);
            fetchModules();
        }
    };

    const handleDelete = async (id: string) => {
        if (!confirm('Tem certeza que deseja excluir este módulo?')) return;
        const { error } = await supabase
            .from('training_modules')
            .delete()
            .eq('id', id);

        if (error) alert('Erro: ' + error.message);
        else fetchModules();
    };

    return (
        <div className="space-y-6">
            <div className="flex justify-between items-center">
                <div>
                    <h2 className="text-2xl font-black text-slate-800 dark:text-white flex items-center gap-2">
                        <Video className="text-purple-600" />
                        Treinamento de Professores
                    </h2>
                    <p className="text-slate-500 text-sm">Gerencie os vídeos e manuais de padronização da escola.</p>
                </div>
                <button
                    onClick={() => setIsAdding(true)}
                    className="flex items-center gap-2 bg-purple-600 hover:bg-purple-700 text-white px-4 py-2 rounded-xl font-bold transition-colors shadow-lg shadow-purple-500/20"
                >
                    <Plus size={18} /> Novo Módulo
                </button>
            </div>

            {/* List */}
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
                {modules.map(module => (
                    <div key={module.id} className="bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 rounded-2xl overflow-hidden shadow-sm group hover:shadow-md transition-all">
                        <div className="aspect-video bg-slate-100 dark:bg-slate-800 relative group-hover:bg-slate-200 transition-colors flex items-center justify-center">
                            {module.video_url.includes('youtube') ? (
                                <img
                                    src={`https://img.youtube.com/vi/${module.video_url.split('v=')[1]?.split('&')[0]}/maxresdefault.jpg`}
                                    className="w-full h-full object-cover opacity-90 group-hover:opacity-100 transition-opacity"
                                />
                            ) : (
                                <Video size={48} className="text-slate-300" />
                            )}
                            <div className="absolute inset-0 flex items-center justify-center">
                                <div className="w-12 h-12 bg-white/30 backdrop-blur-sm rounded-full flex items-center justify-center">
                                    <Play fill="white" className="text-white ml-1" size={20} />
                                </div>
                            </div>
                            {module.is_mandatory && (
                                <span className="absolute top-2 right-2 bg-red-500 text-white text-[10px] font-bold px-2 py-1 rounded-full uppercase tracking-wider shadow-sm">
                                    Obrigatório
                                </span>
                            )}
                        </div>
                        <div className="p-5">
                            <div className="flex justify-between items-start mb-2">
                                <span className="text-[10px] uppercase font-bold text-slate-400 tracking-wider bg-slate-50 dark:bg-slate-800 px-2 py-0.5 rounded">
                                    {module.category}
                                </span>
                                <button onClick={() => handleDelete(module.id)} className="text-slate-300 hover:text-red-500 transition-colors">
                                    <Trash2 size={16} />
                                </button>
                            </div>
                            <h3 className="font-bold text-slate-800 dark:text-white mb-1 line-clamp-1" title={module.title}>{module.title}</h3>
                            <p className="text-xs text-slate-500 line-clamp-2 min-h-[2.5em]">{module.description || 'Sem descrição.'}</p>

                            <div className="mt-4 pt-4 border-t border-slate-50 dark:border-slate-800 flex justify-between items-center">
                                <a
                                    href={module.video_url}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-xs font-bold text-purple-600 hover:text-purple-700 flex items-center gap-1"
                                >
                                    Assistir <Play size={10} />
                                </a>
                            </div>
                        </div>
                    </div>
                ))}
            </div>

            {/* Empty State */}
            {!loading && modules.length === 0 && (
                <div className="text-center py-20 bg-slate-50 dark:bg-slate-900/50 rounded-3xl border-2 border-dashed border-slate-200 dark:border-slate-800">
                    <div className="w-16 h-16 bg-slate-100 dark:bg-slate-800/2 rounded-full flex items-center justify-center mx-auto mb-4">
                        <Video className="text-slate-400" size={32} />
                    </div>
                    <h3 className="text-lg font-bold text-slate-600 dark:text-slate-300">Nenhum treinamento encontrado</h3>
                    <p className="text-slate-400 text-sm max-w-md mx-auto mt-2">Adicione vídeos e materiais para padronizar o atendimento da sua equipe.</p>
                    <button
                        onClick={() => setIsAdding(true)}
                        className="mt-6 text-purple-600 font-bold text-sm hover:underline"
                    >
                        Criar Primeiro Módulo
                    </button>
                </div>
            )}

            {/* Modal */}
            {isAdding && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-in fade-in">
                    <div className="bg-white dark:bg-slate-900 rounded-3xl p-8 max-w-md w-full shadow-2xl relative">
                        <h3 className="text-xl font-black mb-6 dark:text-white">Novo Treinamento</h3>
                        <form onSubmit={handleAddModule} className="space-y-4">
                            <div>
                                <label className="text-xs font-bold uppercase text-slate-500">Título</label>
                                <input
                                    className="w-full p-3 bg-slate-50 dark:bg-slate-800 rounded-xl border-none outline-none font-bold text-slate-800 dark:text-white focus:ring-2 focus:ring-purple-500"
                                    value={newModule.title}
                                    onChange={e => setNewModule({ ...newModule, title: e.target.value })}
                                    required
                                    placeholder="Ex: Como realizar a aula experimental"
                                />
                            </div>
                            <div>
                                <label className="text-xs font-bold uppercase text-slate-500">Video URL (YouTube)</label>
                                <input
                                    className="w-full p-3 bg-slate-50 dark:bg-slate-800 rounded-xl border-none outline-none text-sm text-slate-600 dark:text-slate-300 focus:ring-2 focus:ring-purple-500"
                                    value={newModule.video_url}
                                    onChange={e => setNewModule({ ...newModule, video_url: e.target.value })}
                                    required
                                    placeholder="https://youtube.com/watch?v=..."
                                />
                            </div>
                            <div>
                                <label className="text-xs font-bold uppercase text-slate-500">Descrição</label>
                                <textarea
                                    className="w-full p-3 bg-slate-50 dark:bg-slate-800 rounded-xl border-none outline-none text-sm text-slate-600 dark:text-slate-300 focus:ring-2 focus:ring-purple-500 resize-none h-24"
                                    value={newModule.description}
                                    onChange={e => setNewModule({ ...newModule, description: e.target.value })}
                                    placeholder="Resumo do conteúdo..."
                                />
                            </div>
                            <div className="flex justify-between items-center">
                                <label className="text-xs font-bold uppercase text-slate-500">Categoria</label>
                                <select
                                    className="bg-slate-50 dark:bg-slate-800 p-2 rounded-lg text-xs font-bold outline-none"
                                    value={newModule.category}
                                    onChange={e => setNewModule({ ...newModule, category: e.target.value })}
                                >
                                    <option value="General">Geral</option>
                                    <option value="Methodology">Metodologia</option>
                                    <option value="Sales">Vendas</option>
                                    <option value="Conduct">Conduta</option>
                                </select>
                            </div>
                            <div className="flex items-center gap-3 bg-slate-50 dark:bg-slate-800 p-3 rounded-xl cursor-pointer" onClick={() => setNewModule(prev => ({ ...prev, is_mandatory: !prev.is_mandatory }))}>
                                <div className={`w-5 h-5 rounded flex items-center justify-center border transition-colors ${newModule.is_mandatory ? 'bg-purple-600 border-purple-600' : 'border-slate-300'}`}>
                                    {newModule.is_mandatory && <CheckCircle size={14} className="text-white" />}
                                </div>
                                <span className="text-sm font-bold text-slate-700 dark:text-slate-200">Conteúdo Obrigatório</span>
                            </div>

                            <div className="flex gap-2 mt-6">
                                <button type="button" onClick={() => setIsAdding(false)} className="flex-1 py-3 bg-slate-100 dark:bg-slate-800 text-slate-500 font-bold rounded-xl hover:bg-slate-200 transition-colors">Cancelar</button>
                                <button type="submit" className="flex-1 py-3 bg-purple-600 text-white font-bold rounded-xl hover:bg-purple-700 transition-colors shadow-lg shadow-purple-500/20">Salvar</button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
};

export default TeacherTrainingAdmin;
