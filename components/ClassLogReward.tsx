import React, { useEffect, useRef, useState } from 'react';
import { Zap, Flame, TrendingUp, CheckCircle2, Info, X } from 'lucide-react';
// Importa de `classLogRules` (puro) e não de `classLogging` (que carrega o
// cliente Supabase): a tela de recompensa não faz I/O nenhum.
import { ClassLogResult, XpBreakdown, describeUnpaid, describeSkip } from '../lib/classLogRules';

// ─────────────────────────────────────────────────────────────────────────────
// RECOMPENSA DO LANÇAMENTO
//
// O professor lançava a aula e recebia "Aulas registradas com perfeição." — sem
// nenhum número. O dinheiro dele morava em outra aba. Aqui ele vê o caixa subir
// no momento exato do lançamento.
//
// DUAS CAMADAS, DE PROPÓSITO:
//   • XP  — instantâneo, arcade. Não representa dinheiro, então não pode mentir.
//   • R$  — vem da RPC (`v_payable_class_logs`), a MESMA fonte que paga. Nunca
//           estimado no cliente.
//
// Aula que não entra na folha mostra R$ 0 COM O MOTIVO. Fingir festa numa aula
// que vale zero seria pior que não animar nada: o professor descobriria no
// fechamento, e aí a tela toda perde a credibilidade.
// ─────────────────────────────────────────────────────────────────────────────

interface Props {
    result: ClassLogResult;
    xp: XpBreakdown;
    onClose: () => void;
}

