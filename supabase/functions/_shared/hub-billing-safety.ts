/// <reference lib="deno.ns" />

export const WOLFIE_DIRECT_TENANT_ID = "wolfie-direct";
export const WOLFIE_PRODUCT_FAMILY = "WOLFIE_STANDALONE";
export const HUB_CORE_PRODUCT_FAMILY = "HUB_CORE";

export type HubCheckoutSubscription = {
  status?: string | null;
  planId?: string | null;
  planCode?: string | null;
  billingCycle?: string | null;
  trialEndsAt?: string | null;
  currentPeriodEndsAt?: string | null;
  provider?: string | null;
  providerSubscriptionId?: string | null;
};

export type HubCheckoutDecision =
  | "ALLOW_NEW"
  | "ALLOW_REPLACEMENT"
  | "ALREADY_ACTIVE"
  | "BLOCK_INCOMPLETE";

export type HubBillingBlockCode =
  | "HUB_ACCOUNT_INACTIVE"
  | "HUB_DISABLED";

export type HubFixtureCheckoutBlockCode =
  | "TEST_FIXTURE_REQUIRES_TEST_MODE"
  | "TEST_MODE_REQUIRES_SANDBOX";

const HUB_RECOVERY_EVENTS = new Set([
  "PAYMENT_PARTIALLY_REFUNDED",
  "PAYMENT_REFUND_DENIED",
  "PAYMENT_RESTORED",
  "PAYMENT_CHARGEBACK_DISPUTE",
  "PAYMENT_AWAITING_CHARGEBACK_REVERSAL",
]);

export function tenantMayCheckoutProduct(
  tenantId: string | null | undefined,
  productFamily: string,
): boolean {
  return tenantId !== WOLFIE_DIRECT_TENANT_ID ||
    productFamily === WOLFIE_PRODUCT_FAMILY;
}

export function isSupportedHubProductFamily(productFamily: string): boolean {
  return productFamily === HUB_CORE_PRODUCT_FAMILY ||
    productFamily === WOLFIE_PRODUCT_FAMILY;
}

export function isValidHubAccountId(accountId: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(accountId);
}

export function hubPlanMatchesAccountAudience(
  productFamily: string,
  planAudience: string | null | undefined,
  accountAudience: string | null | undefined,
): boolean {
  if (productFamily !== HUB_CORE_PRODUCT_FAMILY) return true;
  return planAudience === "ALL" || planAudience === accountAudience;
}

export function hubBillingBlockCode(
  productFamily: string,
  accountStatus: string | null | undefined,
  hubEnabled = true,
): HubBillingBlockCode | null {
  if (accountStatus !== "ACTIVE") return "HUB_ACCOUNT_INACTIVE";
  if (productFamily === HUB_CORE_PRODUCT_FAMILY && !hubEnabled) {
    return "HUB_DISABLED";
  }
  return null;
}

export function hubFixtureCheckoutBlockCode(input: {
  testMode: boolean;
  userIsTestFixture: boolean;
  sandboxProvider: boolean;
}): HubFixtureCheckoutBlockCode | null {
  if (input.userIsTestFixture && !input.testMode) {
    return "TEST_FIXTURE_REQUIRES_TEST_MODE";
  }
  if (
    input.testMode &&
    (!input.userIsTestFixture || !input.sandboxProvider)
  ) {
    return "TEST_MODE_REQUIRES_SANDBOX";
  }
  return null;
}

export function hubReplacementNeedsProviderReconciliation(
  subscription: HubCheckoutSubscription | null | undefined,
  decision: HubCheckoutDecision,
): boolean {
  if (
    decision !== "ALLOW_REPLACEMENT" || !subscription ||
    subscription.planCode === "DISCOVERY"
  ) {
    return false;
  }
  return subscription.provider !== "ASAAS" ||
    !subscription.providerSubscriptionId?.trim();
}

function isFuture(value: string | null | undefined, nowMs: number): boolean {
  if (!value) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > nowMs;
}

