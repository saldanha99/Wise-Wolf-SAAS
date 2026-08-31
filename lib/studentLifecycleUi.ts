export type StudentOffboardingPolicy = 'CHARGE_CURRENT_MONTH' | 'WAIVE_CURRENT_MONTH';

export type CurrentMonthInvoicePreview = {
  id: unknown;
  value: unknown;
  dueDate: unknown;
  status: unknown;
  providerStatus?: unknown;
  asaasPaymentId?: unknown;
  legacyAsaasPaymentId?: unknown;
};

const CONFIRMED_OR_RECEIVED_CURRENT_MONTH_STATUSES = new Set([
  'CONFIRMED',
  'RECEIVED',
  'RECEIVED_IN_CASH',
  'PAGO',
  'PAID',
]);

const NON_LIVE_CURRENT_MONTH_STATUSES = new Set([
  'CANCELLED',
  'DELETED',
  'REFUNDED',
  'REVERSED',
]);

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const normalized = (value: unknown): string => String(value || '').trim().toUpperCase();
const trimmed = (value: unknown): string => String(value || '').trim();

export function isConfirmedOrReceivedCurrentMonthStatus(status: unknown): boolean {
  return CONFIRMED_OR_RECEIVED_CURRENT_MONTH_STATUSES.has(normalized(status));
}

export function isLiveCurrentMonthInvoiceStatus(status: unknown): boolean {
  const value = normalized(status);
  return Boolean(value) && !NON_LIVE_CURRENT_MONTH_STATUSES.has(value);
}

export function isOpenRecurringPaymentStatus(status: unknown): boolean {
  return ['PENDING', 'OVERDUE'].includes(normalized(status));
}

export function hasConsistentAsaasPaymentIdentity(
  payment: Pick<CurrentMonthInvoicePreview, 'asaasPaymentId' | 'legacyAsaasPaymentId'>,
): boolean {
  const primaryId = trimmed(payment.asaasPaymentId);
  const legacyId = trimmed(payment.legacyAsaasPaymentId);
  return Boolean(primaryId || legacyId) && (!primaryId || !legacyId || primaryId === legacyId);
}

/**
 * Espelha a prova local mínima exigida pelo backend antes de preservar a
 * competência. A existência e o estado da cobrança no Asaas ainda são
 * revalidados autoritativamente pela Edge Function.
 */
export function canPreserveExactlyOneCurrentMonthInvoice(
  payments: CurrentMonthInvoicePreview[],
): boolean {
  const livePayments = payments.filter(payment => isLiveCurrentMonthInvoiceStatus(payment.status));
  if (livePayments.length !== 1) return false;

  const payment = livePayments[0];
  const providerStatus = normalized(payment.providerStatus || payment.status);
  return UUID_PATTERN.test(trimmed(payment.id))
    && /^\d{4}-\d{2}-\d{2}$/.test(trimmed(payment.dueDate))
    && Number.isFinite(Number(payment.value))
    && Number(payment.value) > 0
    && Boolean(normalized(payment.status))
    && Boolean(providerStatus)
    && hasConsistentAsaasPaymentIdentity(payment);
}

/**
 * "Sem nova cobrança" não apaga uma cobrança já confirmada ou recebida. Ela
 * só pode ser preservada quando a prévia prova sua identidade local no Asaas.
 */
export function noNewChargePolicy(
  hasConfirmedOrReceivedCurrentMonth: boolean,
  canPreserveCurrentMonth = true,
): StudentOffboardingPolicy | null {
  if (!hasConfirmedOrReceivedCurrentMonth) return 'WAIVE_CURRENT_MONTH';
  return canPreserveCurrentMonth ? 'CHARGE_CURRENT_MONTH' : null;
}

export function saoPauloCalendarDate(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
