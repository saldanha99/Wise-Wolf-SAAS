import {
  BoundPaymentObservationError,
  observeBoundPayment,
  validateBoundPaymentEvidence,
} from "./bound-payment-observation.ts";
import type { ResolvedAsaasIntegration } from "../_shared/tenant-integration-broker.ts";

type Row = Record<string, unknown>;
const local: Row = {
  id: "96000000-0000-4000-8000-000000000001",
  tenant_id: "bound-observation-school",
  student_id: "96000000-0000-4000-8000-000000000002",
  asaas_payment_id: "pay_boundfixture",
  asaas_id: null,
  provider_customer_id: "cus_boundfixture",
  value: 300,
  status: "PENDING",
  provider_status: "PENDING",
  refunded_amount: 0,
  due_date: "2026-08-01",
  raw_payload: {},
  authoritative_subscription_id: null,
  last_authoritative_observed_at: null,
  updated_at: "2026-08-01T12:00:00+00:00",
};
const payment: Row = {
  id: "pay_boundfixture",
  customer: "cus_boundfixture",
  value: 300,
  subscription: "sub_boundfixture",
  externalReference: null,
  status: "RECEIVED",
  dueDate: "2026-09-01",
  paymentDate: "2026-09-01",
  creditDate: "2026-09-02",
  refundedValue: 0,
  deleted: false,
};
const parent: Row = {
  id: "sub_boundfixture",
  customer: "cus_boundfixture",
  status: "ACTIVE",
  externalReference: null,
  deleted: false,
};
const integration: ResolvedAsaasIntegration = {
  integrationId: "96000000-0000-4000-8000-000000000003",
  tenantId: "bound-observation-school",
  provider: "asaas",
  version: 1,
  mode: "TENANT_BYOK",
  environment: "sandbox",
  baseUrl: "https://fixture.invalid/v3",
  apiKey: "synthetic-never-sent-credential",
};
function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
async function rejects(
  action: () => unknown | Promise<unknown>,
  code: string,
  retryable = false,
) {
  try {
    await action();
  } catch (error) {
    assert(
      error instanceof BoundPaymentObservationError,
      "unexpected error class",
    );
    assert(error.code === code, `expected ${code}, got ${error.code}`);
    assert(error.retryable === retryable, "unexpected retry disposition");
    return;
  }
  throw new Error(`expected ${code}`);
}
function harness(options: {
  local?: Row | null;
  get?: (path: string, attempt: number) => Row | Promise<Row>;
  resolve?: (attempt: number, purpose: string) => ResolvedAsaasIntegration;
  apply?: Row;
  applyError?: boolean;
  recomputeError?: boolean;
} = {}) {
  const calls: { name: string; args: Row }[] = [];
  const reads: string[] = [];
  const filters: [string, unknown][] = [];
  let resolutions = 0;
  const query = {
    select: () => query,
    eq: (column: string, value: unknown) => {
      filters.push([column, value]);
      return query;
    },
    maybeSingle: () =>
      Promise.resolve({
        data: options.local === undefined ? { ...local } : options.local,
        error: null,
      }),
  };
  const client = {
    from: (table: string) => {
      assert(table === "student_payments");
      return query;
    },
    rpc: (name: string, args: Row) => {
      calls.push({ name, args });
      assert(
        [
          "apply_authoritative_bound_student_payment",
          "recompute_student_financial_status",
        ].includes(name),
        "unexpected mutation RPC",
      );
      return Promise.resolve(
        name === "apply_authoritative_bound_student_payment"
          ? {
            data: options.apply ??
              { ok: true, action: "UPDATED", id: local.id },
            error: options.applyError ? { code: "40001" } : null,
          }
          : { data: { ok: !options.recomputeError }, error: null },
      );
    },
  };
  const dependencies = {
    resolve: (
      _client: unknown,
      tenant: string,
      purpose: "payment.read" | "subscription.read",
    ) => {
      assert(tenant === local.tenant_id);
      return Promise.resolve(
        options.resolve ? options.resolve(++resolutions, purpose) : integration,
      );
    },
    get: (_integration: ResolvedAsaasIntegration, path: string) => {
      reads.push(path);
      return Promise.resolve(
        options.get
          ? options.get(path, reads.length)
          : path.startsWith("/payments/")
          ? { ...payment }
          : { ...parent },
      );
    },
  };
  return {
    calls,
    reads,
    filters,
    run: (event?: Row) =>
      observeBoundPayment(
        client,
        local.id as string,
        local.tenant_id as string,
        event,
        dependencies,
      ),
  };
}

