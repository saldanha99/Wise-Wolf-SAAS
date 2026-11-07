/**
 * Renovação de contrato pela ficha do aluno: leitura do servidor, prévia e textos.
 *
 * A prévia repete a conta do banco (`private.renewal_last_due_date`) só para a
 * direção conferir antes de gerar o link. Quem decide as datas é o servidor: a
 * resposta de `create_student_renewal_offer` é a oficial.
 */

export type RenewalTerm = 6 | 12;
export type RenewalPlan = 'INSTALLMENTS' | 'UPFRONT_CHARGE' | 'UPFRONT_EXTERNAL';

export interface RenewalOffer {
    id: string;
    status: 'PENDING_SIGNATURE' | 'SIGNED' | 'CANCELLED';
    billing_status: string;
    billing_strategy: string;
    billing_type: string;
    term_months: number;
    monthly_fee_cents: number;
    total_cents: number;
    classes_per_week: number;
    contract_start: string;
    first_due_date: string;
    last_due_date: string;
    service_end_date: string;
    upfront_due_date: string | null;
    expires_at: string;
    signed_at: string | null;
    expired: boolean;
    billing_error: string | null;
    invoice_url: string | null;
    coverage_registered_at: string | null;
    token: string | null;
    notice_status: string | null;
}

export interface RenewalContext {
    ok: true;
    student: {
        id: string;
        full_name: string;
        lifecycle_status: string | null;
        monthly_fee: number | null;
        class_frequency: string | null;
        due_day: number | null;
        contract_accepted: boolean;
        has_asaas_customer: boolean;
        subscription_status: string | null;
        subscription_end_date: string | null;
        weekly_lessons: number;
    };
    period: { current_end: string | null; source: string | null; suggested_start: string };
    catalog: Array<{ term_months: number; classes_per_week: number; monthly_price: number }>;
    offers: RenewalOffer[];
}

export function isRenewalContext(value: unknown): value is RenewalContext {
    const context = value as RenewalContext | null;
    return Boolean(context && context.ok === true && context.student && typeof context.student.id === 'string'
        && context.period && typeof context.period.suggested_start === 'string'
        && Array.isArray(context.catalog) && Array.isArray(context.offers));
}

const pad = (value: number) => String(value).padStart(2, '0');
const isoDate = (value: string) => /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value);

export function addMonthsIso(date: string, months: number): string {
    const [year, month, day] = date.split('-').map(Number);
    const index = month - 1 + months;
    const targetYear = year + Math.floor(index / 12);
    const targetMonth = ((index % 12) + 12) % 12;
    const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
    return `${targetYear}-${pad(targetMonth + 1)}-${pad(Math.min(day, lastDay))}`;
}

/** Calendário da escola, independente do fuso do computador. */
export const renewalToday = (now = new Date()): string =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

export function addDaysIso(date: string, days: number): string {
    const parsed = new Date(`${date}T12:00:00Z`);
    parsed.setUTCDate(parsed.getUTCDate() + days);
    return parsed.toISOString().slice(0, 10);
}

/** Mesma regra do servidor: o dia combinado no início ou depois dele, e nunca antes de amanhã. */
export function renewalFirstDueDate(start: string, dueDay: number, today = renewalToday()): string {
    let first = `${start.slice(0, 7)}-${pad(dueDay)}`;
    if (first < start) first = addMonthsIso(first, 1);
    const tomorrow = addDaysIso(today, 1);
    return first < tomorrow ? tomorrow : first;
}

export interface RenewalPreview {
    firstDue: string;
    lastDue: string;
    serviceEnd: string;
    firstMonth: string;
    lastMonth: string;
    totalCents: number;
}

