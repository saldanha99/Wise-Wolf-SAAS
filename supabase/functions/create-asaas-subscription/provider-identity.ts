/// <reference lib="deno.ns" />

import {
  providerPaymentSplitMatches,
  type ProviderSplitPolicy,
} from "../_shared/student-provider-lifecycle.ts";

export type ProviderBillingType = "PIX" | "BOLETO" | "CREDIT_CARD";

export type ProviderCandidateResolution =
  | { status: "MATCH"; id: string; providerStatus: string }
  | { status: "CONFLICT" };

export type ExpectedProviderCustomer = {
  providerId: string;
  externalReference: string;
  cpfCnpj: string;
};

export type ProviderCustomerResolution =
  | { status: "MATCH"; id: string }
  | { status: "CONFLICT" };

export type ProRataFailure = {
  error: string;
  state: "BLOCKED" | "FAILED" | "IN_PROGRESS" | "RETRY" | "UNKNOWN";
  httpStatus: number;
};

export type ExpectedProviderPayment = {
  externalReference: string;
  customerId: string;
  billingType: ProviderBillingType;
  value: number;
  dueDate: string;
  subscriptionId?: string | null;
  splitPolicy: ProviderSplitPolicy;
};

export type ExpectedProviderSubscription = {
  externalReference: string;
  customerId: string;
  billingType: ProviderBillingType;
  value: number;
  nextDueDate: string;
  cycle: "MONTHLY";
  status: "ACTIVE";
  maxPayments: number | null;
  splitPolicy: ProviderSplitPolicy;
};

const PAYMENT_STATUSES = new Set([
  "PENDING",
  "RECEIVED",
  "CONFIRMED",
  "OVERDUE",
  "REFUNDED",
  "RECEIVED_IN_CASH",
  "REFUND_REQUESTED",
  "REFUND_IN_PROGRESS",
  "CHARGEBACK_REQUESTED",
  "CHARGEBACK_DISPUTE",
  "AWAITING_CHARGEBACK_REVERSAL",
  "DUNNING_REQUESTED",
  "DUNNING_RECEIVED",
  "AWAITING_RISK_ANALYSIS",
  "APPROVED_BY_RISK_ANALYSIS",
  "REPROVED_BY_RISK_ANALYSIS",
  "AUTHORIZED",
  "PARTIALLY_REFUNDED",
  "REFUND_DENIED",
  "CANCELED",
  "CANCELLED",
  "DELETED",
  "RECEIVED_IN_CASH_UNDONE",
  "BANK_SLIP_CANCELLED",
  "CREDIT_CARD_CAPTURE_REFUSED",
]);

const PENDING_LEDGER_PROVIDER_STATUSES = new Set([
  "PENDING",
  "OVERDUE",
  "CONFIRMED",
  "DUNNING_REQUESTED",
  "DUNNING_RECEIVED",
  "AWAITING_RISK_ANALYSIS",
  "APPROVED_BY_RISK_ANALYSIS",
  "AUTHORIZED",
]);

const PROVIDER_STATUSES_WITHOUT_CREDIT_DATE = new Set([
  ...PENDING_LEDGER_PROVIDER_STATUSES,
  "REPROVED_BY_RISK_ANALYSIS",
  "CANCELED",
  "CANCELLED",
  "DELETED",
  "BANK_SLIP_CANCELLED",
  "CREDIT_CARD_CAPTURE_REFUSED",
  "RECEIVED_IN_CASH",
  "RECEIVED_IN_CASH_UNDONE",
]);

export function providerPaymentCanStartPendingLedger(
  providerStatus: unknown,
): boolean {
  return PENDING_LEDGER_PROVIDER_STATUSES.has(
    normalizedText(providerStatus).toUpperCase(),
  );
}

export function providerPaymentStatusRejectsCreditDate(
  providerStatus: unknown,
): boolean {
  return PROVIDER_STATUSES_WITHOUT_CREDIT_DATE.has(
    normalizedText(providerStatus).toUpperCase(),
  );
}

