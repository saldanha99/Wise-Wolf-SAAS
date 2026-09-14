import {
  type Dependencies,
  type Integration,
  type Json,
  matchesInvoice,
  processCancellation,
  type Source,
} from "./core.ts";
const assert = (ok: unknown, message: string) => {
  if (!ok) throw new Error(message);
};
const operation = "7e150000-0000-4000-8000-000000000001";
const actor = "7e150000-0000-4000-8000-000000000002";
const source: Source = {
  payment_id: operation,
  tenant_id: "qa-school",
  student_id: actor,
  provider_payment_id: "pay_exact",
  customer_id: "cus_exact",
  subscription_id: "sub_exact",
  due_date: "2026-09-15",
  value: 100,
  status: "PENDING",
};
const provider: Json = {
  id: "pay_exact",
  customer: "cus_exact",
  subscription: "sub_exact",
  dueDate: "2026-09-15",
  value: 100,
  status: "PENDING",
  deleted: false,
};
const integration: Integration = {
  integrationId: "integration-qa",
  tenantId: "qa-school",
  provider: "asaas",
  version: 1,
  environment: "sandbox",
  mode: "TENANT_BYOK",
  baseUrl: "https://api-sandbox.asaas.com/v3",
  apiKey: "never-log-fixture",
};
function fixture() {
  const trace: string[] = [];
  const outcomes: string[] = [];
  let action = "SUBMIT_ONCE";
  const deps: Dependencies = {
    token: () => operation,
    claim: async () => ({ ok: true, action, token: operation, source }),
    resolve: async (_tenant, purpose) => {
      trace.push(purpose);
      return integration;
    },
    get: async () => {
      trace.push("GET exact");
      return { status: 200, body: { ...provider } };
    },
    verifyCanonical: async () => {
      trace.push("canonical");
      return true;
    },
    revalidate: async () => {
      trace.push("capability");
      return integration;
    },
    begin: async () => {
      trace.push("boundary");
      return { ok: true };
    },
    remove: async () => {
      trace.push("DELETE exact");
      return { status: 200, body: { id: "pay_exact", deleted: true } };
    },
    finish: async (_op, _actor, _token, outcome) => {
      outcomes.push(outcome);
      if (outcome === "UNKNOWN") action = "RECONCILE_ONLY";
      return {
        ok: true,
        status: ["GET_DELETED", "DELETE_CONFIRMED"].includes(outcome)
          ? "CONFIRMED"
          : outcome,
      };
    },
  };
  return {
    deps,
    trace,
    outcomes,
    reconcile: () => {
      action = "RECONCILE_ONLY";
    },
  };
}

Deno.test("exact invoice GET, identity and durable boundary precede one DELETE", async () => {
  const f = fixture();
  const result = await processCancellation(operation, actor, f.deps);
  assert(result.status === "CONFIRMED", "cancellation not confirmed");
  assert(
    f.trace.join(",") ===
      "payment.delete,GET exact,canonical,capability,boundary,DELETE exact",
    "unsafe order",
  );
  assert(f.outcomes[0] === "DELETE_CONFIRMED", "wrong outcome");
});

for (
  const change of [
    { id: "pay_other" },
    { customer: "cus_other" },
    { subscription: "sub_other" },
    { dueDate: "2026-10-15" },
    { value: 101 },
    { value: "100.001" },
    { status: "CONFIRMED" },
    { status: "RECEIVED" },
    { status: "REFUNDED" },
    { status: undefined },
  ]
) {
  Deno.test(`refuses provider change ${JSON.stringify(change)}`, async () => {
    const f = fixture();
    f.deps.get = async () => ({
      status: 200,
      body: { ...provider, ...change },
    });
    await processCancellation(operation, actor, f.deps);
    assert(
      !f.trace.includes("DELETE exact"),
      "deleted ineligible provider invoice",
    );
    assert(f.outcomes[0] === "REVIEW", "must require review");
  });
}

Deno.test("timeout after DELETE is UNKNOWN and retry is GET-only, never a second DELETE", async () => {
  const f = fixture();
  f.deps.remove = async () => {
    f.trace.push("DELETE exact");
    throw new Error("timeout");
  };
  assert(
    (await processCancellation(operation, actor, f.deps)).status === "UNKNOWN",
    "timeout hidden",
  );
  assert(
    (await processCancellation(operation, actor, f.deps)).status === "REVIEW",
    "live invoice not reconciled",
  );
  assert(
    f.trace.filter((x) => x === "DELETE exact").length === 1,
    "duplicated DELETE",
  );
  assert(
    f.trace.includes("payment.read"),
    "reconciliation did not use read capability",
  );
});

Deno.test("UNKNOWN can confirm matching deleted resource, but 404 alone proves nothing", async () => {
  const f = fixture();
  f.reconcile();
  f.deps.get = async () => ({ status: 404, body: {} });
  assert(
    (await processCancellation(operation, actor, f.deps)).status === "UNKNOWN",
    "404 presumed deletion",
  );
  f.deps.get = async () => ({
    status: 200,
    body: { ...provider, deleted: true },
  });
  assert(
    (await processCancellation(operation, actor, f.deps)).status ===
      "CONFIRMED",
    "exact GET not confirmed",
  );
  assert(!f.trace.includes("DELETE exact"), "reconciliation mutated provider");
});

Deno.test("claim, source and rotated integration fences prevent a provider mutation", async () => {
  for (const stage of ["claim", "begin", "capability", "identity"] as const) {
    const f = fixture();
    if (stage === "claim") f.deps.claim = async () => ({ ok: false });
    if (stage === "begin") f.deps.begin = async () => ({ ok: false });
    if (stage === "capability") {
      f.deps.revalidate = async () => {
        throw new Error("rotated");
      };
    }
    if (stage === "identity") f.deps.verifyCanonical = async () => false;
    await processCancellation(operation, actor, f.deps);
    assert(!f.trace.includes("DELETE exact"), `missed ${stage} fence`);
  }
});

Deno.test("malformed, empty or ambiguous successful DELETE response remains UNKNOWN", async () => {
  for (
    const body of [
      {},
      { deleted: true },
      { deleted: "true", id: "pay_exact" },
      { deleted: true, id: "pay_other" },
    ]
  ) {
    const f = fixture();
    f.deps.remove = async () => ({ status: 200, body });
    assert(
      (await processCancellation(operation, actor, f.deps)).status ===
        "UNKNOWN",
      "unproven delete accepted",
    );
  }
});

Deno.test("failed local completion never advertises a successful cancellation", async () => {
  const f = fixture();
  f.deps.finish = async () => {
    throw new Error("database unavailable");
  };
  const result = await processCancellation(operation, actor, f.deps);
  assert(result.ok === false && result.status === "UNKNOWN", "false success");
});

Deno.test("matching rejects wrong numeric types and unexpected subscription", () => {
  assert(
    !matchesInvoice(source, { ...provider, value: true }),
    "boolean money accepted",
  );
  assert(
    !matchesInvoice({ ...source, subscription_id: null }, provider),
    "subscription scope widened",
  );
});

Deno.test("deleted flag never overwrites received or confirmed financial evidence", async () => {
  for (const status of ["RECEIVED", "CONFIRMED", "REFUNDED"]) {
    const f = fixture();
    f.reconcile();
    f.deps.get = async () => ({
      status: 200,
      body: { ...provider, status, deleted: true },
    });
    assert(
      (await processCancellation(operation, actor, f.deps)).status === "REVIEW",
      "deleted paid invoice treated as canceled",
    );
    assert(!f.trace.includes("DELETE exact"), "paid invoice mutated");
  }
});
