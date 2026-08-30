import {
  providerPaymentSplitMatches,
  type ProviderSplitPolicy,
} from "../_shared/student-provider-lifecycle.ts";

export type WolfieTopupPaymentExpectation = {
  reference: string;
  customerId: string;
  value: number;
  dueDate: string;
  description: string;
  splitPolicy: ProviderSplitPolicy;
};

type CreationClaimAction =
  | "SUBMIT_ONCE"
  | "RECONCILE_REQUIRED"
  | "ALREADY_SUCCEEDED"
  | "IN_PROGRESS"
  | "REVIEW_REQUIRED";

type CollectionLookupKind =
  | "FOUND"
  | "NOT_FOUND"
  | "CONFLICT"
  | "DUPLICATE"
  | "UNAVAILABLE";

const text = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

function sameMoney(left: unknown, right: number): boolean {
  const candidate = Number(left);
  return Number.isFinite(candidate) && Number.isFinite(right) &&
    Math.round(candidate * 100) === Math.round(right * 100);
}

export function wolfieTopupProviderReference(orderId: string): string {
  return `wolfie-topup-order:${orderId}`;
}

export function wolfieTopupDueDate(createdAt: unknown): string | null {
  const raw = text(createdAt);
  if (!raw) return null;
  const timestamp = new Date(raw);
  if (!Number.isFinite(timestamp.getTime())) return null;
  // The provider request must remain byte-for-byte stable across retries.
  return timestamp.toISOString().slice(0, 10);
}

export function wolfieTopupDescription(packageName: unknown): string | null {
  const normalizedName = text(packageName);
  if (!normalizedName) return null;
  return `Wolfie — ${normalizedName}`.slice(0, 500);
}

export function wolfieTopupPaymentMatches(
  candidate: unknown,
  expected: WolfieTopupPaymentExpectation,
): candidate is Record<string, unknown> {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return false;
  }
  const payment = candidate as Record<string, unknown>;
  const providerId = text(payment.id);
  return payment.deleted !== true &&
    providerId.length >= 1 && providerId.length <= 200 &&
    text(payment.externalReference) === expected.reference &&
    text(payment.customer) === expected.customerId &&
    text(payment.billingType).toUpperCase() === "PIX" &&
    sameMoney(payment.value, expected.value) &&
    text(payment.dueDate) === expected.dueDate &&
    text(payment.description) === expected.description &&
    text(payment.subscription) === "" &&
    providerPaymentSplitMatches(payment, expected.splitPolicy);
}

export function wolfieTopupPaymentCoreIdentityMatches(
  candidate: unknown,
  expectedPaymentId: string,
  expected: Pick<
    WolfieTopupPaymentExpectation,
    "reference" | "customerId" | "value" | "splitPolicy"
  >,
): candidate is Record<string, unknown> {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return false;
  }
  const payment = candidate as Record<string, unknown>;
  return text(payment.id) === text(expectedPaymentId) &&
    text(payment.externalReference) === expected.reference &&
    text(payment.customer) === expected.customerId &&
    text(payment.billingType).toUpperCase() === "PIX" &&
    sameMoney(payment.value, expected.value) &&
    text(payment.subscription) === "" &&
    providerPaymentSplitMatches(payment, expected.splitPolicy);
}

export function wolfieTopupReferenceConflicts(
  candidate: unknown,
  reference: string,
): boolean {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return false;
  }
  // A deleted or otherwise divergent payment still proves that this immutable
  // provider identity has already been used. Reusing it could duplicate money.
  return text((candidate as Record<string, unknown>).externalReference) ===
    reference;
}

export function wolfieTopupCreationSnapshot(input: {
  tenantId: string;
  studentId: string;
  orderId: string;
  packageId: string;
  packageName: string;
  minutes: number;
  amountBrl: number;
  customerId: string;
  dueDate: string;
  description: string;
  externalReference: string;
}): Record<string, unknown> {
  return {
    tenantId: input.tenantId,
    operation: "PAYMENT_CREATE",
    logicalKey: input.orderId,
    order: {
      id: input.orderId,
      studentId: input.studentId,
      packageId: input.packageId,
      packageName: input.packageName,
      minutes: input.minutes,
      amountBrl: input.amountBrl,
    },
    providerRequest: {
      customer: input.customerId,
      billingType: "PIX",
      value: input.amountBrl,
      dueDate: input.dueDate,
      description: input.description,
      externalReference: input.externalReference,
      splitPolicy: { kind: "NONE" },
    },
  };
}

export function wolfieTopupMaySubmitProviderPayment(input: {
  claimAction: CreationClaimAction;
  lookupKind: CollectionLookupKind;
  localOrderStatus: unknown;
}): boolean {
  // PENDING is also the migration boundary: an order left as CREATING by the
  // legacy expiring lease is ambiguous and must remain GET-only.
  return input.claimAction === "SUBMIT_ONCE" &&
    input.lookupKind === "NOT_FOUND" &&
    text(input.localOrderStatus).toUpperCase() === "PENDING";
}
