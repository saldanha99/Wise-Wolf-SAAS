import {
  activateThenCancelHubReplacement,
  failedCheckoutStatus,
  HUB_CORE_PRODUCT_FAMILY,
  hubActivationAllowsReplacementCancellation,
  hubBillingBlockCode,
  hubCheckoutDecision,
  hubCheckoutIdFromExternalReference,
  hubFixtureCheckoutBlockCode,
  hubPlanMatchesAccountAudience,
  hubRecoveryReason,
  hubReplacementNeedsProviderReconciliation,
  isHubRecoveryEvent,
  isSupportedHubProductFamily,
  isValidHubAccountId,
  providerCancellationIsFinal,
  replacementProviderSubscriptionId,
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
  assert(
    isSupportedHubProductFamily(HUB_CORE_PRODUCT_FAMILY),
    "Hub Core must be an accepted product family",
  );
  assert(
    isSupportedHubProductFamily(WOLFIE_PRODUCT_FAMILY),
    "standalone Wolfie must be an accepted product family",
  );
  assert(
    !isSupportedHubProductFamily("WOLFIE_FAKE"),
    "unknown product families must fail closed",
  );
});

Deno.test("checkout account scope is explicit and audience-safe", () => {
  const accountId = "550e8400-e29b-41d4-a716-446655440000";
  assert(isValidHubAccountId(accountId), "a canonical account UUID is valid");
  assert(
    !isValidHubAccountId("not-an-account"),
    "an ambiguous account selector must fail closed",
  );
  assert(
    hubPlanMatchesAccountAudience("HUB_CORE", "ALL", "EDUCATOR"),
    "an ALL plan can serve every Hub audience",
  );
  assert(
    hubPlanMatchesAccountAudience("HUB_CORE", "EDUCATOR", "EDUCATOR"),
    "an account can buy its matching audience plan",
  );
  assert(
    !hubPlanMatchesAccountAudience("HUB_CORE", "INSTITUTION", "EDUCATOR"),
    "a Hub account must not buy another audience's plan",
  );
});

Deno.test("Hub checkout permits conversion and only blocks a duplicate active cycle", () => {
  const now = Date.parse("2026-08-22T12:00:00.000Z");
  const future = "2026-09-22T12:00:00.000Z";
  const past = "2026-08-01T12:00:00.000Z";
  const target = { planId: "educator-pro", billingCycle: "MONTHLY" };

  assert(
    hubCheckoutDecision(null, target, now) === "ALLOW_NEW",
    "an account without a subscription can start checkout",
  );
  assert(
    hubCheckoutDecision(
      {
        status: "TRIALING",
        planId: "discovery",
        planCode: "DISCOVERY",
        trialEndsAt: future,
      },
      target,
      now,
    ) === "ALLOW_REPLACEMENT",
    "an active Discovery trial can convert to paid",
  );
  assert(
    hubCheckoutDecision(
      {
        status: "TRIALING",
        planId: "discovery",
        planCode: "DISCOVERY",
        trialEndsAt: past,
      },
      target,
      now,
    ) === "ALLOW_REPLACEMENT",
    "an expired Discovery trial can convert to paid",
  );
  assert(
    hubCheckoutDecision(
      {
        status: "ACTIVE",
        planId: target.planId,
        planCode: "EDUCATOR_PRO",
        billingCycle: target.billingCycle,
        currentPeriodEndsAt: future,
      },
      target,
      now,
    ) === "ALREADY_ACTIVE",
    "the same active plan and cycle must not create duplicate billing",
  );
  assert(
    hubCheckoutDecision(
      {
        status: "ACTIVE",
        planId: target.planId,
        planCode: "EDUCATOR_PRO",
        billingCycle: "YEARLY",
        currentPeriodEndsAt: future,
      },
      target,
      now,
    ) === "ALLOW_REPLACEMENT",
    "changing the billing cycle is an explicit replacement",
  );
  assert(
    hubCheckoutDecision(
      {
        status: "ACTIVE",
        planId: "library-solo",
        planCode: "LIBRARY_SOLO",
        billingCycle: "MONTHLY",
        currentPeriodEndsAt: future,
      },
      target,
      now,
    ) === "ALLOW_REPLACEMENT",
    "an active account can upgrade to another plan",
  );
  assert(
    hubCheckoutDecision(
      {
        status: "ACTIVE",
        planId: target.planId,
        planCode: "EDUCATOR_PRO",
        billingCycle: target.billingCycle,
        currentPeriodEndsAt: past,
      },
      target,
      now,
    ) === "ALLOW_REPLACEMENT",
    "an expired paid period must not block renewal",
  );
  assert(
    hubCheckoutDecision({ status: "INCOMPLETE" }, target, now) ===
      "BLOCK_INCOMPLETE",
    "an incomplete subscription requires reconciliation",
  );
});

Deno.test("billing lifecycle fails closed for inactive accounts and disabled Hub Core", () => {
  assert(
    hubBillingBlockCode(HUB_CORE_PRODUCT_FAMILY, "SUSPENDED", true) ===
      "HUB_ACCOUNT_INACTIVE",
    "a suspended account must never activate or extend billing access",
  );
  assert(
    hubBillingBlockCode(HUB_CORE_PRODUCT_FAMILY, "ACTIVE", false) ===
      "HUB_DISABLED",
    "the Hub kill switch must block Hub Core billing activation",
  );
  assert(
    hubBillingBlockCode(WOLFIE_PRODUCT_FAMILY, "ACTIVE", false) === null,
    "the Hub Core kill switch must not disable the isolated Wolfie product",
  );
});

