import React from 'react';
import {
    BadgePercent, MessageCircle, ClipboardCheck, Landmark, Wallet, ShieldCheck, Info,
} from 'lucide-react';
import {
    DEFAULT_AFFILIATE_COMMISSION_CENTS,
    SETTLEMENT_RULES,
    STAGE_LABEL,
    formatCents,
    type AffiliateStage,
} from '../../lib/affiliateProgram';

interface Props {
    commissionCents?: number | null;
    couponCode?: string | null;
    schoolName?: string | null;
    /** No cadastro mostramos o essencial; no painel, o guia inteiro. */
    compact?: boolean;
}

// O que cada etapa do painel quer dizer — mesma ordem em que a indicação anda.
const STAGE_MEANING: Array<{ stage: AffiliateStage; text: string }> = [
    { stage: 'AGUARDANDO_PAGAMENTO', text: 'A pessoa começou a matrícula com o seu cupom; falta pagar a 1ª mensalidade.' },
    { stage: 'EM_LIQUIDACAO', text: 'A 1ª mensalidade foi paga e o dinheiro está a caminho da conta da escola.' },
    { stage: 'DISPONIVEL', text: 'O dinheiro caiu: a comissão entra no seu saldo para saque.' },
    { stage: 'EM_SAQUE', text: 'Você pediu o saque; a escola aprova e paga no seu PIX.' },
    { stage: 'PAGA', text: 'A comissão foi paga no seu PIX.' },
];

const AffiliateProgramGuide: React.FC<Props> = ({ commissionCents, couponCode, compact = false }) => {
    const commission = formatCents(commissionCents ?? DEFAULT_AFFILIATE_COMMISSION_CENTS);
    const code = couponCode?.trim() || 'SEU CUPOM';

    const steps = [
        {
            icon: BadgePercent,
            title: 'Seu cupom é a sua indicação',
            text: `Você recebe um cupom exclusivo — o seu é ${code}. Compartilhe com quem quiser indicar: WhatsApp, Instagram, conversa.`,
        },
        {
            icon: MessageCircle,
            title: 'Quem você indica não paga a taxa de matrícula',
            text: 'Na conversa com a escola, a pessoa informa o seu cupom — ou diz que foi você quem indicou. Ela também pode digitar o cupom na página de matrícula. A mensalidade não muda.',
        },
        {
            icon: ClipboardCheck,
            title: 'A matrícula reserva a sua comissão',
            text: `Quando a pessoa começa a matrícula com o seu cupom, a comissão de ${commission} aparece no seu painel como "Aguardando pagamento".`,
        },
        {
            icon: Landmark,
            title: 'A comissão é liberada na liquidação da 1ª mensalidade',
            text: 'Liquidada é quando o dinheiro cai na conta da escola. O prazo depende de como a pessoa pagou (veja abaixo).',
        },
        {
            icon: Wallet,
            title: 'Você pede o saque',
            text: 'Com a comissão liberada, cadastre sua chave PIX no painel e toque em "Solicitar saque". A escola aprova e paga no seu PIX.',
        },
    ];

    const rules = [
        `Comissão fixa de ${commission} por matrícula, paga uma única vez: só a 1ª mensalidade conta (não é recorrente).`,
        'Vale para planos (mensal, semestral e anual). Aula avulsa não gera comissão.',
        'Cada matrícula tem um único afiliado: vale o primeiro cupom informado.',
        'Se o pagamento for estornado antes do repasse, a comissão volta para "Aguardando pagamento" e o saque pendente é cancelado.',
        'Todo saque passa pela aprovação da escola antes do PIX.',
    ];

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
                    No cartão, o painel mostra a data prevista quando o pagamento é aprovado.
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

            {!compact && (
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
            )}
        </div>
    );
};

export default AffiliateProgramGuide;
