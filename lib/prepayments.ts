export type PrepaymentMode = 'MENSAL' | 'LEGADO';

export interface PrepaymentStudent { id: string; full_name: string }
export interface PrepaymentPayment {
    id: string;
    student_id: string;
    value: number | string;
    status: string;
    due_date: string | null;
    received_on: string | null;
    description: string | null;
    registration_allowed: boolean;
    registration_block_reason?: string | null;
    monthly_allowed: boolean;
    monthly_block_reason?: string | null;
}
export interface PrepaymentAllocation {
    id: string;
    grupo_id: string;
    registration_id: string;
    payment_id: string | null;
    student_id: string;
    competencia: string;
    sequencia: number;
    meses: number;
    valor: number | string;
    modo: PrepaymentMode;
    origem: 'ASAAS' | 'EXTERNO';
    recebido_em: string | null;
    observacao: string | null;
    status: string;
    stored_status?: string;
    is_valid?: boolean;
    status_reason?: string | null;
    created_at: string;
    cancelled_at: string | null;
}
export interface PrepaymentHistoryEvent {
    id: string;
    action: string;
    occurred_at: string;
    actor_name: string | null;
    reason?: string | null;
    grupo_id: string;
}
export interface PrepaymentContext {
    ok: true;
    can_write: boolean;
    students: PrepaymentStudent[];
    payments: PrepaymentPayment[];
    allocations: PrepaymentAllocation[];
    history: PrepaymentHistoryEvent[];
    has_more_students?: boolean;
    notification_settings?: { enabled: boolean; starts_on: string | null };
}

