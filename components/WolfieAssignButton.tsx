import React, { useState } from 'react';
import { Check, Loader2, Sparkles, X } from 'lucide-react';
import { supabase } from '../lib/supabase';

interface WolfieAssignButtonProps {
    studentId: string;
    studentName: string;
    /** Sugestões vindas do conteúdo da aula, para o professor não digitar do zero. */
    suggestions?: string[];
    classLogId?: string | null;
    compact?: boolean;
}

const DEFAULT_SUGGESTIONS = [
    'Falar sobre o fim de semana',
    'Se apresentar em uma reunião',
    'Pedir informação na rua',
    'Contar uma história do trabalho',
];

/**
 * Prescrição do Wolfie pelo professor, ao fim da aula.
 *
 * A escola deu 274 aulas em julho e só 9 de 52 alunos usaram o Wolfie. O
 * gargalo nunca foi custo nem capacidade — é que ninguém diz ao aluno para
 * praticar. A aula é o único momento em que escola e aluno já estão em
 * contato; sair dela com um tema prescrito é o que fecha essa lacuna.
 */
export const WolfieAssignButton: React.FC<WolfieAssignButtonProps> = ({
    studentId,
    studentName,
    suggestions,
    classLogId = null,
    compact = false,
}) => {
    const [open, setOpen] = useState(false);
    const [topic, setTopic] = useState('');
    const [note, setNote] = useState('');
    const [busy, setBusy] = useState(false);
    const [done, setDone] = useState(false);
    const [error, setError] = useState('');

    const options = suggestions?.length ? suggestions : DEFAULT_SUGGESTIONS;

    const assign = async () => {
        const clean = topic.trim();
        if (!clean) { setError('Escolha ou escreva um tema.'); return; }
        setBusy(true);
        setError('');
        try {
            const { data, error: rpcError } = await supabase.rpc('assign_wolfie_task', {
                p_student_id: studentId,
                p_topic: clean,
                p_note: note.trim() || null,
                p_class_log_id: classLogId,
            });
            if (rpcError) throw rpcError;

            const result = data as Record<string, unknown>;
            if (result?.duplicada) {
                setError(`${studentName} já recebeu uma tarefa hoje.`);
                return;
            }
            if (result?.reason === 'aluno_inativo') {
                setError('Aluno inativo não recebe tarefa automática.');
                return;
            }
            if (!result?.ok || !result?.id) throw new Error('falha');

            // O WhatsApp sai pela instância do próprio professor, como os
            // demais avisos de aula. Se o envio falhar, a tarefa continua
            // valendo — o aluno a vê ao abrir o app.
            const { data: notifyData, error: notifyError } = await supabase.functions.invoke(
                'send-class-notification',
                { body: { action: 'WOLFIE_ASSIGNMENT', assignment_id: result.id } },
            );
            if (notifyError) throw notifyError;
            if (
                notifyData?.delivery !== 'accepted' ||
                typeof notifyData?.provider_message_id !== 'string' ||
                !notifyData.provider_message_id.trim()
            ) {
                throw new Error('delivery_not_confirmed');
            }

            setDone(true);
            setTimeout(() => { setOpen(false); setDone(false); setTopic(''); setNote(''); }, 1800);
        } catch {
            setError('Não foi possível enviar a tarefa. Tente de novo.');
        } finally {
            setBusy(false);
        }
    };

    if (!open) {
        return (
            <button
                type="button"
                onClick={() => setOpen(true)}
                className={`inline-flex items-center gap-1.5 rounded-lg border border-indigo-300 bg-indigo-50 font-bold text-indigo-700 transition-colors hover:bg-indigo-100 ${
                    compact ? 'px-2 py-1 text-[11px]' : 'px-3 py-1.5 text-xs'
                }`}
                title={`Prescrever uma prática no Wolfie para ${studentName}`}
            >
                <Sparkles size={compact ? 11 : 13} /> Tarefa no Wolfie
            </button>
        );
    }

    return (
        <div className="rounded-xl border border-indigo-200 bg-indigo-50/60 p-3">
            <div className="mb-2 flex items-center justify-between">
                <p className="text-xs font-black text-indigo-900">
                    Tarefa para {studentName.split(' ')[0]}
                </p>
                <button type="button" onClick={() => setOpen(false)} aria-label="Fechar">
                    <X size={14} className="text-indigo-400 hover:text-indigo-700" />
                </button>
            </div>

            {done ? (
                <p className="flex items-center gap-1.5 py-2 text-xs font-bold text-emerald-700">
                    <Check size={14} /> Enviado no WhatsApp.
                </p>
            ) : (
                <>
                    <div className="mb-2 flex flex-wrap gap-1.5">
                        {options.map((s) => (
                            <button
                                key={s}
                                type="button"
                                onClick={() => setTopic(s)}
                                className={`rounded-full border px-2 py-1 text-[11px] font-bold transition-colors ${
                                    topic === s
                                        ? 'border-indigo-500 bg-indigo-600 text-white'
                                        : 'border-indigo-200 bg-white text-indigo-700 hover:bg-indigo-100'
                                }`}
                            >
                                {s}
                            </button>
                        ))}
                    </div>
                    <input
                        value={topic}
                        onChange={(e) => setTopic(e.target.value)}
                        placeholder="Ou escreva o tema..."
                        maxLength={120}
                        className="mb-2 w-full rounded-lg border border-indigo-200 px-2.5 py-1.5 text-xs"
                    />
                    <input
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        placeholder="Instrução opcional (ex: use 5 verbos no passado)"
                        maxLength={300}
                        className="mb-2 w-full rounded-lg border border-indigo-200 px-2.5 py-1.5 text-xs"
                    />
                    {error && <p className="mb-2 text-[11px] font-bold text-amber-700">{error}</p>}
                    <button
                        type="button"
                        onClick={() => void assign()}
                        disabled={busy}
                        className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-xs font-black text-white hover:bg-indigo-700 disabled:opacity-60"
                    >
                        {busy ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                        {busy ? 'Enviando...' : 'Enviar no WhatsApp'}
                    </button>
                </>
            )}
        </div>
    );
};

export default WolfieAssignButton;
