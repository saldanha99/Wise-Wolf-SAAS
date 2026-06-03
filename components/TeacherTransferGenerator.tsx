import React, { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { APP_BASE_URL } from '../constants';
import { X, ArrowRightLeft, Search, Check, Copy, Loader2, Calendar, MessageCircle } from 'lucide-react';

// Gerador (admin) da TRANSFERÊNCIA de aluno para outro professor.
// Aberto a partir da ficha do aluno. O novo professor aceita pelo link.

interface Props {
    tenantId?: string;
    student: { id: string; full_name: string; professor_id?: string | null; class_frequency?: string | null };
    onClose: () => void;
}

// JS getDay(): 0=Domingo ... 6=Sábado. bookings usam estes nomes (igual sync-student-asaas).
const DAY_PT = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

interface Slot { day_of_week: string; time_slot: string; }

const TeacherTransferGenerator: React.FC<Props> = ({ tenantId, student, onClose }) => {
    const [teachers, setTeachers] = useState<any[]>([]);
    const [toTeacher, setToTeacher] = useState('');
    const [teacherSearch, setTeacherSearch] = useState('');
    const [showTeacherList, setShowTeacherList] = useState(false);

    const [freeSlots, setFreeSlots] = useState<Slot[]>([]);
    const [loadingSlots, setLoadingSlots] = useState(false);
    const [selected, setSelected] = useState<Slot[]>([]);

    const [cutover, setCutover] = useState(() => new Date(Date.now() + 86400000).toISOString().split('T')[0]); // amanhã
    const [reason, setReason] = useState('');

    const [link, setLink] = useState('');
    const [copied, setCopied] = useState(false);
    const [generating, setGenerating] = useState(false);
    const [error, setError] = useState('');

    const freqNum = (() => { const m = String(student.class_frequency || '').match(/\d+/); return m ? parseInt(m[0]) : null; })();

    // Carrega professores do tenant (exclui o professor atual)
    useEffect(() => {
        if (!tenantId) return;
        (async () => {
            const { data } = await supabase
                .from('profiles')
                .select('id, full_name')
                .eq('tenant_id', tenantId)
                .in('role', ['TEACHER', 'teacher'])
                .order('full_name', { ascending: true });
            setTeachers((data || []).filter(t => t.id !== student.professor_id));
        })();
    }, [tenantId, student.professor_id]);

    // Ao escolher o novo professor, calcula horários LIVRES (disponibilidade − bookings)
    useEffect(() => {
        if (!toTeacher) { setFreeSlots([]); setSelected([]); return; }
        let cancelled = false;
        (async () => {
            setLoadingSlots(true);
            setSelected([]);
            const [{ data: avail }, { data: bks }] = await Promise.all([
                supabase.from('teacher_availability').select('day_of_week, start_time, end_time').eq('teacher_id', toTeacher),
                supabase.from('bookings').select('day_of_week, time_slot').eq('teacher_id', toTeacher).not('day_of_week', 'is', null),
            ]);
            if (cancelled) return;
            const booked = new Set((bks || []).map((b: any) => `${b.day_of_week}|${String(b.time_slot).slice(0, 5)}`));
            const out: Slot[] = [];
            for (const a of (avail || [])) {
                const dayName = DAY_PT[Number(a.day_of_week)] || String(a.day_of_week);
                const startH = parseInt(String(a.start_time).slice(0, 2));
                const endH = parseInt(String(a.end_time).slice(0, 2));
                for (let h = startH; h < endH; h++) {
                    const time = `${String(h).padStart(2, '0')}:00`;
                    if (!booked.has(`${dayName}|${time}`)) out.push({ day_of_week: dayName, time_slot: time });
                }
            }
            setFreeSlots(out);
            setLoadingSlots(false);
        })();
        return () => { cancelled = true; };
    }, [toTeacher]);

    const toggleSlot = (s: Slot) => {
        setSelected(prev => {
            const key = `${s.day_of_week}|${s.time_slot}`;
            return prev.some(p => `${p.day_of_week}|${p.time_slot}` === key)
                ? prev.filter(p => `${p.day_of_week}|${p.time_slot}` !== key)
                : [...prev, s];
        });
    };
    const isSel = (s: Slot) => selected.some(p => p.day_of_week === s.day_of_week && p.time_slot === s.time_slot);

    const slotsByDay = useMemo(() => {
        const g: Record<string, Slot[]> = {};
        for (const s of freeSlots) { (g[s.day_of_week] ||= []).push(s); }
        return DAY_PT.filter(d => g[d]).map(d => ({ day: d, slots: g[d].sort((a, b) => a.time_slot.localeCompare(b.time_slot)) }));
    }, [freeSlots]);

    const generate = async () => {
        setError('');
        if (!toTeacher) return setError('Selecione o novo professor.');
        if (selected.length === 0) return setError('Selecione ao menos um horário.');
        if (!cutover) return setError('Defina a data de início.');
        setGenerating(true);
        const { data, error } = await supabase.rpc('create_teacher_transfer', {
            p_student_id: student.id, p_to_teacher: toTeacher, p_slots: selected, p_cutover: cutover, p_reason: reason || null,
        });
        setGenerating(false);
        if (error || !data?.ok) { setError(data?.error || 'Erro ao gerar a transferência.'); return; }
        setLink(`${APP_BASE_URL}/transferencia?token=${data.token}`);
    };

    const copy = () => { navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 2000); };
    const teacherName = teachers.find(t => t.id === toTeacher)?.full_name || '';
    const waLink = `https://wa.me/?text=${encodeURIComponent(`Olá ${teacherName}! Temos uma proposta de transferência de aluno para você. Aceite ou recuse por aqui: ${link}`)}`;

    return (
        <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={onClose}>
            <div className="bg-brand-surface rounded-3xl w-full max-w-lg border border-brand-border shadow-2xl max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
                <div className="px-6 py-5 border-b border-brand-border flex justify-between items-center bg-brand-surface-2/50">
                    <div className="flex items-center gap-2">
                        <ArrowRightLeft size={18} className="text-indigo-600" />
                        <h3 className="font-black text-brand-text text-base">Transferir de professor</h3>
                    </div>
                    <button onClick={onClose} className="p-2 hover:bg-brand-surface-2 rounded-full text-brand-muted"><X size={18} /></button>
                </div>

                <div className="p-6 space-y-5 overflow-y-auto custom-scrollbar">
                    <p className="text-xs text-brand-muted">
                        Aluno: <b className="text-brand-text">{student.full_name}</b>{freqNum ? <> · plano {freqNum}x/semana</> : ''}.
                        O novo professor recebe um link para <b>aceitar</b> os horários. Mensalidade do aluno não muda.
                    </p>

                    {/* Novo professor */}
                    <div className="relative">
                        <label className="text-[10px] font-black uppercase tracking-widest text-brand-muted mb-1 block">Novo professor</label>
                        <div className="relative">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-brand-muted" size={15} />
                            <input
                                value={toTeacher ? teacherName : teacherSearch}
                                onChange={e => { setTeacherSearch(e.target.value); setToTeacher(''); setShowTeacherList(true); }}
                                onFocus={() => { setTeacherSearch(''); setShowTeacherList(true); }}
                                placeholder="Buscar professor..."
                                className="w-full pl-9 pr-4 py-3 bg-brand-surface-2 border border-brand-border rounded-xl text-sm font-bold text-brand-text outline-none focus:ring-2 focus:ring-indigo-500"
                            />
                        </div>
                        {showTeacherList && (
                            <>
                                <div className="fixed inset-0 z-40" onClick={() => setShowTeacherList(false)} />
                                <div className="absolute left-0 right-0 mt-1 bg-brand-surface border border-brand-border rounded-xl shadow-xl max-h-52 overflow-y-auto z-50">
                                    {teachers.filter(t => !teacherSearch || (t.full_name || '').toLowerCase().includes(teacherSearch.toLowerCase())).map(t => (
                                        <button key={t.id} onClick={() => { setToTeacher(t.id); setShowTeacherList(false); }}
                                            className="w-full text-left px-4 py-2.5 hover:bg-brand-surface-2 text-sm font-bold text-brand-text flex items-center justify-between">
                                            {t.full_name}{toTeacher === t.id && <Check size={14} className="text-indigo-500" />}
                                        </button>
                                    ))}
                                    {teachers.length === 0 && <p className="p-4 text-center text-brand-muted text-xs">Nenhum outro professor.</p>}
                                </div>
                            </>
                        )}
                    </div>

                    {/* Horários livres */}
                    {toTeacher && (
                        <div>
                            <label className="text-[10px] font-black uppercase tracking-widest text-brand-muted mb-2 block">
                                Horários livres do professor {freqNum ? <span className="text-indigo-500">(escolha {freqNum})</span> : ''}
                            </label>
                            {loadingSlots ? <p className="text-xs text-brand-muted flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Calculando agenda…</p>
                                : slotsByDay.length === 0 ? <p className="text-xs text-amber-600">Sem horários livres cadastrados para este professor (verifique a disponibilidade dele).</p>
                                    : (
                                        <div className="space-y-2 max-h-52 overflow-y-auto pr-1">
                                            {slotsByDay.map(({ day, slots }) => (
                                                <div key={day}>
                                                    <p className="text-[10px] font-black uppercase text-brand-muted mb-1">{day}</p>
                                                    <div className="flex flex-wrap gap-1.5">
                                                        {slots.map(s => (
                                                            <button key={s.time_slot} onClick={() => toggleSlot(s)}
                                                                className={`px-2.5 py-1.5 rounded-lg text-xs font-bold border transition-all ${isSel(s) ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-brand-surface-2 text-brand-text border-brand-border hover:border-indigo-400'}`}>
                                                                {s.time_slot}
                                                            </button>
                                                        ))}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                            {selected.length > 0 && <p className="text-[11px] text-indigo-600 font-bold mt-2">{selected.length} horário(s) selecionado(s).</p>}
                        </div>
                    )}

                    {/* Data de virada + motivo */}
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className="text-[10px] font-black uppercase tracking-widest text-brand-muted mb-1 flex items-center gap-1"><Calendar size={11} /> Início com o novo prof.</label>
                            <input type="date" value={cutover} min={new Date().toISOString().split('T')[0]} onChange={e => setCutover(e.target.value)}
                                className="w-full px-3 py-2.5 bg-brand-surface-2 border border-brand-border rounded-xl text-sm font-bold text-brand-text outline-none focus:ring-2 focus:ring-indigo-500" />
                        </div>
                        <div>
                            <label className="text-[10px] font-black uppercase tracking-widest text-brand-muted mb-1 block">Motivo (interno)</label>
                            <input value={reason} onChange={e => setReason(e.target.value)} placeholder="Ex.: faltas / insatisfação"
                                className="w-full px-3 py-2.5 bg-brand-surface-2 border border-brand-border rounded-xl text-sm font-bold text-brand-text outline-none focus:ring-2 focus:ring-indigo-500" />
                        </div>
                    </div>

                    {error && <p className="text-xs font-bold text-red-500">{error}</p>}

                    {!link ? (
                        <button onClick={generate} disabled={generating}
                            className="w-full py-3.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-black text-sm uppercase tracking-widest disabled:opacity-50 flex items-center justify-center gap-2">
                            {generating ? <Loader2 size={16} className="animate-spin" /> : <ArrowRightLeft size={16} />}
                            Gerar link de aceite
                        </button>
                    ) : (
                        <div className="space-y-3 animate-in fade-in">
                            <div className="bg-brand-surface-2 border border-brand-border rounded-xl p-3 flex items-center gap-2">
                                <input readOnly value={link} className="flex-1 bg-transparent text-xs font-mono text-emerald-600 outline-none truncate" />
                                <button onClick={copy} className="px-3 py-1.5 rounded-lg bg-brand-surface text-xs font-bold flex items-center gap-1 border border-brand-border">
                                    {copied ? <Check size={13} className="text-emerald-500" /> : <Copy size={13} />}{copied ? 'Copiado' : 'Copiar'}
                                </button>
                            </div>
                            <a href={waLink} target="_blank" rel="noreferrer"
                                className="w-full py-3 bg-emerald-500 hover:bg-emerald-600 text-white rounded-xl font-bold text-sm flex items-center justify-center gap-2">
                                <MessageCircle size={16} /> Enviar ao professor no WhatsApp
                            </a>
                            <p className="text-[11px] text-brand-muted text-center">Quando o professor aceitar, a troca é aplicada em {new Date(cutover + 'T00:00:00').toLocaleDateString('pt-BR')} e o aluno é avisado.</p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default TeacherTransferGenerator;
