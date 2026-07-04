import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { GraduationCap, Check, Loader2, CalendarClock } from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// MURAL DE OPORTUNIDADES — realocação de alunos.
// Quando um professor sai, os alunos dele aparecem aqui para os demais
// professores aceitarem (primeiro que aceitar leva; claim é atômico no banco).
// Compatibilidade: os dias do aluno são comparados com a disponibilidade
// cadastrada do professor (teacher_availability). Sem disponibilidade
// cadastrada, tudo aparece com aviso.
// Renderiza null quando não há oportunidades abertas.
// ─────────────────────────────────────────────────────────────────────────────

interface Opp {
    id: string;
    student_name: string;
    schedule: string;
    schedule_days: string[];
    from_teacher_name: string;
    compatible: boolean;
}

const StudentOpportunitiesBoard: React.FC<{ userId: string }> = ({ userId }) => {
    const [opps, setOpps] = useState<Opp[]>([]);
    const [hasAvailability, setHasAvailability] = useState(true);
    const [claiming, setClaiming] = useState<string | null>(null);
    const [msg, setMsg] = useState<string | null>(null);

    const load = async () => {
        try {
            const [{ data: open }, { data: avail }] = await Promise.all([
                supabase.from('student_opportunities')
                    .select('id, student_name, schedule, schedule_days, from_teacher_name, from_teacher_id')
                    .eq('status', 'OPEN')
                    .order('created_at', { ascending: true }),
                supabase.from('teacher_availability').select('day_of_week').eq('teacher_id', userId),
            ]);
            const myDays = new Set((avail || []).map((a: any) => a.day_of_week));
            setHasAvailability((avail || []).length > 0);
            setOpps((open || [])
                .filter((o: any) => o.from_teacher_id !== userId)
                .map((o: any) => ({
                    ...o,
                    compatible: (avail || []).length === 0
                        ? true
                        : (o.schedule_days || []).every((d: string) => myDays.has(d)),
                })));
        } catch (e) { console.warn('opps:', e); }
    };
    useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [userId]);

    const claim = async (opp: Opp) => {
        if (!confirm(`Aceitar o aluno ${opp.student_name} (${opp.schedule})? Os horários entram na sua agenda.`)) return;
        setClaiming(opp.id);
        setMsg(null);
        try {
            const { data, error } = await supabase.rpc('claim_student_opportunity', { p_opp_id: opp.id });
            if (error) throw error;
            if (data?.ok) {
                setMsg(`🎉 ${data.student_name} agora é seu aluno! ${data.bookings_transferidos} horário(s) entraram na sua agenda.`);
                try { (await import('canvas-confetti')).default({ particleCount: 120, spread: 75, origin: { y: 0.6 } }); } catch { /* sem confete, sem drama */ }
            } else {
                setMsg(data?.error || 'Essa oportunidade já foi aceita por outro professor.');
            }
        } catch (e: any) {
            setMsg('Erro ao aceitar: ' + (e.message || 'tente novamente'));
        } finally {
            setClaiming(null);
            load();
        }
    };

    if (!opps.length && !msg) return null;

    return (
        <div className="mb-6 bg-gradient-to-br from-violet-600 to-indigo-700 rounded-3xl p-5 sm:p-6 text-white shadow-xl shadow-violet-500/20">
            <div className="flex items-center gap-2 mb-1">
                <GraduationCap size={20} />
                <h3 className="font-black text-base sm:text-lg">Mural de Oportunidades — novos alunos disponíveis</h3>
            </div>
            <p className="text-white/70 text-xs mb-4">Primeiro professor a aceitar fica com o aluno. Horários compatíveis com sua agenda aparecem destacados.</p>

            {msg && <div className="mb-3 bg-white/15 border border-white/20 rounded-xl px-4 py-3 text-sm font-bold">{msg}</div>}
            {!hasAvailability && opps.length > 0 && (
                <div className="mb-3 bg-amber-400/20 border border-amber-300/40 rounded-xl px-4 py-2 text-xs font-bold flex items-center gap-2">
                    <CalendarClock size={14} /> Cadastre sua disponibilidade na Agenda para vermos o encaixe certinho.
                </div>
            )}

            <div className="space-y-2">
                {opps.map(o => (
                    <div key={o.id} className={`flex items-center gap-3 rounded-2xl px-4 py-3 ${o.compatible ? 'bg-white/15 border border-white/25' : 'bg-white/5 border border-white/10 opacity-80'}`}>
                        <div className="flex-1 min-w-0">
                            <p className="font-black text-sm truncate">{o.student_name}</p>
                            <p className="text-[11px] text-white/75">{o.schedule} · vindo do prof. {o.from_teacher_name}</p>
                            {!o.compatible && <p className="text-[10px] text-amber-200 font-bold mt-0.5">⚠ fora da sua disponibilidade cadastrada — aceite só se conseguir encaixar</p>}
                        </div>
                        <button
                            onClick={() => claim(o)}
                            disabled={claiming === o.id}
                            className="shrink-0 flex items-center gap-1.5 bg-white text-violet-700 px-4 py-2 rounded-xl text-xs font-black uppercase tracking-wide hover:bg-violet-50 transition-colors disabled:opacity-50"
                        >
                            {claiming === o.id ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Aceitar
                        </button>
                    </div>
                ))}
                {!opps.length && <p className="text-white/60 text-sm">Nenhuma oportunidade aberta no momento.</p>}
            </div>
        </div>
    );
};

export default StudentOpportunitiesBoard;