export function hubSubscriptionHasCurrentAccess(
  subscription: HubCheckoutSubscription | null | undefined,
  nowMs = Date.now(),
): boolean {
  if (!subscription) return false;
  if (subscription.status === "TRIALING") {
    return isFuture(subscription.trialEndsAt, nowMs);
  }
  if (subscription.status === "ACTIVE") {
    return isFuture(subscription.currentPeriodEndsAt, nowMs);
  }
  return false;
}

export function hubCheckoutDecision(
  subscription: HubCheckoutSubscription | null | undefined,
  target: { planId: string; billingCycle: string },
  nowMs = Date.now(),
): HubCheckoutDecision {
  if (!subscription) return "ALLOW_NEW";
  if (subscription.status === "INCOMPLETE") return "BLOCK_INCOMPLETE";

  const currentAccess = hubSubscriptionHasCurrentAccess(subscription, nowMs);
  if (subscription.planCode === "DISCOVERY" || !currentAccess) {
    return "ALLOW_REPLACEMENT";
  }
  if (
    subscription.status === "ACTIVE" &&
    subscription.planId === target.planId &&
    subscription.billingCycle === target.billingCycle
  ) {
    return "ALREADY_ACTIVE";
  }
  return "ALLOW_REPLACEMENT";
}

export function replacementProviderSubscriptionId(
  metadata: unknown,
  currentProviderSubscriptionId?: string | null,
): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const record = metadata as Record<string, unknown>;
  if (record.replacesProvider !== "ASAAS") return null;
  const replacementId = typeof record.replacesProviderSubscriptionId ===
      "string"
    ? record.replacesProviderSubscriptionId.trim()
    : "";
  if (
    !replacementId || replacementId.length > 200 ||
    replacementId === currentProviderSubscriptionId
  ) {
    return null;
  }
  return replacementId;
}

export async function activateThenCancelHubReplacement(
  activate: () => Promise<boolean>,
  replacementId: string | null,
  cancelReplacement: (providerSubscriptionId: string) => Promise<void>,
  recordCompletion: (providerSubscriptionId: string) => Promise<void>,
): Promise<void> {
  const activated = await activate();
  if (!activated || !replacementId) return;
  await cancelReplacement(replacementId);
  await recordCompletion(replacementId);
}

export function hubActivationAllowsReplacementCancellation(
  activation: unknown,
): boolean {
  if (
    !activation || typeof activation !== "object" || Array.isArray(activation)
  ) {
    return false;
  }
  const result = activation as Record<string, unknown>;
  const status = typeof result.status === "string"
    ? result.status.trim().toUpperCase()
    : "";
  if (["CANCELLED", "REVERSED", "EXPIRED"].includes(status)) return false;
  return status === "ACTIVE" || result.applied === true;
}

export function providerCancellationIsFinal(status: number): boolean {
  return (status >= 200 && status < 300) || status === 404 || status === 410;
}

export function failedCheckoutStatus(
  providerSubscriptionCreated: boolean,
  providerCancellationConfirmed: boolean,
): "FAILED" | "PENDING" {
  return providerSubscriptionCreated && !providerCancellationConfirmed
    ? "PENDING"
    : "FAILED";
}

export function hubCheckoutIdFromExternalReference(
  externalReference: string | null | undefined,
): string | null {
  const reference = externalReference?.trim() ?? "";
  return reference.startsWith("hub:") ? reference.slice(4) : null;
}

export function isHubRecoveryEvent(event: string): boolean {
  return HUB_RECOVERY_EVENTS.has(event);
}

export function hubRecoveryReason(event: string): string {
  return event === "PAYMENT_PARTIALLY_REFUNDED"
    ? "PARTIAL_REFUND_REVIEW"
    : event === "PAYMENT_REFUND_DENIED"
    ? "REFUND_DENIED_REVIEW"
    : event === "PAYMENT_RESTORED"
    ? "DELETED_PAYMENT_RESTORED_REVIEW"
    : event === "PAYMENT_AWAITING_CHARGEBACK_REVERSAL"
    ? "CHARGEBACK_WON_RECONCILIATION"
    : "CHARGEBACK_DISPUTE_REVIEW";
}
