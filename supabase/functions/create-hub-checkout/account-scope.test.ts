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
      checkoutSource.includes("resolvePlatformAsaasIntegration(") &&
        checkoutSource.includes('"customer.create"') &&
        checkoutSource.includes('"subscription.create"') &&
        checkoutSource.includes('providerIntegration("payment.read")') &&
        !checkoutSource.includes('Deno.env.get("ASAAS_API_URL")') &&
        !checkoutSource.includes('Deno.env.get("ASAAS_ACCESS_TOKEN")') &&
        !checkoutSource.includes('Deno.env.get("ASAAS_API_KEY")'),
      "Hub billing must resolve the canonical platform integration per capability",
    );
    assert(
      (checkoutSource.match(/await assertCheckoutStillAuthorized\(\)/g) ?? [])
        .length >= 3,
      "authorization must be revalidated before and after provider creation",
    );
    const providerBillingIndex = checkoutSource.indexOf(
      "`${subscriptionCreateIntegration.baseUrl}/subscriptions`",
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

    const subscriptionClaimIndex = checkoutSource.indexOf(
      'operation: "SUBSCRIPTION_CREATE"',
    );
    const subscriptionLookupIndex = checkoutSource.indexOf(
      "const subscriptionLookup = await findUniqueAsaasEntity",
      subscriptionClaimIndex,
    );
    const subscriptionFenceIndex = checkoutSource.indexOf(
      "await markHubProviderCreationSubmitting({",
      subscriptionLookupIndex,
    );
    assert(
      subscriptionClaimIndex >= 0 &&
        subscriptionLookupIndex > subscriptionClaimIndex &&
        subscriptionFenceIndex > subscriptionLookupIndex &&
        providerBillingIndex > subscriptionFenceIndex,
      "subscription creation must claim, reconcile and fence before its only POST",
    );
    assert(
      (checkoutSource.match(/await markHubProviderCreationSubmitting\(\{/g) ??
            []).length === 2 &&
        checkoutSource.includes("accountId: membership.account_id") &&
        checkoutSource.includes("checkoutId: checkout.id"),
      "customer and subscription POSTs must share the account lifecycle fence",
    );
    assert(
      checkoutSource.includes('subscriptionLookup.kind === "DUPLICATE"') &&
        checkoutSource.includes(
          'throw new Error("ASAAS_SUBSCRIPTION_RECONCILIATION_PENDING")',
        ) &&
        checkoutSource.includes("let resumableCheckout:") &&
        checkoutSource.includes("if (!resumableCheckout)"),
      "ambiguous and duplicate subscription creations need a GET-only resumable path",
    );
    assert(
      (checkoutSource.match(/method: "POST"/g) ?? []).length === 2 &&
        (checkoutSource.match(/redirect: "error"/g) ?? []).length >= 3 &&
        checkoutSource.includes(
          'throw new Error("ASAAS_CREATION_REQUIRES_DURABLE_CLAIM")',
        ),
      "the checkout must expose only its two durably claimed, redirect-safe creation POSTs",
    );
    assert(
      checkoutSource.indexOf(
            "const existingProviderSubscriptionId = normalizeAsaasCustomerId(",
          ) < providerBillingIndex &&
        checkoutSource.includes(
          'error: "hub_subscription_local_link_not_observed"',
        ),
      "a legacy local subscription link must block a replacement POST until reconciled",
    );
    assert(
      checkoutSource.includes("amount = resumableCheckout.amount;") &&
        checkoutSource.includes("provider_subscription_description:") &&
        (checkoutSource.match(/resolveHubAsaasSubscriptionCandidate\(/g) ?? [])
            .length >= 3 &&
        checkoutSource.includes("hub_subscription_post_payload_conflict") &&
        checkoutSource.includes(
          "providerPaymentReconciliationRequired = true;",
        ) &&
        checkoutSource.includes(
          'throw new Error("ASAAS_SUBSCRIPTION_PAYMENT_NOT_READY")',
        ),
      "recovery must preserve the financial snapshot and wait for a real first payment",
    );
    const providerSubscriptionProof = checkoutSource.indexOf(
      "const verifiedProviderSubscription = await asaasRequest(",
    );
    const recoveredIdentityProof = checkoutSource.indexOf(
      "const subscriptionResolution = resolveHubAsaasSubscriptionCandidate(",
    );
    const submittedIdentityProof = checkoutSource.indexOf(
      "const submittedResolution = resolveHubAsaasSubscriptionCandidate(",
    );
    const verifiedIdentityProof = checkoutSource.indexOf(
      "const verifiedSubscriptionResolution = resolveHubAsaasSubscriptionCandidate(",
    );
    for (
      const [label, start, end] of [
        ["FOUND", recoveredIdentityProof, submittedIdentityProof],
        ["fresh POST", submittedIdentityProof, providerSubscriptionProof],
        ["exact GET", verifiedIdentityProof, verifiedIdentityProof + 1_000],
      ] as const
    ) {
      const proof = checkoutSource.slice(start, end);
      assert(
        start >= 0 && end > start && proof.includes("maxPayments: null") &&
          proof.includes('splitPolicy: { kind: "NONE" }'),
        `${label} subscription identity must prove open-ended billing with no split`,
      );
    }
    const alreadySucceededStart = checkoutSource.indexOf(
      'if (subscriptionClaim.action === "ALREADY_SUCCEEDED")',
    );
    const alreadySucceededEnd = checkoutSource.indexOf(
      "} else if (",
      alreadySucceededStart,
    );
    assert(
      alreadySucceededStart >= 0 &&
        alreadySucceededEnd > alreadySucceededStart &&
        providerSubscriptionProof > alreadySucceededEnd &&
        !checkoutSource.slice(alreadySucceededStart, alreadySucceededEnd)
          .includes("await adoptHubProviderCreationBinding({"),
      "ALREADY_SUCCEEDED must still pass the exact provider GET before adoption",
    );
    const providerAdoption = checkoutSource.indexOf(
      "await adoptHubProviderCreationBinding({",
      providerSubscriptionProof,
    );
    const providerLink = checkoutSource.indexOf(
      '"hub_bind_checkout_provider_subscription"',
    );
    assert(
      providerSubscriptionProof >= 0 &&
        providerAdoption > providerSubscriptionProof &&
        providerLink > providerSubscriptionProof &&
        providerLink > providerAdoption &&
        checkoutSource.includes(
          "ASAAS_SUBSCRIPTION_PROVIDER_IDENTITY_CONFLICT",
        ),
      "claimed and local subscription ids must be GET-verified and atomically adopted before metadata binding",
    );
    const recoveredSubscriptionStart = checkoutSource.indexOf(
      'if (subscriptionLookup.kind === "FOUND")',
    );
    const reconcileSubscriptionStart = checkoutSource.indexOf(
      '} else if (subscriptionClaim.action === "RECONCILE_REQUIRED")',
      recoveredSubscriptionStart,
    );
    const recoveredSubscriptionBlock = checkoutSource.slice(
      recoveredSubscriptionStart,
      reconcileSubscriptionStart,
    );
    assert(
      recoveredSubscriptionBlock.includes(
        "await adoptHubProviderCreationBinding({",
      ) &&
        !recoveredSubscriptionBlock.includes('status: "SUCCEEDED"'),
      "a recovered provider subscription must atomically record success and bind under the lifecycle fence",
    );
    assert(
      checkoutSource.includes('"hub_bind_checkout_provider_subscription"') &&
        checkoutSource.includes(
          "p_expected_subscription_id: providerSubscriptionId",
        ),
      "provider subscription linking and finalization must use immutable CAS guards",
    );
    assert(
      checkoutSource.includes("const payments = await asaasListAll(") &&
        checkoutSource.includes("const matchingPayments = payments.filter(") &&
        checkoutSource.includes("matchingPayments.length !== 1") &&
        checkoutSource.includes("assertExactHubProviderPayment(exactPayment"),
      "the first provider payment must be selected from every page by exact identity",
    );
    const existingPaymentProof = checkoutSource.indexOf(
      "assertExactHubProviderPayment(providerPaymentSnapshot",
    );
    const existingQr = checkoutSource.indexOf(
      "/pixQrCode",
      existingPaymentProof,
    );
    assert(
      existingPaymentProof >= 0 && existingQr > existingPaymentProof &&
        (checkoutSource.match(/assertExactHubProviderPayment\(/g) ?? [])
            .length >= 4 &&
        checkoutSource.includes('"hub_merge_checkout_provider_state"'),
      "idempotent QR and payment finalization require exact GET identity plus payment CAS",
    );
    assert(
      checkoutSource.includes(
        'throw new Error("ASAAS_CUSTOMER_DUPLICATE_REVIEW_REQUIRED")',
      ) &&
        !checkoutSource.includes('method: "DELETE"') &&
        !checkoutSource.includes("deleteAsaasCustomer") &&
        !checkoutSource.includes("DELETE_CREATED_CUSTOMER") &&
        !checkoutSource.includes("compensateCreatedProviderCustomer"),
      "a succeeded customer claim must never be compensated into a deleted provider id",
    );
  },
});
