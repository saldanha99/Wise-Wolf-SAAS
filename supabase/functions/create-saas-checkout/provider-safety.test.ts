/// <reference lib="deno.ns" />

import {
  containsCardMaterial,
  resolveProviderCustomer,
  resolveProviderSubscription,
  saasCheckoutNextDueDate,
  saasCheckoutProviderReference,
} from "./provider-safety.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEquals(
  actual: unknown,
  expected: unknown,
  message: string,
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

const checkoutId = "00000000-0000-4000-8000-000000000100";
const reference = saasCheckoutProviderReference(checkoutId);
const subscriptionExpected = {
  reference,
  customerId: "cus_expected",
  billingType: "PIX" as const,
  billingCycle: "MONTHLY" as const,
  amount: 397,
  description: "Assinatura Wise Wolf SaaS",
  maxPayments: null,
  splitPolicy: { kind: "NONE" as const },
  nextDueDate: "2026-08-26",
  status: "ACTIVE" as const,
};

Deno.test("checkout rejects nested card material", () => {
  assert(
    containsCardMaterial({ payment: { creditCard: { cvv: "123" } } }),
    "nested card fields must be rejected",
  );
  assert(
    !containsCardMaterial({ billing_type: "PIX", postalCode: "01000-000" }),
    "ordinary PIX checkout fields must remain accepted",
  );
});

Deno.test("customer recovery requires one exact reference and CPF identity", () => {
  assertEquals(
    resolveProviderCustomer(
      [{
        id: "cus_expected",
        externalReference: reference,
        cpfCnpj: "11.222.333/0001-81",
      }],
      reference,
      "11222333000181",
    ),
    { status: "MATCH", id: "cus_expected" },
    "the exact active identity should be reusable",
  );
  assertEquals(
    resolveProviderCustomer(
      [{
        id: "cus_conflict",
        externalReference: reference,
        cpfCnpj: "99888777000166",
      }],
      reference,
      "11222333000181",
    ),
    { status: "CONFLICT" },
    "a divergent CPF must block recovery",
  );
  assertEquals(
    resolveProviderCustomer(
      [
        {
          id: "cus_one",
          externalReference: reference,
          cpfCnpj: "11222333000181",
        },
        {
          id: "cus_two",
          externalReference: reference,
          cpfCnpj: "11222333000181",
        },
      ],
      reference,
      "11222333000181",
    ),
    { status: "CONFLICT" },
    "duplicate exact customers must never be selected automatically",
  );
});

Deno.test("subscription recovery validates every immutable financial field", () => {
  const exact = {
    id: "sub_expected",
    externalReference: reference,
    customer: "cus_expected",
    billingType: "PIX",
    cycle: "MONTHLY",
    value: 397,
    description: subscriptionExpected.description,
    nextDueDate: "2026-08-26",
    status: "ACTIVE",
  };
  assertEquals(
    resolveProviderSubscription([exact], subscriptionExpected),
    { status: "MATCH", id: "sub_expected" },
    "the exact active financial schedule should be reusable",
  );

  for (
    const divergent of [
      { ...exact, externalReference: "saas:other" },
      { ...exact, customer: "cus_other" },
      { ...exact, billingType: "BOLETO" },
      { ...exact, cycle: "YEARLY" },
      { ...exact, value: 397.01 },
      { ...exact, description: "Outro produto" },
      { ...exact, maxPayments: 12 },
      {
        ...exact,
        split: [{ walletId: "wallet_unexpected", percentualValue: 90 }],
      },
      { ...exact, nextDueDate: "2026-08-27" },
      { ...exact, status: "INACTIVE" },
    ]
  ) {
    const resolution = resolveProviderSubscription(
      [divergent],
      subscriptionExpected,
    );
    assert(
      resolution.status !== "MATCH",
      `divergent subscription was accepted: ${JSON.stringify(divergent)}`,
    );
  }
});

Deno.test("subscription recovery blocks exact duplicates", () => {
  const exact = {
    externalReference: reference,
    customer: "cus_expected",
    billingType: "PIX",
    cycle: "MONTHLY",
    value: 397,
    description: subscriptionExpected.description,
    nextDueDate: "2026-08-26",
    status: "ACTIVE",
  };
  assertEquals(
    resolveProviderSubscription([
      { ...exact, id: "sub_one" },
      { ...exact, id: "sub_two" },
    ], subscriptionExpected),
    { status: "CONFLICT" },
    "provider duplicates need manual review",
  );
});

