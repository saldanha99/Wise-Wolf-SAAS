import React, { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { Plus, Trash2, Video, CheckCircle, Play, FileText, Upload, Users, DollarSign, Mic } from 'lucide-react';
import TeacherTrainingView from './TeacherTrainingView';

interface TrainingModule {
    id: string;
    title: string;
    description: string;
    video_url: string;
    pdf_url?: string;
    resource_type: 'video' | 'pdf' | 'meet';
    is_mandatory: boolean;
    category: string;
}

interface TeacherTrainingAdminProps {
    tenantId: string;
    currentUser?: any; // To pass created_by
}

const TeacherTrainingAdmin: React.FC<TeacherTrainingAdminProps> = ({ tenantId, currentUser }) => {
    const [activeTab, setActiveTab] = useState<'admin' | 'view'>('admin');

    const [modules, setModules] = useState<TrainingModule[]>([]);
    const [loading, setLoading] = useState(true);
    const [isAdding, setIsAdding] = useState(false);
    const [teachers, setTeachers] = useState<any[]>([]);
    const [assignModalModule, setAssignModalModule] = useState<string | null>(null);
    const [selectedTeachers, setSelectedTeachers] = useState<string[]>([]);

    const defaultResourceType = currentUser?.role === 'TEACHER' ? 'meet' : 'video';

    // New Module Form
    const [newModule, setNewModule] = useState({
        title: '',
        description: '',
        video_url: '',
        pdf_url: '',
        resource_type: defaultResourceType as 'video' | 'pdf' | 'meet',
        is_mandatory: true,
        category: 'Methodology'
    });

    const [pdfFile, setPdfFile] = useState<File | null>(null);
    const [uploading, setUploading] = useState(false);

    useEffect(() => {
        fetchModules();
        fetchTeachers();
    }, [tenantId]);

    const fetchModules = async () => {
        setLoading(true);
        const { data, error } = await supabase
            .from('training_modules')
            .select('*')
            .eq('tenant_id', tenantId)
            .order('created_at', { ascending: false });

        if (error) console.error('Error fetching modules:', error);
        else setModules((data || []).map(m => ({ ...m, resource_type: m.pdf_url ? 'pdf' : 'video' })));
        setLoading(false);
    };

    const fetchTeachers = async () => {
        const { data } = await supabase
            .from('profiles')
            .select('id, name, full_name')
            .eq('tenant_id', tenantId)
            .in('role', ['TEACHER', 'teacher']);
        if (data) setTeachers(data);
    };

    const handleAddModule = async (e: React.FormEvent) => {
        e.preventDefault();
        setUploading(true);

        try {
            let finalPdfUrl = newModule.pdf_url;

            // Upload PDF if file is selected
            if (pdfFile && newModule.resource_type === 'pdf') {
                // Sanitiza o nome: acento/espaço/parênteses em nomes PT-BR (ex.: "Método (final).pdf")
                // geram "Invalid key" no Supabase Storage → era o erro ao subir PDF de treinamento.
                const safeName = pdfFile.name.replace(/[^a-zA-Z0-9.-]/g, '_');
                const fileName = `${tenantId}/${Date.now()}_${safeName}`;
                const { data: uploadData, error: uploadError } = await supabase.storage
                    .from('training_materials')
                    .upload(fileName, pdfFile, { contentType: pdfFile.type });

                if (uploadError) throw uploadError;

                const { data: publicUrl } = supabase.storage
                    .from('training_materials')
                    .getPublicUrl(fileName);

                finalPdfUrl = publicUrl.publicUrl;
            }

            const { error } = await supabase
                .from('training_modules')
                .insert({
                    tenant_id: tenantId,
                    title: newModule.title,
                    description: newModule.description,
                    video_url: (newModule.resource_type === 'video' || newModule.resource_type === 'meet') ? newModule.video_url : '',
                    pdf_url: newModule.resource_type === 'pdf' ? finalPdfUrl : null,
                    is_mandatory: newModule.is_mandatory,
                    category: newModule.category,
                    created_by: currentUser?.id || null
                });

            if (error) throw error;

            setNewModule({ title: '', description: '', video_url: '', pdf_url: '', resource_type: defaultResourceType as 'video' | 'pdf' | 'meet', is_mandatory: true, category: 'Methodology' });
            setPdfFile(null);
            setIsAdding(false);
            fetchModules();
        } catch (err: any) {
            alert('Erro ao adicionar módulo: ' + err.message);
        } finally {
            setUploading(false);
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

    const handleAssign = async () => {
        if (!assignModalModule || selectedTeachers.length === 0) return;

        try {
            const assignments = selectedTeachers.map(tid => ({
                module_id: assignModalModule,
                teacher_id: tid,
                tenant_id: tenantId,
                status: 'PENDING'
            }));

            const { error } = await supabase
                .from('training_assignments')
                .upsert(assignments, { onConflict: 'module_id,teacher_id' });

            if (error) throw error;

            alert('Treinamento atribuído com sucesso!');
            setAssignModalModule(null);
            setSelectedTeachers([]);
        } catch (err: any) {
            alert('Erro: ' + err.message);
        }
    };

    if (activeTab === 'view') {
        return (
            <div className="space-y-6 animate-in fade-in">
                 <div className="flex justify-between items-center bg-brand-surface p-4 rounded-2xl border border-brand-border shadow-sm">
                    <div>
                        <h2 className="text-xl font-black text-brand-text">Meus Treinamentos</h2>
                        <p className="text-sm text-brand-muted">Área do aluno para assistir aos treinamentos obrigatórios.</p>
                    </div>
                    <button
                        onClick={() => setActiveTab('admin')}
                        className="bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300 px-4 py-2 rounded-xl font-bold hover:bg-purple-200 transition-colors"
                    >
                        Painel do Treinador
                    </button>
                 </div>
                 <TeacherTrainingView tenantId={tenantId} teacherId={currentUser?.id} />
            </div>
        );
    }

    return (
        <div className="space-y-6">
            <div className="flex justify-between items-center">
                <div>
                    <h2 className="text-2xl font-black text-brand-text flex items-center gap-2">
                        <Video className="text-purple-600" />
                        Treinamento de Professores
                    </h2>
                    <p className="text-brand-muted text-sm">Gerencie vídeos, PDFs e atribuições de treinamento para sua equipe.</p>
                </div>
                <div className="flex gap-3">
                    {currentUser?.is_trainer && currentUser?.role === 'TEACHER' && (
                        <button
                            onClick={() => setActiveTab('view')}
                            className="flex items-center gap-2 bg-brand-surface-2 hover:bg-slate-200 text-brand-text px-4 py-2 rounded-xl font-bold transition-colors"
                            title="Alternar para visão de aluno"
                        >
                            Ver Meus Treinamentos
                        </button>
                    )}
                    <button
                        onClick={() => setIsAdding(true)}
                        className="flex items-center gap-2 bg-tenant-primary hover:opacity-90 text-white px-4 py-2 rounded-xl font-bold transition-colors shadow-lg shadow-purple-500/20"
                    >
                        <Plus size={18} /> Novo Módulo
                    </button>
                </div>
            </div>

            {/* List */}
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
                {modules.map(module => (
                    <div key={module.id} className="bg-brand-surface border border-brand-border rounded-2xl overflow-hidden shadow-sm group hover:shadow-md transition-all">
                        <div className="aspect-video bg-brand-surface-2 dark:bg-brand-surface-2 relative group-hover:bg-slate-200 transition-colors flex items-center justify-center">
                            {module.resource_type === 'pdf' || module.pdf_url ? (
                                <div className="flex flex-col items-center gap-2">
                                    <FileText size={48} className="text-red-400" />
                                    <span className="text-[10px] font-bold text-brand-muted uppercase">PDF</span>
                                </div>
                            ) : module.resource_type === 'meet' ? (
                                <div className="flex flex-col items-center gap-2">
                                    <Mic size={48} className="text-emerald-500" />
                                    <span className="text-[10px] font-bold text-brand-muted uppercase tracking-widest">Ao Vivo (Meet)</span>
                                </div>
                            ) : module.video_url?.includes('youtube') ? (
                                <img
                                    src={`https://img.youtube.com/vi/${module.video_url.split('v=')[1]?.split('&')[0]}/maxresdefault.jpg`}
                                    className="w-full h-full object-cover opacity-90 group-hover:opacity-100 transition-opacity"
                                />
                            ) : (
                                <Video size={48} className="text-slate-300" />
                            )}
                            {!(module.resource_type === 'pdf' || module.pdf_url || module.resource_type === 'meet') && (
                                <div className="absolute inset-0 flex items-center justify-center">
                                    <div className="w-12 h-12 bg-brand-surface/30 backdrop-blur-sm rounded-full flex items-center justify-center">
                                        <Play fill="white" className="text-white ml-1" size={20} />
                                    </div>
                                </div>
                            )}
                            {module.is_mandatory && (
                                <span className="absolute top-2 right-2 bg-red-500 text-white text-[10px] font-bold px-2 py-1 rounded-full uppercase tracking-wider shadow-sm">
                                    Obrigatório
                                </span>
                            )}
                        </div>
                        <div className="p-5">
                            <div className="flex justify-between items-start mb-2">
                                <span className="text-[10px] uppercase font-bold text-brand-muted tracking-wider bg-brand-surface-2 px-2 py-0.5 rounded">
                                    {module.category}
                                </span>
                                <div className="flex items-center gap-2">
                                    <button
                                        onClick={() => { setAssignModalModule(module.id); setSelectedTeachers([]); }}
                                        className="text-slate-300 hover:text-purple-500 transition-colors"
                                        title="Atribuir a professor"
                                    >
                                        <Users size={16} />
                                    </button>
                                    <button onClick={() => handleDelete(module.id)} className="text-slate-300 hover:text-red-500 transition-colors">
                                        <Trash2 size={16} />
                                    </button>
                                </div>
                            </div>
                            <h3 className="font-bold text-brand-text mb-1 line-clamp-1" title={module.title}>{module.title}</h3>
                            <p className="text-xs text-brand-muted line-clamp-2 min-h-[2.5em]">{module.description || 'Sem descrição.'}</p>

                            <div className="mt-4 pt-4 border-t border-slate-50 dark:border-brand-border flex justify-between items-center">
                                <a
                                    href={module.pdf_url || module.video_url}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-xs font-bold text-purple-600 hover:text-purple-700 flex items-center gap-1"
                                >
                                    {module.resource_type === 'meet' ? <>Link da Reunião <Mic size={10} /></> : module.pdf_url ? <>Abrir PDF <FileText size={10} /></> : <>Assistir <Play size={10} /></>}
                                </a>
                            </div>
                        </div>
                    </div>
                ))}
            </div>

            {/* Empty State */}
            {!loading && modules.length === 0 && (
                <div className="text-center py-20 bg-brand-surface-2 dark:bg-brand-surface/50 rounded-3xl border-2 border-dashed border-brand-border dark:border-brand-border">
                    <div className="w-16 h-16 bg-brand-surface-2 dark:bg-brand-surface-2/2 rounded-full flex items-center justify-center mx-auto mb-4">
                        <Video className="text-brand-muted" size={32} />
                    </div>
                    <h3 className="text-lg font-bold text-brand-muted">Nenhum treinamento encontrado</h3>
                    <p className="text-brand-muted text-sm max-w-md mx-auto mt-2">Adicione vídeos e materiais para padronizar o atendimento da sua equipe.</p>
                    <button
                        onClick={() => setIsAdding(true)}
                        className="mt-6 text-purple-600 font-bold text-sm hover:underline"
                    >
                        Criar Primeiro Módulo
                    </button>
                </div>
            )}

            {/* Add Module Modal */}
            {isAdding && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-in fade-in">
                    <div className="bg-brand-surface rounded-3xl p-8 max-w-md w-full shadow-2xl relative">
                        <h3 className="text-xl font-black mb-6 dark:text-white">Novo Treinamento</h3>
                        <form onSubmit={handleAddModule} className="space-y-4">
                            <div>
                                <label className="text-xs font-bold uppercase text-brand-muted">Título</label>
                                <input
                                    className="w-full p-3 bg-brand-surface-2 rounded-xl border-none outline-none font-bold text-brand-text focus:ring-2 focus:ring-purple-500"
                                    value={newModule.title}
                                    onChange={e => setNewModule({ ...newModule, title: e.target.value })}
                                    required
                                    placeholder="Ex: Como realizar a aula experimental"
                                />
                            </div>

                            {/* Resource Type Toggle */}
                            <div>
                                <label className="text-xs font-bold uppercase text-brand-muted mb-2 block">Tipo de Conteúdo</label>
                                <div className={`grid gap-3 ${currentUser?.role !== 'TEACHER' ? 'grid-cols-3' : 'grid-cols-1'}`}>
                                    {currentUser?.role !== 'TEACHER' && (
                                        <button
                                            type="button"
                                            onClick={() => setNewModule({ ...newModule, resource_type: 'video' })}
                                            className={`p-3 rounded-xl border-2 font-bold text-sm flex items-center justify-center gap-2 transition-all ${newModule.resource_type === 'video' ? 'border-purple-600 bg-purple-50 text-purple-700' : 'border-brand-border bg-brand-surface-2 text-brand-muted'}`}
                                        >
                                            <Video size={16} /> Vídeo
                                        </button>
                                    )}
                                    <button
                                        type="button"
                                        onClick={() => setNewModule({ ...newModule, resource_type: 'meet' })}
                                        className={`p-3 rounded-xl border-2 font-bold text-sm flex items-center justify-center gap-2 transition-all ${newModule.resource_type === 'meet' ? 'border-emerald-600 bg-emerald-50 text-emerald-700' : 'border-brand-border bg-brand-surface-2 text-brand-muted'}`}
                                    >
                                        <Mic size={16} /> Ao Vivo
                                    </button>
                                    {currentUser?.role !== 'TEACHER' && (
                                        <button
                                            type="button"
                                            onClick={() => setNewModule({ ...newModule, resource_type: 'pdf' })}
                                            className={`p-3 rounded-xl border-2 font-bold text-sm flex items-center justify-center gap-2 transition-all ${newModule.resource_type === 'pdf' ? 'border-red-600 bg-red-50 text-red-700' : 'border-brand-border bg-brand-surface-2 text-brand-muted'}`}
                                        >
                                            <FileText size={16} /> PDF
                                        </button>
                                    )}
                                </div>
                            </div>

                            {/* Video URL, Meet Link, or PDF Upload */}
                            {newModule.resource_type === 'video' ? (
                                <div>
                                    <label className="text-xs font-bold uppercase text-brand-muted">Video URL (YouTube)</label>
                                    <input
                                        className="w-full p-3 bg-brand-surface-2 rounded-xl border-none outline-none text-sm text-brand-muted focus:ring-2 focus:ring-purple-500"
                                        value={newModule.video_url}
                                        onChange={e => setNewModule({ ...newModule, video_url: e.target.value })}
                                        required
                                        placeholder="https://youtube.com/watch?v=..."
                                    />
                                </div>
                            ) : newModule.resource_type === 'meet' ? (
                                <div>
                                    <label className="text-xs font-bold uppercase text-brand-muted">Link da Reunião (Zoom/Meet)</label>
                                    <input
                                        type="url"
                                        className="w-full p-3 bg-brand-surface-2 rounded-xl border-none outline-none text-sm text-brand-muted focus:ring-2 focus:ring-emerald-500"
                                        value={newModule.video_url}
                                        onChange={e => setNewModule({ ...newModule, video_url: e.target.value })}
                                        required
                                        placeholder="https://meet.google.com/..."
                                    />
                                </div>
                            ) : (
                                <div>
                                    <label className="text-xs font-bold uppercase text-brand-muted">Upload do PDF</label>
                                    <div className="mt-2 border-2 border-dashed border-brand-border rounded-xl p-6 text-center hover:border-purple-400 transition-colors cursor-pointer relative">
                                        <input
                                            type="file"
                                            accept=".pdf"
                                            onChange={e => {
                                                const file = e.target.files?.[0];
                                                if (file) setPdfFile(file);
                                            }}
                                            className="absolute inset-0 opacity-0 cursor-pointer"
                                        />
                                        <Upload size={24} className="mx-auto text-brand-muted mb-2" />
                                        {pdfFile ? (
                                            <p className="text-sm font-bold text-purple-600">{pdfFile.name}</p>
                                        ) : (
                                            <p className="text-xs text-brand-muted">Clique ou arraste o PDF aqui</p>
                                        )}
                                    </div>
                                </div>
                            )}

                            <div>
                                <label className="text-xs font-bold uppercase text-brand-muted">Descrição</label>
                                <textarea
                                    className="w-full p-3 bg-brand-surface-2 rounded-xl border-none outline-none text-sm text-brand-muted focus:ring-2 focus:ring-purple-500 resize-none h-24"
                                    value={newModule.description}
                                    onChange={e => setNewModule({ ...newModule, description: e.target.value })}
                                    placeholder="Resumo do conteúdo..."
                                />
                            </div>
                            <div className="flex justify-between items-center">
                                <label className="text-xs font-bold uppercase text-brand-muted">Categoria</label>
                                <select
                                    className="bg-brand-surface-2 p-2 rounded-lg text-xs font-bold outline-none"
                                    value={newModule.category}
                                    onChange={e => setNewModule({ ...newModule, category: e.target.value })}
                                >
                                    <option value="General">Geral</option>
                                    <option value="Methodology">Metodologia</option>
                                    <option value="Sales">Vendas</option>
                                    <option value="Conduct">Conduta</option>
                                </select>
                            </div>
                            <div className="flex items-center gap-3 bg-brand-surface-2 p-3 rounded-xl cursor-pointer" onClick={() => setNewModule(prev => ({ ...prev, is_mandatory: !prev.is_mandatory }))}>
                                <div className={`w-5 h-5 rounded flex items-center justify-center border transition-colors ${newModule.is_mandatory ? 'bg-purple-600 border-purple-600' : 'border-brand-border'}`}>
                                    {newModule.is_mandatory && <CheckCircle size={14} className="text-white" />}
                                </div>
                                <span className="text-sm font-bold text-brand-text dark:text-slate-200">Conteúdo Obrigatório</span>
                            </div>

                            <div className="flex gap-2 mt-6">
                                <button type="button" onClick={() => { setIsAdding(false); setPdfFile(null); }} className="flex-1 py-3 bg-brand-surface-2 dark:bg-brand-surface-2 text-brand-muted font-bold rounded-xl hover:bg-slate-200 transition-colors">Cancelar</button>
                                <button type="submit" disabled={uploading} className="flex-1 py-3 bg-purple-600 text-white font-bold rounded-xl hover:bg-purple-700 transition-colors shadow-lg shadow-purple-500/20 disabled:opacity-50">
                                    {uploading ? 'Enviando...' : 'Salvar'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* Assign to Teacher Modal */}
            {assignModalModule && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-in fade-in">
                    <div className="bg-brand-surface rounded-3xl p-8 max-w-md w-full shadow-2xl">
                        <h3 className="text-xl font-black mb-2 dark:text-white flex items-center gap-2">
                            <Users className="text-purple-600" size={20} />
                            Atribuir Treinamento
                        </h3>
                        <p className="text-sm text-brand-muted mb-6">Selecione os professores que devem completar este treinamento. Ao concluir, serão remunerados pelo valor da aula.</p>

                        <div className="space-y-2 max-h-60 overflow-y-auto">
                            {teachers.map(t => (
                                <div
                                    key={t.id}
                                    onClick={() => setSelectedTeachers(prev =>
                                        prev.includes(t.id) ? prev.filter(id => id !== t.id) : [...prev, t.id]
                                    )}
                                    className={`flex items-center gap-3 p-3 rounded-xl cursor-pointer transition-all ${selectedTeachers.includes(t.id) ? 'bg-purple-50 dark:bg-purple-900/20 border-2 border-purple-500' : 'bg-brand-surface-2 border-2 border-transparent hover:border-brand-border'}`}
                                >
                                    <div className={`w-5 h-5 rounded flex items-center justify-center border-2 transition-colors ${selectedTeachers.includes(t.id) ? 'bg-purple-600 border-purple-600' : 'border-brand-border'}`}>
                                        {selectedTeachers.includes(t.id) && <CheckCircle size={14} className="text-white" />}
                                    </div>
                                    <span className="text-sm font-bold text-brand-text dark:text-slate-200">{t.name || t.full_name}</span>
                                </div>
                            ))}
                        </div>

                        <div className="bg-amber-50 dark:bg-amber-900/20 p-3 rounded-xl mt-4 flex items-center gap-2 border border-amber-200 dark:border-amber-900/30">
                            <DollarSign size={16} className="text-amber-600" />
                            <span className="text-xs font-bold text-amber-700 dark:text-amber-400">
                                Importante: Os professores só serão remunerados se o treinamento for do tipo <strong>Ao Vivo (Meet)</strong>. Treinamentos em Vídeo ou PDF não geram pagamento em saldo!
                            </span>
                        </div>

                        <div className="flex gap-2 mt-6">
                            <button onClick={() => { setAssignModalModule(null); setSelectedTeachers([]); }} className="flex-1 py-3 bg-brand-surface-2 dark:bg-brand-surface-2 text-brand-muted font-bold rounded-xl hover:bg-slate-200 transition-colors">Cancelar</button>
                            <button
                                onClick={handleAssign}
                                disabled={selectedTeachers.length === 0}
                                className="flex-1 py-3 bg-purple-600 text-white font-bold rounded-xl hover:bg-purple-700 transition-colors shadow-lg shadow-purple-500/20 disabled:opacity-50"
                            >
                                Atribuir ({selectedTeachers.length})
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default TeacherTrainingAdmin;
