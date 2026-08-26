import {
  asaasCreationFingerprint,
  asaasCreationHttpOutcome,
  findUniqueAsaasEntity,
  isAsaasRefundedPaymentStatus,
  isAsaasSettledPaymentStatus,
} from "./asaas-creation-guard.ts";

function withMockFetch(
  handler: typeof fetch,
  run: () => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  return run().finally(() => {
    globalThis.fetch = originalFetch;
  });
}

Deno.test("creation fingerprint is canonical and changes with logical amount", async () => {
  const first = await asaasCreationFingerprint({
    operation: "PAYMENT_CREATE",
    amount: 100,
    tenantId: "tenant-a",
  });
  const reordered = await asaasCreationFingerprint({
    tenantId: "tenant-a",
    amount: 100,
    operation: "PAYMENT_CREATE",
  });
  const changed = await asaasCreationFingerprint({
    tenantId: "tenant-a",
    amount: 101,
    operation: "PAYMENT_CREATE",
  });
  if (!/^[a-f0-9]{64}$/.test(first) || first !== reordered) {
    throw new Error("fingerprint must be stable and canonical");
  }
  if (first === changed) throw new Error("changed amount reused fingerprint");
});

Deno.test("only an explicit 4xx is treated as a definitive failed creation", () => {
  if (asaasCreationHttpOutcome(true, 200, "pay_1") !== "SUCCEEDED") {
    throw new Error("successful provider id was not accepted");
  }
  if (asaasCreationHttpOutcome(false, 422, "") !== "FAILED") {
    throw new Error("definitive validation rejection was not terminal");
  }
  for (const status of [0, 408, 409, 425, 429, 500, 502, 504]) {
    if (asaasCreationHttpOutcome(false, status, "") !== "UNKNOWN") {
      throw new Error(`${status} must require GET reconciliation`);
    }
  }
  if (asaasCreationHttpOutcome(true, 200, "") !== "UNKNOWN") {
    throw new Error("2xx without an entity id is ambiguous");
  }
});

Deno.test("CONFIRMED never settles access and REFUNDED reopens it", () => {
  if (isAsaasSettledPaymentStatus("CONFIRMED")) {
    throw new Error("CONFIRMED must not activate enrollment or access");
  }
  if (
    !isAsaasSettledPaymentStatus("RECEIVED") ||
    !isAsaasSettledPaymentStatus("RECEIVED_IN_CASH")
  ) {
    throw new Error("settled provider states were rejected");
  }
  if (!isAsaasRefundedPaymentStatus("REFUNDED")) {
    throw new Error("REFUNDED must reopen the enrollment payment state");
  }
});

Deno.test({
  name: "provider identity conflict is never downgraded to NOT_FOUND",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withMockFetch(
      () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              data: [{
                id: "pay_conflict",
                externalReference: "manual-pix:one",
                customer: "cus_other",
              }],
              hasMore: false,
            }),
            { status: 200 },
          ),
        ),
      async () => {
        const lookup = await findUniqueAsaasEntity({
          baseUrl: "https://provider.invalid/v3",
          apiKey: "test-only",
          path: "payments",
          query: { externalReference: "manual-pix:one" },
          matches: (entity) => entity.customer === "cus_expected",
          conflicts: (entity) => entity.externalReference === "manual-pix:one",
        });
        if (lookup.kind !== "CONFLICT" || lookup.count !== 1) {
          throw new Error(`identity conflict was downgraded: ${lookup.kind}`);
        }
      },
    );
  },
});
