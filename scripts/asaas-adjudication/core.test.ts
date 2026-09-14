import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  adjudicate,
  amountCents,
  type Dependencies,
  type Integration,
  type Manifest,
  minimalPayment,
  parseManifest,
  type Row,
} from "./core.ts";
import { operatorSql } from "./run.ts";
const integration: Integration = {
  integrationId: "97000000-0000-4000-8000-000000000090",
  tenantId: "school-wise-wolf",
  version: 1,
  mode: "PLATFORM_MANAGED_ROOT",
  environment: "production",
  baseUrl: "https://provider.invalid/v3",
  apiKey: "MOCK_KEY",
};
function manifest(): Manifest {
  return {
    version: 1,
    tenant_id: "school-wise-wolf",
    batch_id: "97000000-0000-4000-8000-000000000099",
    operator: "synthetic-qa-operator",
    approval_ref: "a".repeat(64),
    cases: Array.from(
      { length: 7 },
      (_, i) => ({
        case_key: `C0${i + 1}`,
        disposition: i < 2
          ? "IMPORT_STUDENT"
          : i === 6
          ? "DUPLICATE_OF"
          : "IMPORT_UNASSIGNED",
        reason: "Synthetic isolated operator decision",
        expected_payment: {
          id: `pay_fixture${i}`,
          customer: `cus_fixture${i}`,
          value: i === 1 ? 1300 : 100,
          dueDate: "2026-09-01",
          paymentDate: "2026-09-01",
          creditDate: "2026-09-01",
        },
        ...(i < 2
          ? { student_id: `97000000-0000-4000-8000-00000000000${i + 1}` }
          : {}),
        ...(i === 1
          ? {
            prepayment: {
              mode: "MENSAL" as const,
              months: 6 as const,
              first_month: "2026-09-01",
            },
          }
          : {}),
        ...(i === 6
          ? {
            expected_canonical: {
              id: "pay_canonical",
              customer: "cus_fixture6",
              value: 100,
              subscription: "sub_fixture",
              dueDate: "2026-09-01",
              paymentDate: "2026-09-01",
              creditDate: null,
            },
          }
          : {}),
      }),
    ),
  };
}
function setup(plan = manifest()) {
  const gets: string[] = [];
  const applications: { proofs: Row[]; commit: boolean }[] = [];
  const map = new Map<string, Row>();
  for (const item of plan.cases) {
    map.set(String(item.expected_payment.id), {
      ...item.expected_payment,
      status: "RECEIVED",
      deleted: false,
      refundedValue: 0,
      creditCardToken: "DO_NOT_RETAIN",
      description: "PRIVATE_NAME_DO_NOT_RETAIN",
    });
    if (item.expected_canonical) {
      map.set(String(item.expected_canonical.id), {
        ...item.expected_canonical,
        status: "RECEIVED_IN_CASH",
      });
    }
  }
  const dependencies: Dependencies = {
    resolve: () => Promise.resolve({ ...integration }),
    get: (_integration, path) => {
      gets.push(path);
      return Promise.resolve(structuredClone(map.get(path.split("/").at(-1)!)));
    },
    apply: (_plan, proofs, _integration, commit) => {
      applications.push({ proofs, commit });
      return Promise.resolve({ ok: true, committed: commit });
    },
    now: () => new Date("2026-09-14T20:00:00Z"),
  };
  return { plan, gets, applications, dependencies, map };
}
Deno.test("operator defaults to dry-run and verifies every exact payment twice without provider writes", async () => {
  const state = setup();
  await adjudicate(state.plan, state.dependencies);
  assertEquals(state.gets.length, 16);
  assertEquals(state.applications.length, 1);
  assertEquals(state.applications[0].commit, false);
  assertEquals(
    state.gets.every((path) => /^\/payments\/pay_[A-Za-z0-9]+$/.test(path)),
    true,
  );
  assertEquals(
    JSON.stringify(state.applications).includes("DO_NOT_RETAIN"),
    false,
  );
});
Deno.test("explicit commit preserves one batch and all six months without fabricating director identity", async () => {
  const state = setup();
  await adjudicate(state.plan, state.dependencies, true);
  assertEquals(state.applications[0].commit, true);
  const sql = operatorSql(
    state.plan,
    state.applications[0].proofs,
    integration,
    true,
  );
  assertEquals(sql.includes("request.jwt.claims"), false);
  assertEquals(sql.includes("set role"), false);
  assertEquals(sql.includes("MOCK_KEY"), false);
  assertEquals(sql.includes("Synthetic isolated"), false);
  assertEquals(sql.endsWith("commit;\n"), true);
});
Deno.test("manifest rejects an extra case, customer conflict, external coverage mode and unknown fields", () => {
  const extra = manifest();
  extra.cases.push(extra.cases[0]);
  assertThrows(() => parseManifest(extra));
  const wrong = manifest();
  wrong.cases[6].expected_canonical!.customer = "cus_other";
  assertThrows(() => parseManifest(wrong));
  const mode = manifest();
  (mode.cases[1].prepayment as unknown as Row).mode = "LEGADO";
  assertThrows(() => parseManifest(mode));
  const secret = { ...manifest(), access_token: "NO" };
  assertThrows(() => parseManifest(secret));
});
Deno.test("exact cents reject exponential notation, fraction rounding and non-numeric amounts", () => {
  assertEquals(amountCents("1300.00"), 130000);
  assertEquals(amountCents("28.50"), 2850);
  for (const value of ["1e3", "10.001", "NaN", "12x", 0, -5, Infinity]) {
    assertThrows(() => amountCents(value));
  }
});
for (
  const change of [
    "id",
    "customer",
    "dueDate",
    "paymentDate",
    "creditDate",
    "value",
    "subscription",
    "externalReference",
    "status",
  ]
) {
  Deno.test(`provider ${change} divergence aborts whole batch before SQL`, async () => {
    const state = setup();
    state.map.get("pay_fixture0")![change] = change === "value"
      ? 101
      : "changed";
    await assertRejects(() => adjudicate(state.plan, state.dependencies));
    assertEquals(state.applications.length, 0);
  });
}
for (
  const reversal of [
    { refundedValue: 1 },
    { chargeback: { privateData: "SECRET" } },
    { deleted: true },
    { refunds: [{ status: "REQUESTED" }] },
  ]
) {
  Deno.test(`reversal proof ${Object.keys(reversal)[0]} cannot enter the ledger`, async () => {
    const state = setup();
    Object.assign(state.map.get("pay_fixture0")!, reversal);
    await assertRejects(() => adjudicate(state.plan, state.dependencies));
    assertEquals(state.applications.length, 0);
  });
}
Deno.test("canonical cash fact is mandatory; CONFIRMED duplicate target fails", async () => {
  const state = setup();
  state.map.get("pay_canonical")!.status = "CONFIRMED";
  await assertRejects(() => adjudicate(state.plan, state.dependencies));
  assertEquals(state.applications.length, 0);
});
Deno.test("key-only rotation aborts before database boundary", async () => {
  const state = setup();
  let count = 0;
  state.dependencies.resolve = () =>
    Promise.resolve({
      ...integration,
      apiKey: count++ ? "ROTATED" : "MOCK_KEY",
    });
  await assertRejects(
    () => adjudicate(state.plan, state.dependencies),
    Error,
    "integration_rotated",
  );
  assertEquals(state.applications.length, 0);
});
Deno.test("ambiguous DB response is not retried and never claims success", async () => {
  const state = setup();
  let calls = 0;
  state.dependencies.apply = () => {
    calls++;
    return Promise.resolve({ ok: "true", committed: true });
  };
  await assertRejects(() => adjudicate(state.plan, state.dependencies, true));
  assertEquals(calls, 1);
});
Deno.test("proof deadline aborts without writes", async () => {
  const state = setup();
  let ticks = 0;
  state.dependencies.now = () => new Date(1_790_000_000_000 + ticks++ * 4000);
  await assertRejects(
    () => adjudicate(state.plan, state.dependencies),
    Error,
    "provider_proof_deadline_exceeded",
  );
  assertEquals(state.applications.length, 0);
});
Deno.test("minimization keeps only dispute presence rather than personal details", () => {
  const minimal = minimalPayment({
    id: "pay_fixture",
    customer: "cus_fixture",
    chargeback: { holderName: "PRIVATE" },
    creditCardToken: "SECRET",
  });
  assertEquals(minimal, {
    id: "pay_fixture",
    customer: "cus_fixture",
    chargeback: { present: true },
  });
});
