import React, { useState, useEffect } from 'react';
import { LogOut, CalendarOff, Loader2, AlertCircle, UserCheck, X, Check, ChevronRight, Sparkles, Repeat } from 'lucide-react';
import { supabase } from '../lib/supabase';

interface Props {
    user: { id: string; tenantId?: string };
    tenantId?: string;
}

const AdminWorkflowsPanel: React.FC<Props> = ({ user, tenantId }) => {
    const [tab, setTab] = useState<'offboarding' | 'absences' | 'trials'>('offboarding');

    return (
        <div className="space-y-4">
            <div className="flex gap-2 flex-wrap">
                <TabBtn active={tab === 'offboarding'} onClick={() => setTab('offboarding')} icon={LogOut} label="Saídas de professor" />
                <TabBtn active={tab === 'absences'} onClick={() => setTab('absences')} icon={CalendarOff} label="Ausências & Coberturas" />
                <TabBtn active={tab === 'trials'} onClick={() => setTab('trials')} icon={Sparkles} label="Trials pendentes" />
            </div>
            {tab === 'offboarding' && <OffboardingPanel tenantId={tenantId} />}
            {tab === 'absences' && <AbsencesPanel tenantId={tenantId} />}
            {tab === 'trials' && <TrialsPanel tenantId={tenantId} />}
        </div>
    );
};

