/// <reference lib="deno.ns" />

export const HUB_CANCELLATION_CONFIRMATION = "CANCELAR";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type CancellationRequest = {
  accountId: string;
};

export type ProviderLinkedCheckout = {
  status?: string | null;
  asaas_subscription_id?: string | null;
  asaas_payment_id?: string | null;
};

export type ProviderLinkedSubscription = {
  provider?: string | null;
  provider_subscription_id?: string | null;
};

export class CancellationValidationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "CancellationValidationError";
  }
}

export function parseCancellationRequest(input: unknown): CancellationRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new CancellationValidationError("INVALID_HUB_CANCELLATION_REQUEST");
  }
  const body = input as Record<string, unknown>;
  if (
    Object.keys(body).some((key) =>
      !["accountId", "confirmation"].includes(key)
    )
  ) {
    throw new CancellationValidationError("INVALID_HUB_CANCELLATION_REQUEST");
  }
  const accountId = typeof body.accountId === "string"
    ? body.accountId.trim()
    : "";
  const confirmation = typeof body.confirmation === "string"
    ? body.confirmation.trim().toUpperCase()
    : "";
  if (
    !UUID_PATTERN.test(accountId) ||
    confirmation !== HUB_CANCELLATION_CONFIRMATION
  ) {
    throw new CancellationValidationError("INVALID_HUB_CANCELLATION_REQUEST");
  }
  return { accountId };
}

export function cancellationAlreadyScheduled(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return false;
  }
  return (metadata as Record<string, unknown>).cancelAtPeriodEnd === true;
}

function providerId(value: string | null | undefined): string {
  const normalized = value?.trim() ?? "";
  if (normalized.length > 200) {
    throw new CancellationValidationError(
      "HUB_SUBSCRIPTION_RECONCILIATION_REQUIRED",
    );
  }
  return normalized;
}

export function collectProviderSubscriptionIds(
  subscription: ProviderLinkedSubscription,
  checkouts: ProviderLinkedCheckout[],
): string[] {
  if (subscription.provider !== "ASAAS") {
    throw new CancellationValidationError(
      "HUB_SUBSCRIPTION_RECONCILIATION_REQUIRED",
    );
  }
  const currentProviderId = providerId(subscription.provider_subscription_id);
  if (!currentProviderId) {
    throw new CancellationValidationError(
      "HUB_SUBSCRIPTION_RECONCILIATION_REQUIRED",
    );
  }

  const providerIds = new Set<string>([currentProviderId]);
  for (const checkout of checkouts) {
    const status = checkout.status?.trim().toUpperCase() ?? "";
    const checkoutProviderId = providerId(checkout.asaas_subscription_id);
    const paymentId = checkout.asaas_payment_id?.trim() ?? "";
    if (!checkoutProviderId) {
      if (status !== "CREATED" || paymentId) {
        throw new CancellationValidationError(
          "HUB_SUBSCRIPTION_RECONCILIATION_REQUIRED",
        );
      }
      continue;
    }
    providerIds.add(checkoutProviderId);
  }
  return [...providerIds];
}
