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
    wolfie_transcription: 'Wolfie — transcrição da fala',
    wolfie_activity: 'Wolfie — atividades',
    wolfie_activity_eval: 'Wolfie — correção',
    wolfie_activity_speech_assessment: 'Wolfie — avaliação de fala',
    wolfie_activity_listening_tts: 'Wolfie — áudio de listening',
    wolfie_meeting_recall: 'Wolfie — memorização de reunião',
    wolfie_tts: 'Wolfie — voz da resposta (estimado)',
    wolfie_realtime_post_turn: 'Wolfie ao vivo — análise do turno',
    wolfie_realtime_rag: 'Wolfie ao vivo — busca de contexto',
    pedagogical_content: 'Geração de material',
    lesson_planner: 'Planner de aula',
};

/**
 * A que mundo cada consumo pertence. O aluno do tier gratuito fala e escreve; a
 * VOZ do Wolfie (resposta falada e conversa ao vivo) é o que se vende. Sem esta
 * separação o diretor via um total só e não sabia o que era custo de assinatura
 * e o que era custo da prática incluída na mensalidade.
 *
 * `wolfie_activity_listening_tts` é áudio de EXERCÍCIO, não resposta do tutor:
 * continua no gratuito de propósito.
 */
const PREMIUM_FEATURES = new Set([
    'wolfie_tts',
    'wolfie_realtime_post_turn',
    'wolfie_realtime_rag',
]);
const INTERNAL_FEATURES = new Set(['pedagogical_content', 'lesson_planner']);

const featureTier = (feature: string): 'premium' | 'interno' | 'gratuito' =>
    PREMIUM_FEATURES.has(feature)
        ? 'premium'
        : INTERNAL_FEATURES.has(feature)
        ? 'interno'
        : 'gratuito';

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
export const AiCostPanel: React.FC = () => {
    const months = useMemo(monthOptions, []);
    const [month, setMonth] = useState(months[0]);
    const [rows, setRows] = useState<CostRow[]>([]);
    const [live, setLive] = useState<LiveRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    const load = useCallback(async (selected: string) => {
        setLoading(true);
        setError('');
        try {
            const [cost, voice] = await Promise.all([
                supabase.rpc('ai_cost_report', { p_month: selected }),
                supabase.rpc('wolfie_realtime_usage_report', { p_month: selected }),
            ]);
            if (cost.error) throw cost.error;
            setRows((cost.data as CostRow[]) ?? []);
            // A voz é opcional: se falhar, o custo de escrita ainda é útil.
            setLive(voice.error ? [] : ((voice.data as LiveRow[]) ?? []));
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
    const porTier = rows.reduce(
        (acc, r) => {
            acc[featureTier(r.feature)] += r.custo_usd ?? 0;
            return acc;
        },
        { gratuito: 0, premium: 0, interno: 0 },
    );

    return (
        <div className="space-y-5">
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
                        <div className="mt-3 grid gap-2 sm:grid-cols-3">
                            {([
                                ['gratuito', 'Wolfie gratuito', 'Fala e escrita — incluído na mensalidade'],
                                ['premium', 'Wolfie premium (voz)', 'Resposta falada e conversa ao vivo'],
                                ['interno', 'Uso interno', 'Material e planner do professor'],
                            ] as const).map(([key, titulo, ajuda]) => (
                                <div key={key} className="rounded-lg border border-brand-border p-3">
                                    <p className="text-[11px] font-bold uppercase tracking-wide text-brand-muted">
                                        {titulo}
                                    </p>
                                    <p className="mt-0.5 text-lg font-black text-brand-text">
                                        {usd(porTier[key])}
                                    </p>
                                    <p className="text-[11px] text-brand-muted">{ajuda}</p>
                                </div>
                            ))}
                        </div>
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
