import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Bot, Loader2, Mic, RefreshCw } from 'lucide-react';
import { supabase } from '../lib/supabase';

interface CostRow {
    feature: string;
    model: string;
    chamadas: number;
    input_tokens: number;
    output_tokens: number;
    cached_tokens: number;
    custo_usd: number | null;
    tem_preco: boolean;
}

interface LiveRow {
    student_name: string;
    turns: number;
    input_audio_tokens: number;
    output_audio_tokens: number;
    total_tokens: number;
}

const FEATURE_LABELS: Record<string, string> = {
    wolfie_brain: 'Wolfie — conversa (texto)',
    wolfie_activity: 'Wolfie — atividades',
    wolfie_activity_eval: 'Wolfie — correção',
    pedagogical_content: 'Geração de material',
    lesson_planner: 'Planner de aula',
};

const monthOptions = (): string[] => {
    // Sem lista fixa: o diretor precisa olhar meses anteriores para comparar.
    const now = new Date();
    return Array.from({ length: 6 }, (_, index) => {
        const d = new Date(now.getFullYear(), now.getMonth() - index, 1);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    });
};

const usd = (value: number | null) =>
    `US$ ${(value ?? 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const compact = (value: number) =>
    value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value ?? 0);

/**
 * Custo de IA por funcionalidade e por aluno.
 *
 * Existia só como RPC — para saber quanto a IA custou era preciso abrir o
 * banco. Sem isto na tela, ninguém percebe um gasto subindo até a fatura
 * chegar, que é exatamente como se perde dinheiro em produto com IA.
 */
export type AlunoCusto = {
    mes: string;
    usd_brl: number;
    aviso: string;
    total_brl: number;
    minutos_totais: number;
    custo_por_minuto_brl: number | null;
    sem_aluno_brl: number;
    alunos: {
        student_id: string; aluno: string; sessoes: number; minutos: number;
        voz_brl: number; texto_brl: number; total_brl: number;
        mensalidade: number; pct_da_mensalidade: number | null;
    }[];
    sem_preco: { model: string; chamadas: number; tokens: number }[];
};

const AiCostPanel: React.FC = () => {
    const months = useMemo(monthOptions, []);
    const [month, setMonth] = useState(months[0]);
    const [rows, setRows] = useState<CostRow[]>([]);
    const [live, setLive] = useState<LiveRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    // Custo em REAIS por aluno — era o que faltava: o resto do painel dá token
    // e dólar por feature, e não respondia "quanto o aluno X me custou".
    const [porAluno, setPorAluno] = useState<AlunoCusto | null>(null);

    const load = useCallback(async (selected: string) => {
        setLoading(true);
        setError('');
        try {
            const [cost, voice, aluno] = await Promise.all([
                supabase.rpc('ai_cost_report', { p_month: selected }),
                supabase.rpc('wolfie_realtime_usage_report', { p_month: selected }),
                supabase.rpc('ai_cost_por_aluno', { p_month: selected }),
            ]);
            if (cost.error) throw cost.error;
            setRows((cost.data as CostRow[]) ?? []);
            // A voz é opcional: se falhar, o custo de escrita ainda é útil.
            setLive(voice.error ? [] : ((voice.data as LiveRow[]) ?? []));
            setPorAluno(aluno.error || (aluno.data as any)?.error ? null : (aluno.data as AlunoCusto));
        } catch (err) {
            setError(
                (err as { message?: string })?.message?.includes('sem_permissao')
                    ? 'Apenas diretor ou coordenador pode ver o custo de IA.'
                    : 'Não foi possível carregar o custo de IA.',
            );
            setRows([]);
            setLive([]);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { void load(month); }, [load, month]);

    const totalUsd = rows.reduce((sum, r) => sum + (r.custo_usd ?? 0), 0);
    const semPreco = rows.filter((r) => !r.tem_preco);

    const brl = (v: number | null | undefined) =>
        `R$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    return (
        <div className="space-y-5">
            {porAluno && (
                <div className="bg-brand-surface border border-brand-border rounded-2xl p-5">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                        <h3 className="text-sm font-bold text-brand-text">Custo por aluno</h3>
                        <span className="text-xs text-brand-muted">
                            {brl(porAluno.total_brl)} no mês · {porAluno.minutos_totais} min ·
                            {' '}{brl(porAluno.custo_por_minuto_brl)}/min · dólar a {porAluno.usd_brl}
                        </span>
                    </div>
                    <p className="text-[11px] text-brand-muted mb-3">{porAluno.aviso}</p>

                    {porAluno.alunos.length === 0 ? (
                        <p className="text-sm text-brand-muted py-3">Nenhum aluno usou IA neste mês.</p>
                    ) : (
                        <div className="space-y-1.5">
                            {porAluno.alunos.map(a => (
                                <div key={a.student_id} className="flex items-center gap-3 px-3 py-2 rounded-xl bg-brand-surface-2 border border-brand-border">
                                    <div className="min-w-0 flex-1">
                                        <p className="text-sm font-bold text-brand-text truncate">{a.aluno}</p>
                                        <p className="text-[11px] text-brand-muted">
                                            {a.minutos} min · {a.sessoes} {a.sessoes === 1 ? 'sessão' : 'sessões'}
                                            {' · voz '}{brl(a.voz_brl)}{' · texto '}{brl(a.texto_brl)}
                                        </p>
                                    </div>
                                    <div className="text-right shrink-0">
                                        <p className="text-sm font-black text-brand-text">{brl(a.total_brl)}</p>
                                        {a.pct_da_mensalidade !== null && (
                                            <p className="text-[10px] text-brand-muted">{a.pct_da_mensalidade}% da mensalidade</p>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}

                    {porAluno.sem_aluno_brl > 0 && (
                        <p className="text-[11px] text-brand-muted mt-3">
                            + {brl(porAluno.sem_aluno_brl)} de IA da escola (crons, gestão) que não pertence a aluno nenhum.
                        </p>
                    )}
                    {porAluno.sem_preco.length > 0 && (
                        <p className="text-[11px] text-amber-600 mt-2">
                            ⚠️ {porAluno.sem_preco.map(m => m.model).join(', ')} sem preço cadastrado —
                            esse custo existe e <b>não está</b> somado acima.
                        </p>
                    )}
                </div>
            )}
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h2 className="text-xl font-black tracking-tight text-brand-text">Custo de IA</h2>
                    <p className="text-sm text-brand-muted">
                        Quanto cada funcionalidade consumiu no mês.
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <select
                        value={month}
                        onChange={(e) => setMonth(e.target.value)}
                        className="rounded-lg border border-brand-border bg-brand-surface px-3 py-2 text-sm font-bold"
                        aria-label="Mês de referência"
                    >
                        {months.map((m) => <option key={m} value={m}>{m}</option>)}
                    </select>
                    <button
                        type="button"
                        onClick={() => void load(month)}
                        className="rounded-lg border border-brand-border p-2 text-brand-muted hover:text-brand-text"
                        aria-label="Recarregar"
                    >
                        <RefreshCw size={15} />
                    </button>
                </div>
            </div>

            {error && (
                <div className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
                    <AlertTriangle size={15} className="mt-0.5 shrink-0" /> {error}
                </div>
            )}

            {loading ? (
                <div className="flex items-center gap-2 p-6 text-sm text-brand-muted">
                    <Loader2 size={15} className="animate-spin" /> Carregando...
                </div>
            ) : (
                <>
                    <div className="rounded-xl border border-brand-border bg-brand-surface p-5">
                        <p className="text-xs font-bold uppercase tracking-wide text-brand-muted">
                            Total do mês
                        </p>
                        <p className="mt-1 text-3xl font-black text-brand-text">{usd(totalUsd)}</p>
                        {semPreco.length > 0 && (
                            <p className="mt-2 text-xs text-amber-700">
                                {semPreco.length} modelo(s) sem preço cadastrado — os tokens aparecem,
                                mas não entram na soma. Cadastre em <code>ai_model_pricing</code>.
                            </p>
                        )}
                    </div>

                    <section>
                        <h3 className="mb-2 flex items-center gap-2 text-sm font-black text-brand-text">
                            <Bot size={15} /> Por funcionalidade
                        </h3>
                        {rows.length === 0 ? (
                            <p className="rounded-xl border border-dashed border-brand-border p-5 text-sm text-brand-muted">
                                Nenhum consumo registrado neste mês.
                            </p>
                        ) : (
                            <div className="overflow-x-auto rounded-xl border border-brand-border">
                                <table className="w-full min-w-[640px] text-sm">
                                    <thead className="bg-brand-surface-2 text-left text-xs uppercase text-brand-muted">
                                        <tr>
                                            <th className="px-3 py-2">Funcionalidade</th>
                                            <th className="px-3 py-2">Modelo</th>
                                            <th className="px-3 py-2 text-right">Chamadas</th>
                                            <th className="px-3 py-2 text-right">Entrada</th>
                                            <th className="px-3 py-2 text-right">Cache</th>
                                            <th className="px-3 py-2 text-right">Saída</th>
                                            <th className="px-3 py-2 text-right">Custo</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {rows.map((r, i) => (
                                            <tr key={`${r.feature}-${r.model}-${i}`} className="border-t border-brand-border">
                                                <td className="px-3 py-2 font-bold">
                                                    {FEATURE_LABELS[r.feature] ?? r.feature}
                                                </td>
                                                <td className="px-3 py-2 font-mono text-xs text-brand-muted">{r.model}</td>
                                                <td className="px-3 py-2 text-right">{r.chamadas}</td>
                                                <td className="px-3 py-2 text-right">{compact(r.input_tokens)}</td>
                                                <td className="px-3 py-2 text-right text-emerald-600">{compact(r.cached_tokens)}</td>
                                                <td className="px-3 py-2 text-right">{compact(r.output_tokens)}</td>
                                                <td className="px-3 py-2 text-right font-bold">
                                                    {r.tem_preco ? usd(r.custo_usd) : '—'}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </section>

                    <section>
                        <h3 className="mb-2 flex items-center gap-2 text-sm font-black text-brand-text">
                            <Mic size={15} /> Voz ao vivo, por aluno
                        </h3>
                        {live.length === 0 ? (
                            <p className="rounded-xl border border-dashed border-brand-border p-5 text-sm text-brand-muted">
                                Nenhuma conversa ao vivo registrada neste mês.
                            </p>
                        ) : (
                            <div className="overflow-x-auto rounded-xl border border-brand-border">
                                <table className="w-full min-w-[520px] text-sm">
                                    <thead className="bg-brand-surface-2 text-left text-xs uppercase text-brand-muted">
                                        <tr>
                                            <th className="px-3 py-2">Aluno</th>
                                            <th className="px-3 py-2 text-right">Turnos</th>
                                            <th className="px-3 py-2 text-right">Áudio entrada</th>
                                            <th className="px-3 py-2 text-right">Áudio saída</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {live.map((r, i) => (
                                            <tr key={`${r.student_name}-${i}`} className="border-t border-brand-border">
                                                <td className="px-3 py-2 font-bold">{r.student_name}</td>
                                                <td className="px-3 py-2 text-right">{r.turns}</td>
                                                <td className="px-3 py-2 text-right">{compact(r.input_audio_tokens)}</td>
                                                <td className="px-3 py-2 text-right">{compact(r.output_audio_tokens)}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </section>
                </>
            )}
        </div>
    );
};

export default AiCostPanel;
