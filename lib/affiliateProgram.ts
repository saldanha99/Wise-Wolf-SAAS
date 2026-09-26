/**
 * Programa de afiliados — regras e textos compartilhados pelas telas.
 *
 * Modelo híbrido (decisão da direção, 25/09/2026): o afiliado não gera link.
 * A indicação é o CUPOM dele, que o aluno digita na página de matrícula ou a
 * escola põe no link manual (pelo cupom, ou pelo nome quando só existe um
 * afiliado com aquele nome). Quem se matricula com cupom fica isento da taxa de
 * matrícula; a comissão (valor fixo por matrícula) fica reservada quando a
 * matrícula começa e é liberada quando a PRIMEIRA mensalidade é liquidada.
 *
 * A etapa de cada indicação vem pronta do servidor (`get_my_affiliate_panel`,
 * `private.affiliate_referral_view`). Aqui só se traduz para gente — nenhuma
 * regra de dinheiro é decidida no navegador.
 */

export type AffiliateStage =
    | 'AGUARDANDO_PAGAMENTO'
    | 'EM_LIQUIDACAO'
    | 'DISPONIVEL'
    | 'EM_SAQUE'
    | 'PAGA'
    | 'CANCELADA'
    | 'NAO_CONCLUIDA';

export interface AffiliateFirstPayment {
    billing_type: string | null;
    status: string | null;
    due_date: string | null;
    paid_on: string | null;
    estimated_credit_on: string | null;
    credited_at: string | null;
}

export interface AffiliateReferral {
    id: string;
    stage: AffiliateStage;
    status: string;
    amount_cents: number;
    student_display: string;
    referred_at: string | null;
    confirmed_at: string | null;
    paid_at: string | null;
    attribution: string | null;
    coupon_code: string | null;
    first_payment: AffiliateFirstPayment | null;
    withdrawal: { id: string; status: string; requested_at: string | null } | null;
}

export interface AffiliateWithdrawal {
    id: string;
    amount_cents: number;
    commission_count: number;
    status: string;
    requested_at: string | null;
    reviewed_at: string | null;
    paid_at: string | null;
    review_note: string | null;
}

export interface AffiliatePanelData {
    affiliate: {
        full_name: string | null;
        affiliate_code: string | null;
        commission_cents: number;
        active: boolean;
        pix_key: string | null;
        pix_key_type: string | null;
        school_name: string | null;
    };
    totals: {
        referrals: number;
        waiting_payment: number;
        settling: number;
        released: number;
        pending_cents: number;
        available_cents: number;
        requested_cents: number;
        paid_cents: number;
    };
    referrals: AffiliateReferral[];
    withdrawals: AffiliateWithdrawal[];
}

/** Comissão padrão de um afiliado novo (R$ 49,00), a mesma do banco. */
export const DEFAULT_AFFILIATE_COMMISSION_CENTS = 4900;

/** Cupom: 4 a 32 caracteres, letras/números/"-"/"_", começando por letra ou número. */
export const AFFILIATE_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{3,31}$/;

/** Mesma normalização do banco (`private.normalize_affiliate_code`). */
export function normalizeAffiliateCode(value: string): string {
    return value.trim().replace(/[^A-Za-z0-9_-]+/g, '').toUpperCase();
}

export function isValidAffiliateCode(value: string): boolean {
    return AFFILIATE_CODE_PATTERN.test(normalizeAffiliateCode(value));
}

export function formatCents(cents: number | null | undefined): string {
    const value = Number(cents || 0) / 100;
    return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

/**
 * "2026-10-02" → "02/10". Data pura (sem hora) é tratada como texto: passar
 * por `new Date()` jogaria o dia para trás em Brasília.
 */
export function formatDayMonth(value: string | null | undefined): string {
    if (!value) return '';
    const plain = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (plain) return `${plain[3]}/${plain[2]}`;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleDateString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        timeZone: 'America/Sao_Paulo',
    });
}

export const STAGE_LABEL: Record<AffiliateStage, { label: string; tone: 'amber' | 'sky' | 'emerald' | 'violet' | 'slate' }> = {
    AGUARDANDO_PAGAMENTO: { label: 'Aguardando pagamento', tone: 'amber' },
    EM_LIQUIDACAO: { label: 'Em liquidação', tone: 'sky' },
    DISPONIVEL: { label: 'Disponível para saque', tone: 'emerald' },
    EM_SAQUE: { label: 'Saque solicitado', tone: 'violet' },
    PAGA: { label: 'Paga', tone: 'emerald' },
    CANCELADA: { label: 'Cancelada', tone: 'slate' },
    NAO_CONCLUIDA: { label: 'Matrícula não concluída', tone: 'slate' },
};

export function stageLabel(stage: string): string {
    return STAGE_LABEL[stage as AffiliateStage]?.label || stage;
}

/** Quando a comissão libera, por forma de pagamento da 1ª mensalidade. */
export const SETTLEMENT_RULES: Array<{ method: string; when: string }> = [
    { method: 'Pix', when: 'na hora, assim que o pagamento cai' },
    { method: 'Boleto', when: 'na compensação — até 2 dias úteis depois do pagamento' },
    { method: 'Cartão de crédito', when: 'quando o valor cai na conta da escola — até cerca de 30 dias depois da aprovação' },
];

