/// <reference lib="deno.ns" />

import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  BRIEFING_NO_TEACHER_PHONE,
  BRIEFING_NOT_QUEUED,
  type BriefingRpc,
  enqueueForcedCoverageBriefing,
} from "./briefing.ts";

const COVERAGE = "00000000-0000-4000-8000-00000000c0de";

function fakeRpc(
  response: { data: unknown; error: { code?: string } | null } | Error,
  calls: unknown[][] = [],
): BriefingRpc {
  return (fn, args) => {
    calls.push([fn, args]);
    if (response instanceof Error) return Promise.reject(response);
    return Promise.resolve(response);
  };
}

Deno.test("cobertura forçada pede o pacote do aceite, sem avisar o grupo", async () => {
  const calls: unknown[][] = [];
  const warning = await enqueueForcedCoverageBriefing(
    fakeRpc({
      data: {
        ok: true,
        queued: ["briefing", "family"],
        cover_phone_known: true,
      },
      error: null,
    }, calls),
    COVERAGE,
  );
  assertEquals(warning, null);
  assertEquals(calls, [[
    "coverage_briefing_enqueue",
    { p_coverage_id: COVERAGE, p_notify_group: false },
  ]]);
});

Deno.test("pacote já enfileirado antes (repetição) não vira aviso", async () => {
  const warning = await enqueueForcedCoverageBriefing(
    fakeRpc({
      data: { ok: true, queued: [], cover_phone_known: true },
      error: null,
    }),
    COVERAGE,
  );
  assertEquals(warning, null);
});

Deno.test("substituto sem WhatsApp: a tela é avisada de que o pacote não saiu", async () => {
  const warning = await enqueueForcedCoverageBriefing(
    fakeRpc({
      data: { ok: true, queued: ["family"], cover_phone_known: false },
      error: null,
    }),
    COVERAGE,
  );
  assertEquals(warning, BRIEFING_NO_TEACHER_PHONE);
});

Deno.test("recusa do banco, erro do PostgREST ou exceção viram aviso, nunca falha", async () => {
  assertEquals(
    await enqueueForcedCoverageBriefing(
      fakeRpc({ data: { ok: false, error: "sem_diretor_ativo" }, error: null }),
      COVERAGE,
    ),
    BRIEFING_NOT_QUEUED,
  );
  assertEquals(
    await enqueueForcedCoverageBriefing(
      fakeRpc({ data: null, error: { code: "42501" } }),
      COVERAGE,
    ),
    BRIEFING_NOT_QUEUED,
  );
  assertEquals(
    await enqueueForcedCoverageBriefing(
      fakeRpc(new Error("rede")),
      COVERAGE,
    ),
    BRIEFING_NOT_QUEUED,
  );
});
