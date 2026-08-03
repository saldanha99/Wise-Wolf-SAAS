/// <reference lib="deno.ns" />

export const WOLFIE_DIRECT_TENANT_ID = "wolfie-direct";
export const WOLFIE_PRODUCT_FAMILY = "WOLFIE_STANDALONE";

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
