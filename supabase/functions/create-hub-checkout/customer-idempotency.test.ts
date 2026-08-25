/// <reference lib="deno.ns" />

import {
  decideHubAsaasCustomerCompensation,
  hubAsaasCustomerReference,
  normalizeAsaasCustomerId,
  resolveHubAsaasCustomerCandidate,
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

Deno.test("compensation deletes only a customer proven created by this attempt and still unlinked", () => {
  assertEquals(
    decideHubAsaasCustomerCompensation({
      createdCustomerId: "cus_attempt",
      linkedCustomerIds: [],
      linkStateConfirmed: true,
      providerObjectsSafeToDelete: true,
    }),
    "DELETE_CREATED_CUSTOMER",
    "the unlinked customer created by this attempt should be compensated",
  );
  assertEquals(
    decideHubAsaasCustomerCompensation({
      createdCustomerId: null,
      linkedCustomerIds: [],
      linkStateConfirmed: true,
      providerObjectsSafeToDelete: true,
    }),
    "NOT_CREATED_BY_ATTEMPT",
    "a recovered customer must never be deleted",
  );
});

Deno.test("compensation keeps linked customers and defers on ambiguous state", () => {
  assertEquals(
    decideHubAsaasCustomerCompensation({
      createdCustomerId: "cus_attempt",
      linkedCustomerIds: ["cus_attempt"],
      linkStateConfirmed: true,
      providerObjectsSafeToDelete: true,
    }),
    "KEEP_LINKED_CUSTOMER",
    "a concurrently linked customer must not be deleted",
  );
  assertEquals(
    decideHubAsaasCustomerCompensation({
      createdCustomerId: "cus_attempt",
      linkedCustomerIds: [],
      linkStateConfirmed: false,
      providerObjectsSafeToDelete: true,
    }),
    "DEFER_UNCONFIRMED_STATE",
    "an unavailable database read must fail closed",
  );
  assertEquals(
    decideHubAsaasCustomerCompensation({
      createdCustomerId: "cus_attempt",
      linkedCustomerIds: [],
      linkStateConfirmed: true,
      providerObjectsSafeToDelete: false,
    }),
    "DEFER_UNCONFIRMED_STATE",
    "a provider subscription with unknown rollback state must protect its customer",
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

Deno.test({
  name: "checkout reconciles before create and compare-and-sets the local link",
  permissions: { read: true },
  async fn() {
    const source = await Deno.readTextFile(
      new URL("./index.ts", import.meta.url),
    );
    const lookupPosition = source.indexOf(
      "const existingCustomers = await asaasRequest(",
    );
    const createPosition = source.indexOf(
      'const customer = await asaasRequest("/customers", {',
    );
    if (
      lookupPosition < 0 || createPosition < 0 ||
      lookupPosition >= createPosition
    ) {
      throw new Error("provider lookup must happen before customer creation");
    }
    if (!source.includes('.is("asaas_customer_id", null)')) {
      throw new Error("customer binding must use a null compare-and-set guard");
    }
    if (!source.includes("!Array.isArray(existingCustomers?.data)")) {
      throw new Error("a malformed provider lookup must fail closed");
    }
    if (!source.includes("createdProviderCustomerId = customerId;")) {
      throw new Error(
        "compensation provenance must come from the POST response",
      );
    }
    if (!source.includes("await compensateCreatedProviderCustomer(")) {
      throw new Error("created customers need a guarded compensation path");
    }
  },
});
