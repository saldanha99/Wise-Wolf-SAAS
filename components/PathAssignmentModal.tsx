import React, { useState, useEffect, useRef } from 'react';
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
    const [completedPathStudents, setCompletedPathStudents] = useState<Set<string>>(new Set());
    const [activePathByStudent, setActivePathByStudent] = useState<Record<string, string>>({});
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [search, setSearch] = useState('');
    const [feedback, setFeedback] = useState<string | null>(null);
    const [loadError, setLoadError] = useState('');
    const [submitError, setSubmitError] = useState('');
    const [switchReason, setSwitchReason] = useState('');
    const dialogRef = useRef<HTMLDivElement>(null);
    const savingRef = useRef(false);

    useEffect(() => {
        load();
    }, []);

    useEffect(() => {
        savingRef.current = saving;
    }, [saving]);

    useEffect(() => {
        const previousFocus = document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        const frame = window.requestAnimationFrame(() => dialogRef.current?.focus());

        const onKeyDown = (event: KeyboardEvent) => {
            const dialog = dialogRef.current;
            if (!dialog) return;
            if (event.key === 'Escape') {
                event.preventDefault();
                if (!savingRef.current) onClose();
                return;
            }
            if (event.key !== 'Tab') return;
            const focusable = Array.from(dialog.querySelectorAll(
                'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
            )) as HTMLElement[];
            if (focusable.length === 0) {
                event.preventDefault();
                dialog.focus();
                return;
            }
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
                event.preventDefault();
                first.focus();
            }
        };

        document.addEventListener('keydown', onKeyDown);
        return () => {
            window.cancelAnimationFrame(frame);
            document.removeEventListener('keydown', onKeyDown);
            document.body.style.overflow = previousOverflow;
            previousFocus?.focus();
        };
    }, [onClose]);

    const load = async () => {
        setLoading(true);
        setLoadError('');
        try {
            // Alunos do tenant (filtrados pelo professor se for o caso)
            let q = supabase
                .from('profiles')
                .select('id, full_name, email, module, status, lifecycle_status, offboarding_status')
                .eq('role', 'STUDENT')
                .eq('tenant_id', tenantId)
                .order('full_name', { ascending: true });

            // Se for professor (nao admin), filtra apenas alunos dele
            const isTeacher = user.role === 'TEACHER' || user.role === 'teacher';
            if (isTeacher) {
                const { data: bookings, error: bookingsError } = await supabase
                    .from('bookings')
                    .select('student_id')
                    .eq('teacher_id', user.id)
                    .eq('tenant_id', tenantId)
                    .in('status', ['SCHEDULED', 'scheduled']);
                if (bookingsError) throw bookingsError;
                const ids = Array.from(new Set((bookings || []).map(b => b.student_id)));
                if (ids.length > 0) q = q.in('id', ids);
                else { setStudents([]); setLoading(false); return; }
            }

            const { data: studs, error: studentsError } = await q;
            if (studentsError) throw studentsError;
            const assignableStudents = (studs || []).filter((student: any) => {
                const lifecycle = String(student.lifecycle_status || 'active').trim().toLowerCase();
                const legacyStatus = String(student.status || 'Ativo').trim().toLowerCase();
                const offboarding = String(student.offboarding_status || '').trim().toUpperCase();
                return !['suspended', 'offboarded'].includes(lifecycle)
                    && !['inativo', 'inactive', 'arquivado', 'cancelado', 'trancado'].includes(legacyStatus)
                    && !['REQUESTED', 'PROCESSING', 'COMPLETED'].includes(offboarding);
            });
            setStudents(assignableStudents);

            // Toda atribuição passa pelo RPC autoritativo. A leitura abaixo
            // serve apenas para antecipar, com clareza, quando haverá troca da
            // trilha ativa e exigir um motivo auditável.
            if (assignableStudents.length > 0) {
                const { data: enrolls, error: enrollmentsError } = await supabase
                    .from('student_path_enrollments')
                    .select('student_id, path_id, status, completed_at')
                    .in('student_id', assignableStudents.map((student: any) => student.id))
                    .in('status', ['ACTIVE', 'COMPLETED'])
                    .order('started_at', { ascending: false });
                if (enrollmentsError) throw enrollmentsError;
                const activeEnrollments = (enrolls || []).filter((enrollment: any) => (
                    enrollment.status === 'ACTIVE' && !enrollment.completed_at
                ));
                const activePaths = Object.fromEntries(activeEnrollments.map((enrollment: any) => [
                    enrollment.student_id, enrollment.path_id,
                ]));
                setActivePathByStudent(activePaths);
                setAlreadyEnrolled(new Set(
                    activeEnrollments
                        .filter((enrollment: any) => enrollment.path_id === path.id)
                        .map((enrollment: any) => enrollment.student_id),
                ));
                setCompletedPathStudents(new Set(
                    (enrolls || [])
                        .filter((enrollment: any) => (
                            enrollment.path_id === path.id
                            && enrollment.status === 'COMPLETED'
                            && !!enrollment.completed_at
                        ))
                        .map((enrollment: any) => enrollment.student_id),
                ));
            } else {
                setActivePathByStudent({});
                setAlreadyEnrolled(new Set());
                setCompletedPathStudents(new Set());
            }
        } catch (err) {
            console.error('PathAssignment load error:', err);
            setStudents([]);
            setLoadError('Não foi possível carregar os alunos e suas trilhas ativas. Tente novamente.');
        } finally {
            setLoading(false);
        }
    };

    const toggle = (id: string) => {
        if (saving || alreadyEnrolled.has(id) || completedPathStudents.has(id)) return;
        setSelected(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const toggleAll = () => {
        if (saving) return;
        const eligible = filtered.filter(s => (
            !alreadyEnrolled.has(s.id) && !completedPathStudents.has(s.id)
        ));
        if (eligible.length > 0 && eligible.every(student => selected.has(student.id))) setSelected(new Set());
        else setSelected(new Set(eligible.map(s => s.id)));
    };

    const submit = async () => {
        if (selected.size === 0) return;
        const selectedIds = Array.from(selected);
        const switchingIds = selectedIds.filter(studentId => (
            !!activePathByStudent[studentId] && activePathByStudent[studentId] !== path.id
        ));
        if (switchingIds.length > 0 && switchReason.trim().length < 5) {
            setSubmitError('Explique brevemente o motivo da troca de trilha para preservar o histórico pedagógico.');
            return;
        }
        setSaving(true);
        setSubmitError('');
        setFeedback(null);
        try {
            const results = await Promise.all(selectedIds.map(async studentId => {
                const switchesCurrent = switchingIds.includes(studentId);
                const { error } = await supabase.rpc('enroll_student_learning_path', {
                    p_path_id: path.id,
                    p_switch_current: switchesCurrent,
                    p_reason: switchesCurrent ? switchReason.trim() : null,
                    p_student_id: studentId,
                });
                return { studentId, error };
            }));
            const succeeded = results.filter(result => !result.error).map(result => result.studentId);
            const failed = results.filter(result => !!result.error);

            if (succeeded.length > 0) {
                setFeedback(`${succeeded.length} aluno${succeeded.length > 1 ? 's receberam' : ' recebeu'} a trilha.`);
                setAlreadyEnrolled(previous => new Set([...previous, ...succeeded]));
                setActivePathByStudent(previous => ({
                    ...previous,
                    ...Object.fromEntries(succeeded.map(studentId => [studentId, path.id])),
                }));
                setSelected(new Set(failed.map(result => result.studentId)));
            }
            if (failed.length > 0) {
                console.error('Secure path assignment failed:', failed.map(result => ({
                    studentId: result.studentId,
                    message: result.error?.message,
                })));
                setSubmitError(`${failed.length} atribuição${failed.length > 1 ? 'ões não foram concluídas' : ' não foi concluída'}. Revise os vínculos e tente novamente.`);
            } else {
                setSelected(new Set());
                setSwitchReason('');
            }
            setTimeout(() => setFeedback(null), 3000);
        } catch (err: any) {
            console.error('Secure path assignment failed:', err);
            setSubmitError('Não foi possível atribuir a trilha agora. Nenhuma alteração incerta será repetida automaticamente.');
        } finally {
            setSaving(false);
        }
    };

    const filtered = students.filter(s =>
        !search || (s.full_name || '').toLowerCase().includes(search.toLowerCase())
    );
    const eligibleCount = filtered.filter(s => (
        !alreadyEnrolled.has(s.id) && !completedPathStudents.has(s.id)
    )).length;
    const selectedSwitchCount = Array.from(selected).filter(studentId => (
        !!activePathByStudent[studentId] && activePathByStudent[studentId] !== path.id
    )).length;

    return (
        <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-sm z-[200] flex items-end sm:items-center justify-center p-0 sm:p-4">
            <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="path-assignment-title" tabIndex={-1} className="bg-white dark:bg-slate-900 rounded-t-3xl sm:rounded-3xl max-w-2xl w-full max-h-[95vh] sm:max-h-[85vh] overflow-hidden shadow-2xl flex flex-col safe-bottom outline-none">
                <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between shrink-0">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-violet-100 dark:bg-violet-900/30 rounded-xl flex items-center justify-center">
                            <UserPlus size={18} className="text-violet-600 dark:text-violet-400" />
                        </div>
                        <div>
                            <p className="text-[10px] uppercase tracking-widest text-slate-400 font-bold">Atribuir trilha</p>
                            <h2 id="path-assignment-title" className="text-base font-black text-slate-800 dark:text-white">{path.name} <span className="text-xs text-violet-500">· {path.target_level}</span></h2>
                        </div>
                    </div>
                    <button type="button" onClick={onClose} disabled={saving} aria-label="Fechar atribuição de trilha" className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl disabled:cursor-not-allowed disabled:opacity-40">
                        <X size={18} aria-hidden="true" />
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
                            disabled={saving}
                            placeholder="Buscar aluno..."
                            aria-label="Buscar aluno para atribuir trilha"
                            className="w-full pl-9 pr-3 py-2 bg-slate-50 dark:bg-slate-800 rounded-xl text-sm border border-slate-200 dark:border-slate-700 focus:outline-none focus:ring-2 focus:ring-violet-500"
                        />
                    </div>
                    {eligibleCount > 0 && (
                        <button
                            type="button"
                            onClick={toggleAll}
                            disabled={saving}
                            className="text-xs font-bold text-violet-600 hover:text-violet-800 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                            {selected.size === eligibleCount ? 'Limpar' : `Selecionar ${eligibleCount}`}
                        </button>
                    )}
                </div>

                {selectedSwitchCount > 0 && (
                    <div className="border-b border-amber-200 bg-amber-50 px-6 py-4 text-amber-950 dark:border-amber-900/50 dark:bg-amber-950/25 dark:text-amber-100">
                        <div className="flex items-start gap-3">
                            <AlertCircle size={17} className="mt-0.5 shrink-0" aria-hidden="true" />
                            <div className="min-w-0 flex-1">
                                <p className="text-xs font-black">
                                    {selectedSwitchCount} aluno{selectedSwitchCount > 1 ? 's trocarão' : ' trocará'} de trilha ativa
                                </p>
                                <label htmlFor="path-switch-reason" className="mt-1 block text-[10px] font-bold uppercase tracking-wider text-amber-800 dark:text-amber-200">
                                    Motivo pedagógico da troca
                                </label>
                                <textarea
                                    id="path-switch-reason"
                                    value={switchReason}
                                    onChange={event => setSwitchReason(event.target.value.slice(0, 500))}
                                    disabled={saving}
                                    placeholder="Ex.: adequação ao objetivo atual do aluno"
                                    rows={2}
                                    className="mt-2 w-full resize-none rounded-xl border border-amber-200 bg-white px-3 py-2 text-xs text-slate-800 outline-none focus:ring-2 focus:ring-amber-400 dark:border-amber-900/60 dark:bg-slate-900 dark:text-white"
                                />
                                <p className="mt-1 text-right text-[9px] font-bold text-amber-700 dark:text-amber-300">{switchReason.length}/500</p>
                            </div>
                        </div>
                    </div>
                )}

                {/* List */}
                <div className="flex-1 overflow-y-auto px-3 py-2">
                    {loading ? (
                        <div className="flex items-center justify-center py-12"><Loader2 className="animate-spin text-violet-500" size={24} /></div>
                    ) : loadError ? (
                        <div className="mx-3 my-6 rounded-2xl border border-amber-200 bg-amber-50 p-5 text-center text-amber-950 dark:border-amber-900/50 dark:bg-amber-950/25 dark:text-amber-100" role="alert">
                            <AlertCircle size={24} className="mx-auto mb-3" aria-hidden="true" />
                            <p className="text-sm font-black">{loadError}</p>
                            <button type="button" onClick={() => void load()} className="mt-4 rounded-xl bg-amber-600 px-4 py-2 text-[10px] font-black uppercase tracking-widest text-white hover:bg-amber-700">
                                Tentar novamente
                            </button>
                        </div>
                    ) : filtered.length === 0 ? (
                        <div className="text-center py-12 text-slate-400">
                            <Users size={32} className="mx-auto mb-3 opacity-40" />
                            <p className="text-sm font-bold">{search ? 'Nenhum aluno encontrado' : 'Nenhum aluno disponível'}</p>
                        </div>
                    ) : (
                        <div className="space-y-1">
                            {filtered.map(s => {
                                const enrolled = alreadyEnrolled.has(s.id);
                                const completed = completedPathStudents.has(s.id);
                                const isSelected = selected.has(s.id);
                                const willSwitch = !!activePathByStudent[s.id] && activePathByStudent[s.id] !== path.id;
                                return (
                                    <button
                                        type="button"
                                        key={s.id}
                                        onClick={() => toggle(s.id)}
                                        disabled={saving || enrolled || completed}
                                        aria-pressed={isSelected}
                                        className={`w-full flex items-center gap-3 p-3 rounded-xl text-left transition-all ${
                                            enrolled || completed
                                                ? 'bg-emerald-50 dark:bg-emerald-900/10 opacity-70 cursor-not-allowed'
                                                : isSelected
                                                    ? 'bg-violet-50 dark:bg-violet-900/20 border-2 border-violet-500'
                                                    : 'hover:bg-slate-50 dark:hover:bg-slate-800/50 border-2 border-transparent'
                                        }`}
                                    >
                                        <div className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 text-sm font-black ${
                                            enrolled || completed ? 'bg-emerald-500 text-white' :
                                            isSelected ? 'bg-violet-500 text-white' :
                                            'bg-slate-200 dark:bg-slate-700 text-slate-500'
                                        }`}>
                                            {enrolled || completed ? <Check size={14} /> : (s.full_name || '?').charAt(0).toUpperCase()}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <p className="text-sm font-black text-slate-800 dark:text-white truncate">{s.full_name}</p>
                                            <p className="text-[10px] text-slate-400 truncate">{s.email} {s.module ? `· ${s.module}` : ''}</p>
                                        </div>
                                        {enrolled && (
                                            <span className="text-[9px] font-bold uppercase tracking-widest text-emerald-600">Já inscrito</span>
                                        )}
                                        {completed && (
                                            <span className="text-[9px] font-bold uppercase tracking-widest text-emerald-600">Trilha concluída</span>
                                        )}
                                        {!enrolled && willSwitch && (
                                            <span className="text-[9px] font-bold uppercase tracking-widest text-amber-600">Trocar trilha</span>
                                        )}
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="shrink-0 border-t border-slate-100 px-6 py-4 dark:border-slate-800">
                    {(feedback || submitError) && (
                        <div className={`mb-3 flex items-start gap-2 rounded-xl px-3 py-2 text-xs font-bold ${submitError ? 'bg-rose-50 text-rose-700 dark:bg-rose-950/30 dark:text-rose-200' : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-200'}`} role={submitError ? 'alert' : 'status'}>
                            {submitError ? <AlertCircle size={14} className="mt-0.5 shrink-0" /> : <Check size={14} className="mt-0.5 shrink-0" />}
                            <span>{submitError || feedback}</span>
                        </div>
                    )}
                    <div className="flex items-center justify-between gap-3">
                        <p className="text-xs text-slate-500">{selected.size} selecionado{selected.size === 1 ? '' : 's'}</p>
                        <button
                            type="button"
                            onClick={() => void submit()}
                            disabled={selected.size === 0 || saving || !!loadError || (selectedSwitchCount > 0 && switchReason.trim().length < 5)}
                            className="flex min-h-11 items-center gap-2 rounded-xl bg-violet-600 px-4 py-2 text-xs font-black uppercase tracking-widest text-white hover:brightness-110 disabled:opacity-50"
                        >
                            {saving ? <Loader2 size={12} className="animate-spin" /> : <UserPlus size={12} />}
                            {saving ? 'Atribuindo...' : 'Atribuir'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default PathAssignmentModal;