Deno.test("bound invoice: known customer and missing profile subscription do not cause rediscovery; due date comes from GET", async () => {
  const h = harness();
  const result = await h.run();
  assert(result.action === "UPDATED");
  assert(
    h.filters.some(([key, val]) =>
      key === "tenant_id" && val === local.tenant_id
    ),
  );
  assert(
    h.reads.join() ===
      "/payments/pay_boundfixture,/subscriptions/sub_boundfixture,/payments/pay_boundfixture,/subscriptions/sub_boundfixture",
  );
  assert(h.calls.length === 2);
  assert(
    (h.calls[0].args.p_authoritative_payment as Row).dueDate === "2026-09-01",
  );
  assert(
    (h.calls[0].args.p_expected_local_snapshot as Row).due_date ===
      "2026-08-01",
  );
  assert(
    h.calls[0].args.p_source_event_id === null,
    "explicit GET fabricated a provider event",
  );
  assert(h.calls[1].args.p_student_id === local.student_id);
});

Deno.test("CONFIRMED is submitted as CONFIRMED, not RECEIVED or a cash date", async () => {
  const h = harness({
    get: (path) =>
      path.startsWith("/payments/")
        ? {
          ...payment,
          status: "CONFIRMED",
          paymentDate: null,
          creditDate: null,
        }
        : parent,
  });
  await h.run({
    id: "evt_boundconfirmed",
    payment: { ...payment, status: "CONFIRMED" },
  });
  const proof = h.calls[0].args.p_authoritative_payment as Row;
  assert(
    proof.status === "CONFIRMED" && proof.creditDate === null &&
      proof.paymentDate === null,
  );
  assert(h.calls[0].args.p_source_event_id === "evt_boundconfirmed");
});

Deno.test("provider financial proof is minimized before RPC and never copies card tokens or holder details", async () => {
  const h = harness({
    get: (path) =>
      path.startsWith("/payments/")
        ? {
          ...payment,
          creditCardToken: "PRIVATE_MARKER_NEVER_COPY",
          creditCard: { holderName: "PRIVATE_MARKER_NEVER_COPY" },
          refunds: [{
            id: "ref_fixture",
            status: "CANCELLED",
            value: 1,
            description: "PRIVATE_MARKER_NEVER_COPY",
          }],
        }
        : {
          ...parent,
          creditCardToken: "PRIVATE_MARKER_NEVER_COPY",
          customerName: "PRIVATE_MARKER_NEVER_COPY",
        },
  });
  await h.run();
  const persisted = JSON.stringify([
    h.calls[0].args.p_authoritative_payment,
    h.calls[0].args.p_authoritative_subscription,
  ]);
  assert(!persisted.includes("PRIVATE_MARKER"));
  assert(persisted.includes("ref_fixture"), "safe refund evidence was dropped");
});

Deno.test("bound proof rejects wrong invoice, customer, amount, refund, subscription and parent before any write", async () => {
  const cases: [Row, Row, Row | null, string][] = [
    [
      local,
      { ...payment, id: "pay_other" },
      parent,
      "bound_payment_identity_mismatch",
    ],
    [
      local,
      { ...payment, customer: "cus_other" },
      parent,
      "bound_customer_mismatch",
    ],
    [local, { ...payment, value: 301 }, parent, "bound_amount_mismatch"],
    [
      local,
      { ...payment, refundedValue: 1 },
      parent,
      "bound_payment_reversal_present",
    ],
    [
      local,
      { ...payment, refunds: [{ status: "REQUESTED" }] },
      parent,
      "bound_payment_reversal_present",
    ],
    [
      local,
      { ...payment, deleted: true },
      parent,
      "bound_payment_reversal_present",
    ],
    [
      local,
      {
        ...payment,
        chargeback: { status: "REQUESTED", reason: "PROCESS_ERROR" },
      },
      parent,
      "bound_payment_reversal_present",
    ],
    [
      local,
      { ...payment, status: "OVERDUE" },
      parent,
      "bound_payment_not_positive_proof",
    ],
    [
      local,
      { ...payment, creditDate: null },
      parent,
      "bound_payment_dates_unproven",
    ],
    [
      { ...local, authoritative_subscription_id: "sub_original" },
      payment,
      parent,
      "bound_subscription_changed",
    ],
    [
      { ...local, raw_payload: { payment: { subscription: "sub_original" } } },
      payment,
      parent,
      "bound_subscription_changed",
    ],
    [
      local,
      payment,
      { ...parent, customer: "cus_other" },
      "bound_parent_identity_mismatch",
    ],
    [local, payment, null, "bound_parent_identity_mismatch"],
  ];
  for (const [l, p, s, code] of cases) {
    await rejects(() => validateBoundPaymentEvidence(l, p, s), code);
  }
  const h = harness({
    get: (path) =>
      path.startsWith("/payments/") ? { ...payment, value: 301 } : parent,
  });
  await rejects(() => h.run(), "bound_amount_mismatch");
  assert(h.calls.length === 0);
});

