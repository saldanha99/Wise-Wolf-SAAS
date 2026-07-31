import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Check, ExternalLink, Loader2, X } from 'lucide-react';
import { supabase } from '../lib/supabase';

interface PendingLink {
    student_id: string;
    student_name: string;
    meeting_link: string | null;
    tem_aula: boolean;
    verificado: boolean;
}

/**
 * Mutirão de verificação de salas.
 *
 * O cadastro antigo gerava códigos aleatórios do Meet, e hoje há uma mistura
 * de links reais e inventados. Nenhum programa consegue separá-los: código
 * real do Meet tem o mesmo formato do que era gerado, a auditoria nunca
 * registrou `meeting_link` e não existe `updated_at` em profiles.
 *
 * Só quem abre o link descobre. Esta tela transforma esse trabalho manual em
 * uma fila curta: abrir, responder abriu/não abriu, seguir. Quem não abriu tem
 * o link apagado — deixá-lo ali só faria outra pessoa clicar de novo.
 */
export const MeetingLinkVerifier: React.FC = () => {
    const [rows, setRows] = useState<PendingLink[]>([]);
    const [loading, setLoading] = useState(true);
    const [busyId, setBusyId] = useState('');
    const [error, setError] = useState('');

    const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const { data, error: rpcError } = await supabase.rpc('meeting_links_to_verify');
            if (rpcError) throw rpcError;
            setRows((data as PendingLink[]) ?? []);
        } catch (err) {
            setError(
                (err as { message?: string })?.message?.includes('sem_permissao')
                    ? 'Apenas professor, coordenador ou diretor pode verificar salas.'
                    : 'Não foi possível carregar a lista.',
            );
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { void load(); }, [load]);

    const answer = async (studentId: string, works: boolean) => {
        setBusyId(studentId);
        try {
            const { error: rpcError } = await supabase.rpc('verify_meeting_link', {
                p_student_id: studentId,
                p_works: works,
            });
            if (rpcError) throw rpcError;
            // Sai da fila na hora: a lista precisa encurtar visivelmente, senão
            // ninguém termina um mutirão de dezenas de itens.
            setRows((prev) => prev.filter((r) => r.student_id !== studentId));
        } catch {
            setError('Não foi possível registrar. Tente de novo.');
        } finally {
            setBusyId('');
        }
    };

    if (loading) {
        return (
            <div className="flex items-center gap-2 p-6 text-sm text-brand-muted">
                <Loader2 size={15} className="animate-spin" /> Carregando salas...
            </div>
        );
    }

    const comAula = rows.filter((r) => r.tem_aula).length;

    return (
        <div className="space-y-4">
            <div>
                <h2 className="text-xl font-black tracking-tight text-brand-text">
                    Verificar salas de aula
                </h2>
                <p className="mt-1 text-sm text-brand-muted">
                    Abra o link e diga se a sala existe. O cadastro antigo criava
                    códigos inventados, e só abrindo dá para saber quais são reais.
                </p>
            </div>

            {error && (
                <div className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
                    <AlertTriangle size={15} className="mt-0.5 shrink-0" /> {error}
                </div>
            )}

            {rows.length === 0 ? (
                <div className="rounded-xl border border-dashed border-brand-border p-8 text-center">
                    <Check size={22} className="mx-auto mb-2 text-emerald-500" />
                    <p className="text-sm font-bold text-brand-text">Todas as salas verificadas.</p>
                </div>
            ) : (
                <>
                    <p className="text-xs font-bold text-brand-muted">
                        {rows.length} a verificar
                        {comAula > 0 && <> · <span className="text-amber-600">{comAula} com aula marcada</span></>}
                    </p>

                    <ul className="space-y-2">
                        {rows.map((row) => (
                            <li
                                key={row.student_id}
                                className="flex flex-wrap items-center gap-3 rounded-xl border border-brand-border bg-brand-surface p-3"
                            >
                                <div className="min-w-0 flex-1">
                                    <p className="truncate text-sm font-bold text-brand-text">
                                        {row.student_name}
                                        {row.tem_aula && (
                                            <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-black uppercase text-amber-700">
                                                tem aula
                                            </span>
                                        )}
                                    </p>
                                    <p className="truncate font-mono text-[11px] text-brand-muted">
                                        {row.meeting_link ?? 'sem link cadastrado'}
                                    </p>
                                </div>

                                {row.meeting_link ? (
                                    <>
                                        <a
                                            href={row.meeting_link}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="inline-flex items-center gap-1.5 rounded-lg border border-brand-border px-3 py-1.5 text-xs font-bold text-brand-text hover:bg-brand-surface-2"
                                        >
                                            <ExternalLink size={13} /> Abrir
                                        </a>
                                        <div className="flex gap-1.5">
                                            <button
                                                type="button"
                                                disabled={busyId === row.student_id}
                                                onClick={() => void answer(row.student_id, true)}
                                                className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-black text-white hover:bg-emerald-700 disabled:opacity-60"
                                            >
                                                <Check size={13} /> Abriu
                                            </button>
                                            <button
                                                type="button"
                                                disabled={busyId === row.student_id}
                                                onClick={() => void answer(row.student_id, false)}
                                                className="inline-flex items-center gap-1 rounded-lg border border-red-300 bg-red-50 px-3 py-1.5 text-xs font-black text-red-700 hover:bg-red-100 disabled:opacity-60"
                                                title="O link será apagado — melhor vazio que morto"
                                            >
                                                <X size={13} /> Não abriu
                                            </button>
                                        </div>
                                    </>
                                ) : (
                                    <span className="rounded-lg bg-brand-surface-2 px-3 py-1.5 text-[11px] font-bold text-brand-muted">
                                        Cadastre a sala em Links de Reunião
                                    </span>
                                )}
                            </li>
                        ))}
                    </ul>
                </>
            )}
        </div>
    );
};

export default MeetingLinkVerifier;
