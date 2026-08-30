/// <reference lib="deno.ns" />

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  asaasProviderIdentityMismatchFields,
  asaasSubscriptionPostconditionMismatchFields,
  type CanonicalAsaasMutationTarget,
  guardAsaasMutationTarget,
  parseCanonicalAsaasReference,
} from "./asaas-mutation-guard.ts";

const studentId = "00000000-0000-4000-8000-000000000011";
const offerId = "00000000-0000-4000-8000-000000000022";

function subscriptionTarget(): CanonicalAsaasMutationTarget {
  return {
    tenantId: "school-one",
    studentId,
    resource: "subscription",
    entityId: "sub_one",
    customerId: "cus_one",
    subscriptionId: "sub_one",
    subscriptionMatch: "entity_id",
  };
}

Deno.test("accepts only canonical student or tenant-scoped enrollment references", () => {
  assertEquals(
    parseCanonicalAsaasReference(studentId, studentId, "subscription"),
    { kind: "STUDENT" },
  );
  assertEquals(
    parseCanonicalAsaasReference(
      `enrollment:${offerId}:subscription`,
      studentId,
      "subscription",
    ),
    { kind: "ENROLLMENT", offerId, purpose: "subscription" },
  );
  assertEquals(
    parseCanonicalAsaasReference(
      `enrollment:${offerId}:fee`,
      studentId,
      "subscription",
    ),
    null,
  );
  const paymentReference = parseCanonicalAsaasReference(
    `enrollment:${offerId}:fee`,
    studentId,
    "payment",
  );
  assertEquals(
    paymentReference?.kind === "ENROLLMENT" ? paymentReference.purpose : null,
    "fee",
  );
  assertEquals(
    parseCanonicalAsaasReference(
      "00000000-0000-4000-8000-000000000099",
      studentId,
      "payment",
    ),
    null,
  );
});

Deno.test("reports every divergent provider binding", () => {
  assertEquals(
    asaasProviderIdentityMismatchFields(
      {
        id: "sub_other",
        customer: "cus_other",
        externalReference: "other",
        deleted: true,
      },
      subscriptionTarget(),
      false,
    ),
    ["id", "customer", "deleted", "externalReference"],
  );
});

Deno.test("subscription postcondition compares exact cents and payment limit", () => {
  assertEquals(
    asaasSubscriptionPostconditionMismatchFields(
      { value: 250.75, maxPayments: 12 },
      { value: 250.75, maxPayments: 12 },
    ),
    [],
  );
  assertEquals(
    asaasSubscriptionPostconditionMismatchFields(
      { value: 250.74, maxPayments: 11 },
      { value: 250.75, maxPayments: 12 },
    ),
    ["value", "maxPayments"],
  );
});

Deno.test("requires the recurring subscription on a payment mutation", () => {
  const target: CanonicalAsaasMutationTarget = {
    ...subscriptionTarget(),
    resource: "payment",
    entityId: "pay_one",
    subscriptionMatch: "required",
  };
  assertEquals(
    asaasProviderIdentityMismatchFields(
      {
        id: "pay_one",
        customer: "cus_one",
        subscription: "sub_other",
        externalReference: studentId,
      },
      target,
      true,
    ),
    ["subscription"],
  );
  assertEquals(
    asaasProviderIdentityMismatchFields(
      {
        id: "pay_one",
        customer: "cus_one",
        subscription: "sub_one",
        externalReference: studentId,
      },
      target,
      true,
    ),
    [],
  );
});

Deno.test("preflight uses GET and accepts an exact direct binding", async () => {
  const requests: Array<{ url: string; method: string | undefined }> = [];
  const result = await guardAsaasMutationTarget({
    admin: {},
    baseUrl: "https://api.example.test/v3/",
    apiKey: "secret-not-logged",
    operation: "test_subscription_update",
    target: subscriptionTarget(),
    fetcher: (input, init) => {
      requests.push({ url: String(input), method: init?.method });
      return Promise.resolve(Response.json({
        id: "sub_one",
        customer: "cus_one",
        externalReference: studentId,
      }));
    },
  });

  assert(result.ok);
  assertEquals(requests, [{
    url: "https://api.example.test/v3/subscriptions/sub_one",
    method: "GET",
  }]);
});

Deno.test("mismatch blocks and persists a critical signal", async () => {
  const issues: Record<string, unknown>[] = [];
  const admin = {
    from(table: string) {
      assertEquals(table, "asaas_reconciliation_issues");
      return {
        insert(payload: Record<string, unknown>) {
          issues.push(payload);
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  const result = await guardAsaasMutationTarget({
    admin,
    baseUrl: "https://api.example.test/v3",
    apiKey: "secret-not-logged",
    operation: "test_subscription_delete",
    target: subscriptionTarget(),
    fetcher: () =>
      Promise.resolve(Response.json({
        id: "sub_one",
        customer: "cus_other",
        externalReference: studentId,
      })),
  });

  assertEquals(result, {
    ok: false,
    code: "IDENTITY_MISMATCH",
    providerStatus: 200,
  });
  assertEquals(issues.length, 1);
  assertEquals(issues[0].severity, "CRITICAL");
  assertEquals(issues[0].kind, "ASAAS_PROVIDER_IDENTITY_MISMATCH");
  assertEquals(
    (issues[0].details as Record<string, unknown>).mismatchFields,
    ["customer"],
  );
});

Deno.test("recurring payment may prove an absent reference on its parent", async () => {
  const requests: string[] = [];
  const result = await guardAsaasMutationTarget({
    admin: {},
    baseUrl: "https://api.example.test/v3",
    apiKey: "secret-not-logged",
    operation: "test_payment_charge",
    target: {
      ...subscriptionTarget(),
      resource: "payment",
      entityId: "pay_one",
      subscriptionMatch: "required",
    },
    fetcher: (input) => {
      const url = String(input);
      requests.push(url);
      return Promise.resolve(Response.json(
        url.includes("/payments/")
          ? {
            id: "pay_one",
            customer: "cus_one",
            subscription: "sub_one",
            externalReference: null,
          }
          : {
            id: "sub_one",
            customer: "cus_one",
            externalReference: studentId,
          },
      ));
    },
  });

  assert(result.ok);
  assertEquals(requests, [
    "https://api.example.test/v3/payments/pay_one",
    "https://api.example.test/v3/subscriptions/sub_one",
  ]);
});

Deno.test("enrollment reference must resolve to the same student and tenant", async () => {
  const query = {
    select() {
      return this;
    },
    eq() {
      return this;
    },
    maybeSingle() {
      return Promise.resolve({
        data: {
          id: offerId,
          tenant_id: "school-one",
          processing_by: studentId,
          consumed_by: null,
        },
        error: null,
      });
    },
  };
  const admin = {
    from(table: string) {
      assertEquals(table, "offers");
      return query;
    },
  };
  const result = await guardAsaasMutationTarget({
    admin,
    baseUrl: "https://api.example.test/v3",
    apiKey: "secret-not-logged",
    operation: "test_subscription_update",
    target: subscriptionTarget(),
    fetcher: () =>
      Promise.resolve(Response.json({
        id: "sub_one",
        customer: "cus_one",
        externalReference: `enrollment:${offerId}:subscription`,
      })),
  });
  assert(result.ok);
});
