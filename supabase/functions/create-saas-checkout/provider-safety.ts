import {
  providerPaymentSplitMatches,
  type ProviderSplitPolicy,
} from "../_shared/student-provider-lifecycle.ts";

export type SaasCheckoutBillingType = "PIX" | "BOLETO";

export type ProviderResolution =
  | { status: "NONE" }
  | { status: "MATCH"; id: string }
  | { status: "CONFLICT" };

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

const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const digits = (value: unknown) => text(value).replace(/\D/g, "");

function normalizedFieldName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function containsCardMaterial(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== "object" || depth > 2) return false;
  if (Array.isArray(value)) {
    return value.some((item) => containsCardMaterial(item, depth + 1));
  }
  return Object.entries(value as Record<string, unknown>).some(([key, item]) =>
    CARD_FIELD_NAMES.has(normalizedFieldName(key)) ||
    containsCardMaterial(item, depth + 1)
  );
}

export function parseSaasCheckoutBillingType(
  value: unknown,
): SaasCheckoutBillingType | null {
  return value === "PIX" || value === "BOLETO" ? value : null;
}

export function normalizeProviderId(value: unknown): string | null {
  const id = text(value);
  return id.length > 0 && id.length <= 200 && /^[A-Za-z0-9_-]+$/.test(id)
    ? id
    : null;
}

export function saasCheckoutProviderReference(checkoutId: string): string {
  return `saas:${checkoutId}`;
}

function stableMatch(
  candidates: Array<Record<string, unknown>>,
): ProviderResolution {
  if (candidates.length === 0) return { status: "NONE" };
  const valid = candidates.flatMap((candidate) => {
    const id = normalizeProviderId(candidate.id);
    return id ? [{ id, createdAt: text(candidate.dateCreated) }] : [];
  });
  // externalReference is a reconciliation hint, not an idempotency key. Two
  // active objects occupying the same provider identity are never safe to
  // choose between automatically, even when their immutable fields match.
  if (valid.length !== 1) return { status: "CONFLICT" };
  return { status: "MATCH", id: valid[0].id };
}

export function resolveProviderCustomer(
  candidates: unknown,
  expectedReference: string,
  expectedCpfCnpj: string,
): ProviderResolution {
  if (!Array.isArray(candidates)) return { status: "CONFLICT" };
  const scoped = candidates.filter((candidate) => {
    if (
      !candidate || typeof candidate !== "object" || Array.isArray(candidate)
    ) {
      return false;
    }
    const record = candidate as Record<string, unknown>;
    return record.deleted !== true &&
      text(record.externalReference) === expectedReference;
  }) as Array<Record<string, unknown>>;
  if (scoped.length === 0) return { status: "NONE" };
  const identityMatches = scoped.filter((candidate) =>
    digits(candidate.cpfCnpj) === expectedCpfCnpj
  );
  if (scoped.length !== 1 || identityMatches.length !== 1) {
    return { status: "CONFLICT" };
  }
  return stableMatch(identityMatches);
}

export function resolveProviderSubscription(
  candidates: unknown,
  expected: {
    reference: string;
    customerId: string;
    billingType: SaasCheckoutBillingType;
    billingCycle: "MONTHLY" | "YEARLY";
    amount: number;
    description: string;
    maxPayments: null;
    splitPolicy: ProviderSplitPolicy;
    nextDueDate?: string;
    status?: "ACTIVE";
  },
): ProviderResolution {
  if (!Array.isArray(candidates)) return { status: "CONFLICT" };
  const scoped = candidates.filter((candidate) => {
    if (
      !candidate || typeof candidate !== "object" || Array.isArray(candidate)
    ) {
      return false;
    }
    const record = candidate as Record<string, unknown>;
    return record.deleted !== true &&
      text(record.externalReference) === expected.reference;
  }) as Array<Record<string, unknown>>;
  if (scoped.length === 0) return { status: "NONE" };
  const exactMatches = scoped.filter((candidate) =>
    text(candidate.customer) === expected.customerId &&
    text(candidate.billingType).toUpperCase() === expected.billingType &&
    text(candidate.cycle).toUpperCase() === expected.billingCycle &&
    Number.isFinite(Number(candidate.value)) &&
    Math.round(Number(candidate.value) * 100) ===
      Math.round(expected.amount * 100) &&
    text(candidate.description) === expected.description &&
    (candidate.maxPayments === null ||
      candidate.maxPayments === undefined || candidate.maxPayments === "") &&
    expected.maxPayments === null &&
    providerPaymentSplitMatches(candidate, expected.splitPolicy) &&
    (expected.nextDueDate === undefined ||
      text(candidate.nextDueDate) === expected.nextDueDate) &&
    (expected.status === undefined ||
      text(candidate.status).toUpperCase() === expected.status)
  );
  if (scoped.length !== 1 || exactMatches.length !== 1) {
    return { status: "CONFLICT" };
  }
  return stableMatch(exactMatches);
}

export function saasCheckoutNextDueDate(createdAt: unknown): string | null {
  const raw = text(createdAt);
  if (!raw) return null;
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) return null;
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString().slice(0, 10);
}

export function checkoutPayloadMatches(
  checkout: Record<string, unknown>,
  expected: {
    schoolName: string;
    ownerName: string;
    ownerEmail: string;
    ownerCpfCnpj: string;
    ownerPhone: string;
    planId: string;
    billingCycle: "MONTHLY" | "YEARLY";
    billingType: SaasCheckoutBillingType;
  },
): boolean {
  return text(checkout.school_name) === expected.schoolName &&
    text(checkout.owner_name) === expected.ownerName &&
    text(checkout.owner_email).toLowerCase() === expected.ownerEmail &&
    digits(checkout.owner_cpf_cnpj) === expected.ownerCpfCnpj &&
    digits(checkout.owner_phone) === expected.ownerPhone &&
    text(checkout.plan_id) === expected.planId &&
    text(checkout.billing_cycle) === expected.billingCycle &&
    text(checkout.billing_type) === expected.billingType;
}