Deno.test("bound lookup never creates or claims an unbound/cross-tenant or ambiguously aliased invoice", async () => {
  for (
    const l of [null, { ...local, tenant_id: "other-school" }, {
      ...local,
      student_id: null,
    }]
  ) {
    const h = harness({ local: l });
    await rejects(() => h.run(), "bound_local_payment_missing");
    assert(h.calls.length === 0 && h.reads.length === 0);
  }
  const h = harness({ local: { ...local, asaas_id: "pay_other" } });
  await rejects(() => h.run(), "bound_provider_alias_ambiguous");
  assert(h.reads.length === 0);
});

Deno.test("RECEIVED with a local dispute/refund warning cannot be cleared by a positive GET", async () => {
  for (
    const status of [
      "REFUND_IN_PROGRESS",
      "CHARGEBACK_REQUESTED",
      "CHARGEBACK_DISPUTE",
      "AWAITING_CHARGEBACK_REVERSAL",
      "DELETED",
      "CANCELLED",
    ]
  ) {
    const h = harness({
      local: {
        ...local,
        status: "RECEIVED",
        provider_status: status,
        refunded_amount: 0,
      },
    });
    await rejects(() => h.run(), "bound_local_financial_review_required");
    assert(!h.calls.length, "positive GET erased a financial review signal");
  }
  const provider = harness({
    get: (path) =>
      path.startsWith("/payments/")
        ? { ...payment, chargeback: { status: "DISPUTE" } }
        : parent,
  });
  await rejects(() => provider.run(), "bound_payment_reversal_present");
  assert(!provider.calls.length);
});

Deno.test("key-only rotation during parent or final resolution fences the observation without exposing credentials", async () => {
  for (const changeAt of [2, 3]) {
    const h = harness({
      resolve: (n) =>
        n === changeAt
          ? { ...integration, apiKey: "different-synthetic-credential" }
          : integration,
    });
    await rejects(() => h.run(), "bound_integration_changed");
    assert(h.calls.length === 0);
  }
});

Deno.test("payment or parent changing between GETs never produces a mixed write", async () => {
  const paymentRace = harness({
    get: (path, n) =>
      path.startsWith("/payments/")
        ? { ...payment, value: n === 3 ? 299 : 300 }
        : parent,
  });
  await rejects(
    () => paymentRace.run(),
    "bound_provider_snapshot_changed",
    true,
  );
  const parentRace = harness({
    get: (path, n) =>
      path.startsWith("/payments/")
        ? payment
        : { ...parent, customer: n === 4 ? "cus_other" : parent.customer },
  });
  await rejects(() => parentRace.run(), "bound_parent_snapshot_changed", true);
  assert(!paymentRace.calls.length && !parentRace.calls.length);
});

Deno.test("provider failure and SQL concurrency rejection cannot report success", async () => {
  const h = harness({
    get: () => {
      throw new BoundPaymentObservationError(
        "bound_provider_unavailable",
        true,
      );
    },
  });
  await rejects(() => h.run(), "bound_provider_unavailable", true);
  assert(!h.calls.length);
  const db = harness({
    apply: { ok: false, reason: "bound_local_snapshot_changed_or_ambiguous" },
  });
  await rejects(() => db.run(), "bound_local_snapshot_changed_or_ambiguous");
  assert(db.calls.length === 1);
  const unavailable = harness({ applyError: true });
  await rejects(() => unavailable.run(), "bound_database_unavailable", true);
});

Deno.test("older CONFIRMED event corroborated as already RECEIVED is ignored without cash regression", async () => {
  const h = harness();
  const result = await h.run({
    id: "evt_oldconfirmed",
    payment: { ...payment, status: "CONFIRMED" },
  });
  assert(result.action === "IGNORED" && !h.calls.length);
  const conflict = harness();
  await rejects(
    () =>
      conflict.run({
        id: "evt_wrongidentity",
        payment: { ...payment, customer: "cus_other" },
      }),
    "bound_event_identity_mismatch",
  );
});

Deno.test("repeated proof rechecks financial state; failed recompute is retryable after idempotent persistence", async () => {
  const h = harness({ apply: { ok: true, action: "ALREADY_APPLIED" } });
  await h.run();
  assert(h.calls.length === 2);
  const failure = harness({ recomputeError: true });
  await rejects(
    () => failure.run(),
    "bound_financial_recompute_unavailable",
    true,
  );
  assert(
    failure.calls.length === 2,
    "must not call provider write or duplicate apply",
  );
});
