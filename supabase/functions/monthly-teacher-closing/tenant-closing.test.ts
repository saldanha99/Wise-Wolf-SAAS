/// <reference lib="deno.ns" />

import {
  closingMonthBounds,
  normalizeClosingMonth,
  runTenantMonthlyTeacherClosing,
} from "./tenant-closing.ts";

function assertEquals(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

interface RecordedCall {
  table: string;
  operation?: string;
  filters?: Array<{ column: string; value: unknown }>;
  payload?: unknown;
  args?: Record<string, unknown>;
}

interface FakeQueryResult {
  data: unknown;
  error: null;
}

interface FakeBuilder extends PromiseLike<FakeQueryResult> {
  select: () => FakeBuilder;
  eq: (column: string, value: unknown) => FakeBuilder;
  gte: (column: string, value: unknown) => FakeBuilder;
  lte: (column: string, value: unknown) => FakeBuilder;
  limit: () => FakeBuilder;
  insert: (payload: unknown) => FakeBuilder;
  maybeSingle: () => Promise<FakeQueryResult>;
  single: () => Promise<FakeQueryResult>;
}

Deno.test("manual closing accepts only canonical year-month values", () => {
  assertEquals(normalizeClosingMonth("2026-08"), "2026-08", "valid month");
  for (const invalid of ["2026-8", "2026-13", "2026-08-01", 202608]) {
    let rejected = false;
    try {
      normalizeClosingMonth(invalid);
    } catch (error) {
      rejected = error instanceof Error && error.message === "invalid_month";
    }
    assertEquals(rejected, true, `${String(invalid)} must be rejected`);
  }
});

Deno.test("default and bounds are deterministic at year and leap boundaries", () => {
  assertEquals(
    normalizeClosingMonth(null, new Date("2026-01-15T10:00:00Z")),
    "2025-12",
    "January defaults to previous December",
  );
  assertEquals(
    closingMonthBounds("2024-02"),
    { start: "2024-02-01", end: "2024-02-29" },
    "leap February must include day 29",
  );
});

Deno.test("manual generation keeps queries and writes inside the authorized tenant", async () => {
  const calls: RecordedCall[] = [];
  const from = (table: string) => {
    const state: {
      operation: string;
      filters: Array<{ column: string; value: unknown }>;
      payload: unknown;
    } = {
      operation: "select",
      filters: [],
      payload: null,
    };
    let settled: FakeQueryResult | null = null;
    const finish = () => {
      if (settled) return settled;
      calls.push({
        table,
        operation: state.operation,
        filters: [...state.filters],
        payload: state.payload,
      });
      if (table === "profiles") {
        settled = {
          data: [
            { id: "teacher-a", tenant_id: "school-a" },
            { id: "teacher-b", tenant_id: "school-b" },
          ],
          error: null,
        };
      } else if (table === "v_payable_class_logs") {
        settled = {
          data: [{ id: "lesson-a", rate_efetivo: 9.5 }],
          error: null,
        };
      } else if (
        table === "teacher_closings" && state.operation === "insert"
      ) {
        settled = { data: { id: "closing-a" }, error: null };
      } else {
        settled = { data: null, error: null };
      }
      return settled;
    };
    const builder = {} as FakeBuilder;
    builder.select = () => builder;
    builder.eq = (column: string, value: unknown) => {
      state.filters.push({ column, value });
      return builder;
    };
    builder.gte = builder.eq;
    builder.lte = builder.eq;
    builder.limit = () => builder;
    builder.insert = (payload: unknown) => {
      state.operation = "insert";
      state.payload = payload;
      return builder;
    };
    builder.maybeSingle = () => Promise.resolve(finish());
    builder.single = () => Promise.resolve(finish());
    builder.then = (resolve, reject) =>
      Promise.resolve(finish()).then(resolve, reject);
    return builder;
  };
  const client = {
    from,
    rpc: (name: string, args: Record<string, unknown>) => {
      calls.push({ table: `rpc:${name}`, args });
      return Promise.resolve({ data: [], error: null });
    },
  };

  const result = await runTenantMonthlyTeacherClosing(
    client as unknown as Parameters<typeof runTenantMonthlyTeacherClosing>[0],
    "school-a",
    "2026-08",
  );

  assertEquals(result.created, 1, "the authorized teacher should be processed");
  assertEquals(
    calls.some((call) =>
      call.filters?.some((filter) =>
        filter.column === "teacher_id" && filter.value === "teacher-b"
      )
    ),
    false,
    "a leaked cross-tenant teacher row must not enter downstream queries",
  );
  assertEquals(
    calls.filter((call) =>
      ["profiles", "v_payable_class_logs", "teacher_closings"].includes(
        call.table,
      ) && call.operation !== "insert"
    ).every((call) =>
      call.filters?.some((filter) =>
        filter.column === "tenant_id" && filter.value === "school-a"
      ) === true
    ),
    true,
    "every tenant-bearing read must include the authorized tenant predicate",
  );
  assertEquals(
    (calls.find((call) =>
      call.table === "teacher_closings" && call.operation === "insert"
    )?.payload as Record<string, unknown> | undefined)?.tenant_id,
    "school-a",
    "the generated closing must persist the authorized tenant",
  );
});
