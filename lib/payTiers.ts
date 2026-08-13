// O que a escola paga por aula — descrito A PARTIR DA TABELA, nunca chumbado.
//
// Três telas do professor (card do turbo, nudges e onboarding) traziam a frase
// "seus alunos do 5º ao 9º valem R$ 9,50 e do 10º em diante R$ 10,50" em texto
// fixo. A faixa de R$ 9,50 foi APAGADA com a direção em 02/08/2026 (migration
// `20260802110000_remove_faixa_9_50`) porque, com a trava de 10+ alunos, ela era
// inalcançável. As telas ficaram 11 dias prometendo o que a folha não paga — o
// Flávio tinha 5 alunos nessa posição recebendo R$ 8,00.
//
// `teacher_pay_projection` passou a devolver `tiers`; estas funções viram texto.
// Mexer na tabela muda a tela junto — sem deploy, sem divergência.

export interface PayTier {
    min_students: number;
    rate: number;
}

export interface PayTierRange {
    /** Primeira posição da faixa (antiguidade do aluno na carteira). */
    from: number;
    /** Última posição, ou null quando a faixa é aberta ("do 10º em diante"). */
    to: number | null;
    rate: number;
    /** "10º em diante" · "5º ao 9º" */
    label: string;
}

export const brl = (v: number) =>
    `R$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;

const parseTiers = (tiers: unknown): PayTier[] =>
    (Array.isArray(tiers) ? tiers : [])
        .map(t => ({ min_students: Number((t as PayTier)?.min_students), rate: Number((t as PayTier)?.rate) }))
        .filter(t => Number.isFinite(t.min_students) && Number.isFinite(t.rate))
        .sort((a, b) => a.min_students - b.min_students);

/** Valor da primeira faixa: o que TODO aluno vale antes de qualquer progressão. */
export const baseRate = (tiers: unknown): number | null => {
    const list = parseTiers(tiers);
    return list.length ? list[0].rate : null;
};

/**
 * Faixas ACIMA da base, já com o intervalo fechado. Devolve vazio quando a
 * escola tem tarifa única — e aí nenhuma tela deve prometer progressão.
 */
export const payTierRanges = (tiers: unknown): PayTierRange[] => {
    const list = parseTiers(tiers);
    if (list.length < 2) return [];

    return list.slice(1).map((tier, i) => {
        const next = list[i + 2]; // slice(1) desloca o índice em 1
        const to = next ? next.min_students - 1 : null;
        return {
            from: tier.min_students,
            to,
            rate: tier.rate,
            label: to && to > tier.min_students
                ? `${tier.min_students}º ao ${to}º`
                : to === tier.min_students
                    ? `${tier.min_students}º`
                    : `${tier.min_students}º em diante`,
        };
    });
};

/**
 * Frase pronta com a progressão real: "do 10º aluno em diante, R$ 10,50 por
 * aula". Devolve null quando não há progressão — a tela então não promete nada.
 */
export const describePayTiers = (tiers: unknown): string | null => {
    const ranges = payTierRanges(tiers);
    if (!ranges.length) return null;
    const base = baseRate(tiers);
    const partes = ranges.map(r => `${r.label}: ${brl(r.rate)}`).join(' · ');
    return base == null ? partes : `${partes} (os demais seguem ${brl(base)})`;
};