export function providerPaymentLedgerStatusMatches(
  providerStatus: unknown,
  localStatus: unknown,
): boolean {
  const provider = normalizedText(providerStatus).toUpperCase();
  const local = normalizedText(localStatus).toUpperCase();
  if (provider === "RECEIVED") return local === "RECEIVED";
  if (provider === "RECEIVED_IN_CASH") return local === "RECEIVED_IN_CASH";
  return providerPaymentCanStartPendingLedger(provider) &&
    ["PENDING", "OVERDUE", "RECEIVED", "RECEIVED_IN_CASH"].includes(local);
}

const CARD_FIELD_NAMES = new Set([
  "card",
  "cardnumber",
  "creditcard",
  "creditcardholderinfo",
  "ccnumber",
  "ccexpiry",
  "ccccv",
  "ccv",
  "cvv",
  "pan",
]);

const normalizedText = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";
const normalizedDigits = (value: unknown): string =>
  String(value || "").replace(/\D/g, "");

function normalizedFieldName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function amountMatches(actual: unknown, expected: number): boolean {
  const amount = Number(actual);
  return Number.isFinite(amount) &&
    Math.round(amount * 100) === Math.round(expected * 100);
}

function normalizeMaxPayments(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : Number.NaN;
}

function nextMonthlyDueDate(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const source = new Date(Date.UTC(year, month - 1, day));
  if (
    source.getUTCFullYear() !== year || source.getUTCMonth() !== month - 1 ||
    source.getUTCDate() !== day
  ) return null;

  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const lastDay = new Date(Date.UTC(nextYear, nextMonth, 0)).getUTCDate();
  return [
    String(nextYear).padStart(4, "0"),
    String(nextMonth).padStart(2, "0"),
    String(Math.min(day, lastDay)).padStart(2, "0"),
  ].join("-");
}

function subscriptionDueDateMatches(
  actual: unknown,
  expectedFirstDueDate: string,
): boolean {
  const providerDueDate = normalizedText(actual);
  return providerDueDate === expectedFirstDueDate ||
    providerDueDate === nextMonthlyDueDate(expectedFirstDueDate);
}

export function normalizeProviderEntityId(value: unknown): string | null {
  const id = normalizedText(value);
  return id.length > 0 && id.length <= 200 && /^[A-Za-z0-9_-]+$/.test(id)
    ? id
    : null;
}

export function occupiesProviderReference(
  candidate: Record<string, unknown>,
  externalReference: string,
): boolean {
  return normalizedText(candidate.externalReference) === externalReference;
}

export function occupiesProviderCustomerIdentity(
  candidate: Record<string, unknown>,
  expected: ExpectedProviderCustomer,
): boolean {
  return normalizedText(candidate.externalReference) ===
      expected.externalReference ||
    normalizedDigits(candidate.cpfCnpj) === expected.cpfCnpj;
}

export function resolveProviderCustomerCandidate(
  candidate: unknown,
  expected: ExpectedProviderCustomer,
): ProviderCustomerResolution {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { status: "CONFLICT" };
  }
  const record = candidate as Record<string, unknown>;
  const id = normalizeProviderEntityId(record.id);
  if (
    !id || id !== expected.providerId || record.deleted === true ||
    normalizedText(record.externalReference) !== expected.externalReference ||
    normalizedDigits(record.cpfCnpj) !== expected.cpfCnpj
  ) {
    return { status: "CONFLICT" };
  }
  return { status: "MATCH", id };
}

