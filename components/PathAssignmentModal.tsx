import React, { useState, useEffect } from 'react';
import { X, Search, Users, Check, Loader2, UserPlus, AlertCircle } from 'lucide-react';
import { supabase } from '../lib/supabase';

interface Props {
    path: { id: string; name: string; target_level: string };
    user: { id: string; tenantId?: string; role: string };
    tenantId?: string;
    onClose: () => void;
}

const PathAssignmentModal: React.FC<Props> = ({ path, user, tenantId, onClose }) => {
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [students, setStudents] = useState<any[]>([]);
    const [alreadyEnrolled, setAlreadyEnrolled] = useState<Set<string>>(new Set());
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [search, setSearch] = useState('');
    const [feedback, setFeedback] = useState<string | null>(null);

    useEffect(() => {
        load();
    }, []);

    const load = async () => {
        setLoading(true);
        try {
            // Alunos do tenant (filtrados pelo professor se for o caso)
            let q = supabase
                .from('profiles')
                .select('id, full_name, email, module, status')
                .eq('role', 'STUDENT')
                .eq('tenant_id', tenantId)
                .order('full_name', { ascending: true });

            // Se for professor (nao admin), filtra apenas alunos dele
            const isTeacher = user.role === 'TEACHER' || user.role === 'teacher';
            if (isTeacher) {
                const { data: bookings } = await supabase
                    .from('bookings')
                    .select('student_id')
                    .eq('teacher_id', user.id)
                    .eq('tenant_id', tenantId);
                const ids = Array.from(new Set((bookings || []).map(b => b.student_id)));
                if (ids.length > 0) q = q.in('id', ids);
                else { setStudents([]); setLoading(false); return; }
            }

            const { data: studs } = await q;
            setStudents(studs || []);

            // Quais ja estao matriculados nesse path
            if (studs && studs.length > 0) {
                const { data: enrolls } = await supabase
                    .from('student_path_enrollments')
                    .select('student_id')
                    .eq('path_id', path.id)
                    .in('student_id', studs.map(s => s.id));
                setAlreadyEnrolled(new Set((enrolls || []).map(e => e.student_id)));
            }
        } catch (err) {
            console.error('PathAssignment load error:', err);
        } finally {
            setLoading(false);
        }
    };

    const toggle = (id: string) => {
        if (alreadyEnrolled.has(id)) return;
        setSelected(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const toggleAll = () => {
        const eligible = filtered.filter(s => !alreadyEnrolled.has(s.id));
        if (selected.size === eligible.length) setSelected(new Set());
        else setSelected(new Set(eligible.map(s => s.id)));
    };

    const submit = async () => {
        if (selected.size === 0) return;
        setSaving(true);
        try {
            const rows = Array.from(selected).map(studentId => ({
                student_id: studentId,
                path_id: path.id,
                tenant_id: tenantId,
                started_at: new Date().toISOString(),
                assigned_by: user.id,
            }));
            const { error } = await supabase
                .from('student_path_enrollments')
                .upsert(rows, { onConflict: 'student_id, path_id', ignoreDuplicates: true });
            if (error) throw error;
            setFeedback(`${selected.size} aluno${selected.size > 1 ? 's matriculados' : ' matriculado'}!`);
            setAlreadyEnrolled(prev => new Set([...prev, ...selected]));
            setSelected(new Set());
            setTimeout(() => setFeedback(null), 3000);
        } catch (err: any) {
            alert('Erro ao atribuir: ' + err.message);
        } finally {
            setSaving(false);
        }
    };

    const filtered = students.filter(s =>
        !search || (s.full_name || '').toLowerCase().includes(search.toLowerCase())
    );
    const eligibleCount = filtered.filter(s => !alreadyEnrolled.has(s.id)).length;

    return (
        <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-sm z-[200] flex items-end sm:items-center justify-center p-0 sm:p-4">
            <div className="bg-white dark:bg-slate-900 rounded-t-3xl sm:rounded-3xl max-w-2xl w-full max-h-[95vh] sm:max-h-[85vh] overflow-hidden shadow-2xl flex flex-col safe-bottom">
                <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between shrink-0">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-violet-100 dark:bg-violet-900/30 rounded-xl flex items-center justify-center">
                            <UserPlus size={18} className="text-violet-600 dark:text-violet-400" />
                        </div>
                        <div>
                            <p className="text-[10px] uppercase tracking-widest text-slate-400 font-bold">Atribuir trilha</p>
                            <h2 className="text-base font-black text-slate-800 dark:text-white">{path.name} <span className="text-xs text-violet-500">· {path.target_level}</span></h2>
                        </div>
                    </div>
                    <button onClick={onClose} className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl">
                        <X size={18} />
                    </button>
                </div>

                {/* Search + Select all */}
                <div className="px-6 py-3 border-b border-slate-100 dark:border-slate-800 flex items-center gap-3 shrink-0">
                    <div className="flex-1 relative">
                        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                        <input
                            type="text"
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            placeholder="Buscar aluno..."
                            className="w-full pl-9 pr-3 py-2 bg-slate-50 dark:bg-slate-800 rounded-xl text-sm border border-slate-200 dark:border-slate-700 focus:outline-none focus:ring-2 focus:ring-violet-500"
                        />
                    </div>
                    {eligibleCount > 0 && (
                        <button
                            onClick={toggleAll}
                            className="text-xs font-bold text-violet-600 hover:text-violet-800"
                        >
                            {selected.size === eligibleCount ? 'Limpar' : `Selecionar ${eligibleCount}`}
                        </button>
                    )}
                </div>

                {/* List */}
                <div className="flex-1 overflow-y-auto px-3 py-2">
                    {loading ? (
                        <div className="flex items-center justify-center py-12"><Loader2 className="animate-spin text-violet-500" size={24} /></div>
                    ) : filtered.length === 0 ? (
                        <div className="text-center py-12 text-slate-400">
                            <Users size={32} className="mx-auto mb-3 opacity-40" />
                            <p className="text-sm font-bold">{search ? 'Nenhum aluno encontrado' : 'Nenhum aluno disponível'}</p>
                        </div>
                    ) : (
                        <div className="space-y-1">
                            {filtered.map(s => {
                                const enrolled = alreadyEnrolled.has(s.id);
                                const isSelected = selected.has(s.id);
                                return (
                                    <button
                                        key={s.id}
                                        onClick={() => toggle(s.id)}
                                        disabled={enrolled}
                                        className={`w-full flex items-center gap-3 p-3 rounded-xl text-left transition-all ${
                                            enrolled
                                                ? 'bg-emerald-50 dark:bg-emerald-900/10 opacity-70 cursor-not-allowed'
                                                : isSelected
                                                    ? 'bg-violet-50 dark:bg-violet-900/20 border-2 border-violet-500'
                                                    : 'hover:bg-slate-50 dark:hover:bg-slate-800/50 border-2 border-transparent'
                                        }`}
                                    >
                                        <div className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 text-sm font-black ${
                                            enrolled ? 'bg-emerald-500 text-white' :
                                            isSelected ? 'bg-violet-500 text-white' :
                                            'bg-slate-200 dark:bg-slate-700 text-slate-500'
                                        }`}>
                                            {enrolled ? <Check size={14} /> : (s.full_name || '?').charAt(0).toUpperCase()}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <p className="text-sm font-black text-slate-800 dark:text-white truncate">{s.full_name}</p>
                                            <p className="text-[10px] text-slate-400 truncate">{s.email} {s.module ? `· ${s.module}` : ''}</p>
                                        </div>
                                        {enrolled && (
                                            <span className="text-[9px] font-bold uppercase tracking-widest text-emerald-600">Já inscrito</span>
                                        )}
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="px-6 py-4 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between shrink-0">
                    {feedback ? (
                        <div className="flex items-center gap-2 text-xs font-bold text-emerald-600">
                            <Check size={14} /> {feedback}
                        </div>
                    ) : (
                        <p className="text-xs text-slate-500">{selected.size} selecionado{selected.size === 1 ? '' : 's'}</p>
                    )}
                    <button
                        onClick={submit}
                        disabled={selected.size === 0 || saving}
                        className="px-4 py-2 bg-violet-600 text-white text-xs font-black uppercase tracking-widest rounded-xl hover:brightness-110 disabled:opacity-50 flex items-center gap-2"
                    >
                        {saving ? <Loader2 size={12} className="animate-spin" /> : <UserPlus size={12} />}
                        Atribuir
                    </button>
                </div>
            </div>
        </div>
    );
};

export default PathAssignmentModal;
