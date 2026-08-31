import React, { useState, useEffect, useRef } from 'react';
import { X, Book, Check, Lock, Unlock, Search, Send, Trash2, Loader2, ShieldCheck, AlertCircle } from 'lucide-react';
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
    const [currentBookPart, setCurrentBookPart] = useState(student.currentBookPart || 'A1-1');
    const [evaluationUnlocked, setEvaluationUnlocked] = useState(student.evaluationUnlocked === true);
    const [evaluationSaving, setEvaluationSaving] = useState(false);
    const [evaluationError, setEvaluationError] = useState('');
    const dialogRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        fetchData();
    }, [student.id]);

    useEffect(() => {
        const previousOverflow = document.body.style.overflow;
        const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        document.body.style.overflow = 'hidden';
        dialogRef.current?.querySelector<HTMLElement>('button')?.focus();
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                onClose();
                return;
            }
            if (event.key !== 'Tab' || !dialogRef.current) return;
            const focusable = Array.from(dialogRef.current.querySelectorAll('button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')) as HTMLElement[];
            if (focusable.length === 0) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        };
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.body.style.overflow = previousOverflow;
            document.removeEventListener('keydown', onKeyDown);
            previousFocus?.focus();
        };
    }, [onClose]);

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
                // Só materiais APROVADOS podem ser atribuídos (pendentes/reprovados ficam de fora).
                const filtered = materialsData.filter(m =>
                    ((m.approval_status || 'APPROVED') === 'APPROVED') && (
                      m.scope === 'GLOBAL' ||
                      String(m.tenant_id) === String(myTenantId) ||
                      (m.scope === 'PRIVATE' && m.uploaded_by === user.id)
                    )
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

            // 3. Fonte canônica da avaliação progressiva.
            const { data: studentProfile } = await supabase
                .from('profiles')
                .select('current_book_part,evaluation_unlocked')
                .eq('id', student.id)
                .single();

            if (studentProfile) {
                setCurrentBookPart(studentProfile.current_book_part || 'A1-1');
                setEvaluationUnlocked(studentProfile.evaluation_unlocked === true);
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

    const handleToggleEvaluation = async () => {
        if (evaluationSaving || currentBookPart === 'COMPLETED') return;
        setEvaluationSaving(true);
        setEvaluationError('');
        try {
            const nextUnlocked = !evaluationUnlocked;
            const { error } = await supabase.rpc('set_student_pedagogical_evaluation_access', {
                p_student_id: student.id,
                p_expected_book_part: currentBookPart,
                p_unlocked: nextUnlocked,
            });

            if (error) throw error;
            setEvaluationUnlocked(nextUnlocked);
        } catch (err: any) {
            console.error('Secure evaluation release failed:', err);
            setEvaluationError(
                String(err?.message || '').toLowerCase().includes('stale_pedagogical_book_part')
                    ? 'O aluno avançou de etapa. Atualize os dados antes de liberar novamente.'
                    : 'Não foi possível alterar a liberação. Confira seu vínculo com o aluno e tente novamente.',
            );
        } finally {
            setEvaluationSaving(false);
        }
    };

    const filteredMaterials = materials.filter(m =>
        m.title.toLowerCase().includes(searchTerm.toLowerCase())
    );

    return (
        <div className="fixed inset-0 z-[150] flex items-end justify-center bg-black/60 p-0 backdrop-blur-sm animate-in fade-in duration-300 sm:items-center sm:p-4" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
            <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="pedagogical-management-title" className="flex max-h-[96dvh] w-full max-w-2xl flex-col overflow-hidden rounded-t-[2rem] bg-brand-surface shadow-2xl sm:max-h-[90vh] sm:rounded-[2rem]">

                {/* Header */}
                <div className="p-6 border-b border-brand-border flex justify-between items-center bg-brand-surface-2/50">
                    <div>
                        <h2 id="pedagogical-management-title" className="text-xl font-black text-brand-text">Gestão Pedagógica</h2>
                        <p className="text-sm text-brand-muted font-medium">Aluno: <span className="text-indigo-500">{student.name}</span></p>
                    </div>
                    <button type="button" aria-label="Fechar gestão pedagógica" onClick={onClose} className="p-2 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-full transition-colors">
                        <X size={20} className="text-brand-muted" />
                    </button>
                </div>

                {/* Tabs */}
                <div className="flex p-2 bg-brand-surface-2 dark:bg-slate-950 mx-6 mt-6 rounded-xl shrink-0">
                    <button
                        onClick={() => setActiveTab('materials')}
                        className={`flex-1 py-3 rounded-lg text-xs font-black uppercase tracking-widest transition-all ${activeTab === 'materials' ? 'bg-brand-surface dark:bg-brand-surface-2 shadow-sm text-indigo-600 dark:text-white' : 'text-brand-muted'}`}
                    >
                        Atribuir Materiais
                    </button>
                    <button
                        onClick={() => setActiveTab('evaluation')}
                        className={`flex-1 py-3 rounded-lg text-xs font-black uppercase tracking-widest transition-all ${activeTab === 'evaluation' ? 'bg-brand-surface dark:bg-brand-surface-2 shadow-sm text-indigo-600 dark:text-white' : 'text-brand-muted'}`}
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
                                <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-brand-muted" />
                                <input
                                    value={searchTerm}
                                    onChange={e => setSearchTerm(e.target.value)}
                                    placeholder="Buscar material na biblioteca..."
                                    className="w-full pl-10 pr-4 py-3 bg-brand-surface-2 rounded-xl text-sm font-bold outline-none focus:ring-2 focus:ring-indigo-500 transition-all"
                                />
                            </div>

                            {/* Materials List */}
                            <div className="space-y-3">
                                <h3 className="text-[10px] font-black uppercase text-brand-muted tracking-widest">Biblioteca Disponível</h3>
                                {loading && <p className="text-xs text-brand-muted">Carregando materiais...</p>}
                                {!loading && filteredMaterials.length === 0 && (
                                    <div className="p-4 rounded-xl bg-orange-50 text-orange-600 text-xs font-bold text-center border border-orange-100">
                                        Nenhum material encontrado. <br />
                                        Se você enviou algo e não aparece aqui, pode ser um problema de permissão (RLS).
                                    </div>
                                )}
                                {!loading && filteredMaterials.map(m => {
                                    const isAssigned = assignments.some(a => a.material_id === m.id);
                                    return (
                                        <div key={m.id} className="flex justify-between items-center p-4 rounded-xl border border-brand-border hover:bg-brand-surface-2 dark:hover:bg-brand-surface-2/50 transition-colors group">
                                            <div className="flex items-center gap-3">
                                                <div className={`p-2 rounded-lg ${m.type === 'PDF' ? 'bg-red-100 text-red-600' : 'bg-blue-100 text-blue-600'}`}>
                                                    <Book size={16} />
                                                </div>
                                                <div>
                                                    <p className="font-bold text-sm text-brand-text dark:text-slate-200">{m.title}</p>
                                                    <p className="text-[10px] text-brand-muted uppercase font-bold">{m.level_tag} • {m.category || 'Geral'}</p>
                                                </div>
                                            </div>

                                            {isAssigned ? (
                                                <div className="flex items-center gap-2">
                                                    <span className="flex items-center gap-1 text-[10px] font-black uppercase text-green-500 bg-green-100 px-3 py-1.5 rounded-full">
                                                        <Check size={12} /> Enviado
                                                    </span>
                                                    <button
                                                        onClick={() => handleUnassign(m.id)}
                                                        className="p-1.5 text-brand-muted hover:text-red-500 hover:bg-red-50 rounded-full transition-colors"
                                                        title="Desatribuir / Remover Material"
                                                    >
                                                        <Trash2 size={14} />
                                                    </button>
                                                </div>
                                            ) : (
                                                <button
                                                    onClick={() => handleAssign(m.id)}
                                                    className="px-4 py-2 bg-tenant-primary text-white rounded-lg text-[10px] font-black uppercase hover:scale-105 transition-transform flex items-center gap-2"
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
                                <h3 className="text-xl font-black text-brand-text">Próxima avaliação</h3>
                                <p className="text-sm text-brand-muted">Libere somente o marco atual. A aprovação define a próxima etapa automaticamente.</p>
                            </div>

                            <div className={`rounded-2xl border-2 p-5 ${evaluationUnlocked ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-900/20' : 'border-brand-border bg-brand-surface-2/50'}`}>
                                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                                    <div className="flex items-center gap-4">
                                        <div className={`flex h-12 w-12 items-center justify-center rounded-xl text-sm font-black ${evaluationUnlocked ? 'bg-emerald-500 text-white' : 'bg-brand-surface text-brand-muted'}`}>
                                            {currentBookPart === 'COMPLETED' ? <ShieldCheck size={22} /> : currentBookPart}
                                        </div>
                                        <div>
                                            <p className="font-black text-brand-text">
                                                {currentBookPart === 'COMPLETED' ? 'Jornada publicada concluída' : `Avaliação ${currentBookPart}`}
                                            </p>
                                            <p className="mt-1 text-xs font-bold text-brand-muted">
                                                {currentBookPart === 'COMPLETED'
                                                    ? 'Não há uma nova avaliação publicada para este aluno.'
                                                    : evaluationUnlocked
                                                        ? 'Disponível agora no portal do aluno.'
                                                        : 'Aguardando sua liberação pedagógica.'}
                                            </p>
                                        </div>
                                    </div>
                                    {currentBookPart !== 'COMPLETED' && (
                                        <button
                                            type="button"
                                            onClick={() => void handleToggleEvaluation()}
                                            disabled={evaluationSaving}
                                            className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-xs font-black uppercase tracking-wider text-white disabled:opacity-50 ${evaluationUnlocked ? 'bg-slate-700 hover:bg-slate-800' : 'bg-emerald-600 hover:bg-emerald-700'}`}
                                        >
                                            {evaluationSaving
                                                ? <Loader2 size={15} className="animate-spin" />
                                                : evaluationUnlocked
                                                    ? <Lock size={15} />
                                                    : <Unlock size={15} />}
                                            {evaluationSaving ? 'Salvando...' : evaluationUnlocked ? 'Recolher acesso' : 'Liberar avaliação'}
                                        </button>
                                    )}
                                </div>
                            </div>

                            {evaluationError && (
                                <div role="alert" className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm font-bold text-amber-900 dark:border-amber-800/40 dark:bg-amber-900/20 dark:text-amber-100">
                                    <AlertCircle size={17} className="mt-0.5 shrink-0" /> {evaluationError}
                                </div>
                            )}

                            <div className="pt-6 border-t border-brand-border w-full">
                                <h4 className="text-[10px] uppercase font-black text-brand-muted mb-4">Como funciona</h4>
                                <p className="text-xs text-brand-muted">
                                    O aluno pode tentar novamente se não atingir 70%. Ao ser aprovado, a tentativa, o XP e a progressão são registrados juntos e o acesso é recolhido automaticamente.
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
