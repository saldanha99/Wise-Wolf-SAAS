/// <reference lib="deno.ns" />

const assert = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};

Deno.test({
  name: "checkout binds authorization and idempotency to the requested account",
  permissions: { read: true },
  async fn() {
    const checkoutSource = await Deno.readTextFile(
      new URL("./index.ts", import.meta.url),
    );
    assert(
      checkoutSource.includes(
        "const requestedAccountId = text(body.accountId, 40);",
      ),
      "checkout must require an explicit account selector",
    );
    assert(
      checkoutSource.includes('.eq("account_id", requestedAccountId)'),
      "membership authorization must be bound to the requested account",
    );
    assert(
      checkoutSource.includes(
        "existingCheckout.account_id !== requestedAccountId",
      ),
      "idempotency keys must not be replayed across accounts",
    );
    assert(
      (checkoutSource.match(/await assertCheckoutStillAuthorized\(\)/g) ?? [])
        .length >= 3,
      "authorization must be revalidated before and after provider creation",
    );
    const providerBillingIndex = checkoutSource.indexOf(
      'asaasRequest("/subscriptions"',
    );
    const finalCatalogRecheckIndex = checkoutSource.lastIndexOf(
      'rpc("hub_catalog_checkout_is_ready")',
      providerBillingIndex,
    );
    const finalAuthorizationIndex = checkoutSource.lastIndexOf(
      "await assertCheckoutStillAuthorized()",
      providerBillingIndex,
    );
    assert(
      finalCatalogRecheckIndex >= 0 &&
        finalAuthorizationIndex > finalCatalogRecheckIndex &&
        providerBillingIndex > finalAuthorizationIndex,
      "catalog readiness must be revalidated immediately before provider billing",
    );
    assert(
      checkoutSource.includes("metadata?.cancelAtPeriodEnd === true") &&
        checkoutSource.includes("metadata?.cancellationInProgress === true") &&
        checkoutSource.includes("HUB_SUBSCRIPTION_CANCELLATION_PENDING"),
      "provider billing must close both scheduled and in-progress cancellation races",
    );
    assert(
      checkoutSource.includes("SUBSCRIPTION_RECONCILIATION_REQUIRED"),
      "paid legacy replacements must not leave an unidentified provider schedule active",
    );
  },
});