Deno.test("Hub checkout fixtures cannot reach a real provider by omission", () => {
  assert(
    hubFixtureCheckoutBlockCode({
      testMode: false,
      userIsTestFixture: true,
      sandboxProvider: false,
    }) === "TEST_FIXTURE_REQUIRES_TEST_MODE",
    "a fixture user must opt into the guarded test path",
  );
  assert(
    hubFixtureCheckoutBlockCode({
      testMode: true,
      userIsTestFixture: false,
      sandboxProvider: true,
    }) === "TEST_MODE_REQUIRES_SANDBOX",
    "ordinary users must not impersonate a fixture",
  );
  assert(
    hubFixtureCheckoutBlockCode({
      testMode: true,
      userIsTestFixture: true,
      sandboxProvider: false,
    }) === "TEST_MODE_REQUIRES_SANDBOX",
    "a fixture must never call the production provider",
  );
  assert(
    hubFixtureCheckoutBlockCode({
      testMode: true,
      userIsTestFixture: true,
      sandboxProvider: true,
    }) === null,
    "a marked fixture is allowed only in explicit sandbox mode",
  );
  assert(
    hubFixtureCheckoutBlockCode({
      testMode: false,
      userIsTestFixture: false,
      sandboxProvider: false,
    }) === null,
    "ordinary production checkout remains unchanged",
  );
});

Deno.test("paid replacements require a cancellable prior provider schedule", () => {
  const replacement = {
    status: "ACTIVE",
    planCode: "EDUCATOR_PRO",
    provider: "ASAAS",
    providerSubscriptionId: "sub_old",
  };
  assert(
    !hubReplacementNeedsProviderReconciliation(
      replacement,
      "ALLOW_REPLACEMENT",
    ),
    "an identified Asaas schedule can be replaced safely",
  );
  assert(
    hubReplacementNeedsProviderReconciliation(
      { ...replacement, providerSubscriptionId: null },
      "ALLOW_REPLACEMENT",
    ),
    "a paid legacy schedule without provider id must be reconciled first",
  );
  assert(
    !hubReplacementNeedsProviderReconciliation(
      { status: "TRIALING", planCode: "DISCOVERY" },
      "ALLOW_REPLACEMENT",
    ),
    "the free Discovery trial has no provider schedule to cancel",
  );
});

Deno.test("paid replacements cancel only a distinct prior Asaas subscription", () => {
  const metadata = {
    replacesProvider: "ASAAS",
    replacesProviderSubscriptionId: "sub_old",
  };
  assert(
    replacementProviderSubscriptionId(metadata, "sub_new") === "sub_old",
    "the previous provider schedule must be cancelled after activation",
  );
  assert(
    replacementProviderSubscriptionId(metadata, "sub_old") === null,
    "the newly activated provider schedule must never cancel itself",
  );
  assert(
    replacementProviderSubscriptionId({
      ...metadata,
      replacesProvider: "OTHER",
    }, "sub_new") === null,
    "unknown providers must not be sent to the Asaas cancellation API",
  );
  assert(
    replacementProviderSubscriptionId({}, "sub_new") === null,
    "non-replacement checkouts have no cancellation action",
  );
});

Deno.test("paid replacement activates before cancelling the prior provider schedule", async () => {
  const calls: string[] = [];
  await activateThenCancelHubReplacement(
    async () => {
      calls.push("activate");
      return true;
    },
    "sub_old",
    async (providerSubscriptionId) => {
      calls.push(`cancel:${providerSubscriptionId}`);
    },
    async (providerSubscriptionId) => {
      calls.push(`record:${providerSubscriptionId}`);
    },
  );
  assert(
    calls.join(",") === "activate,cancel:sub_old,record:sub_old",
    "activation must commit before the prior recurrence is cancelled",
  );

  let cancelledAfterFailure = false;
  let activationFailed = false;
  try {
    await activateThenCancelHubReplacement(
      async () => {
        throw new Error("activation_failed");
      },
      "sub_old",
      async () => {
        cancelledAfterFailure = true;
      },
      async () => undefined,
    );
  } catch {
    activationFailed = true;
  }
  assert(activationFailed, "the activation failure must propagate for retry");
  assert(
    !cancelledAfterFailure,
    "a failed activation must preserve the previous provider schedule",
  );

  await activateThenCancelHubReplacement(
    async () => false,
    "sub_old",
    async () => {
      cancelledAfterFailure = true;
    },
    async () => undefined,
  );
  assert(
    !cancelledAfterFailure,
    "a reversed or unapplied payment must preserve the previous schedule",
  );
});

Deno.test("replacement retry accepts locally active state but rejects terminal states", () => {
  assert(
    hubActivationAllowsReplacementCancellation({
      applied: false,
      status: "ACTIVE",
    }),
    "a retry must finish provider cancellation after local activation committed",
  );
  assert(
    hubActivationAllowsReplacementCancellation({
      applied: true,
      status: "PAST_DUE",
    }),
    "an already applied payment can finish its durable cancellation action",
  );
  for (const status of ["CANCELLED", "REVERSED", "EXPIRED"]) {
    assert(
      !hubActivationAllowsReplacementCancellation({ applied: true, status }),
      `${status} must never cancel the previous provider schedule`,
    );
  }
  assert(
    !hubActivationAllowsReplacementCancellation(null),
    "missing activation evidence must fail closed",
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