export function classifyProRataFailure(error: unknown): ProRataFailure {
  const code = error instanceof Error ? error.message : "";
  if (code === "provider_pro_rata_creation_rejected") {
    return {
      error: code,
      state: "FAILED",
      httpStatus: 502,
    };
  }
  if (code === "provider_pro_rata_in_progress") {
    return {
      error: code,
      state: "IN_PROGRESS",
      httpStatus: 409,
    };
  }
  if (
    code === "pro_rata_creation_outcome_unknown" ||
    code === "provider_pro_rata_reconciliation_pending" ||
    code === "provider_pro_rata_claim_lookup_unavailable"
  ) {
    return {
      error: code,
      state: "UNKNOWN",
      httpStatus: code === "provider_pro_rata_reconciliation_pending"
        ? 409
        : 503,
    };
  }
  if (
    code === "pro_rata_recovery_lookup_unavailable" ||
    code === "asaas_creation_claim_failed" ||
    code === "pro_rata_split_configuration_unavailable" ||
    code === "credit_card_required_before_submit" ||
    code === "card_holder_incomplete_before_submit"
  ) {
    return {
      error: code,
      state: "RETRY",
      httpStatus: code === "credit_card_required_before_submit" ||
          code === "card_holder_incomplete_before_submit"
        ? 400
        : 503,
    };
  }
  if (
    code === "provider_pro_rata_creation_requires_review" ||
    code === "provider_pro_rata_requires_review" ||
    code === "provider_pro_rata_claim_id_invalid" ||
    code === "provider_pro_rata_claim_not_found_or_invalid" ||
    code === "provider_pro_rata_claim_payload_conflict" ||
    code === "provider_pro_rata_claim_identity_conflict" ||
    code === "provider_pro_rata_id_missing" ||
    code === "provider_pro_rata_response_payload_conflict" ||
    code === "sensitive_card_material_in_pro_rata_claim" ||
    code === "pro_rata_due_date_invalid" ||
    code === "pro_rata_split_configuration_invalid" ||
    code === "pro_rata_split_configuration_changed" ||
    code === "billing_creation_legacy_reference_requires_review"
  ) {
    return {
      error: code,
      state: "BLOCKED",
      httpStatus: 409,
    };
  }
  return {
    error: "pro_rata_processing_failed",
    state: "BLOCKED",
    httpStatus: 500,
  };
}

export function resolveProviderPaymentCandidate(
  candidate: unknown,
  expected: ExpectedProviderPayment,
): ProviderCandidateResolution {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { status: "CONFLICT" };
  }
  const record = candidate as Record<string, unknown>;
  const id = normalizeProviderEntityId(record.id);
  const providerStatus = normalizedText(record.status).toUpperCase();
  const expectedSubscription = expected.subscriptionId;
  const subscriptionMatches = expectedSubscription === undefined ||
    (expectedSubscription === null
      ? normalizedText(record.subscription) === ""
      : normalizedText(record.subscription) === expectedSubscription);
  if (
    !id || record.deleted === true ||
    normalizedText(record.externalReference) !== expected.externalReference ||
    normalizedText(record.customer) !== expected.customerId ||
    normalizedText(record.billingType).toUpperCase() !== expected.billingType ||
    !amountMatches(record.value, expected.value) ||
    normalizedText(record.dueDate) !== expected.dueDate ||
    !PAYMENT_STATUSES.has(providerStatus) ||
    !subscriptionMatches ||
    !providerPaymentSplitMatches(record, expected.splitPolicy)
  ) {
    return { status: "CONFLICT" };
  }
  return { status: "MATCH", id, providerStatus };
}

export function resolveProviderSubscriptionCandidate(
  candidate: unknown,
  expected: ExpectedProviderSubscription,
): ProviderCandidateResolution {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { status: "CONFLICT" };
  }
  const record = candidate as Record<string, unknown>;
  const id = normalizeProviderEntityId(record.id);
  const providerStatus = normalizedText(record.status).toUpperCase();
  const providerMaxPayments = normalizeMaxPayments(record.maxPayments);
  if (
    !id || record.deleted === true ||
    normalizedText(record.externalReference) !== expected.externalReference ||
    normalizedText(record.customer) !== expected.customerId ||
    normalizedText(record.billingType).toUpperCase() !== expected.billingType ||
    !amountMatches(record.value, expected.value) ||
    !subscriptionDueDateMatches(record.nextDueDate, expected.nextDueDate) ||
    normalizedText(record.cycle).toUpperCase() !== expected.cycle ||
    providerStatus !== expected.status ||
    !Object.is(providerMaxPayments, expected.maxPayments) ||
    !providerPaymentSplitMatches(record, expected.splitPolicy)
  ) {
    return { status: "CONFLICT" };
  }
  return { status: "MATCH", id, providerStatus };
}

export function containsSensitiveCardMaterial(
  value: unknown,
  depth = 0,
): boolean {
  if (!value || typeof value !== "object" || depth > 3) return false;
  if (Array.isArray(value)) {
    return value.some((item) => containsSensitiveCardMaterial(item, depth + 1));
  }
  return Object.entries(value as Record<string, unknown>).some(([key, item]) =>
    CARD_FIELD_NAMES.has(normalizedFieldName(key)) ||
    containsSensitiveCardMaterial(item, depth + 1)
  );
}

