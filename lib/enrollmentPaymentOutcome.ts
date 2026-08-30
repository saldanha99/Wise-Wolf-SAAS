export type EnrollmentPaymentCheck = {
    paid?: boolean;
    status?: string | null;
    enrollment_complete?: boolean;
};

export type EnrollmentPaymentOutcome =
    | 'PENDING'
    | 'SETTLED_AWAITING_COMPLETION'
    | 'COMPLETE';

export type PendingEnrollmentPaymentKind =
    | 'ENROLLMENT_FEE'
    | 'ONE_TIME'
    | 'RECURRING_FIRST_PAYMENT';

export type EnrollmentProgressCheck = {
    success?: boolean;
    status?: string | null;
};

export type EnrollmentProgressOutcome =
    | 'UNAVAILABLE'
    | 'AWAITING_PAYMENT'
    | 'NOT_COMPLETE'
    | 'COMPLETE';

const SETTLED_PAYMENT_STATUSES = new Set(['RECEIVED', 'CONFIRMED']);

/**
 * Payment settlement and enrollment completion are separate facts. A paid
 * enrollment fee can still leave a pro-rata or one-time charge outstanding.
 * The UI therefore fails closed unless the server explicitly confirms that
 * the complete enrollment state machine reached COMPLETED.
 */
export const classifyEnrollmentPaymentOutcome = (
    result: EnrollmentPaymentCheck | null | undefined,
): EnrollmentPaymentOutcome => {
    const paymentSettled = result?.paid === true
        || SETTLED_PAYMENT_STATUSES.has(String(result?.status || '').toUpperCase());

    if (!paymentSettled) return 'PENDING';
    if (result?.enrollment_complete === true) return 'COMPLETE';
    return 'SETTLED_AWAITING_COMPLETION';
};

export const getPendingEnrollmentPaymentKind = (
    enrollmentFee: number,
    planDuration: number,
): PendingEnrollmentPaymentKind => {
    if (enrollmentFee > 0) return 'ENROLLMENT_FEE';
    if (planDuration === 0) return 'ONE_TIME';
    return 'RECURRING_FIRST_PAYMENT';
};

export const getEnrollmentConfirmationSource = (
    kind: PendingEnrollmentPaymentKind,
): 'PAYMENT_PROVIDER' | 'ENROLLMENT_PROGRESS' => (
    kind === 'RECURRING_FIRST_PAYMENT'
        ? 'ENROLLMENT_PROGRESS'
        : 'PAYMENT_PROVIDER'
);

export const classifyEnrollmentProgressOutcome = (
    progress: EnrollmentProgressCheck | null | undefined,
): EnrollmentProgressOutcome => {
    if (progress?.success !== true) return 'UNAVAILABLE';

    const status = String(progress.status || '').toUpperCase();
    if (status === 'COMPLETED') return 'COMPLETE';
    if (status === 'AWAITING_PAYMENT') return 'AWAITING_PAYMENT';
    return 'NOT_COMPLETE';
};

export const getPendingEnrollmentPaymentPresentation = (
    kind: PendingEnrollmentPaymentKind | null | undefined,
    amount: number,
): { title: string; amountLabel: string; showAmount: boolean } => {
    const showAmount = Number.isFinite(amount) && amount > 0;

    if (kind === 'ONE_TIME') {
        return {
            title: 'Pagamento da Aula Avulsa',
            amountLabel: 'Valor a Pagar',
            showAmount,
        };
    }
    if (kind === 'RECURRING_FIRST_PAYMENT') {
        return {
            title: 'Primeira Mensalidade Pendente',
            amountLabel: 'Valor da primeira mensalidade',
            showAmount,
        };
    }
    if (kind === 'ENROLLMENT_FEE') {
        return {
            title: 'Taxa de Matrícula',
            amountLabel: 'Valor a Pagar',
            showAmount,
        };
    }
    return {
        title: 'Confirmação de Pagamento',
        amountLabel: 'Valor a Pagar',
        showAmount: false,
    };
};
