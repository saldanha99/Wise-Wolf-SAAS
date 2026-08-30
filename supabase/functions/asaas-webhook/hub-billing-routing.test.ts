/// <reference lib="deno.ns" />

import {
  billingIdentityMismatch,
  hubPaymentEventRequiresIdentity,
  providerWebhookEventKey,
} from "./billing-safety.ts";

const assert = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};

Deno.test({
  name: "Hub webhook has one guarded activation path",
  permissions: { read: true },
  async fn() {
    const source = await Deno.readTextFile(
      new URL("./index.ts", import.meta.url),
    );
    assert(
      (source.match(/hub_activate_paid_checkout/g) ?? []).length === 1,
      "legacy direct activation paths must not coexist",
    );
    assert(
      source.includes("await processHubPaymentEvent(body);") &&
        source.includes("initialBillingBlock"),
      "all Hub routes must use the account and kill-switch guard",
    );
  },
});

Deno.test("paid billing identity fails closed on every provider mismatch", () => {
  const expected = {
    subscriptionId: "sub_expected",
    customerId: "cus_expected",
    amount: 119,
    billingType: "PIX",
    billingCycle: "MONTHLY",
  };
  const provider = {
    subscriptionId: "sub_expected",
    customerId: "cus_expected",
    amount: 119,
    billingType: "PIX",
    billingCycle: "MONTHLY",
  };

  assert(
    billingIdentityMismatch(expected, provider, {
      requireBillingCycle: true,
    }) === null,
    "the exact checkout identity must be accepted",
  );
  assert(
    billingIdentityMismatch(expected, {
      ...provider,
      subscriptionId: "sub_other",
    }) === "SUBSCRIPTION_MISMATCH",
    "a subscription mismatch must block activation",
  );
  assert(
    billingIdentityMismatch(expected, {
      ...provider,
      customerId: "cus_other",
    }) === "CUSTOMER_MISMATCH",
    "a customer mismatch must block activation",
  );
  assert(
    billingIdentityMismatch(expected, { ...provider, amount: 118.99 }) ===
      "AMOUNT_MISMATCH",
    "an amount mismatch must block activation",
  );
  assert(
    billingIdentityMismatch(expected, {
      ...provider,
      billingType: "BOLETO",
    }) ===
      "BILLING_TYPE_MISMATCH",
    "a billing type mismatch must block activation",
  );
  assert(
    billingIdentityMismatch(
      expected,
      { ...provider, billingCycle: "YEARLY" },
      { requireBillingCycle: true },
    ) === "BILLING_CYCLE_MISMATCH",
    "a subscription cycle mismatch must block activation",
  );
});

Deno.test({
  name: "Hub reversals, overdue and recovery reject forged billing identity",
  permissions: { read: true },
  async fn() {
    const expected = {
      subscriptionId: "sub_expected",
      customerId: "cus_expected",
      amount: 119,
      billingType: "PIX",
    };
    const forgedProvider = {
      subscriptionId: "sub_expected",
      customerId: "cus_attacker",
      amount: 1,
      billingType: "BOLETO",
    };

    for (
      const event of [
        "PAYMENT_REFUNDED",
        "PAYMENT_OVERDUE",
        "PAYMENT_RESTORED",
      ]
    ) {
      assert(
        hubPaymentEventRequiresIdentity(event),
        `${event} must validate the provider billing identity`,
      );
      assert(
        billingIdentityMismatch(expected, forgedProvider) !== null,
        `${event} must reject a forged reversal or recovery payload`,
      );
    }
    assert(
      !hubPaymentEventRequiresIdentity("PAYMENT_UPDATED"),
      "informational events must not be promoted to access-bearing events",
    );

    const source = await Deno.readTextFile(
      new URL("./index.ts", import.meta.url),
    );
    const identityGuard = source.indexOf(
      "if (hubPaymentEventRequiresIdentity(event))",
    );
    const paidBranch = source.indexOf(
      "if (PAID_EVENTS.has(event))",
      identityGuard,
    );
    assert(
      identityGuard >= 0 && paidBranch > identityGuard,
      "the shared identity guard must run before every Hub lifecycle branch",
    );
  },
});