// ─────────────────────────────────────────────────────────────
// OFFBOARDING — admin reatribui alunos e finaliza saída
// ─────────────────────────────────────────────────────────────
const OffboardingPanel: React.FC<{ tenantId?: string }> = ({ tenantId }) => {
    const [pending, setPending] = useState<any[]>([]);
    const [teachers, setTeachers] = useState<any[]>([]);
    const [studentsByTeacher, setStudentsByTeacher] = useState<Record<string, any[]>>({});
    const [loading, setLoading] = useState(true);

    useEffect(() => { load(); }, [tenantId]);

    const load = async () => {
        setLoading(true);
        const [reqRes, allRes] = await Promise.all([
            supabase.from('profiles')
                .select('id, full_name, email, offboarding_status, offboarding_requested_at, offboarding_last_day, offboarding_reason')
                .eq('tenant_id', tenantId)
                .in('offboarding_status', ['REQUESTED', 'APPROVED', 'REASSIGNING']),
            supabase.from('profiles').select('id, full_name')
                .eq('tenant_id', tenantId).eq('role', 'TEACHER').eq('status', 'Ativo'),
        ]);
        setPending(reqRes.data || []);
        setTeachers(allRes.data || []);

        // Para cada teacher saindo, buscar alunos
        if (reqRes.data) {
            const map: Record<string, any[]> = {};
            for (const t of reqRes.data) {
                const { data: bks } = await supabase.from('bookings')
                    .select('student_id, day_of_week, time_slot, student:student_id(full_name)')
                    .eq('teacher_id', t.id).eq('tenant_id', tenantId);
                // dedupe por student_id
                const seen = new Set();
                map[t.id] = (bks || []).filter(b => {
                    if (seen.has(b.student_id)) return false;
                    seen.add(b.student_id); return true;
                });
            }
            setStudentsByTeacher(map);
        }
        setLoading(false);
    };

    const reassign = async (studentId: string, newTeacherId: string) => {
        try {
            const { error } = await supabase.rpc('reassign_student_teacher', {
                p_student_id: studentId, p_new_teacher_id: newTeacherId
            });
            if (error) throw error;
            load();
        } catch (err: any) { alert('Erro: ' + err.message); }
    };

    const finalize = async (teacherId: string) => {
        if (!confirm('Finalizar a saída deste professor? (todos os alunos precisam estar reatribuídos)')) return;
        try {
            const { data, error } = await supabase.rpc('complete_teacher_offboarding', { p_teacher_id: teacherId });
            if (error) throw error;
            const d = data as any;
            if (d?.status === 'PENDING_REASSIGN') {
                alert(`Ainda há ${d.remaining} bookings deste professor. Reatribua primeiro.`);
            } else {
                alert('Saída finalizada com sucesso.');
                load();
            }
        } catch (err: any) { alert('Erro: ' + err.message); }
    };

    if (loading) return <div className="p-12 flex items-center justify-center"><Loader2 className="animate-spin text-violet-500" size={24} /></div>;
    if (pending.length === 0) return (
        <div className="bg-white dark:bg-slate-900 rounded-[2.5rem] border border-slate-100 dark:border-slate-800 p-12 text-center text-slate-400">
            <UserCheck size={32} className="mx-auto mb-3 opacity-40" />
            <p className="text-sm font-bold">Nenhuma solicitação de saída pendente</p>
        </div>
    );

    return (
        <div className="space-y-4">
            {pending.map(t => {
                const students = studentsByTeacher[t.id] || [];
                const availableTeachers = teachers.filter(x => x.id !== t.id);
                return (
                    <div key={t.id} className="bg-white dark:bg-slate-900 rounded-2xl border border-rose-200 dark:border-rose-800/30 overflow-hidden">
                        <div className="p-4 bg-rose-50 dark:bg-rose-900/10 flex items-center justify-between gap-3">
                            <div>
                                <p className="text-sm font-black text-slate-800 dark:text-white">{t.full_name}</p>
                                <p className="text-xs text-slate-500">{t.email} · último dia: <b>{t.offboarding_last_day}</b></p>
                                <p className="text-xs text-slate-600 dark:text-slate-400 mt-1 italic">"{t.offboarding_reason}"</p>
                            </div>
                            <button onClick={() => finalize(t.id)} disabled={students.length > 0}
                                className="px-3 py-1.5 bg-emerald-600 text-white text-[10px] font-black uppercase tracking-widest rounded-lg hover:brightness-110 disabled:opacity-50">
                                Finalizar saída
                            </button>
                        </div>
                        <div className="p-4 space-y-2">
                            <p className="text-[10px] uppercase tracking-widest text-slate-500 font-bold">{students.length} aluno{students.length === 1 ? '' : 's'} para reatribuir:</p>
                            {students.length === 0 && <p className="text-xs text-emerald-600 font-bold">✓ Todos alunos já foram reatribuídos. Pode finalizar.</p>}
                            {students.map(s => (
                                <div key={s.student_id} className="flex items-center gap-2 p-2 rounded-xl bg-slate-50 dark:bg-slate-800/50">
                                    <div className="flex-1 min-w-0">
                                        <p className="text-xs font-bold text-slate-800 dark:text-white truncate">{(s.student as any)?.full_name || s.student_id}</p>
                                        <p className="text-[10px] text-slate-400">{s.day_of_week} · {s.time_slot}</p>
                                    </div>
                                    <select defaultValue=""
                                        onChange={e => e.target.value && reassign(s.student_id, e.target.value)}
                                        className="text-xs p-1.5 bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-700">
                                        <option value="">→ Mover para...</option>
                                        {availableTeachers.map(t2 => <option key={t2.id} value={t2.id}>{t2.full_name}</option>)}
                                    </select>
                                </div>
                            ))}
                        </div>
                    </div>
                );
            })}
        </div>
    );
};

