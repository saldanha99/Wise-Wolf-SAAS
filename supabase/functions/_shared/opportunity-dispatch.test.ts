/// <reference lib="deno.ns" />
import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  evaluateOpportunityReuseCandidate,
  parseOpportunityDispatchGuard,
} from "./opportunity-dispatch.ts";

Deno.test("dispatch guard fails closed on malformed data", () => {
  assertEquals(parseOpportunityDispatchGuard(null).dispatchMode, "NONE");
  assertEquals(
    parseOpportunityDispatchGuard({ ok: true, dispatchMode: "TARGETED" })
      .dispatchMode,
    "NONE",
  );
  assertEquals(
    parseOpportunityDispatchGuard({ ok: true, dispatchMode: "UNKNOWN" })
      .dispatchMode,
    "NONE",
  );
});

Deno.test("dispatch guard preserves reviewed generic and targeted modes", () => {
  assertEquals(
    parseOpportunityDispatchGuard({
      ok: true,
      dispatchMode: "GENERIC",
      state: "GENERIC",
    }),
    {
      ok: true,
      dispatchMode: "GENERIC",
      state: "GENERIC",
      targetTeacherId: null,
    },
  );
  assertEquals(
    parseOpportunityDispatchGuard({
      ok: true,
      dispatchMode: "TARGETED",
      state: "AWAITING_TEACHER",
      targetTeacherId: "00000000-0000-4000-8000-000000000001",
    }).dispatchMode,
    "TARGETED",
  );
});

Deno.test("directed request blocks a second auction even for another slot", () => {
  assertEquals(
    evaluateOpportunityReuseCandidate(
      [{ date: "2026-08-26", time: "14:00" }],
      {
        ok: true,
        dispatchMode: "TARGETED",
        state: "AWAITING_TEACHER",
        targetTeacherId: "00000000-0000-4000-8000-000000000001",
      },
      "2026-08-27",
      "15:00",
    ),
    "BLOCK_DIRECTED",
  );
  assertEquals(
    evaluateOpportunityReuseCandidate(
      [{ date: "2026-08-26", time: "14:00" }],
      {
        ok: true,
        dispatchMode: "GENERIC",
        state: "GENERIC",
        targetTeacherId: null,
      },
      "2026-08-27",
      "15:00",
    ),
    "SKIP_GENERIC",
  );
});

Deno.test("a stale recipient list cannot authorize a suspended teacher or an unavailable eligibility read", async () => {
  const { teacherMayReceiveOpportunity } = await import(
    "./opportunity-dispatch.ts"
  );
  const id = "00000000-0000-4000-8000-000000000011";
  for (
    const result of [{ data: false, error: null }, {
      data: true,
      error: { code: "503" },
    }, { data: null, error: null }]
  ) {
    if (
      await teacherMayReceiveOpportunity(
        { rpc: () => Promise.resolve(result) },
        "fixture",
        id,
      )
    ) throw new Error("ineligible teacher admitted");
  }
  if (
    !await teacherMayReceiveOpportunity(
      { rpc: () => Promise.resolve({ data: true, error: null }) },
      "fixture",
      id,
    )
  ) throw new Error("active teacher blocked");
});
