export type AsaasRefund = {
  value?: number | null;
  status?: string | null;
};

export type AsaasPaymentSnapshot = {
  id?: string | null;
  status?: string | null;
  value?: number | null;
  subscription?: string | null;
  paymentDate?: string | null;
  creditDate?: string | null;
  estimatedCreditDate?: string | null;
  refundedValue?: number | null;
  refunds?: AsaasRefund[] | null;
};

export type ExistingPaymentEventState = {
  status?: string | null;
  last_provider_event_at?: string | null;
  last_provider_event_rank?: number | null;
};

const COMPLETED_REFUND_STATUSES = new Set(["DONE"]);

export const SETTLED_PAYMENT_EVENTS: ReadonlySet<string> = new Set([
  "PAYMENT_RECEIVED",
  "PAYMENT_RECEIVED_IN_CASH",
]);

export type EnrollmentPaymentBinding = {
  enrollmentPaymentId?: string | null;
  oneTimePaymentId?: string | null;
  subscriptionId?: string | null;
  subscriptionActivationPaymentId?: string | null;
  requiresEnrollmentPayment?: boolean | null;
};

export type EnrollmentPaymentKind =
  | "ENROLLMENT_FEE"
  | "ONE_TIME"
  | "SUBSCRIPTION_ACTIVATION";

function normalizedId(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function monetaryCents(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) && numeric > 0
    ? Math.round(numeric * 100)
    : null;
}