const brl = (v: number) =>
    `R$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Contador que sobe até o valor final (easing de desaceleração). */
const useContagem = (alvo: number, duracaoMs = 1100) => {
    const [valor, setValor] = useState(0);
    const frameRef = useRef<number | null>(null);

    useEffect(() => {
        // Respeita quem pediu menos animação no sistema operacional.
        const semAnimacao = typeof window !== 'undefined'
            && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        if (semAnimacao || alvo <= 0) {
            setValor(alvo);
            return;
        }

        const inicio = performance.now();
        const passo = (agora: number) => {
            const t = Math.min(1, (agora - inicio) / duracaoMs);
            const eased = 1 - Math.pow(1 - t, 3);
            setValor(alvo * eased);
            if (t < 1) frameRef.current = requestAnimationFrame(passo);
        };
        frameRef.current = requestAnimationFrame(passo);
        return () => { if (frameRef.current) cancelAnimationFrame(frameRef.current); };
    }, [alvo, duracaoMs]);

    return valor;
};

const ClassLogReward: React.FC<Props> = ({ result, xp, onClose }) => {
    const caixa = useContagem(result.deltaAmount);
    const pontos = useContagem(xp.total, 800);
    const mes = useContagem(result.monthAmount, 1400);

    // Fecha sozinho, mas dá tempo de ler quando há recado (aula que não pagou
    // ou aula ignorada) — nesses casos a informação importa mais que o efeito.
    const semPagamento = result.entries.filter(e => e.status === 'lancada' && !e.paid);
    const ignoradas = result.entries.filter(e => e.status === 'ignorada');
    const temRecado = semPagamento.length > 0 || ignoradas.length > 0;

    useEffect(() => {
        const t = window.setTimeout(onClose, temRecado ? 12000 : 5200);
        return () => window.clearTimeout(t);
    }, [onClose, temRecado]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    if (result.inserted === 0 && ignoradas.length === 0) return null;

    return (
        <div
            className="fixed inset-0 z-[9998] flex items-center justify-center p-4 bg-slate-950/70 backdrop-blur-sm animate-in fade-in duration-300"
            onClick={onClose}
            role="dialog"
            aria-live="polite"
            aria-label="Resumo do lançamento de aulas"
        >
            <div
                onClick={e => e.stopPropagation()}
                className="relative w-full max-w-md overflow-hidden rounded-[2.5rem] border border-emerald-400/20 bg-gradient-to-br from-emerald-600 via-teal-600 to-emerald-700 p-7 text-white shadow-2xl shadow-emerald-900/40 animate-in zoom-in-95 slide-in-from-bottom-4 duration-500 max-h-[90dvh] overflow-y-auto"
            >
                <div className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-white/10 blur-3xl" />

                <button
                    onClick={onClose}
                    aria-label="Fechar"
                    className="absolute right-4 top-4 z-10 rounded-full bg-white/15 p-1.5 text-white/80 transition-colors hover:bg-white/25 hover:text-white"
                >
                    <X size={16} />
                </button>

                <div className="relative">
                    {/* Cabeçalho */}
                    <div className="mb-5 flex items-center gap-2">
                        <CheckCircle2 size={18} className="text-emerald-200" />
                        <span className="text-[11px] font-black uppercase tracking-widest text-emerald-100">
                            {result.inserted} aula{result.inserted === 1 ? '' : 's'} lançada{result.inserted === 1 ? '' : 's'}
                        </span>
                    </div>

                    {/* O CAIXA — o número que importa */}
                    <p className="text-[10px] font-black uppercase tracking-widest text-white/60">
                        Entrou no seu caixa agora
                    </p>
                    <div className="mt-1 flex items-baseline gap-2">
                        <span className="text-5xl font-black tracking-tighter tabular-nums">
                            {brl(caixa)}
                        </span>
                        {result.deltaLessons > 0 && (
                            <span className="text-xs font-bold text-white/70">
                                · {result.deltaLessons} paga{result.deltaLessons === 1 ? '' : 's'}
                            </span>
                        )}
                    </div>

                    {/* XP — camada arcade */}
                    {xp.total > 0 && (
                        <div className="mt-4 inline-flex items-center gap-2 rounded-full border border-amber-300/30 bg-amber-400/20 px-4 py-2">
                            <Zap size={15} className="text-amber-200" fill="currentColor" />
                            <span className="text-sm font-black tabular-nums">+{Math.round(pontos)} XP</span>
                            {xp.combo > 1 && (
                                <span className="rounded-full bg-white/20 px-2 py-0.5 text-[10px] font-black uppercase tracking-widest">
                                    combo ×{xp.combo}
                                </span>
                            )}
                        </div>
                    )}
                    {xp.aulasEmDia > 0 && (
                        <p className="mt-2 text-[11px] font-bold text-emerald-100/80">
                            🎯 {xp.aulasEmDia} lançada{xp.aulasEmDia === 1 ? '' : 's'} em dia — é isso que mantém seu fechamento limpo.
                        </p>
                    )}

                    {/* Total do mês — a barra de progresso de verdade */}
                    <div className="mt-6 rounded-2xl border border-white/15 bg-white/10 p-4">
                        <div className="flex items-center justify-between">
                            <span className="text-[10px] font-black uppercase tracking-widest text-white/70">
                                Acumulado do mês
                            </span>
                            {result.turboActive && (
                                <span className="inline-flex items-center gap-1 rounded-full bg-orange-500/30 px-2 py-0.5 text-[10px] font-black uppercase tracking-widest">
                                    <Flame size={11} /> turbo
                                </span>
                            )}
                        </div>
                        <div className="mt-1 flex items-baseline gap-2">
                            <TrendingUp size={18} className="text-emerald-200" />
                            <span className="text-2xl font-black tracking-tight tabular-nums">{brl(mes)}</span>
                            <span className="text-[11px] font-bold text-white/60">
                                em {result.monthLessons} aula{result.monthLessons === 1 ? '' : 's'}
                            </span>
                        </div>
                    </div>

                    {/* Reposição criada — o professor precisa saber que a aula não sumiu */}
                    {result.reschedulesCreated > 0 && (
                        <p className="mt-4 rounded-xl bg-white/10 px-3 py-2 text-[11px] font-bold leading-relaxed text-white/85">
                            ↻ {result.reschedulesCreated} reposição{result.reschedulesCreated === 1 ? '' : 'ões'} gerada{result.reschedulesCreated === 1 ? '' : 's'} —
                            agende na aba Reposições.
                        </p>
                    )}

                    {/* Aulas que NÃO entraram na folha, com o motivo. Sem isso a tela mentiria. */}
                    {semPagamento.length > 0 && (
                        <div className="mt-4 space-y-2 rounded-2xl border border-amber-300/25 bg-amber-950/25 p-3">
                            {semPagamento.map((e, i) => (
                                <div key={`${e.ref}-${i}`} className="flex items-start gap-2">
                                    <Info size={13} className="mt-0.5 shrink-0 text-amber-200" />
                                    <p className="text-[11px] font-medium leading-relaxed text-amber-50">
                                        <span className="font-black">R$ 0,00 · </span>
                                        {describeUnpaid(e.unpaidReason)}
                                    </p>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Ignoradas: tranquiliza (nada foi duplicado) em vez de assustar */}
                    {ignoradas.length > 0 && (
                        <p className="mt-3 rounded-xl bg-white/10 px-3 py-2 text-[11px] font-medium leading-relaxed text-white/80">
                            {ignoradas.length} aula{ignoradas.length === 1 ? '' : 's'} não {ignoradas.length === 1 ? 'entrou' : 'entraram'}:
                            {' '}{[...new Set(ignoradas.map(e => describeSkip(e.reason)))].join(' · ')}. Nada foi duplicado.
                        </p>
                    )}
                </div>
            </div>
        </div>
    );
};

export default ClassLogReward;
