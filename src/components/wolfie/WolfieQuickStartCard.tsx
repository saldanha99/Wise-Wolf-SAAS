import React from "react";
import { Play, Settings2, Sparkles } from "lucide-react";
import type { QuickStartPlan } from "./quickStart";

interface WolfieQuickStartCardProps {
  firstName: string;
  plan: QuickStartPlan;
  /** Dispara a prática imediatamente, sem passar pelo wizard. */
  onStart: () => void;
  /** Leva ao catálogo completo, para quem quer escolher. */
  onBrowse: () => void;
  busy?: boolean;
}

/**
 * Início em um toque.
 *
 * O funil mostrou 52 alunos ativos e só 16 que chegaram a usar o Wolfie. O
 * caminho exigia escolher entre dezenas de experiências, depois nível, setor e
 * formato — antes de qualquer valor aparecer. Aqui o aluno começa direto, com
 * o que o sistema já sabe dele, e o catálogo vira escolha, não pedágio.
 */
export const WolfieQuickStartCard: React.FC<WolfieQuickStartCardProps> = ({
  firstName,
  plan,
  onStart,
  onBrowse,
  busy = false,
}) => (
  <section
    className="rounded-2xl border border-brand-border bg-gradient-to-br from-brand-surface to-brand-surface-2 p-5 sm:p-7"
    aria-label="Começar a praticar agora"
  >
    <div className="flex items-start gap-3">
      <span className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-accent/10 text-brand-accent">
        <Sparkles size={17} />
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="text-lg font-black tracking-tight text-brand-text sm:text-xl">
          Pronto para praticar, {firstName}?
        </h2>
        <p className="mt-1 text-sm text-brand-muted">{plan.reason}</p>
      </div>
    </div>

    <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:items-center">
      <button
        type="button"
        onClick={onStart}
        disabled={busy}
        className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-brand-accent px-5 py-3.5 text-sm font-black text-white transition-opacity hover:opacity-90 disabled:opacity-60"
      >
        <Play size={16} />
        {busy ? "Preparando..." : plan.label}
      </button>
      <button
        type="button"
        onClick={onBrowse}
        disabled={busy}
        className="inline-flex items-center justify-center gap-2 rounded-xl border border-brand-border px-4 py-3.5 text-sm font-bold text-brand-muted transition-colors hover:text-brand-text disabled:opacity-60"
      >
        <Settings2 size={15} />
        Escolher outra prática
      </button>
    </div>

    {/* Só aparece quando chutamos o nível: pedir confirmação a quem já tem
        nível cadastrado seria repetir exatamente o atrito que removemos. */}
    {!plan.levelKnown && (
      <p className="mt-3 text-xs text-brand-muted">
        Começamos num nível intermediário e ajustamos conforme você conversa.
      </p>
    )}
  </section>
);

export default WolfieQuickStartCard;
