import React from 'react';
import {
    BadgePercent, MessageCircle, ClipboardCheck, Landmark, Wallet, ShieldCheck, Info,
    type LucideIcon,
} from 'lucide-react';
import {
    SETTLEMENT_CARD_NOTE,
    SETTLEMENT_RULES,
    STAGE_LABEL,
    affiliateGuideSteps,
    affiliateProgramRules,
    type AffiliateGuideStepId,
    type AffiliateStage,
} from '../../lib/affiliateProgram';

interface Props {
    commissionCents?: number | null;
    couponCode?: string | null;
}

// O que cada etapa do painel quer dizer — mesma ordem em que a indicação anda.
const STAGE_MEANING: Array<{ stage: AffiliateStage; text: string }> = [
    { stage: 'AGUARDANDO_PAGAMENTO', text: 'A pessoa começou a matrícula com o seu cupom; falta pagar a 1ª mensalidade.' },
    { stage: 'EM_LIQUIDACAO', text: 'A 1ª mensalidade foi paga e o dinheiro está a caminho da conta da escola.' },
    { stage: 'DISPONIVEL', text: 'O dinheiro caiu: a comissão entra no seu saldo para saque.' },
    { stage: 'EM_SAQUE', text: 'Você pediu o saque; a escola aprova e paga no seu PIX.' },
    { stage: 'PAGA', text: 'A comissão foi paga no seu PIX.' },
];

const STEP_ICONS: Record<AffiliateGuideStepId, LucideIcon> = {
    CUPOM: BadgePercent,
    ISENCAO: MessageCircle,
    RESERVA: ClipboardCheck,
    LIBERACAO: Landmark,
    SAQUE: Wallet,
};

const AffiliateProgramGuide: React.FC<Props> = ({ commissionCents, couponCode }) => {
    // Texto único em lib/affiliateProgram.ts: a página do convite lê o mesmo.
    const steps = affiliateGuideSteps(commissionCents, couponCode).map(step => ({ ...step, icon: STEP_ICONS[step.id] }));
    const rules = affiliateProgramRules(commissionCents);

    return (
        <div className="space-y-6">
            <ol className="space-y-3">
                {steps.map((step, index) => (
                    <li key={step.title} className="flex gap-3 rounded-2xl border border-brand-border bg-brand-surface p-4">
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-600">
                            <step.icon size={18} aria-hidden="true" />
                        </div>
                        <div className="min-w-0">
                            <p className="text-sm font-black text-brand-text">
                                <span className="mr-1 text-emerald-600">{index + 1}.</span>{step.title}
                            </p>
                            <p className="mt-1 text-xs leading-relaxed text-brand-muted">{step.text}</p>
                        </div>
                    </li>
                ))}
            </ol>

            <section className="rounded-2xl border border-sky-200 bg-sky-50 p-4 dark:border-sky-900/50 dark:bg-sky-950/30">
                <h4 className="flex items-center gap-2 text-xs font-black uppercase tracking-widest text-sky-700 dark:text-sky-300">
                    <Landmark size={14} aria-hidden="true" /> Quando a comissão libera
                </h4>
                <ul className="mt-3 space-y-2">
                    {SETTLEMENT_RULES.map(rule => (
                        <li key={rule.method} className="text-xs text-slate-700 dark:text-slate-200">
                            <strong>{rule.method}:</strong> {rule.when}.
                        </li>
                    ))}
                </ul>
                <p className="mt-3 text-[11px] text-slate-500 dark:text-slate-400">
                    {SETTLEMENT_CARD_NOTE}
                </p>
            </section>

            <section>
                <h4 className="flex items-center gap-2 text-xs font-black uppercase tracking-widest text-brand-muted">
                    <ShieldCheck size={14} aria-hidden="true" /> Regras do programa
                </h4>
                <ul className="mt-3 space-y-2">
                    {rules.map(rule => (
                        <li key={rule} className="flex gap-2 text-xs leading-relaxed text-brand-text">
                            <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden="true" />
                            {rule}
                        </li>
                    ))}
                </ul>
            </section>

            <section>
                <h4 className="flex items-center gap-2 text-xs font-black uppercase tracking-widest text-brand-muted">
                    <Info size={14} aria-hidden="true" /> O que cada status quer dizer
                </h4>
                <dl className="mt-3 space-y-2">
                    {STAGE_MEANING.map(item => (
                        <div key={item.stage} className="rounded-xl border border-brand-border bg-brand-surface px-3 py-2">
                            <dt className="text-xs font-black text-brand-text">{STAGE_LABEL[item.stage].label}</dt>
                            <dd className="text-xs text-brand-muted">{item.text}</dd>
                        </div>
                    ))}
                </dl>
            </section>
        </div>
    );
};

export default AffiliateProgramGuide;
