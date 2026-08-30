/// <reference lib="deno.ns" />

import {
  decideHubAsaasCustomerPreservation,
  hubAsaasCustomerReference,
  normalizeAsaasCustomerId,
  resolveHubAsaasCustomerCandidate,
  resolveHubAsaasSubscriptionCandidate,
} from "./customer-idempotency.ts";

const assertEquals = (actual: unknown, expected: unknown, message: string) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
};

const accountId = "00000000-0000-4000-8000-000000000001";
const reference = hubAsaasCustomerReference(accountId);

Deno.test("reuses only an active Asaas customer with the account reference and billing identity", () => {
  assertEquals(
    resolveHubAsaasCustomerCandidate(
      [
        {
          id: "cus_other_account",
          externalReference: "hub-account:00000000-0000-4000-8000-000000000002",
          cpfCnpj: "123.456.789-09",
        },
        {
          id: "cus_deleted",
          externalReference: reference,
          cpfCnpj: "123.456.789-09",
          deleted: true,
        },
        {
          id: "cus_account",
          externalReference: reference,
          cpfCnpj: "123.456.789-09",
        },
      ],
      reference,
      "12345678909",
    ),
    { status: "MATCH", customerId: "cus_account" },
    "cross-account and deleted customers must never be reused",
  );
});

Deno.test("fails closed when the account reference exists with another billing identity", () => {
  assertEquals(
    resolveHubAsaasCustomerCandidate(
      [
        {
          id: "cus_wrong_identity",
          externalReference: reference,
          cpfCnpj: "987.654.321-00",
        },
      ],
      reference,
      "12345678909",
    ),
    { status: "IDENTITY_CONFLICT" },
    "an identity mismatch must block a duplicate customer creation",
  );
});

Deno.test("chooses a stable canonical customer when a prior failure already left duplicates", () => {
  assertEquals(
    resolveHubAsaasCustomerCandidate(
      [
        {
          id: "cus_newer",
          externalReference: reference,
          cpfCnpj: "12345678909",
          dateCreated: "2026-08-23",
        },
        {
          id: "cus_older",
          externalReference: reference,
          cpfCnpj: "12345678909",
          dateCreated: "2026-08-22",
        },
      ],
      reference,
      "12345678909",
    ),
    { status: "MATCH", customerId: "cus_older" },
    "reconciliation must be deterministic across retries",
  );
});

Deno.test("an unlinked claimed customer is preserved for explicit review", () => {
  assertEquals(
    decideHubAsaasCustomerPreservation({
      createdCustomerId: "cus_attempt",
      linkedCustomerIds: [],
      linkStateConfirmed: true,
    }),
    "PRESERVE_CREATED_CUSTOMER_FOR_REVIEW",
    "a succeeded creation claim must never point at a deleted customer",
  );
  assertEquals(
    decideHubAsaasCustomerPreservation({
      createdCustomerId: null,
      linkedCustomerIds: [],
      linkStateConfirmed: true,
    }),
    "NOT_CREATED_BY_ATTEMPT",
    "a recovered customer must never be deleted",
  );
});

Deno.test("customer preservation keeps linked ids and fails closed on uncertain state", () => {
  assertEquals(
    decideHubAsaasCustomerPreservation({
      createdCustomerId: "cus_attempt",
      linkedCustomerIds: ["cus_attempt"],
      linkStateConfirmed: true,
    }),
    "KEEP_LINKED_CUSTOMER",
    "a concurrently linked customer must not be deleted",
  );
  assertEquals(
    decideHubAsaasCustomerPreservation({
      createdCustomerId: "cus_attempt",
      linkedCustomerIds: [],
      linkStateConfirmed: false,
    }),
    "PRESERVE_CREATED_CUSTOMER_FOR_REVIEW",
    "an unavailable database read must fail closed",
  );
  assertEquals(
    decideHubAsaasCustomerPreservation({
      createdCustomerId: "cus_attempt",
      linkedCustomerIds: ["cus_other"],
      linkStateConfirmed: true,
    }),
    "PRESERVE_CREATED_CUSTOMER_FOR_REVIEW",
    "a compare-and-set loser must preserve the claimed customer for triage",
  );
});

Deno.test("rejects malformed provider customer identifiers", () => {
  assertEquals(
    normalizeAsaasCustomerId("cus_safe-123"),
    "cus_safe-123",
    "valid id",
  );
  assertEquals(normalizeAsaasCustomerId("../customer"), null, "path-like id");
  assertEquals(normalizeAsaasCustomerId("customer id"), null, "spaced id");
});