Deno.test("next due date is derived once from the checkout UTC timestamp", () => {
  assertEquals(
    saasCheckoutNextDueDate("2026-08-25T23:59:59.000Z"),
    "2026-08-26",
    "UTC calculation must not depend on retry time or machine timezone",
  );
  assertEquals(
    saasCheckoutNextDueDate("invalid"),
    null,
    "invalid checkout timestamps must fail closed",
  );
});

Deno.test({
  name: "SaaS provider creations are claimed once and every retry is GET-only",
  permissions: { read: true },
  async fn() {
    const source = await Deno.readTextFile(
      new URL("./index.ts", import.meta.url),
    );
    const customerClaim = source.indexOf('operation: "CUSTOMER_CREATE"');
    const customerLookup = source.indexOf(
      "const customerLookup = await findUniqueAsaasEntity",
      customerClaim,
    );
    const customerCapability = source.indexOf(
      '"customer.create"',
      customerLookup,
    );
    const customerFence = source.indexOf(
      "await markAsaasCreationSubmitting(supabase, customerClaim)",
      customerCapability,
    );
    const customerPost = source.indexOf(
      "`${freshCustomerCreateIntegration.baseUrl}/customers`",
      customerFence,
    );
    const subscriptionClaim = source.indexOf(
      'operation: "SUBSCRIPTION_CREATE"',
      customerPost,
    );
    const subscriptionLookup = source.indexOf(
      "const subscriptionLookup = await findUniqueAsaasEntity",
      subscriptionClaim,
    );
    const subscriptionCapability = source.indexOf(
      '"subscription.create"',
      subscriptionLookup,
    );
    const subscriptionFence = source.indexOf(
      "await markAsaasCreationSubmitting(supabase, subscriptionClaim)",
      subscriptionCapability,
    );
    const subscriptionPost = source.indexOf(
      "`${freshSubscriptionCreateIntegration.baseUrl}/subscriptions`",
      subscriptionFence,
    );

    assert(
      customerClaim >= 0 && customerLookup > customerClaim &&
        customerCapability > customerLookup &&
        customerFence > customerCapability && customerPost > customerFence,
      "customer creation must claim, reconcile, authorize and fence before its only POST",
    );
    assert(
      subscriptionClaim > customerPost &&
        subscriptionLookup > subscriptionClaim &&
        subscriptionCapability > subscriptionLookup &&
        subscriptionFence > subscriptionCapability &&
        subscriptionPost > subscriptionFence,
      "subscription creation must claim, reconcile, authorize and fence before its only POST",
    );
    assert(
      (source.match(/method: "POST"/g) ?? []).length === 2,
      "the checkout must expose exactly two durably claimed creation POSTs",
    );
    assert(
      source.includes('method !== "GET"') &&
        source.includes(
          'throw new Error("ASAAS_CREATION_REQUIRES_DURABLE_CLAIM")',
        ),
      "the generic provider helper must be read-only",
    );
    assert(
      (source.match(
            /conflicts:\s*\(candidate\)\s*=>\s*activeProviderIdentity/g,
          ) ?? [])
            .length === 2 &&
        source.includes('customerLookup.kind === "CONFLICT"') &&
        source.includes('subscriptionLookup.kind === "CONFLICT"'),
      "same-reference payload conflicts must block both provider creations",
    );
    assert(
      !source.includes('method: "DELETE"') &&
        !source.includes("removeProviderObject"),
      "a succeeded provider claim must never be deleted as compensation",
    );
    assert(
      source.includes("saasCheckoutNextDueDate(checkout.created_at)") &&
        source.includes("providerSubscriptionDescription") &&
        source.includes('status: "ACTIVE" as const'),
      "financial schedule and description must be frozen and validated exactly",
    );
    assert(
      source.includes("code: responseCode") &&
        source.includes('"PROVIDER_REVIEW_REQUIRED"') &&
        source.includes('"PROVIDER_RECONCILIATION_REQUIRED"'),
      "manual review and ambiguous recovery need distinct HTTP contracts",
    );
    assert(
      source.includes("loadAllSubscriptionPayments(") &&
        source.includes("?limit=100&offset=${offset}"),
      "first-payment recovery must exhaust provider pagination",
    );
    assert(
      source.includes("resolvePlatformAsaasIntegration") &&
        source.includes('"customer.read"') &&
        source.includes('"subscription.read"') &&
        source.includes('"payment.read"') &&
        !source.includes('Deno.env.get("ASAAS_ACCESS_TOKEN")') &&
        !source.includes('Deno.env.get("ASAAS_API_KEY")'),
      "every provider read/write must use the purpose-scoped platform broker",
    );
  },
});
