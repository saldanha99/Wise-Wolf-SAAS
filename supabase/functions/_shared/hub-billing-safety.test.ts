import {
  failedCheckoutStatus,
  hubCheckoutIdFromExternalReference,
  hubRecoveryReason,
  isHubRecoveryEvent,
  providerCancellationIsFinal,
  tenantMayCheckoutProduct,
  WOLFIE_PRODUCT_FAMILY,
} from "./hub-billing-safety.ts";

const assert = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};

Deno.test("wolfie-direct can buy only the standalone product", () => {
  assert(
    tenantMayCheckoutProduct("wolfie-direct", WOLFIE_PRODUCT_FAMILY),
    "standalone Wolfie must remain purchasable",
  );
  assert(
    !tenantMayCheckoutProduct("wolfie-direct", "HUB_CORE"),
    "the isolated tenant must not buy Hub Core",
  );
  assert(
    tenantMayCheckoutProduct("school-wise-wolf", "HUB_CORE"),
    "existing non-direct tenants must keep their product behavior",
  );
});

Deno.test("an ambiguous provider rollback keeps the checkout open", () => {
  assert(
    failedCheckoutStatus(true, false) === "PENDING",
    "an orphan-capable subscription must block a replacement checkout",
  );
  assert(
    failedCheckoutStatus(true, true) === "FAILED",
    "a confirmed provider deletion can release the checkout",
  );
  assert(
    failedCheckoutStatus(false, false) === "FAILED",
    "a failure before provider creation is safe to release",
  );
});

Deno.test("provider cancellation treats already absent subscriptions as final", () => {
  for (const status of [200, 204, 404, 410]) {
    assert(
      providerCancellationIsFinal(status),
      `${status} must be idempotently final`,
    );
  }
  for (const status of [0, 400, 401, 429, 500, 503]) {
    assert(
      !providerCancellationIsFinal(status),
      `${status} must require retry or reconciliation`,
    );
  }
});

Deno.test("Hub routing and recovery events are conservative", () => {
  assert(
    hubCheckoutIdFromExternalReference("hub:checkout-id") === "checkout-id",
    "Hub external references must be extracted",
  );
  assert(
    hubCheckoutIdFromExternalReference("student:checkout-id") === null,
    "unrelated references must not be captured",
  );
  for (
    const event of [
      "PAYMENT_PARTIALLY_REFUNDED",
      "PAYMENT_REFUND_DENIED",
      "PAYMENT_RESTORED",
      "PAYMENT_CHARGEBACK_DISPUTE",
      "PAYMENT_AWAITING_CHARGEBACK_REVERSAL",
    ]
  ) {
    assert(isHubRecoveryEvent(event), `${event} must be explicitly handled`);
    assert(
      hubRecoveryReason(event).length > 5,
      `${event} must carry a reconciliation reason`,
    );
  }
  assert(
    !isHubRecoveryEvent("PAYMENT_RECEIVED"),
    "paid events keep their exactly-once ledger path",
  );
});