function normalizedAsaasDate(value: unknown): string {
  const date = normalizedId(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "";
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Only references emitted by our own payment writers may name a student.
 * Unknown prefixes remain hints and must fall back to the canonical customer
 * binding instead of being parsed permissively.
 */
export function studentIdFromKnownPaymentReference(
  externalReference: unknown,
): string | null {
  const reference = normalizedId(externalReference);
  if (UUID_PATTERN.test(reference)) return reference;

  const manualPix = reference.match(
    /^manual-pix:([0-9a-f-]{36}):student:([0-9a-f-]{36})$/i,
  );
  if (
    manualPix &&
    UUID_PATTERN.test(manualPix[1]) &&
    UUID_PATTERN.test(manualPix[2])
  ) {
    return manualPix[2];
  }
  return null;
}

export function providerGeneratedSubscriptionPaymentMatches(
  payment: {
    customer?: unknown;
    subscription?: unknown;
    externalReference?: unknown;
  },
  parentSubscription: unknown,
  expected: {
    studentId: string;
    customerId: string;
    subscriptionId: string;
  },
): boolean {
  if (
    !parentSubscription || typeof parentSubscription !== "object" ||
    Array.isArray(parentSubscription)
  ) {
    return false;
  }
  const parent = parentSubscription as Record<string, unknown>;
  const parentReference = normalizedId(parent.externalReference);
  const paymentReference = normalizedId(payment.externalReference);
  return parent.deleted !== true &&
    normalizedId(payment.subscription) === expected.subscriptionId &&
    normalizedId(payment.customer) === expected.customerId &&
    normalizedId(parent.id) === expected.subscriptionId &&
    normalizedId(parent.customer) === expected.customerId &&
    parseCanonicalAsaasReference(
        parentReference,
        expected.studentId,
        "subscription",
      ) !== null &&
    (!paymentReference || paymentReference === parentReference);
}

/**
 * Legacy Asaas subscriptions may generate installments without any
 * externalReference. This is deliberately narrower than the canonical
 * reference path: it only corroborates an already-known local payment after
 * fresh GETs of both that payment and its exact parent subscription. The
 * parent price is intentionally not compared with the historical installment:
 * Asaas keeps old charges immutable when a subscription is repriced.
 */
export function legacyRecurringProviderEvidenceMatches(
  webhookPayment: {
    id?: unknown;
    customer?: unknown;
    subscription?: unknown;
    externalReference?: unknown;
    value?: unknown;
    dueDate?: unknown;
    status?: unknown;
  },
  authoritativePayment: unknown,
  authoritativeSubscription: unknown,
  expected: {
    paymentId: string;
    customerId: string;
    subscriptionId: string;
    value: number;
    dueDate: string;
    status: "RECEIVED" | "RECEIVED_IN_CASH";
  },
): boolean {
  if (
    !authoritativePayment || typeof authoritativePayment !== "object" ||
    Array.isArray(authoritativePayment) ||
    !authoritativeSubscription ||
    typeof authoritativeSubscription !== "object" ||
    Array.isArray(authoritativeSubscription)
  ) {
    return false;
  }

  const payment = authoritativePayment as Record<string, unknown>;
  const subscription = authoritativeSubscription as Record<string, unknown>;
  const expectedCents = monetaryCents(expected.value);
  const expectedDueDate = normalizedAsaasDate(expected.dueDate);
  if (
    !expected.paymentId.trim() || !expected.customerId.trim() ||
    !expected.subscriptionId.trim() || expectedCents === null ||
    !expectedDueDate
  ) {
    return false;
  }

  const paymentEvidenceMatches = (
    candidate: typeof webhookPayment | Record<string, unknown>,
  ): boolean =>
    normalizedId(candidate.id) === expected.paymentId &&
    normalizedId(candidate.customer) === expected.customerId &&
    normalizedId(candidate.subscription) === expected.subscriptionId &&
    normalizedId(candidate.externalReference) === "" &&
    monetaryCents(candidate.value) === expectedCents &&
    normalizedAsaasDate(candidate.dueDate) === expectedDueDate &&
    normalizedId(candidate.status).toUpperCase() === expected.status;

  return payment.deleted !== true &&
    paymentEvidenceMatches(webhookPayment) &&
    paymentEvidenceMatches(payment) &&
    normalizedId(subscription.id) === expected.subscriptionId &&
    normalizedId(subscription.customer) === expected.customerId &&
    normalizedId(subscription.externalReference) === "" &&
    normalizedId(subscription.status) !== "";
}

/**
 * A PAYMENT_DELETED notification is not enough to erase money or debt. Only a
 * fresh GET of the same, explicitly deleted provider object can cancel an
 * already-known local payment that has never settled.
 */
export function deletedUnsettledProviderPaymentMatches(
  webhookPayment: {
    id?: unknown;
    customer?: unknown;
    subscription?: unknown;
    externalReference?: unknown;
    value?: unknown;
    dueDate?: unknown;
    status?: unknown;
  },
  authoritativePayment: unknown,
  expected: {
    paymentId: string;
    customerId: string;
    subscriptionId: string;
    value: number;
    dueDate: string;
    providerStatus: string;
  },
): boolean {
  if (
    !authoritativePayment || typeof authoritativePayment !== "object" ||
    Array.isArray(authoritativePayment)
  ) {
    return false;
  }
  const payment = authoritativePayment as Record<string, unknown>;
  const expectedCents = monetaryCents(expected.value);
  const expectedDueDate = normalizedAsaasDate(expected.dueDate);
  const expectedProviderStatus = normalizedId(expected.providerStatus)
    .toUpperCase();
  if (
    !expected.paymentId.trim() || !expected.customerId.trim() ||
    !expected.subscriptionId.trim() || expectedCents === null ||
    !expectedDueDate || !expectedProviderStatus
  ) {
    return false;
  }
  const exactCore = (
    candidate: typeof webhookPayment | Record<string, unknown>,
  ): boolean =>
    normalizedId(candidate.id) === expected.paymentId &&
    normalizedId(candidate.customer) === expected.customerId &&
    normalizedId(candidate.subscription) === expected.subscriptionId &&
    monetaryCents(candidate.value) === expectedCents &&
    normalizedAsaasDate(candidate.dueDate) === expectedDueDate &&
    normalizedId(candidate.status).toUpperCase() === expectedProviderStatus;

  return payment.deleted === true &&
    exactCore(webhookPayment) &&
    exactCore(payment) &&
    normalizedId(payment.externalReference) ===
      normalizedId(webhookPayment.externalReference) &&
    normalizedId(payment.creditDate) === "";
}

export function isSettledPaymentEvent(eventName: string): boolean {
  return SETTLED_PAYMENT_EVENTS.has(eventName);
}

const PROVEN_HISTORICAL_REVERSAL_EVENTS = new Set([
  "PAYMENT_REFUNDED",
  "PAYMENT_PARTIALLY_REFUNDED",
  "PAYMENT_RECEIVED_IN_CASH_UNDONE",
]);

/**
 * Events that can correct an already persisted payment even after the tenant
 * or student membership was deactivated. This excludes requests, disputes and
 * deletions because none of them proves that money has left the account.
 */
export function isProvenHistoricalReversalEvent(eventName: string): boolean {
  return PROVEN_HISTORICAL_REVERSAL_EVENTS.has(eventName);
}

/**
 * Binds the provider payment to the exact enrollment prerequisite. A first
 * recurring charge may establish the durable activation payment id only on a
 * settled event; reversals and later installments must match that stored id.
 */
export function enrollmentPaymentKind(
  binding: EnrollmentPaymentBinding,
  payment: Pick<AsaasPaymentSnapshot, "id" | "subscription">,
  allowInitialSubscriptionActivation = false,
): EnrollmentPaymentKind | null {
  const paymentId = normalizedId(payment.id);
  if (!paymentId) return null;
  if (paymentId === normalizedId(binding.enrollmentPaymentId)) {
    return "ENROLLMENT_FEE";
  }
  if (paymentId === normalizedId(binding.oneTimePaymentId)) {
    return "ONE_TIME";
  }
  const activationPaymentId = normalizedId(
    binding.subscriptionActivationPaymentId,
  );
  if (activationPaymentId) {
    return paymentId === activationPaymentId ? "SUBSCRIPTION_ACTIVATION" : null;
  }
  if (
    allowInitialSubscriptionActivation &&
    binding.requiresEnrollmentPayment !== true &&
    normalizedId(payment.subscription) !== "" &&
    normalizedId(payment.subscription) === normalizedId(binding.subscriptionId)
  ) {
    return "SUBSCRIPTION_ACTIVATION";
  }
  return null;
}

const TERMINAL_REVERSAL_EVENTS = new Set([
  "PAYMENT_REFUNDED",
  "PAYMENT_DELETED",
  "PAYMENT_CHARGEBACK_REQUESTED",
  "PAYMENT_RECEIVED_IN_CASH_UNDONE",
]);

export function providerEventRank(eventName: string): number {
  if (TERMINAL_REVERSAL_EVENTS.has(eventName)) return 100;
  if (eventName === "PAYMENT_REFUND_IN_PROGRESS") return 95;
  if (eventName === "PAYMENT_PARTIALLY_REFUNDED") return 90;
  if (eventName === "PAYMENT_RECEIVED_IN_CASH") return 80;
  if (eventName === "PAYMENT_RECEIVED") return 80;
  if (eventName === "PAYMENT_CONFIRMED") return 60;
  if (eventName === "PAYMENT_OVERDUE") return 40;
  if (eventName === "PAYMENT_UPDATED") return 30;
  if (eventName === "PAYMENT_CREATED") return 20;
  return 10;
}

/**
 * Asaas commonly sends date-only fields. Noon UTC prevents a calendar day
 * from moving backwards when rendered in Brazil while keeping the convention
 * explicit and deterministic.
 */
export function asaasDateToIso(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const parsed = new Date(`${trimmed}T12:00:00.000Z`);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  // Webhook dateCreated examples use "YYYY-MM-DD HH:mm:ss". Treat a missing
  // zone as UTC for ordering only; financial competence uses the date fields.
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmed)
    ? `${trimmed.replace(" ", "T")}Z`
    : trimmed;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function completedRefundAmount(
  payment: AsaasPaymentSnapshot,
  eventName: string,
): number {
  const originalValue = Number(payment.value);
  const cap = Number.isFinite(originalValue) && originalValue >= 0
    ? originalValue
    : Number.POSITIVE_INFINITY;
  const providerTotal = Number(payment.refundedValue);
  const refundsTotal = Array.isArray(payment.refunds)
    ? payment.refunds.reduce((total, refund) => {
      const value = Number(refund?.value);
      const status = String(refund?.status || "").toUpperCase();
      const completed = COMPLETED_REFUND_STATUSES.has(status);
      return (
        total + (completed && Number.isFinite(value) && value > 0 ? value : 0)
      );
    }, 0)
    : 0;
  const fullRefund = (
      eventName === "PAYMENT_REFUNDED" ||
      eventName === "PAYMENT_RECEIVED_IN_CASH_UNDONE"
    ) &&
      Number.isFinite(originalValue) &&
      originalValue > 0
    ? originalValue
    : 0;
  const cumulative = Math.max(
    Number.isFinite(providerTotal) && providerTotal > 0 ? providerTotal : 0,
    refundsTotal,
    fullRefund,
  );
  return Math.min(cap, Math.max(0, Math.round(cumulative * 100) / 100));
}

export function shouldApplyProviderEvent(
  existing: ExistingPaymentEventState | null | undefined,
  incomingEventAt: string,
  incomingRank: number,
): boolean {
  if (!existing?.last_provider_event_at) return true;
  const currentTime = Date.parse(existing.last_provider_event_at);
  const incomingTime = Date.parse(incomingEventAt);
  if (!Number.isFinite(currentTime) || !Number.isFinite(incomingTime)) {
    return incomingRank >= Number(existing.last_provider_event_rank || 0);
  }
  if (incomingTime > currentTime) return true;
  if (incomingTime < currentTime) return false;
  return incomingRank >= Number(existing.last_provider_event_rank || 0);
}

export function paymentCustomerMatchesCanonicalBinding(
  canonicalCustomerId: unknown,
  providerCustomerId: unknown,
): boolean {
  return Boolean(
    typeof canonicalCustomerId === "string" &&
      canonicalCustomerId.trim() &&
      typeof providerCustomerId === "string" &&
      providerCustomerId.trim() &&
      canonicalCustomerId.trim() === providerCustomerId.trim(),
  );
}

export function localStatusAfterProviderEvent(
  currentStatus: string | null | undefined,
  providerStatus: string,
  eventName: string,
  refundedAmount = 0,
  originalValue?: number | null,
): string {
  if (currentStatus === "NAO_RECEITA") return "NAO_RECEITA";

  const paid = currentStatus === "RECEIVED" ||
    currentStatus === "RECEIVED_IN_CASH" ||
    currentStatus === "PAGO";
  const fullRefund = Number.isFinite(Number(originalValue)) &&
    Number(originalValue) > 0 &&
    refundedAmount >= Number(originalValue);

  // A proven full reversal always wins over a contradictory snapshot status.
  // Keep the provider's raw value in provider_status, while the canonical local
  // status remains REFUNDED so access and accounting cannot regress to paid.
  if (
    eventName === "PAYMENT_RECEIVED_IN_CASH_UNDONE" ||
    eventName === "PAYMENT_REFUNDED" ||
    fullRefund
  ) {
    return "REFUNDED";
  }

  // A completed partial refund changes the net amount, but the remaining
  // balance is still settled cash. This also covers a PAYMENT_UPDATED snapshot
  // carrying a DONE refund item, not only PAYMENT_PARTIALLY_REFUNDED.
  if (paid && refundedAmount > 0 && !fullRefund) return currentStatus!;

  // These are warnings or intermediate states, not proof that available cash
  // left the account. Keeping the settled local status also keeps its ledger
  // entry; provider_status and reconciliation issues retain the new signal.
  if (
    paid &&
    (eventName === "PAYMENT_REFUND_IN_PROGRESS" ||
      eventName === "PAYMENT_CHARGEBACK_REQUESTED" ||
      eventName === "PAYMENT_CHARGEBACK_DISPUTE" ||
      eventName === "PAYMENT_AWAITING_CHARGEBACK_REVERSAL" ||
      eventName === "PAYMENT_DELETED" ||
      eventName === "PAYMENT_PARTIALLY_REFUNDED")
  ) {
    return currentStatus!;
  }

  return providerStatus;
}

export function financialReviewReason(
  eventName: string,
  currentStatus: string | null | undefined,
  refundedAmount: number,
): string | null {
  const paid = currentStatus === "RECEIVED" ||
    currentStatus === "RECEIVED_IN_CASH" ||
    currentStatus === "PAGO";
  if (eventName === "PAYMENT_REFUND_IN_PROGRESS") return "refund_in_progress";
  if (
    eventName.startsWith("PAYMENT_CHARGEBACK") ||
    eventName === "PAYMENT_AWAITING_CHARGEBACK_REVERSAL"
  ) {
    return "chargeback_not_final";
  }
  if (eventName === "PAYMENT_DELETED" && paid) {
    return "paid_payment_deleted_without_proven_reversal";
  }
  if (eventName === "PAYMENT_PARTIALLY_REFUNDED" && refundedAmount <= 0) {
    return "partial_refund_amount_unproven";
  }
  return null;
}

export function actualCreditAt(
  eventName: string,
  payment: AsaasPaymentSnapshot,
): string | null {
  if (eventName !== "PAYMENT_RECEIVED") return null;
  return asaasDateToIso(payment.creditDate);
}
import { parseCanonicalAsaasReference } from "../_shared/asaas-mutation-guard.ts";
