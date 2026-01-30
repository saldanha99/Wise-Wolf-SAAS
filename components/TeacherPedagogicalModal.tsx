import React, { useState, useEffect } from 'react';
import { X, Book, Check, Lock, Unlock, Search, Send, Trash2 } from 'lucide-react';
import { supabase } from '../lib/supabase';

interface TeacherPedagogicalModalProps {
    student: any;
    onClose: () => void;
}

const TeacherPedagogicalModal: React.FC<TeacherPedagogicalModalProps> = ({ student, onClose }) => {
    const [activeTab, setActiveTab] = useState<'materials' | 'evaluation'>('materials');
    const [materials, setMaterials] = useState<any[]>([]);
    const [assignments, setAssignments] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState('');
    const [evaluationUnlocked, setEvaluationUnlocked] = useState<string[]>(student.unlocked_tests || []);

    useEffect(() => {
        fetchData();
    }, [student.id]);

    const fetchData = async () => {
        setLoading(true);
        try {
            // 0. Get Current User info for Security filtering
            const { data: { user } } = await supabase.auth.getUser();
            if (!user) return;

            const { data: profile } = await supabase
                .from('profiles')
                .select('tenant_id')
                .eq('id', user.id)
                .single();

            const myTenantId = profile?.tenant_id;

            // 1. Fetch Materials
            // RLS should handle this, but we filter client-side too for double safety
            const { data: materialsData, error } = await supabase
                .from('pedagogical_materials')
                .select('*')
                .order('created_at', { ascending: false });

            if (materialsData) {
                // STRICT FILTERING: Only show my tenant's materials or truly Global ones.
                const filtered = materialsData.filter(m =>
                    m.scope === 'GLOBAL' ||
                    String(m.tenant_id) === String(myTenantId) ||
                    (m.scope === 'PRIVATE' && m.uploaded_by === user.id)
                );
                setMaterials(filtered);
            }

            // 2. Fetch Assignments for this student
            const { data: assignmentsData } = await supabase
                .from('student_assignments')
                .select('*')
                .eq('student_id', student.id);

            if (assignmentsData) {
                setAssignments(assignmentsData);
            }

            // 3. Fetch Evaluation Status (Granular)
            const { data: studentProfile } = await supabase
                .from('profiles')
                .select('unlocked_tests')
                .eq('id', student.id)
                .single();

            // Ensure array
            if (studentProfile?.unlocked_tests) {
                setEvaluationUnlocked(Array.isArray(studentProfile.unlocked_tests) ? studentProfile.unlocked_tests : []);
            } else {
                setEvaluationUnlocked([]); // Default empty
            }

        } catch (err) {
            console.error(err);
        } finally {
            setLoading(false);
        }
    };

    const handleAssign = async (materialId: string) => {
        try {
            const assignerId = (await supabase.auth.getUser()).data.user?.id;
            // alert(`Debug: Tentando atribuir...\nAluno: ${student.id}\nMaterial: ${materialId}\nProfessor: ${assignerId}`);

            const { data, error } = await supabase.from('student_assignments').insert({
                student_id: student.id,
                material_id: materialId,
                assigned_by: assignerId
            }).select();

            if (error) {
                console.error('Assign Error:', error);
                throw new Error(error.message + ` (${error.code})`);
            }

            alert('Material atribuído com sucesso!');
            fetchData(); // Refresh
        } catch (err: any) {
            console.error('Catch Error:', err);
            alert('Erro CRÍTICO ao atribuir: ' + err.message);
        }
    };

    const handleUnassign = async (materialId: string) => {
        if (!confirm('Deseja remover este material do aluno?')) return;
        try {
            const { error } = await supabase
                .from('student_assignments')
                .delete()
                .eq('student_id', student.id)
                .eq('material_id', materialId);

            if (error) throw error;
            // alert('Material removido com sucesso!'); // Optional: keep it silent/fast
            fetchData();
        } catch (err: any) {
            alert('Erro ao desatribuir: ' + err.message);
        }
    };

    const handleToggleEvaluation = async (moduleTag: string) => {
        try {
            const currentList = Array.isArray(evaluationUnlocked) ? evaluationUnlocked : [];
            let newList: string[];

            if (currentList.includes(moduleTag)) {
                // Remove (Force lock)
                newList = currentList.filter(m => m !== moduleTag);
            } else {
                // Add (Unlock)
                newList = [...currentList, moduleTag];
            }

            const { error } = await supabase
                .from('profiles')
                .update({ unlocked_tests: newList })
                .eq('id', student.id);

            if (error) throw error;
            setEvaluationUnlocked(newList);
            // Silent success update mostly, or small toast
        } catch (err: any) {
            alert('Erro ao alterar status: ' + err.message);
        }
    };

    const filteredMaterials = materials.filter(m =>
        m.title.toLowerCase().includes(searchTerm.toLowerCase())
    );

    return (
        <div className="fixed inset-0 z-[150] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-300">
            <div className="w-full max-w-2xl bg-white dark:bg-slate-900 rounded-[2rem] shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">

                {/* Header */}
                <div className="p-6 border-b border-slate-100 dark:border-slate-800 flex justify-between items-center bg-slate-50 dark:bg-slate-800/50">
                    <div>
                        <h2 className="text-xl font-black text-slate-800 dark:text-white">Gestão Pedagógica</h2>
                        <p className="text-sm text-slate-500 dark:text-slate-400 font-medium">Aluno: <span className="text-indigo-500">{student.name}</span></p>
                    </div>
                    <button onClick={onClose} className="p-2 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-full transition-colors">
                        <X size={20} className="text-slate-500" />
                    </button>
                </div>

                {/* Tabs */}
                <div className="flex p-2 bg-slate-100 dark:bg-slate-950 mx-6 mt-6 rounded-xl shrink-0">
                    <button
                        onClick={() => setActiveTab('materials')}
                        className={`flex-1 py-3 rounded-lg text-xs font-black uppercase tracking-widest transition-all ${activeTab === 'materials' ? 'bg-white dark:bg-slate-800 shadow-sm text-indigo-600 dark:text-white' : 'text-slate-400'}`}
                    >
                        Atribuir Materiais
                    </button>
                    <button
                        onClick={() => setActiveTab('evaluation')}
                        className={`flex-1 py-3 rounded-lg text-xs font-black uppercase tracking-widest transition-all ${activeTab === 'evaluation' ? 'bg-white dark:bg-slate-800 shadow-sm text-indigo-600 dark:text-white' : 'text-slate-400'}`}
                    >
                        Avaliações
                    </button>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-6 custom-scrollbar">

                    {activeTab === 'materials' && (
                        <div className="space-y-6">
                            {/* Search */}
                            <div className="relative">
                                <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
                                <input
                                    value={searchTerm}
                                    onChange={e => setSearchTerm(e.target.value)}
                                    placeholder="Buscar material na biblioteca..."
                                    className="w-full pl-10 pr-4 py-3 bg-slate-50 dark:bg-slate-800 rounded-xl text-sm font-bold outline-none focus:ring-2 focus:ring-indigo-500 transition-all"
                                />
                            </div>

                            {/* Materials List */}
                            <div className="space-y-3">
                                <h3 className="text-[10px] font-black uppercase text-slate-400 tracking-widest">Biblioteca Disponível</h3>
                                {loading && <p className="text-xs text-slate-400">Carregando materiais...</p>}
                                {!loading && filteredMaterials.length === 0 && (
                                    <div className="p-4 rounded-xl bg-orange-50 text-orange-600 text-xs font-bold text-center border border-orange-100">
                                        Nenhum material encontrado. <br />
                                        Se você enviou algo e não aparece aqui, pode ser um problema de permissão (RLS).
                                    </div>
                                )}
                                {!loading && filteredMaterials.map(m => {
                                    const isAssigned = assignments.some(a => a.material_id === m.id);
                                    return (
                                        <div key={m.id} className="flex justify-between items-center p-4 rounded-xl border border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors group">
                                            <div className="flex items-center gap-3">
                                                <div className={`p-2 rounded-lg ${m.type === 'PDF' ? 'bg-red-100 text-red-600' : 'bg-blue-100 text-blue-600'}`}>
                                                    <Book size={16} />
                                                </div>
                                                <div>
                                                    <p className="font-bold text-sm text-slate-700 dark:text-slate-200">{m.title}</p>
                                                    <p className="text-[10px] text-slate-400 uppercase font-bold">{m.level_tag} • {m.category || 'Geral'}</p>
                                                </div>
                                            </div>

                                            {isAssigned ? (
                                                <div className="flex items-center gap-2">
                                                    <span className="flex items-center gap-1 text-[10px] font-black uppercase text-green-500 bg-green-100 px-3 py-1.5 rounded-full">
                                                        <Check size={12} /> Enviado
                                                    </span>
                                                    <button
                                                        onClick={() => handleUnassign(m.id)}
                                                        className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-full transition-colors"
                                                        title="Desatribuir / Remover Material"
                                                    >
                                                        <Trash2 size={14} />
                                                    </button>
                                                </div>
                                            ) : (
                                                <button
                                                    onClick={() => handleAssign(m.id)}
                                                    className="px-4 py-2 bg-slate-900 dark:bg-white text-white dark:text-slate-900 rounded-lg text-[10px] font-black uppercase hover:scale-105 transition-transform flex items-center gap-2"
                                                >
                                                    Atribuir <Send size={12} />
                                                </button>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {activeTab === 'evaluation' && (
                        <div className="p-4 space-y-6">
                            <div className="text-center">
                                <h3 className="text-xl font-black text-slate-800 dark:text-white">Liberar Provas</h3>
                                <p className="text-sm text-slate-500">Selecione quais provas o aluno pode realizar.</p>
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                {['A1', 'A2', 'B1', 'B2', 'C1', 'C2'].map((mod) => {
                                    // Parse unlocked_tests which might be array or null
                                    const isUnlocked = Array.isArray(evaluationUnlocked)
                                        ? evaluationUnlocked.includes(mod)
                                        : false; // Fallback if data is old boolean

                                    return (
                                        <div key={mod} className={`p-4 rounded-xl border-2 transition-all cursor-pointer flex items-center justify-between ${isUnlocked
                                            ? 'border-green-500 bg-green-50 dark:bg-green-900/20'
                                            : 'border-slate-100 dark:border-slate-800 grayscale opacity-60 hover:opacity-100 hover:border-indigo-200'
                                            }`}
                                            onClick={() => handleToggleEvaluation(mod)}
                                        >
                                            <div className="flex items-center gap-3">
                                                <div className={`w-10 h-10 rounded-lg flex items-center justify-center font-black text-sm ${isUnlocked ? 'bg-green-500 text-white' : 'bg-slate-200 text-slate-500'}`}>
                                                    {mod}
                                                </div>
                                                <div>
                                                    <p className="font-bold text-sm text-slate-800 dark:text-white">Prova {mod}</p>
                                                    <p className="text-[10px] uppercase font-bold text-slate-400">{isUnlocked ? 'Liberada' : 'Bloqueada'}</p>
                                                </div>
                                            </div>
                                            {isUnlocked ? <Unlock size={18} className="text-green-500" /> : <Lock size={18} className="text-slate-400" />}
                                        </div>
                                    );
                                })}
                            </div>

                            <div className="pt-6 border-t border-slate-100 dark:border-slate-800 w-full">
                                <h4 className="text-[10px] uppercase font-black text-slate-400 mb-4">Nota:</h4>
                                <p className="text-xs text-slate-500">
                                    Ao liberar uma prova, ela aparecerá imediatamente no painel do aluno.
                                    O aluno só pode fazer a prova uma vez por liberação.
                                </p>
                            </div>
                        </div>
                    )}

                </div>
            </div>
        </div>
    );
};

export default TeacherPedagogicalModal;
