/// <reference lib="deno.ns" />

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ambiguousProviderMutationStatus,
  canonicalEnrollmentSplitPolicy,
  deterministicProviderDeclineStatus,
  providerCustomerMatchesStudent,
  providerEnrollmentPaymentMatches,
  providerPaymentSplitMatches,
  providerSplitPayload,
  providerSplitPoliciesEqual,
} from "./student-provider-lifecycle.ts";

Deno.test("customer identity requires id, student reference and CPF", () => {
  const expected = {
    id: "cus_123",
    externalReference: "11111111-1111-4111-8111-111111111111",
    cpfCnpj: "28718884857",
  };
  const customer = {
    id: expected.id,
    externalReference: expected.externalReference,
    cpfCnpj: "287.188.848-57",
  };
  assert(providerCustomerMatchesStudent(customer, expected));
  assert(
    !providerCustomerMatchesStudent({ ...customer, id: "cus_other" }, expected),
  );
  assert(
    !providerCustomerMatchesStudent(
      { ...customer, externalReference: "other" },
      expected,
    ),
  );
  assert(
    !providerCustomerMatchesStudent(
      { ...customer, cpfCnpj: "00000000000" },
      expected,
    ),
  );
  assert(
    !providerCustomerMatchesStudent({ ...customer, deleted: true }, expected),
  );
});

Deno.test("enrollment PIX identity requires every immutable field", () => {
  const expected = {
    id: "pay_123",
    customerId: "cus_123",
    externalReference: "enrollment:offer:fee",
    value: 99.9,
    dueDate: "2026-08-25",
    description: "Taxa de Matricula Wise Wolf School",
    splitPolicy: { kind: "NONE" } as const,
  };
  const payment = {
    id: expected.id,
    customer: expected.customerId,
    externalReference: expected.externalReference,
    billingType: "PIX",
    value: "99.90",
    dueDate: expected.dueDate,
    description: expected.description,
    subscription: null,
  };
  assert(providerEnrollmentPaymentMatches(payment, expected));
  for (
    const divergent of [
      { ...payment, id: "pay_other" },
      { ...payment, customer: "cus_other" },
      { ...payment, externalReference: "other" },
      { ...payment, billingType: "BOLETO" },
      { ...payment, value: 99.91 },
      { ...payment, dueDate: "2026-08-26" },
      { ...payment, description: "Outra cobranca" },
      { ...payment, subscription: "sub_wrong" },
      { ...payment, deleted: true },
    ]
  ) {
    assert(!providerEnrollmentPaymentMatches(divergent, expected));
  }
});

Deno.test("enrollment PIX split policy is canonical and provider-proven", () => {
  const policy = canonicalEnrollmentSplitPolicy(
    "PLATFORM_MANAGED_ROOT",
    " wallet_school ",
    "90.123456",
  );
  assertEquals(policy, {
    kind: "PERCENTAGE",
    walletId: "wallet_school",
    percentualValue: 90.1235,
  });
  assert(policy !== null);
  assertEquals(providerSplitPayload(policy), [{
    walletId: "wallet_school",
    percentualValue: 90.1235,
  }]);
  assert(providerSplitPoliciesEqual(policy, {
    kind: "PERCENTAGE",
    walletId: "wallet_school",
    percentualValue: 90.1235,
  }));
  assert(providerPaymentSplitMatches({
    split: [{
      walletId: "wallet_school",
      percentualValue: "90.1235",
      totalValue: 90.12,
    }],
  }, policy));

  for (
    const divergent of [
      {},
      { split: [] },
      { split: [{ walletId: "wallet_other", percentualValue: 90.1235 }] },
      { split: [{ walletId: "wallet_school", percentualValue: 90 }] },
      {
        split: [{
          walletId: "wallet_school",
          percentualValue: 90.1235,
          fixedValue: 1,
        }],
      },
      {
        split: [
          { walletId: "wallet_school", percentualValue: 90.1235 },
          { walletId: "wallet_other", percentualValue: 1 },
        ],
      },
    ]
  ) {
    assert(!providerPaymentSplitMatches(divergent, policy));
  }
});

Deno.test("non-applicable split remains explicit and invalid split fails closed", () => {
  assertEquals(
    canonicalEnrollmentSplitPolicy("TENANT_BYOK", "wallet_ignored", 75),
    { kind: "NONE" },
  );
  assertEquals(
    canonicalEnrollmentSplitPolicy("PLATFORM_MANAGED_ROOT", "", 75),
    { kind: "NONE" },
  );
  assertEquals(
    canonicalEnrollmentSplitPolicy(
      "PLATFORM_MANAGED_ROOT",
      "wallet_school",
      null,
    ),
    { kind: "PERCENTAGE", walletId: "wallet_school", percentualValue: 90 },
  );
  assertEquals(
    canonicalEnrollmentSplitPolicy(
      "PLATFORM_MANAGED_ROOT",
      "wallet_school",
      0,
    ),
    null,
  );
  assert(providerPaymentSplitMatches({}, { kind: "NONE" }));
  assert(providerPaymentSplitMatches({ split: [] }, { kind: "NONE" }));
  assert(
    !providerPaymentSplitMatches({
      split: [{ walletId: "unexpected", percentualValue: 1 }],
    }, { kind: "NONE" }),
  );
});

Deno.test("timeouts and commit-racing HTTP statuses are never terminal declines", () => {
  for (const status of [408, 409, 425, 429, 500, 502, 503]) {
    assert(ambiguousProviderMutationStatus(status));
    assertEquals(deterministicProviderDeclineStatus(status), false);
  }
  for (const status of [400, 401, 403, 404, 422]) {
    assertEquals(ambiguousProviderMutationStatus(status), false);
    assert(deterministicProviderDeclineStatus(status));
  }
});
