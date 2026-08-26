// Pure identity and outcome rules shared by the student billing lifecycle.
// Provider identifiers are addresses, never authorization on their own.

export type ExpectedProviderCustomer = {
  id: string;
  externalReference: string;
  cpfCnpj: string;
};

export type ExpectedEnrollmentPayment = {
  id: string;
  customerId: string;
  externalReference: string;
  value: number;
  dueDate: string;
  description: string;
  splitPolicy: ProviderSplitPolicy;
};

export type ProviderSplitPolicy =
  | { kind: "NONE" }
  | {
    kind: "PERCENTAGE";
    walletId: string;
    percentualValue: number;
  };

const text = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const digits = (value: unknown): string =>
  String(value || "").replace(/\D/g, "");

const sameMoney = (left: unknown, right: number): boolean => {
  const parsed = Number(left);
  return Number.isFinite(parsed) &&
    Math.round(parsed * 100) === Math.round(right * 100);
};

const sameDecimal = (left: unknown, right: number): boolean => {
  const parsed = Number(left);
  return Number.isFinite(parsed) &&
    Math.round(parsed * 10_000) === Math.round(right * 10_000);
};

/**
 * Produces the one representation that is allowed in creation fingerprints,
 * recovery matching and provider POSTs. A configured wallet with an invalid
 * percentage is an unsafe configuration, not a no-split policy.
 */
export function canonicalEnrollmentSplitPolicy(
  mode: string,
  walletId: unknown,
  percentualValue: unknown,
): ProviderSplitPolicy | null {
  if (mode !== "PLATFORM_MANAGED_ROOT") return { kind: "NONE" };

  const wallet = text(walletId);
  if (!wallet) return { kind: "NONE" };
  const parsed = percentualValue === null || percentualValue === undefined ||
      percentualValue === ""
    ? 90
    : Number(percentualValue);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100) return null;
  const canonicalPercentage = Math.round(parsed * 10_000) / 10_000;
  return {
    kind: "PERCENTAGE",
    walletId: wallet,
    percentualValue: canonicalPercentage,
  };
}

export function providerPaymentSplitMatches(
  candidate: unknown,
  expected: ProviderSplitPolicy,
): boolean {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return false;
  }
  const payment = candidate as Record<string, unknown>;
  const split = payment.split;
  if (expected.kind === "NONE") {
    return split === undefined || split === null ||
      (Array.isArray(split) && split.length === 0);
  }

  // When split applies, omission is not evidence of the expected routing.
  if (!Array.isArray(split) || split.length !== 1) return false;
  const entry = split[0];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const providerSplit = entry as Record<string, unknown>;
  const fixedValue = providerSplit.fixedValue;
  return text(providerSplit.walletId) === expected.walletId &&
    sameDecimal(providerSplit.percentualValue, expected.percentualValue) &&
    (fixedValue === undefined || fixedValue === null ||
      sameMoney(fixedValue, 0));
}

export function providerSplitPoliciesEqual(
  left: ProviderSplitPolicy,
  right: ProviderSplitPolicy,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "NONE" && right.kind === "NONE") return true;
  if (left.kind !== "PERCENTAGE" || right.kind !== "PERCENTAGE") return false;
  return left.walletId === right.walletId &&
    sameDecimal(left.percentualValue, right.percentualValue);
}

export function providerSplitPayload(
  policy: ProviderSplitPolicy,
): Array<{ walletId: string; percentualValue: number }> | undefined {
  return policy.kind === "PERCENTAGE"
    ? [{
      walletId: policy.walletId,
      percentualValue: policy.percentualValue,
    }]
    : undefined;
}

export function providerCustomerMatchesStudent(
  candidate: unknown,
  expected: ExpectedProviderCustomer,
): boolean {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return false;
  }
  const customer = candidate as Record<string, unknown>;
  return customer.deleted !== true &&
    text(customer.id) === expected.id &&
    text(customer.externalReference) === expected.externalReference &&
    digits(customer.cpfCnpj) === digits(expected.cpfCnpj);
}

export function providerEnrollmentPaymentMatches(
  candidate: unknown,
  expected: ExpectedEnrollmentPayment,
): boolean {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return false;
  }
  const payment = candidate as Record<string, unknown>;
  const subscription = payment.subscription;
  return payment.deleted !== true &&
    text(payment.id) === expected.id &&
    text(payment.customer) === expected.customerId &&
    text(payment.externalReference) === expected.externalReference &&
    text(payment.billingType).toUpperCase() === "PIX" &&
    sameMoney(payment.value, expected.value) &&
    text(payment.dueDate) === expected.dueDate &&
    text(payment.description) === expected.description &&
    (subscription === undefined || subscription === null ||
      (typeof subscription === "string" && subscription.trim() === "")) &&
    providerPaymentSplitMatches(payment, expected.splitPolicy);
}

export function ambiguousProviderMutationStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 ||
    status >= 500;
}

export function deterministicProviderDeclineStatus(status: number): boolean {
  return status >= 400 && status < 500 &&
    !ambiguousProviderMutationStatus(status);
}
