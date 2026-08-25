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

export function requiresProviderReconciliation(
  mutationWasAmbiguous: boolean,
  lookupCompleted: boolean,
): boolean {
  return mutationWasAmbiguous && !lookupCompleted;
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
  if (valid.length === 0) return { status: "CONFLICT" };
  valid.sort((left, right) =>
    `${left.createdAt || "9999"}:${left.id}`.localeCompare(
      `${right.createdAt || "9999"}:${right.id}`,
    )
  );
  return { status: "MATCH", id: valid[0].id };
}

export function resolveProviderCustomer(
  candidates: unknown,
  expectedReference: string,
  expectedCpfCnpj: string,
): ProviderResolution {
  if (!Array.isArray(candidates)) return { status: "CONFLICT" };
  const scoped = candidates.filter((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
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
  return identityMatches.length > 0
    ? stableMatch(identityMatches)
    : { status: "CONFLICT" };
}

export function resolveProviderSubscription(
  candidates: unknown,
  expected: {
    reference: string;
    customerId: string;
    billingType: SaasCheckoutBillingType;
    billingCycle: "MONTHLY" | "YEARLY";
    amount: number;
  },
): ProviderResolution {
  if (!Array.isArray(candidates)) return { status: "CONFLICT" };
  const scoped = candidates.filter((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
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
    Math.abs(Number(candidate.value) - expected.amount) < 0.005
  );
  if (scoped.length !== 1 || exactMatches.length !== 1) {
    return { status: "CONFLICT" };
  }
  return stableMatch(exactMatches);
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
