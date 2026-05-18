import React, { useState, useEffect } from 'react';
import { LogOut, CalendarOff, Loader2, AlertCircle, CheckCircle, ChevronDown, Plus } from 'lucide-react';
import { supabase } from '../lib/supabase';

interface Props {
    user: { id: string };
}

/**
 * Painel do PROFESSOR com:
 * - Solicitar saida (offboarding)
 * - Registrar ausencia (doenca/ferias) → admin atribui cobertura
 */
const TeacherWorkflows: React.FC<Props> = ({ user }) => {
    const [profile, setProfile] = useState<any>(null);
    const [absences, setAbsences] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);

    // Offboarding
    const [offReason, setOffReason] = useState('');
    const [offLastDay, setOffLastDay] = useState('');
    const [offSaving, setOffSaving] = useState(false);
    const [offMsg, setOffMsg] = useState<string | null>(null);

    // Ausencia
    const [absStart, setAbsStart] = useState('');
    const [absEnd, setAbsEnd] = useState('');
    const [absReason, setAbsReason] = useState<'SICK' | 'VACATION' | 'PERSONAL' | 'OTHER'>('SICK');
    const [absNotes, setAbsNotes] = useState('');
    const [absSaving, setAbsSaving] = useState(false);

    useEffect(() => { load(); }, []);

    const load = async () => {
        setLoading(true);
        const [pRes, aRes] = await Promise.all([
            supabase.from('profiles').select('offboarding_status, offboarding_requested_at, offboarding_last_day, offboarding_reason').eq('id', user.id).single(),
            supabase.from('teacher_absences').select('*').eq('teacher_id', user.id).order('starts_at', { ascending: false }),
        ]);
        setProfile(pRes.data);
        setAbsences(aRes.data || []);
        setLoading(false);
    };

    const requestOffboarding = async () => {
        if (!offReason || !offLastDay) { alert('Preencha motivo e último dia.'); return; }
        if (!confirm(`Confirma solicitação de saída até ${offLastDay}? O admin irá reatribuir seus alunos.`)) return;
        setOffSaving(true);
        try {
            const { data, error } = await supabase.rpc('request_teacher_offboarding', { p_reason: offReason, p_last_day: offLastDay });
            if (error) throw error;
            setOffMsg(`Solicitação enviada. ${(data as any)?.active_students || 0} aluno(s) precisarão ser reatribuídos pelo admin.`);
            load();
        } catch (err: any) { alert('Erro: ' + err.message); }
        finally { setOffSaving(false); }
    };

    const createAbsence = async () => {
        if (!absStart || !absEnd) { alert('Preencha as datas.'); return; }
        if (absEnd < absStart) { alert('Data final deve ser depois da inicial.'); return; }
        setAbsSaving(true);
        try {
            const { error } = await supabase.rpc('create_absence_with_coverage', {
                p_teacher_id: user.id, p_starts: absStart, p_ends: absEnd, p_reason: absReason, p_notes: absNotes || null
            });
            if (error) throw error;
            setAbsStart(''); setAbsEnd(''); setAbsNotes('');
            load();
        } catch (err: any) { alert('Erro: ' + err.message); }
        finally { setAbsSaving(false); }
    };

    if (loading) return <div className="p-12 flex items-center justify-center"><Loader2 className="animate-spin text-violet-500" size={24} /></div>;

    const offRequested = profile?.offboarding_status === 'REQUESTED';
    const offCompleted = profile?.offboarding_status === 'COMPLETED';

    return (
        <div className="space-y-4">
            {/* OFFBOARDING */}
            <div className="bg-white dark:bg-slate-900 rounded-[2.5rem] border border-slate-100 dark:border-slate-800 overflow-hidden">
                <div className="p-6 border-b border-slate-100 dark:border-slate-800 flex items-center gap-3">
                    <div className="w-10 h-10 bg-rose-100 dark:bg-rose-900/30 rounded-xl flex items-center justify-center">
                        <LogOut size={20} className="text-rose-600 dark:text-rose-400" />
                    </div>
                    <div>
                        <h3 className="font-black text-slate-800 dark:text-white text-sm">Solicitar saída da Wise Wolf</h3>
                        <p className="text-[10px] text-slate-400 uppercase tracking-widest">Offboarding com reatribuição de alunos</p>
                    </div>
                </div>

                <div className="p-6">
                    {offCompleted ? (
                        <div className="bg-emerald-50 dark:bg-emerald-900/20 rounded-xl p-4 flex items-center gap-3">
                            <CheckCircle size={20} className="text-emerald-500" />
                            <p className="text-sm text-emerald-700 dark:text-emerald-300">Sua saída foi finalizada.</p>
                        </div>
                    ) : offRequested ? (
                        <div className="bg-amber-50 dark:bg-amber-900/20 rounded-xl p-4">
                            <div className="flex items-start gap-3">
                                <AlertCircle size={20} className="text-amber-500 shrink-0 mt-0.5" />
                                <div>
                                    <p className="text-sm font-bold text-amber-700 dark:text-amber-300">Solicitação enviada</p>
                                    <p className="text-xs text-slate-600 dark:text-slate-400 mt-1">Último dia: {profile.offboarding_last_day}</p>
                                    <p className="text-xs text-slate-600 dark:text-slate-400">Motivo: {profile.offboarding_reason}</p>
                                    <p className="text-[10px] text-slate-500 mt-2">Aguardando admin reatribuir seus alunos e finalizar.</p>
                                </div>
                            </div>
                        </div>
                    ) : (
                        <div className="space-y-3">
                            <div>
                                <label className="text-[10px] uppercase tracking-widest text-slate-500 font-bold block mb-1">Motivo</label>
                                <textarea value={offReason} onChange={e => setOffReason(e.target.value)} rows={3}
                                    placeholder="Por que está saindo? Esse texto vai pro admin."
                                    className="w-full p-2 bg-slate-50 dark:bg-slate-800 rounded-xl text-sm border border-slate-200 dark:border-slate-700 focus:outline-none focus:ring-2 focus:ring-rose-500" />
                            </div>
                            <div>
                                <label className="text-[10px] uppercase tracking-widest text-slate-500 font-bold block mb-1">Último dia de trabalho</label>
                                <input type="date" value={offLastDay} onChange={e => setOffLastDay(e.target.value)}
                                    min={new Date().toISOString().split('T')[0]}
                                    className="w-full p-2 bg-slate-50 dark:bg-slate-800 rounded-xl text-sm border border-slate-200 dark:border-slate-700 focus:outline-none focus:ring-2 focus:ring-rose-500" />
                            </div>
                            {offMsg && (
                                <div className="bg-blue-50 dark:bg-blue-900/20 rounded-xl p-3 text-xs text-blue-700 dark:text-blue-300">{offMsg}</div>
                            )}
                            <button onClick={requestOffboarding} disabled={offSaving || !offReason || !offLastDay}
                                className="w-full py-3 bg-rose-600 text-white rounded-xl text-xs font-black uppercase tracking-widest hover:brightness-110 disabled:opacity-50 flex items-center justify-center gap-2">
                                {offSaving ? <Loader2 size={12} className="animate-spin" /> : <LogOut size={12} />}
                                Solicitar saída
                            </button>
                        </div>
                    )}
                </div>
            </div>

            {/* AUSENCIA / COBERTURA */}
            <div className="bg-white dark:bg-slate-900 rounded-[2.5rem] border border-slate-100 dark:border-slate-800 overflow-hidden">
                <div className="p-6 border-b border-slate-100 dark:border-slate-800 flex items-center gap-3">
                    <div className="w-10 h-10 bg-amber-100 dark:bg-amber-900/30 rounded-xl flex items-center justify-center">
                        <CalendarOff size={20} className="text-amber-600 dark:text-amber-400" />
                    </div>
                    <div>
                        <h3 className="font-black text-slate-800 dark:text-white text-sm">Registrar ausência</h3>
                        <p className="text-[10px] text-slate-400 uppercase tracking-widest">Doença, férias ou imprevisto</p>
                    </div>
                </div>

                <div className="p-6 space-y-3">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                            <label className="text-[10px] uppercase tracking-widest text-slate-500 font-bold block mb-1">Início</label>
                            <input type="date" value={absStart} onChange={e => setAbsStart(e.target.value)}
                                className="w-full p-2 bg-slate-50 dark:bg-slate-800 rounded-xl text-sm border border-slate-200 dark:border-slate-700 focus:outline-none focus:ring-2 focus:ring-amber-500" />
                        </div>
                        <div>
                            <label className="text-[10px] uppercase tracking-widest text-slate-500 font-bold block mb-1">Fim</label>
                            <input type="date" value={absEnd} onChange={e => setAbsEnd(e.target.value)}
                                className="w-full p-2 bg-slate-50 dark:bg-slate-800 rounded-xl text-sm border border-slate-200 dark:border-slate-700 focus:outline-none focus:ring-2 focus:ring-amber-500" />
                        </div>
                    </div>
                    <div>
                        <label className="text-[10px] uppercase tracking-widest text-slate-500 font-bold block mb-1">Motivo</label>
                        <select value={absReason} onChange={e => setAbsReason(e.target.value as any)}
                            className="w-full p-2 bg-slate-50 dark:bg-slate-800 rounded-xl text-sm border border-slate-200 dark:border-slate-700">
                            <option value="SICK">Doença</option>
                            <option value="VACATION">Férias</option>
                            <option value="PERSONAL">Pessoal</option>
                            <option value="OTHER">Outro</option>
                        </select>
                    </div>
                    <div>
                        <label className="text-[10px] uppercase tracking-widest text-slate-500 font-bold block mb-1">Observações (opcional)</label>
                        <textarea value={absNotes} onChange={e => setAbsNotes(e.target.value)} rows={2}
                            className="w-full p-2 bg-slate-50 dark:bg-slate-800 rounded-xl text-sm border border-slate-200 dark:border-slate-700" />
                    </div>
                    <button onClick={createAbsence} disabled={absSaving}
                        className="w-full py-2.5 bg-amber-600 text-white rounded-xl text-xs font-black uppercase tracking-widest hover:brightness-110 disabled:opacity-50 flex items-center justify-center gap-2">
                        {absSaving ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
                        Registrar ausência
                    </button>
                </div>

                {/* Lista de ausências */}
                {absences.length > 0 && (
                    <div className="px-6 pb-6 space-y-2">
                        <p className="text-[10px] uppercase tracking-widest text-slate-500 font-bold mt-4">Histórico</p>
                        {absences.map(a => (
                            <div key={a.id} className="flex items-center gap-3 p-3 rounded-xl bg-slate-50 dark:bg-slate-800/50">
                                <span className={`w-2 h-2 rounded-full ${a.status === 'ACTIVE' ? 'bg-amber-500' : 'bg-slate-300'}`} />
                                <div className="flex-1 text-xs">
                                    <p className="font-bold text-slate-800 dark:text-white">{a.starts_at} → {a.ends_at}</p>
                                    <p className="text-slate-500 dark:text-slate-400">{a.reason} {a.notes && `· ${a.notes}`}</p>
                                </div>
                                <span className="text-[9px] uppercase tracking-widest text-slate-400 font-bold">{a.status}</span>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};

export default TeacherWorkflows;