Deno.test({
  name: "every Hub subscription DELETE proves provider and local identity",
  permissions: { read: true },
  async fn() {
    const source = await Deno.readTextFile(
      new URL("./index.ts", import.meta.url),
    );
    const shared = await Deno.readTextFile(
      new URL("../_shared/hub-provider-operations.ts", import.meta.url),
    );
    const durableClaim = shared.indexOf(
      '"hub_claim_webhook_provider_cancellation"',
    );
    const providerLookup = shared.indexOf(
      "await exactProviderLookup(",
      durableClaim,
    );
    const identityDecision = shared.indexOf(
      "hubProviderCancellationDecision(",
    );
    const providerDelete = shared.lastIndexOf('method: "DELETE"');
    assert(
      durableClaim >= 0 && providerLookup > durableClaim &&
        identityDecision >= 0 && providerDelete > providerLookup,
      "provider customer and checkout reference must be proven before DELETE",
    );
    assert(
      source.includes("cancelHubProviderSubscriptionForAccount(") &&
        source.includes(
          '.eq("asaas_subscription_id", providerSubscriptionId)',
        ) &&
        source.includes("matches.length !== 1"),
      "replacement, reversal and billing-block deletion must use one exact local binding",
    );
    assert(
      source.includes("cancelHubProviderSubscriptionOnce({") &&
        shared.includes('action === "RECONCILE_ONLY"') &&
        shared.includes('"hub_mark_provider_cancellation_submitting"'),
      "all Hub deletes must share the durable GET-only retry transport",
    );
  },
});

Deno.test("provider event keys make exact webhook replays deterministic", () => {
  const first = providerWebhookEventKey(
    "saas",
    "evt_same",
    "PAYMENT_RECEIVED",
    "pay_1",
  );
  const replay = providerWebhookEventKey(
    "saas",
    "evt_same",
    "PAYMENT_RECEIVED",
    "pay_1",
  );
  const nextEvent = providerWebhookEventKey(
    "saas",
    "evt_next",
    "PAYMENT_RECEIVED",
    "pay_1",
  );
  const hubNamespace = providerWebhookEventKey(
    "hub",
    "evt_same",
    "PAYMENT_RECEIVED",
    "pay_1",
  );

  assert(first === replay, "an exact replay must claim the same inbox row");
  assert(first !== nextEvent, "different provider events must remain distinct");
  assert(first !== hubNamespace, "Hub and School OS inboxes must not collide");
});

Deno.test({
  name: "refund reconciliation paginates and counts only completed refunds",
  permissions: { read: true },
  async fn() {
    const source = await Deno.readTextFile(
      new URL("./index.ts", import.meta.url),
    );
    const helper = source.slice(
      source.indexOf("async function listAllPaymentRefunds"),
      source.indexOf("async function processWolfieTopupEvent"),
    );
    assert(helper.includes('limit: "100"'), "refund lookup is not paginated");
    assert(
      helper.includes("payload.hasMore !== true"),
      "refund pagination may stop after the first page",
    );
    assert(
      source.includes('status === "DONE"'),
      "pending refunds must not reduce settled balance",
    );
    assert(
      helper.includes("integration.baseUrl") &&
        helper.includes("integration.apiKey") &&
        !helper.includes("ASAAS_ACCESS_TOKEN") &&
        source.includes("resolvePlatformAsaasIntegration(") &&
        source.includes('"payment.read"'),
      "top-up refund reads must use the purpose-scoped platform broker",
    );
  },
});

Deno.test({
  name:
    "School OS billing persists before ack and never skips provisioned checkouts",
  permissions: { read: true },
  async fn() {
    const source = await Deno.readTextFile(
      new URL("./index.ts", import.meta.url),
    );
    assert(
      source.includes("saas_billing_event_inbox") &&
        source.includes('"enqueue_asaas_webhook_event"') &&
        source.includes("PERSISTENCE_RETRY_REQUIRED"),
      "access-bearing School OS billing must persist before acknowledging",
    );
    assert(
      !source.includes('if (checkout.status === "PROVISIONED") return true;'),
      "renewals and reversals must not be skipped after provisioning",
    );
    assert(
      source.includes("apply_saas_checkout_billing_event"),
      "School OS lifecycle changes must use the atomic database transition",
    );
    assert(
      source.includes('throw new Error("saas_checkout_not_found")') &&
        source.includes('p_outcome: triage ? "TRIAGE" : "RETRY"'),
      "an unresolved durable access event must remain observable and retryable",
    );
    const enqueue = source.indexOf('"enqueue_asaas_webhook_event"');
    const acknowledgement = source.indexOf("received: true", enqueue);
    assert(
      enqueue >= 0 && acknowledgement > enqueue,
      "provider acknowledgement must occur only after durable enqueue",
    );
  },
});