/** Uma linha explicando onde a indicação está e o que falta. */
export function referralStageDetail(referral: AffiliateReferral): string {
    const payment = referral.first_payment;
    const billing = (payment?.billing_type || '').toUpperCase();
    switch (referral.stage) {
        case 'AGUARDANDO_PAGAMENTO': {
            if (!payment) return 'Matrícula em andamento — aguardando a 1ª mensalidade.';
            if ((payment.status || '').toUpperCase() === 'OVERDUE') {
                return `1ª mensalidade vencida desde ${formatDayMonth(payment.due_date)}.`;
            }
            const due = formatDayMonth(payment.due_date);
            return due ? `1ª mensalidade vence em ${due}.` : 'Aguardando a 1ª mensalidade.';
        }
        case 'EM_LIQUIDACAO': {
            if (billing === 'CREDIT_CARD') {
                const expected = formatDayMonth(payment?.estimated_credit_on);
                return expected
                    ? `Cartão aprovado — libera por volta de ${expected}.`
                    : 'Cartão aprovado — libera quando o valor cair (até ~30 dias).';
            }
            if (billing === 'BOLETO') return 'Boleto pago — liberando na compensação (até 2 dias úteis).';
            if (billing === 'PIX') return 'Pix recebido — liberando.';
            return 'Pagamento recebido — em liquidação.';
        }
        case 'DISPONIVEL': {
            const since = formatDayMonth(referral.confirmed_at);
            return since ? `Liberada em ${since} — pronta para saque.` : 'Liberada — pronta para saque.';
        }
        case 'EM_SAQUE':
            return (referral.withdrawal?.status || '').toUpperCase() === 'APPROVED'
                ? 'Saque aprovado — pagamento no seu PIX em andamento.'
                : 'Saque solicitado — aguardando aprovação da escola.';
        case 'PAGA': {
            const paid = formatDayMonth(referral.paid_at);
            return paid ? `Paga em ${paid}.` : 'Paga.';
        }
        case 'CANCELADA':
            return 'Comissão cancelada.';
        case 'NAO_CONCLUIDA':
            return 'A matrícula não foi concluída.';
        default:
            return '';
    }
}

export function withdrawalStatusLabel(status: string): string {
    switch ((status || '').toUpperCase()) {
        case 'PENDING': return 'Aguardando aprovação';
        case 'APPROVED': return 'Aprovado — pagamento em andamento';
        case 'PAID': return 'Pago';
        case 'REJECTED': return 'Recusado';
        case 'CANCELLED': return 'Cancelado';
        default: return status;
    }
}

/** Texto pronto para o afiliado divulgar o cupom. */
export function affiliateShareMessage(code: string, schoolName?: string | null): string {
    const school = schoolName?.trim() ? `a ${schoolName.trim()}` : 'a minha escola de inglês';
    return `Oi! Estou te indicando ${school}. `
        + `Na matrícula, informe o meu cupom *${code}* e você fica isento da taxa de matrícula. `
        + 'É só falar com a escola e passar o cupom 😉';
}

export const PIX_KEY_TYPES: Array<{ value: string; label: string; placeholder: string }> = [
    { value: 'CPF', label: 'CPF', placeholder: '000.000.000-00' },
    { value: 'CNPJ', label: 'CNPJ', placeholder: '00.000.000/0000-00' },
    { value: 'EMAIL', label: 'E-mail', placeholder: 'voce@email.com' },
    { value: 'PHONE', label: 'Celular', placeholder: '(11) 99999-9999' },
    { value: 'EVP', label: 'Chave aleatória', placeholder: '1a2b3c4d-...' },
];

export function affiliateErrorMessage(code: unknown): string {
    switch (String(code || '')) {
        case 'PIX_REQUIRED': return 'Cadastre sua chave PIX antes de solicitar o saque.';
        case 'NO_AVAILABLE_BALANCE': return 'Ainda não há comissão liberada para saque.';
        case 'INVALID_PIX': return 'Chave PIX inválida para o tipo escolhido. Confira e tente de novo.';
        case 'FORBIDDEN': return 'Esta área é exclusiva de afiliados.';
        default: return 'Não foi possível concluir agora. Tente novamente em instantes.';
    }
}

export interface AffiliateMatch {
    vendor_id: string;
    full_name: string | null;
    affiliate_code: string;
    commission_cents: number;
    match: 'CODE' | 'NAME';
}

/**
 * Regra da direção para identificar quem indicou: cupom exato resolve; nome
 * resolve se só existe UM afiliado com aquele nome; com dois ou mais, quem gera
 * o link escolhe pelo cupom.
 */
export function resolveAffiliateLookup(
    matches: AffiliateMatch[],
): { kind: 'none' } | { kind: 'single'; affiliate: AffiliateMatch } | { kind: 'ambiguous'; options: AffiliateMatch[] } {
    if (!matches.length) return { kind: 'none' };
    if (matches[0].match === 'CODE') return { kind: 'single', affiliate: matches[0] };
    if (matches.length === 1) return { kind: 'single', affiliate: matches[0] };
    return { kind: 'ambiguous', options: matches };
}

/** Erros do convite de afiliado (`create_affiliate_invite`). */
export function affiliateInviteErrorMessage(error: unknown): string {
    const record = error && typeof error === 'object' ? error as Record<string, unknown> : {};
    const raw = [record.message, record.details, record.code]
        .filter(value => typeof value === 'string')
        .join(' ')
        .toLowerCase();
    if (raw.includes('affiliate_code_in_use') || raw.includes('23505')) {
        return 'Este cupom já é de outro afiliado ou está reservado em outro convite. Escolha outro.';
    }
    if (raw.includes('invalid_affiliate_code')) {
        return 'Cupom inválido: use de 4 a 32 letras, números, "-" ou "_", começando por letra ou número.';
    }
    if (raw.includes('invalid_vendor_invite')) return 'Revise o valor da comissão.';
    if (raw.includes('permission_denied') || raw.includes('42501')) {
        return 'Só a direção ou a coordenação pode convidar afiliados.';
    }
    return 'Não foi possível gerar o convite. Tente novamente.';
}
