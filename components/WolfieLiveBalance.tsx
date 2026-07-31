import React, { useCallback, useEffect, useState } from 'react';
import { Mic, Zap, Infinity as InfinityIcon } from 'lucide-react';
import { supabase } from '../lib/supabase';

interface LiveBalance {
    enforced: boolean;
    allowed: boolean;
    used?: number;
    limit?: number;
    remaining?: number;
}

interface WolfieLiveBalanceProps {
    /** Abre o fluxo de compra de minutos adicionais. */
    onUpgrade?: () => void;
    /** Recarrega ao voltar de uma conversa ao vivo. */
    refreshKey?: number;
    compact?: boolean;
}

/**
 * Medidor de minutos de conversa ao vivo.
 *
 * Sem isto o limite é invisível: o aluno só descobre que acabou quando é
 * bloqueado, e o upgrade nunca é comprado porque ninguém sabe que existe.
 *
 * Deixa explícito que a prática por escrita continua ilimitada — o limite
 * nunca deve ser lido como "acabou meu acesso ao Wolfie".
 */
export const WolfieLiveBalance: React.FC<WolfieLiveBalanceProps> = ({
    onUpgrade,
    refreshKey = 0,
    compact = false,
}) => {
    const [balance, setBalance] = useState<LiveBalance | null>(null);
    const [loading, setLoading] = useState(true);

    const load = useCallback(async () => {
        try {
            const { data, error } = await supabase.rpc('my_wolfie_live_balance');
            if (error) throw error;
            setBalance(data as LiveBalance);
        } catch {
            // Sem saldo legível, não inventamos número nem assustamos o aluno.
            setBalance(null);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { void load(); }, [load, refreshKey]);

    if (loading) return null;

    // Escola sem cota configurada: nada a mostrar, o uso é livre.
    if (!balance || !balance.enforced) {
        if (compact) return null;
        return (
            <div className="flex items-center gap-2 text-xs text-slate-500">
                <InfinityIcon size={13} />
                <span>Prática ilimitada com o Wolfie</span>
            </div>
        );
    }

    const limit = Math.max(1, balance.limit ?? 0);
    const used = Math.min(balance.used ?? 0, limit);
    const remaining = balance.remaining ?? Math.max(0, limit - used);
    const pct = Math.min(100, Math.round((used / limit) * 100));
    const esgotado = remaining <= 0;
    const acabando = !esgotado && remaining <= Math.max(5, limit * 0.2);

    const barColor = esgotado
        ? 'bg-slate-400'
        : acabando
            ? 'bg-amber-500'
            : 'bg-emerald-500';

    return (
        <div className={`rounded-xl border ${esgotado ? 'border-slate-300 bg-slate-50' : 'border-slate-200 bg-white'} ${compact ? 'p-3' : 'p-4'}`}>
            <div className="flex items-center justify-between gap-3 mb-2">
                <div className="flex items-center gap-2 min-w-0">
                    <Mic size={14} className={esgotado ? 'text-slate-400' : 'text-emerald-600'} />
                    <span className="text-xs font-bold text-slate-700 truncate">
                        Conversa ao vivo
                    </span>
                </div>
                <span className={`text-xs font-mono font-bold shrink-0 ${esgotado ? 'text-slate-500' : 'text-slate-700'}`}>
                    {remaining} / {limit} min
                </span>
            </div>

            <div className="h-1.5 w-full rounded-full bg-slate-200 overflow-hidden">
                <div
                    className={`h-full rounded-full transition-all ${barColor}`}
                    style={{ width: `${pct}%` }}
                    role="progressbar"
                    aria-valuenow={used}
                    aria-valuemin={0}
                    aria-valuemax={limit}
                    aria-label={`${remaining} de ${limit} minutos restantes`}
                />
            </div>

            {/* O aluno precisa entender que NÃO ficou sem Wolfie. */}
            <p className="mt-2 text-[11px] leading-snug text-slate-500">
                {esgotado
                    ? 'Seus minutos deste mês acabaram — mas a prática por escrita e voz padrão segue ilimitada.'
                    : acabando
                        ? 'Seus minutos estão acabando. A prática por escrita continua ilimitada.'
                        : 'Renova todo dia 1º. A prática por escrita é ilimitada.'}
            </p>

            {(esgotado || acabando) && onUpgrade && (
                <button
                    type="button"
                    onClick={onUpgrade}
                    className="mt-3 w-full flex items-center justify-center gap-2 rounded-lg bg-[#002366] px-3 py-2 text-xs font-bold text-white transition-colors hover:bg-blue-900"
                >
                    <Zap size={13} /> Quero mais minutos
                </button>
            )}
        </div>
    );
};

export default WolfieLiveBalance;
