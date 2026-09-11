/// <reference lib="deno.ns" />
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  claimTrialTimeoutNotice,
  loadExpiredRescheduleContext,
  readAllTimeoutRows,
  rescheduleTimeoutMessage,
} from "./trial-timeout.ts";

Deno.test("execuções concorrentes e no dia seguinte compartilham uma única reserva", async () => {
  const keys = new Set<string>();
  const sb = {
    from: () => ({
      insert: (key: unknown) => {
        const id = JSON.stringify(key);
        if (keys.has(id)) return Promise.resolve({ error: { code: "23505" } });
        keys.add(id);
        return Promise.resolve({ error: null });
      },
      delete: () => ({
        match: (key: unknown) => {
          keys.delete(JSON.stringify(key));
          return Promise.resolve({ error: null });
        },
      }),
    }),
  };
  const claims = await Promise.all([
    claimTrialTimeoutNotice(sb, "t", "r"),
    claimTrialTimeoutNotice(sb, "t", "r"),
  ]);
  assertEquals(claims.filter((c) => c.ok).length, 1);
  assertEquals((await claimTrialTimeoutNotice(sb, "t", "r")).ok, false);
  await claims.find((c) => c.ok)!.undo();
  assertEquals((await claimTrialTimeoutNotice(sb, "t", "r")).ok, true);
  assertEquals((await claimTrialTimeoutNotice(sb, "other", "r")).ok, true);
});

Deno.test("aceite vencedor impede aviso de falta de professor", async () => {
  const sb = {
    rpc: () => Promise.resolve({ data: { ok: true, expired: false } }),
    from: () => {
      throw new Error("must not query");
    },
  };
  assertEquals(
    await loadExpiredRescheduleContext(sb, { id: "r", tenant_id: "t" }),
    null,
  );
});

Deno.test("falha de banco não é interpretada como falta de aceite", async () => {
  await assertRejects(() =>
    loadExpiredRescheduleContext(
      { rpc: () => Promise.resolve({ error: {} }) },
      {},
    )
  );
  await assertRejects(() =>
    claimTrialTimeoutNotice(
      {
        from: () => ({
          insert: () => Promise.resolve({ error: { code: "08000" } }),
        }),
      },
      "t",
      "r",
    )
  );
});

Deno.test("retorno oferece negociação e nunca afirma alteração da agenda", () => {
  const message = rescheduleTimeoutMessage("2026-09-04T21:30:00Z");
  assertStringIncludes(message, "04/09/2026 às 18:30");
  assertStringIncludes(message, "A alteração não foi confirmada");
  assertStringIncludes(message, "outro dia e horário");
});

Deno.test("timeout scan reaches later pages instead of rereading the first hundred forever", async () => {
  const source = Array.from({ length: 203 }, (_, id) => ({ id }));
  const rows = await readAllTimeoutRows(() => ({
    range: (start: number, end: number) =>
      Promise.resolve({ data: source.slice(start, end + 1), error: null }),
  }));
  assertEquals(rows.length, 203);
  assertEquals(rows[202].id, 202);
});
Deno.test("timeout scan fails closed on an incomplete page", async () => {
  await assertRejects(() =>
    readAllTimeoutRows(() => ({ range: () => Promise.resolve({ error: {} }) }))
  );
});