// ─────────────────────────────────────────────────────────────
// ABSENCES — admin vê ausências ativas e cria coberturas
// ─────────────────────────────────────────────────────────────
const AbsencesPanel: React.FC<{ tenantId?: string }> = ({ tenantId }) => {
    const [absences, setAbsences] = useState<any[]>([]);
    const [teachers, setTeachers] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [openAbsId, setOpenAbsId] = useState<string | null>(null);
    const [bookings, setBookings] = useState<any[]>([]);

    useEffect(() => { load(); }, [tenantId]);

    const load = async () => {
        setLoading(true);
        const [aRes, tRes] = await Promise.all([
            supabase.from('teacher_absences')
                .select('*, teacher:teacher_id(full_name)')
                .eq('tenant_id', tenantId).eq('status', 'ACTIVE').gte('ends_at', new Date().toISOString().split('T')[0])
                .order('starts_at'),
            supabase.from('profiles').select('id, full_name').eq('tenant_id', tenantId).eq('role', 'TEACHER').eq('status', 'Ativo'),
        ]);
        setAbsences(aRes.data || []);
        setTeachers(tRes.data || []);
        setLoading(false);
    };

    const openAbsence = async (abs: any) => {
        setOpenAbsId(abs.id);
        const { data: bks } = await supabase.from('bookings')
            .select('id, day_of_week, time_slot, student_id, student:student_id(full_name)')
            .eq('teacher_id', abs.teacher_id).eq('tenant_id', tenantId);
        // Cobertura por dia da semana dentro do período
        const result: any[] = [];
        const start = new Date(abs.starts_at);
        const end = new Date(abs.ends_at);
        const days = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
        for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
            const dow = days[d.getDay()];
            (bks || []).filter(b => b.day_of_week === dow).forEach(b => {
                result.push({ ...b, class_date: d.toISOString().split('T')[0] });
            });
        }
        setBookings(result);
    };

    const assignCover = async (booking: any, coverTeacherId: string, absId: string) => {
        try {
            const { error } = await supabase.rpc('assign_class_coverage', {
                p_absence_id: absId, p_booking_id: booking.id, p_class_date: booking.class_date,
                p_cover_teacher_id: coverTeacherId
            });
            if (error) throw error;
            alert('Cobertura atribuída!');
        } catch (err: any) { alert('Erro: ' + err.message); }
    };

    if (loading) return <div className="p-12 flex items-center justify-center"><Loader2 className="animate-spin text-violet-500" size={24} /></div>;
    if (absences.length === 0) return (
        <div className="bg-white dark:bg-slate-900 rounded-[2.5rem] border border-slate-100 dark:border-slate-800 p-12 text-center text-slate-400">
            <CalendarOff size={32} className="mx-auto mb-3 opacity-40" />
            <p className="text-sm font-bold">Nenhuma ausência ativa</p>
        </div>
    );

    return (
        <div className="space-y-3">
            {absences.map(a => (
                <div key={a.id} className="bg-white dark:bg-slate-900 rounded-2xl border border-amber-200 dark:border-amber-800/30 overflow-hidden">
                    <button onClick={() => openAbsId === a.id ? setOpenAbsId(null) : openAbsence(a)}
                        className="w-full p-4 flex items-center gap-3 text-left bg-amber-50 dark:bg-amber-900/10">
                        <div className="flex-1">
                            <p className="text-sm font-black text-slate-800 dark:text-white">{(a.teacher as any)?.full_name}</p>
                            <p className="text-xs text-slate-500">{a.starts_at} → {a.ends_at} · {a.reason} {a.notes && `· ${a.notes}`}</p>
                        </div>
                        <ChevronRight size={16} className={`text-slate-400 transition-transform ${openAbsId === a.id ? 'rotate-90' : ''}`} />
                    </button>
                    {openAbsId === a.id && (
                        <div className="p-4 space-y-2">
                            <p className="text-[10px] uppercase tracking-widest text-slate-500 font-bold">Aulas no período:</p>
                            {bookings.length === 0 && <p className="text-xs text-slate-400">Nenhuma aula recorrente no período.</p>}
                            {bookings.map((b, i) => (
                                <div key={`${b.id}-${i}`} className="flex items-center gap-2 p-2 rounded-xl bg-slate-50 dark:bg-slate-800/50">
                                    <div className="flex-1 min-w-0">
                                        <p className="text-xs font-bold text-slate-800 dark:text-white truncate">{(b.student as any)?.full_name}</p>
                                        <p className="text-[10px] text-slate-400">{b.class_date} · {b.time_slot}</p>
                                    </div>
                                    <select defaultValue=""
                                        onChange={e => e.target.value && assignCover(b, e.target.value, a.id)}
                                        className="text-xs p-1.5 bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-700">
                                        <option value="">→ Cobertura...</option>
                                        {teachers.filter(t => t.id !== a.teacher_id).map(t => <option key={t.id} value={t.id}>{t.full_name}</option>)}
                                    </select>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            ))}
        </div>
    );
};

// ─────────────────────────────────────────────────────────────
// TRIALS — marcar como ganho/perdido
// ─────────────────────────────────────────────────────────────
const TrialsPanel: React.FC<{ tenantId?: string }> = ({ tenantId }) => {
    const [opps, setOpps] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => { load(); }, [tenantId]);

    const load = async () => {
        setLoading(true);
        const { data } = await supabase.from('opportunities')
            .select('*, teacher:winner_teacher_id(full_name)')
            .eq('tenant_id', tenantId)
            .in('trial_status', ['scheduled', 'completed'])
            .not('conversion_status', 'in', '(converted,lost)')
            .order('created_at', { ascending: false }).limit(50);
        setOpps(data || []);
        setLoading(false);
    };

    const markLost = async (id: string) => {
        const reason = prompt('Motivo da perda?');
        if (!reason) return;
        await supabase.rpc('mark_opportunity_lost', { p_opp_id: id, p_reason: reason });
        load();
    };
    const markApproved = async (id: string) => {
        await supabase.rpc('mark_opportunity_approved', { p_opp_id: id });
        load();
    };

    if (loading) return <div className="p-12 flex items-center justify-center"><Loader2 className="animate-spin text-violet-500" size={24} /></div>;
    if (opps.length === 0) return (
        <div className="bg-white dark:bg-slate-900 rounded-[2.5rem] border border-slate-100 dark:border-slate-800 p-12 text-center text-slate-400">
            <Sparkles size={32} className="mx-auto mb-3 opacity-40" />
            <p className="text-sm font-bold">Nenhum trial pendente de decisão</p>
        </div>
    );

    return (
        <div className="space-y-2">
            <p className="text-xs text-slate-500 px-2">Aluno trial fica na agenda do professor enquanto aqui pendente. Marque como aprovado (mantém na agenda) ou perdido (some).</p>
            {opps.map(o => (
                <div key={o.id} className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-700 p-3 flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                        <p className="text-sm font-black text-slate-800 dark:text-white truncate">{o.student_name}</p>
                        <p className="text-[10px] text-slate-400">{o.student_phone} · prof {(o.teacher as any)?.full_name || '—'}</p>
                        <p className="text-[10px] text-slate-400">Status: <b>{o.trial_status}</b> · {o.conversion_status || 'not_contacted'}</p>
                    </div>
                    <button onClick={() => markApproved(o.id)} className="p-2 bg-emerald-600 text-white rounded-lg hover:brightness-110" title="Aprovar (mantém na agenda)">
                        <Check size={14} />
                    </button>
                    <button onClick={() => markLost(o.id)} className="p-2 bg-rose-600 text-white rounded-lg hover:brightness-110" title="Marcar perdido (tira da agenda)">
                        <X size={14} />
                    </button>
                </div>
            ))}
        </div>
    );
};

const TabBtn: React.FC<{ active: boolean; onClick: () => void; icon: any; label: string }> = ({ active, onClick, icon: Icon, label }) => (
    <button onClick={onClick} className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-black uppercase tracking-widest transition-all ${active ? 'bg-violet-600 text-white' : 'bg-white dark:bg-slate-900 text-slate-500 border border-slate-200 dark:border-slate-700'}`}>
        <Icon size={12} /> {label}
    </button>
);

export default AdminWorkflowsPanel;