export function renewalPreview(
    start: string,
    dueDay: number,
    term: number,
    feeCents: number | null,
    today = renewalToday(),
): RenewalPreview | null {
    if (!isoDate(start) || !Number.isInteger(dueDay) || dueDay < 1 || dueDay > 28 || ![6, 12].includes(term)
        || feeCents === null || !Number.isSafeInteger(feeCents) || feeCents <= 0) return null;
    const firstDue = renewalFirstDueDate(start, dueDay, today);
    const lastDue = addMonthsIso(firstDue, term - 1);
    return {
        firstDue,
        lastDue,
        serviceEnd: addMonthsIso(lastDue, 1),
        firstMonth: firstDue.slice(0, 7),
        lastMonth: lastDue.slice(0, 7),
        totalCents: feeCents * term,
    };
}

export const renewalMonthLabel = (month: string): string => {
    const match = /^(\d{4})-(\d{2})/.exec(month);
    return match ? `${match[2]}/${match[1]}` : '—';
};

export const renewalDateLabel = (date: string | null | undefined): string => {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date || '');
    return match ? `${match[3]}/${match[2]}/${match[1]}` : '—';
};

export const renewalMoney = (cents: number): string =>
    (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/** "187,00" ou "187.00" em centavos; `parseFloat` aceitaria texto solto no fim. */
export function renewalFeeCents(value: string): number | null {
    const raw = value.trim();
    const normalized = /^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(raw) ? raw.replaceAll('.', '').replace(',', '.') : raw.replace(',', '.');
    if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
    const [whole, decimals = ''] = normalized.split('.');
    const cents = Number(whole) * 100 + Number(decimals.padEnd(2, '0'));
    return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

export function renewalCatalogPrice(context: RenewalContext, term: number, frequency: number): number | null {
    const plan = context.catalog.find(item => item.term_months === term && item.classes_per_week === frequency);
    return plan ? Number(plan.monthly_price) : null;
}

const SOURCE_LABELS: Record<string, string> = {
    PAID_THROUGH: 'pagamento antecipado registrado',
    COVERAGE: 'meses cobertos',
    SUBSCRIPTION: 'assinatura no Asaas',
    SIGNED_RENEWAL: 'renovação já assinada',
};
export const renewalSourceLabel = (source: string | null): string => (source && SOURCE_LABELS[source]) || 'sem período registrado';

export function renewalOfferStatus(offer: RenewalOffer): { label: string; tone: 'ok' | 'wait' | 'bad' | 'off' } {
    if (offer.status === 'CANCELLED') return { label: 'Cancelada', tone: 'off' };
    if (offer.status === 'PENDING_SIGNATURE') {
        return offer.expired
            ? { label: 'Link vencido', tone: 'bad' }
            : { label: 'Aguardando a assinatura do aluno', tone: 'wait' };
    }
    if (offer.coverage_registered_at) return { label: 'Paga: meses cobertos', tone: 'ok' };
    if (['FAILED', 'REVIEW'].includes(offer.billing_status)) return { label: 'Assinada: a cobrança precisa de revisão', tone: 'bad' };
    if (['PENDING', 'PROCESSING'].includes(offer.billing_status)) return { label: 'Assinada: gerando a cobrança', tone: 'wait' };
    if (offer.billing_strategy === 'UPFRONT_CHARGE') return { label: 'Assinada: aguardando o pagamento', tone: 'wait' };
    if (offer.billing_strategy === 'UPFRONT_EXTERNAL') return { label: 'Assinada: confira a cobertura dos meses', tone: 'bad' };
    return { label: 'Assinada: cobrança recorrente no Asaas', tone: 'ok' };
}

const ERRORS: Record<string, string> = {
    sem_permissao: 'Somente a direção pode conduzir a renovação.',
    aluno_nao_encontrado: 'Aluno não encontrado nesta escola.',
    aluno_fora_de_escopo: 'A matrícula deste aluno não permite renovação agora.',
    saida_em_andamento: 'Há uma saída em andamento para este aluno. Conclua antes de renovar.',
    prazo_invalido: 'Escolha 6 ou 12 meses.',
    valor_invalido: 'Informe a mensalidade com até duas casas decimais.',
    frequencia_invalida: 'Informe de 1 a 7 aulas por semana.',
    vencimento_invalido: 'O dia de vencimento vai de 1 a 28.',
    inicio_invalido: 'A data de início não pode ser anterior a 31 dias nem passar de 400 dias.',
    forma_de_pagamento_invalida: 'Escolha a forma de pagamento.',
    forma_de_cobranca_invalida: 'Escolha Pix, boleto ou cartão.',
    contrato_anterior_nao_informado: 'Informe qual documento está sendo prorrogado (de 10 a 500 caracteres).',
    motivo_do_preco_obrigatorio: 'O valor é diferente do catálogo: escreva quem autorizou e por quê (mínimo de 10 caracteres).',
    observacao_longa: 'A observação passa de 800 caracteres.',
    renovacao_em_aberto: 'Já existe uma renovação esperando assinatura. Cancele essa antes de gerar outra.',
    negociacao_em_aberto: 'Há uma negociação de renovação em aberto no WhatsApp. Conclua antes de gerar outra.',
    periodo_ja_renovado: 'Já existe uma renovação assinada neste período.',
    periodo_ja_pago: 'Este período ainda está pago. Comece a renovação na data em que o pagamento atual termina.',
    mes_ja_coberto: 'Um ou mais meses deste período já estão cobertos. Ajuste a data de início.',
    parcelada_exige_cliente_asaas: 'Este aluno não tem cadastro no Asaas. Use o pagamento integral ou cadastre a cobrança antes.',
    assinatura_ativa_com_valor_diferente: 'A assinatura do Asaas está ativa com outro valor. Use "Mudar plano" ou espere ela encerrar.',
    assinatura_ativa_no_periodo: 'A assinatura do Asaas continua ativa neste período e cobraria os mesmos meses. Comece depois do fim dela.',
    vencimento_da_cobranca_invalido: 'O vencimento da cobrança precisa estar entre amanhã e os próximos 60 dias.',
    aluno_suspenso_reative_antes: 'Aluno suspenso não recebe a cobrança única. Reative o cadastro antes.',
    cadastro_incompleto_para_cobranca: 'Complete CPF e WhatsApp do titular antes de gerar a cobrança.',
    data_de_recebimento_invalida: 'Informe uma data real de recebimento, que não esteja no futuro.',
    referencia_do_recebimento_obrigatoria: 'Informe a referência do comprovante (mínimo de 5 caracteres).',
    motivo_obrigatorio: 'Informe o motivo com pelo menos 8 caracteres.',
    renovacao_ja_assinada: 'Esta renovação já foi assinada e não pode ser cancelada aqui.',
    renovacao_nao_encontrada: 'Renovação não encontrada. Atualize a ficha.',
    cobranca_sem_nova_tentativa: 'Esta cobrança não aceita nova tentativa agora. Atualize a ficha.',
};

export const renewalError = (code: unknown): string =>
    (typeof code === 'string' && ERRORS[code]) || 'Não foi possível concluir. Atualize a ficha e confira antes de tentar de novo.';

const BILLING_ERRORS: Record<string, string> = {
    customer_cpf_conflict: 'O CPF já tem outro cadastro no Asaas.',
    customer_not_yet_observed: 'O cadastro no Asaas ainda não apareceu: tente de novo em alguns minutos.',
    customer_post_outcome_unknown: 'O Asaas não confirmou o cadastro: tente de novo para conciliar.',
    payment_not_yet_observed: 'A cobrança ainda não apareceu no Asaas: tente de novo em alguns minutos.',
    payment_post_outcome_unknown: 'O Asaas não confirmou a cobrança: tente de novo para conciliar, sem risco de duplicar.',
    payment_duplicate: 'Há cobranças iguais no Asaas. Confira lá antes de continuar.',
    billing_identity_incomplete: 'Faltam CPF ou WhatsApp do titular.',
    billing_source_invalid: 'A renovação ou o cadastro mudou depois da assinatura.',
};
export const renewalBillingError = (code: string | null): string =>
    (code && BILLING_ERRORS[code]) || 'Confira no Asaas antes de tentar de novo.';