/** Exact decimal input; never parseFloat (which silently accepts trailing text). */
export function prepaymentCents(value: string | number): number | null {
    const raw = String(value).trim();
    const normalized = /^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(raw)
        ? raw.replaceAll('.', '').replace(',', '.')
        : raw.replace(',', '.');
    if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
    const [whole, decimals = ''] = normalized.split('.');
    const cents = Number(whole) * 100 + Number(decimals.padEnd(2, '0'));
    return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

export const prepaymentMonthLabel = (month: string): string => {
    const match = /^(\d{4})-(0[1-9]|1[0-2])(?:-\d{2})?$/.exec(month);
    return match ? `${match[2]}/${match[1]}` : '—';
};

/** Same remainder-first rule as the authoritative RPC. Preview only, not a release. */
export function prepaymentPreview(totalCents: number | null, firstMonth: string, months: number) {
    if (totalCents === null || !Number.isSafeInteger(totalCents) || totalCents <= 0 ||
        !Number.isInteger(months) || months < 2 || months > 24 ||
        !/^(\d{4})-(0[1-9]|1[0-2])$/.test(firstMonth) || totalCents < months) return [];
    const [year, month] = firstMonth.split('-').map(Number);
    if (year < 1900 || year + Math.floor((month - 1 + months - 1) / 12) > 9999) return [];
    const base = Math.floor(totalCents / months);
    const remainder = totalCents % months;
    return Array.from({ length: months }, (_, i) => {
        const monthIndex = month - 1 + i;
        return {
            competencia: `${year + Math.floor(monthIndex / 12)}-${String(monthIndex % 12 + 1).padStart(2, '0')}`,
            cents: base + (i < remainder ? 1 : 0),
        };
    });
}

/** School calendar, independent of the operator's computer time zone. */
export const prepaymentToday = (now = new Date()): string =>
    new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(now);

export function validPrepaymentReceiptDate(value: string, today = prepaymentToday()): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value > today) return false;
    const date = new Date(`${value}T12:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const ERRORS: Record<string, string> = {
    sem_permissao: 'Seu perfil não está autorizado. É necessário acesso ativo da direção nesta escola.',
    forbidden: 'Seu perfil não está autorizado. É necessário acesso ativo da direção nesta escola.',
    tenant_not_operational: 'Esta escola não está operacional para alterações financeiras.',
    pagamento_nao_recebido: 'O pagamento não está mais recebido. Atualize e confira a conciliação.',
    pagamento_nao_encontrado: 'Pagamento não encontrado nesta escola. Atualize a consulta.',
    pagamento_de_matricula: 'Taxa de matrícula não pode cobrir mensalidades.',
    pagamento_ja_tem_parcelas: 'Este pagamento já possui cobertura. Confira o histórico antes de alterá-la.',
    aviso_do_rateio_ja_saiu: 'O aviso do valor integral já pode ter sido enviado. Confira a opção LEGADO; não é permitido ratear novamente.',
    mes_ja_coberto: 'Um ou mais meses já estão cobertos. Confira a cobertura existente e ajuste o período.',
    meses_invalidos: 'Selecione entre 2 e 24 meses.',
    valor_invalido: 'Informe o valor recebido, positivo e com até duas casas decimais.',
    data_de_recebimento_invalida: 'Informe uma data real de recebimento, que não esteja no futuro.',
    nada_a_cancelar: 'Não há cobertura ativa para cancelar. Atualize a consulta.',
    pagamento_estornado: 'O pagamento tem estorno ou contestação. Resolva a conciliação antes de criar cobertura.',
    motivo_obrigatorio: 'Informe o motivo do cancelamento, com 12 a 500 caracteres.',
    motivo_invalido: 'Informe o motivo do cancelamento, com 12 a 500 caracteres.',
    reason_required: 'Informe o motivo do cancelamento, com 12 a 500 caracteres.',
    registration_changed: 'Esta cobertura mudou desde a consulta. Atualize o histórico antes de cancelar.',
    registro_alterado: 'Esta cobertura mudou desde a consulta. Atualize o histórico antes de cancelar.',
    registro_alterado_recarregue: 'Esta cobertura mudou desde a consulta. Atualize o histórico antes de cancelar.',
    motivo_obrigatorio_12_a_500_caracteres: 'Informe o motivo do cancelamento, com 12 a 500 caracteres.',
    pagamento_requer_revisao: 'O pagamento requer revisão da conciliação antes de criar cobertura.',
    pagamento_completo_em_revisao: 'Este pagamento completo está em revisão. Confira o histórico financeiro.',
    parcelamento_mensal_ja_avisado_requer_reconciliacao: 'Já houve preparo ou tentativa de aviso deste rateio mensal. É necessário reconciliar a reserva; não é permitido recadastrar em MENSAL nem em LEGADO.',
    origem_financeira_alterada: 'O recebimento mudou. Atualize a consulta e confira a conciliação.',
    mensal_deve_iniciar_no_mes_do_recebimento: 'No modo MENSAL, a cobertura deve começar no mês do recebimento conciliado.',
};

const REVIEW_REASONS: Record<string, string> = {
    PAYMENT_PROVIDER_OBSERVATION_REVIEW: 'O provedor informou estorno, contestação ou cancelamento; aguarde a conciliação.',
    PAYMENT_REFUNDED_OR_PARTIALLY_REFUNDED: 'O recebimento foi estornado total ou parcialmente.',
    PAYMENT_PROVIDER_REVIEW: 'O recebimento tem uma pendência de revisão no provedor.',
    PAYMENT_NOT_RECEIVED: 'O recebimento não está mais confirmado no caixa.',
    PAYMENT_VALUE_INVALID: 'O valor do recebimento requer revisão.',
    PAYMENT_NOT_TUITION: 'O recebimento não corresponde a uma mensalidade.',
    PAYMENT_SOURCE_CHANGED: 'A origem ou o valor do recebimento mudou e requer conciliação.',
};
export const prepaymentReviewReason = (reason: string): string =>
    REVIEW_REASONS[reason] || 'A cobertura requer revisão da direção; confira o histórico da origem financeira.';

export const prepaymentError = (code: unknown): string =>
    typeof code === 'string' && ERRORS[code]
        ? ERRORS[code]
        : 'Não foi possível confirmar a operação. Atualize os dados e confira o histórico antes de tentar novamente.';

export function isPrepaymentContext(value: unknown): value is PrepaymentContext {
    if (!value || typeof value !== 'object') return false;
    const context = value as PrepaymentContext;
    return context.ok === true && typeof context.can_write === 'boolean' &&
        Array.isArray(context.students) && Array.isArray(context.payments) &&
        Array.isArray(context.allocations) && Array.isArray(context.history);
}