Deno.test("reuses a subscription only when every immutable billing field matches", () => {
  const expected = {
    externalReference: "hub:00000000-0000-4000-8000-000000000123",
    customerId: "cus_expected",
    billingType: "PIX" as const,
    billingCycle: "MONTHLY" as const,
    amount: 99.9,
    nextDueDate: "2026-08-25",
    description: "Wise Wolf Hub - Pro (MONTHLY)",
    maxPayments: null,
    splitPolicy: { kind: "NONE" as const },
  };
  assertEquals(
    resolveHubAsaasSubscriptionCandidate({
      id: "sub_expected",
      customer: "cus_expected",
      billingType: "PIX",
      cycle: "MONTHLY",
      value: 99.90,
      externalReference: expected.externalReference,
      nextDueDate: expected.nextDueDate,
      description: expected.description,
      status: "ACTIVE",
    }, expected),
    {
      status: "MATCH",
      subscriptionId: "sub_expected",
      providerStatus: "ACTIVE",
    },
    "an exact provider subscription should be recovered",
  );

  for (
    const conflicting of [
      { customer: "cus_other" },
      { billingType: "BOLETO" },
      { cycle: "YEARLY" },
      { value: 100 },
      { externalReference: "hub:other" },
      { nextDueDate: "2026-08-26" },
      { description: "Changed provider schedule" },
      { status: "INACTIVE" },
      { status: "EXPIRED" },
      { maxPayments: 12 },
      { split: [{ walletId: "wallet_other", percentualValue: 90 }] },
      { split: {} },
      { deleted: true },
    ]
  ) {
    assertEquals(
      resolveHubAsaasSubscriptionCandidate({
        id: "sub_conflict",
        customer: "cus_expected",
        billingType: "PIX",
        cycle: "MONTHLY",
        value: 99.9,
        externalReference: expected.externalReference,
        nextDueDate: expected.nextDueDate,
        description: expected.description,
        status: "ACTIVE",
        ...conflicting,
      }, expected),
      { status: "CONFLICT" },
      "a changed immutable provider field must require review",
    );
  }

  for (const noSplit of [undefined, null, []]) {
    assertEquals(
      resolveHubAsaasSubscriptionCandidate({
        id: "sub_expected",
        customer: "cus_expected",
        billingType: "PIX",
        cycle: "MONTHLY",
        value: 99.9,
        externalReference: expected.externalReference,
        nextDueDate: expected.nextDueDate,
        description: expected.description,
        status: "ACTIVE",
        maxPayments: null,
        split: noSplit,
      }, expected).status,
      "MATCH",
      "nullish/empty provider split representations must mean no split",
    );
  }
});

Deno.test({
  name:
    "checkout durably claims customer creation and compare-and-sets the local link",
  permissions: { read: true },
  async fn() {
    const source = await Deno.readTextFile(
      new URL("./index.ts", import.meta.url),
    );
    const claimPosition = source.indexOf('operation: "CUSTOMER_CREATE"');
    const lookupPosition = source.indexOf(
      "const customerLookup = await findUniqueAsaasEntity",
      claimPosition,
    );
    const submitFencePosition = source.indexOf(
      "await markHubProviderCreationSubmitting({",
      lookupPosition,
    );
    const createPosition = source.indexOf(
      "`${customerCreateIntegration.baseUrl}/customers`",
      submitFencePosition,
    );
    if (
      claimPosition < 0 || lookupPosition < 0 || submitFencePosition < 0 ||
      createPosition < 0 || claimPosition >= lookupPosition ||
      lookupPosition >= submitFencePosition ||
      submitFencePosition >= createPosition
    ) {
      throw new Error(
        "durable claim, full lookup and submit fence must precede customer POST",
      );
    }
    if (
      !source.includes("await adoptHubProviderCreationBinding({") ||
      !source.includes("providerEntityId: customerId")
    ) {
      throw new Error(
        "customer recovery must atomically adopt its provider claim and local link",
      );
    }
    if (
      !source.includes("await assertProviderCustomerIdentity(customerId)") ||
      !source.includes("ASAAS_CUSTOMER_PROVIDER_IDENTITY_CONFLICT")
    ) {
      throw new Error(
        "linked and claimed customer ids must be reloaded and proven at the provider",
      );
    }
    if (!source.includes('customerLookup.kind === "DUPLICATE"')) {
      throw new Error("duplicate provider customers must enter triage");
    }
    if (!source.includes("createdProviderCustomerId = submittedCustomerId;")) {
      throw new Error(
        "compensation provenance must come from the POST response",
      );
    }
    const postIdentityProof = source.indexOf(
      "await assertProviderCustomerIdentity(submittedCustomerId)",
      createPosition,
    );
    const succeededRecording = source.indexOf(
      "await recordAsaasCreationState(auth.context.admin, customerClaim",
      postIdentityProof,
    );
    if (
      postIdentityProof < createPosition ||
      succeededRecording < postIdentityProof
    ) {
      throw new Error(
        "a 2xx customer POST must be GET-proven by id/reference/CPF before success is recorded",
      );
    }
    if (
      source.includes('method: "DELETE"') ||
      source.includes("deleteAsaasCustomer") ||
      source.includes("DELETE_CREATED_CUSTOMER") ||
      source.includes("compensateCreatedProviderCustomer")
    ) {
      throw new Error(
        "a succeeded customer creation claim must never be deleted by checkout compensation",
      );
    }
    if (
      source.includes('asaasRequest("/customers", {') ||
      !source.includes('status: "UNKNOWN"')
    ) {
      throw new Error(
        "customer creation must never bypass the durable ambiguous-outcome guard",
      );
    }
  },
});
