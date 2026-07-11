import React, { useState, useEffect } from 'react';
import { Calendar, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// Agendamento público de entrevista do candidato a professor (rota /book-interview).
// O candidato aprovado pela triagem da Rita recebe o link no WhatsApp (funnel-sweeper)
// e escolhe aqui o horário da entrevista com o diretor. A reserva é atômica na edge
// book-interview (índice único por tenant+slot); se dois candidatos disputarem o
// mesmo horário, o segundo recebe a lista atualizada.
// Página fora do app logado (padrão /claim-opportunity) porque a Supabase força
// text/plain em HTML servido por edge no domínio *.supabase.co.
// Mobile-first: o link chega pelo WhatsApp.
// ─────────────────────────────────────────────────────────────────────────────

const API_URL = 'https://dvalxbtngopxopzcbfdm.supabase.co/functions/v1/book-interview';
const BRT_OFFSET_MS = 3 * 3600 * 1000; // Brasil não tem mais horário de verão

const fmtBRT = (iso: string) => {
    const d = new Date(new Date(iso).getTime() - BRT_OFFSET_MS);
    const [ymd, rest] = d.toISOString().split('T');
    const [y, mo, day] = ymd.split('-');
    const dows = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
    return { date: `${day}/${mo}/${y}`, time: rest.slice(0, 5), dow: dows[d.getUTCDay()] };
};

interface BookInterviewProps {
    token: string | null;
}

const BookInterview: React.FC<BookInterviewProps> = ({ token }) => {
    const [loading, setLoading] = useState(true);
    const [notFound, setNotFound] = useState(false);
    const [error, setError] = useState('');
    const [name, setName] = useState('');
    const [booked, setBooked] = useState<string | null>(null);
    const [slots, setSlots] = useState<string[]>([]);
    const [selected, setSelected] = useState<string | null>(null);
    const [sending, setSending] = useState(false);
    const [takenMsg, setTakenMsg] = useState(false);

    const load = async () => {
        if (!token) { setNotFound(true); setLoading(false); return; }
        try {
            const resp = await fetch(`${API_URL}?t=${encodeURIComponent(token)}`);
            if (resp.status === 404) { setNotFound(true); return; }
            const data = await resp.json();
            if (!data.ok) { setNotFound(true); return; }
            setName(data.name || '');
            setBooked(data.booked || null);
            setSlots(data.slots || []);
        } catch {
            setError('Não foi possível carregar os horários. Tente de novo em instantes.');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { load(); }, []);

    const confirmSlot = async (slot: string) => {
        if (sending) return;
        setSending(true);
        setTakenMsg(false);
        try {
            const resp = await fetch(API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ t: token, slot }),
            });
            const data = await resp.json();
            if (data.ok) {
                setBooked(data.booked);
            } else if (data.reason === 'taken') {
                // Outro candidato levou o horário na corrida → lista atualizada
                setSlots(data.slots || []);
                setSelected(null);
                setTakenMsg(true);
            } else {
                setError('Algo deu errado. Tente novamente ou responda a Michelle no WhatsApp.');
            }
        } catch {
            setError('Falha de conexão. Tente novamente.');
        } finally {
            setSending(false);
        }
    };

    // Agrupa slots por dia (BRT) para exibição
    const byDay: Record<string, string[]> = {};
    for (const iso of slots) {
        const f = fmtBRT(iso);
        const label = `${f.dow} — ${f.date}`;
        (byDay[label] ||= []).push(iso);
    }

    const Card: React.FC<{ children: React.ReactNode }> = ({ children }) => (
        <div className="min-h-dvh bg-slate-900 text-slate-200 flex items-center justify-center p-4">
            <div className="bg-slate-800 border border-slate-700 rounded-3xl p-7 w-full max-w-md shadow-2xl">
                {children}
            </div>
        </div>
    );

    if (loading) {
        return <Card><div className="flex items-center gap-3 text-slate-400"><Loader2 className="animate-spin" size={20} /> Carregando horários…</div></Card>;
    }

    if (notFound) {
        return <Card>
            <h1 className="text-lg font-black text-white mb-2">Link inválido 🐺</h1>
            <p className="text-sm text-slate-400">Este link de agendamento não é válido ou expirou. Fale com a Michelle pelo WhatsApp.</p>
        </Card>;
    }

    if (booked) {
        const f = fmtBRT(booked);
        return <Card>
            <div className="flex items-center gap-2 text-emerald-400 mb-3"><CheckCircle2 size={22} /><span className="text-xs font-black uppercase tracking-widest">Entrevista confirmada</span></div>
            <h1 className="text-lg font-black text-white mb-1">Tudo certo{name ? `, ${name}` : ''}! 🎉</h1>
            <div className="text-3xl font-black text-white my-3">{f.date} às {f.time}</div>
            <p className="text-sm text-slate-400">{f.dow}, horário de Brasília — conversa online de ~30 min com o diretor da Wise Wolf, pelo seu WhatsApp.</p>
            <p className="text-sm text-emerald-400 font-bold mt-3">Você recebe a confirmação no WhatsApp e um lembrete no dia. 🐺</p>
            <p className="text-xs text-slate-500 mt-4">Precisa remarcar? É só responder a Michelle no WhatsApp.</p>
        </Card>;
    }

    return <Card>
        <h1 className="text-lg font-black text-white mb-1">Oi{name ? `, ${name}` : ''}! Vamos agendar? 🐺</h1>
        <p className="text-sm text-slate-400">Seu perfil foi aprovado na triagem! Escolha o melhor horário para a entrevista online (~30 min) com o diretor da Wise Wolf. Horários de Brasília:</p>

        {takenMsg && (
            <div className="mt-3 flex items-start gap-2 bg-amber-500/10 border border-amber-500/30 text-amber-400 text-xs font-bold rounded-xl p-3">
                <AlertCircle size={16} className="shrink-0 mt-0.5" /> Esse horário acabou de ser reservado por outra pessoa — escolha outro abaixo.
            </div>
        )}
        {error && (
            <div className="mt-3 flex items-start gap-2 bg-red-500/10 border border-red-500/30 text-red-400 text-xs font-bold rounded-xl p-3">
                <AlertCircle size={16} className="shrink-0 mt-0.5" /> {error}
            </div>
        )}

        {slots.length === 0 && !error && (
            <p className="text-sm text-slate-400 mt-4">Ops, os horários desta semana esgotaram 😅 A Michelle vai te chamar no WhatsApp para combinar um horário especial.</p>
        )}

        {Object.entries(byDay).map(([label, isos]) => (
            <div key={label}>
                <div className="text-[11px] font-black uppercase tracking-widest text-sky-400 mt-5 mb-2 flex items-center gap-1.5">
                    <Calendar size={12} /> {label}
                </div>
                <div className="grid grid-cols-3 gap-2">
                    {isos.map((iso) => (
                        <button
                            key={iso}
                            disabled={sending}
                            onClick={() => setSelected(iso)}
                            className={`py-3 rounded-xl text-sm font-black transition-all active:scale-95 disabled:opacity-50 ${selected === iso ? 'bg-sky-500 text-white ring-2 ring-sky-300' : 'bg-slate-700 text-slate-200 hover:bg-slate-600'}`}
                        >
                            {fmtBRT(iso).time}
                        </button>
                    ))}
                </div>
            </div>
        ))}

        {selected && (
            <button
                disabled={sending}
                onClick={() => confirmSlot(selected)}
                className="mt-6 w-full py-4 bg-emerald-500 hover:bg-emerald-400 text-white rounded-2xl font-black text-sm uppercase tracking-widest transition-all active:scale-95 disabled:opacity-60 flex items-center justify-center gap-2"
            >
                {sending ? <Loader2 className="animate-spin" size={18} /> : <CheckCircle2 size={18} />}
                Confirmar {fmtBRT(selected).date} às {fmtBRT(selected).time}
            </button>
        )}

        <p className="text-xs text-slate-500 mt-5">Nenhum horário serve? Responde a Michelle no WhatsApp que a gente dá um jeito 😉</p>
    </Card>;
};

export default BookInterview;