export function creationAnchorCandidates(
  storedCreatedAt: Date | null,
  fallbackNow: Date,
): Date[] {
  const primary = storedCreatedAt ?? fallbackNow;
  if (!Number.isFinite(primary.getTime())) return [];
  if (!storedCreatedAt) return [primary];
  const parts = saoPauloDateParts(primary);
  if (!parts) return [];
  // The pre-claim snapshot can only belong to the same Sao Paulo business day
  // or the immediately preceding one when the claim crosses local midnight.
  const previousBusinessDay = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day - 1, 15, 0, 0),
  );
  return [primary, previousBusinessDay];
}

export async function selectFrozenCreationCandidate<T>(input: {
  candidates: T[];
  storedFingerprint: string | null;
  fingerprintFor: (candidate: T) => Promise<string>;
}): Promise<{
  candidate: T;
  fingerprint: string;
  matchedStoredFingerprint: boolean;
}> {
  if (input.candidates.length === 0) {
    throw new Error("creation_snapshot_candidates_empty");
  }
  let first: { candidate: T; fingerprint: string } | null = null;
  for (const candidate of input.candidates) {
    const fingerprint = await input.fingerprintFor(candidate);
    first ??= { candidate, fingerprint };
    if (
      input.storedFingerprint && fingerprint === input.storedFingerprint
    ) {
      return { candidate, fingerprint, matchedStoredFingerprint: true };
    }
    if (!input.storedFingerprint) {
      return { candidate, fingerprint, matchedStoredFingerprint: true };
    }
  }
  return {
    candidate: first!.candidate,
    fingerprint: first!.fingerprint,
    matchedStoredFingerprint: false,
  };
}

function saoPauloDateParts(anchor: Date): {
  year: number;
  month: number;
  day: number;
} | null {
  if (!Number.isFinite(anchor.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(anchor);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const day = Number(parts.find((part) => part.type === "day")?.value);
  return Number.isInteger(year) && Number.isInteger(month) &&
      Number.isInteger(day)
    ? { year, month, day }
    : null;
}

export function billingDateFromAnchor(anchor: Date): string | null {
  const parts = saoPauloDateParts(anchor);
  if (!parts) return null;
  const year = parts.year.toString().padStart(4, "0");
  const month = parts.month.toString().padStart(2, "0");
  const day = parts.day.toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function canonicalFutureBillingDate(
  value: unknown,
  minimumDate: string,
): string | null {
  const candidate = normalizedText(value);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(candidate) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(minimumDate)
  ) return null;
  const parsed = new Date(`${candidate}T00:00:00.000Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== candidate ||
    candidate < minimumDate
  ) return null;
  return candidate;
}

export function nextDueDateFromAnchor(
  dueDay: number,
  startMonth: string | undefined,
  anchor: Date,
): string | null {
  if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) return null;
  const current = saoPauloDateParts(anchor);
  if (!current) return null;
  let year = current.year;
  let month = current.month - 1;

  if (startMonth && /^\d{4}-\d{2}$/.test(startMonth)) {
    const parsed = startMonth.split("-").map(Number);
    if (
      parsed[0] < 2000 || parsed[0] > 9999 || parsed[1] < 1 || parsed[1] > 12
    ) {
      return null;
    }
    year = parsed[0];
    month = parsed[1] - 1;
  } else if (startMonth) {
    return null;
  } else if (current.day >= dueDay) {
    month += 1;
  }

  const todayUtc = Date.UTC(current.year, current.month - 1, current.day);
  let normalizedYear = year + Math.floor(month / 12);
  let normalizedMonth = ((month % 12) + 12) % 12;
  let lastDay = new Date(Date.UTC(normalizedYear, normalizedMonth + 1, 0))
    .getUTCDate();
  let candidate = Date.UTC(
    normalizedYear,
    normalizedMonth,
    Math.min(dueDay, lastDay),
  );

  while (candidate < todayUtc) {
    month += 1;
    normalizedYear = year + Math.floor(month / 12);
    normalizedMonth = ((month % 12) + 12) % 12;
    lastDay = new Date(Date.UTC(normalizedYear, normalizedMonth + 1, 0))
      .getUTCDate();
    candidate = Date.UTC(
      normalizedYear,
      normalizedMonth,
      Math.min(dueDay, lastDay),
    );
  }

  return new Date(candidate).toISOString().slice(0, 10);
}
