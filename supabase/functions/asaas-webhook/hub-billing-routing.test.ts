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
  name:
    "School OS billing is synchronous and never skips provisioned checkouts",
  permissions: { read: true },
  async fn() {
    const source = await Deno.readTextFile(
      new URL("./index.ts", import.meta.url),
    );
    assert(
      source.includes("saas_billing_event_inbox") &&
        source.includes("SAAS_RETRY_REQUIRED"),
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
        source.includes("accessEvent ? 503 : 200"),
      "an unresolved access event must request a provider retry, never ack 200",
    );
  },
});
