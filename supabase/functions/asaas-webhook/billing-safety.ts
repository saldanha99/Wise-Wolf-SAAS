/// <reference lib="deno.ns" />

export type BillingIdentityMismatch =
  | "SUBSCRIPTION_MISMATCH"
  | "CUSTOMER_MISMATCH"
  | "AMOUNT_MISMATCH"
  | "BILLING_TYPE_MISMATCH"
  | "BILLING_CYCLE_MISMATCH";

const HUB_BILLING_IDENTITY_EVENTS = new Set([
  "PAYMENT_CONFIRMED",
  "PAYMENT_RECEIVED",
  "PAYMENT_OVERDUE",
  "PAYMENT_DELETED",
  "PAYMENT_REFUNDED",
  "PAYMENT_PARTIALLY_REFUNDED",
  "PAYMENT_REFUND_IN_PROGRESS",
  "PAYMENT_REFUND_DENIED",
  "PAYMENT_RECEIVED_IN_CASH_UNDONE",
  "PAYMENT_CHARGEBACK_REQUESTED",
  "PAYMENT_CHARGEBACK_DISPUTE",
  "PAYMENT_AWAITING_CHARGEBACK_REVERSAL",
  "PAYMENT_RESTORED",
  "PAYMENT_BANK_SLIP_CANCELLED",
]);

type ExpectedBillingIdentity = {
  subscriptionId: string | null | undefined;
  customerId: string | null | undefined;
  amount: number;
  billingType: string | null | undefined;
  billingCycle?: string | null | undefined;
};

type ProviderBillingIdentity = {
  subscriptionId: string | null | undefined;
  customerId: string | null | undefined;
  amount: number | null | undefined;
  billingType: string | null | undefined;
  billingCycle?: string | null | undefined;
};

const normalized = (value: string | null | undefined) => value?.trim() ?? "";
const normalizedUpper = (value: string | null | undefined) =>
  normalized(value).toUpperCase();

const amountInCents = (value: number | null | undefined): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.round(value * 100);
};

export function billingIdentityMismatch(
  expected: ExpectedBillingIdentity,
  provider: ProviderBillingIdentity,
  options: { requireBillingCycle?: boolean } = {},
): BillingIdentityMismatch | null {
  const expectedSubscription = normalized(expected.subscriptionId);
  if (
    !expectedSubscription ||
    normalized(provider.subscriptionId) !== expectedSubscription
  ) {
    return "SUBSCRIPTION_MISMATCH";
  }

  const expectedCustomer = normalized(expected.customerId);
  if (
    !expectedCustomer || normalized(provider.customerId) !== expectedCustomer
  ) {
    return "CUSTOMER_MISMATCH";
  }

  const expectedAmount = amountInCents(expected.amount);
  const providerAmount = amountInCents(provider.amount);
  if (expectedAmount === null || providerAmount !== expectedAmount) {
    return "AMOUNT_MISMATCH";
  }

  const expectedBillingType = normalizedUpper(expected.billingType);
  if (
    !expectedBillingType ||
    normalizedUpper(provider.billingType) !== expectedBillingType
  ) {
    return "BILLING_TYPE_MISMATCH";
  }

  if (options.requireBillingCycle) {
    const expectedBillingCycle = normalizedUpper(expected.billingCycle);
    if (
      !expectedBillingCycle ||
      normalizedUpper(provider.billingCycle) !== expectedBillingCycle
    ) {
      return "BILLING_CYCLE_MISMATCH";
    }
  }

  return null;
}

export function hubPaymentEventRequiresIdentity(eventName: string): boolean {
  return HUB_BILLING_IDENTITY_EVENTS.has(normalizedUpper(eventName));
}

export function providerWebhookEventKey(
  namespace: "hub" | "saas",
  providerEventId: string | null | undefined,
  eventName: string,
  providerEntityId: string,
): string {
  const eventId = normalized(providerEventId);
  const fallback = `${normalizedUpper(eventName)}:${
    normalized(providerEntityId)
  }`;
  return `asaas:${namespace}:${eventId || fallback}`.slice(0, 200);
}
