import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { recordEmailEngagement } from "./engagement.ts";

type Call = { table: string; op: string; args: unknown[] };

function fakeAdmin(attemptTable: string | null, calls: Call[]) {
  return {
    from: (table: string) => {
      let op = "select";
      const chain: Record<string, (...args: unknown[]) => unknown> = {};
      for (const method of ["select", "update", "eq", "is", "or", "limit"]) {
        chain[method] = (...args: unknown[]) => {
          if (method === "update") op = "update";
          calls.push({ table, op: method, args });
          return chain;
        };
      }
      chain.maybeSingle = () =>
        Promise.resolve({
          data: table === attemptTable
            ? { id: "attempt-1", payment_id: "payment-1" }
            : null,
          error: null,
        });
      chain.then = (resolve: unknown) =>
        (resolve as (v: unknown) => unknown)({ data: null, error: null, op });
      return chain;
    },
  };
}

Deno.test("email.opened is recorded on the attempt row and summarized on the invoice", async () => {
  const calls: Call[] = [];
  const outcome = await recordEmailEngagement(
    fakeAdmin("daily_payment_email_attempts", calls),
    {
      type: "email.opened",
      created_at: "2026-11-21T12:00:00.000Z",
      data: { email_id: "mail_1" },
    },
  );
  assertEquals(outcome, "RECORDED");
  const updates = calls.filter((c) => c.op === "update");
  assertEquals(updates.map((c) => c.table), [
    "daily_payment_email_attempts",
    "student_payments",
  ]);
  assertEquals(updates[0].args[0], { opened_at: "2026-11-21T12:00:00.000Z" });
  assertEquals(updates[1].args[0], {
    email_opened_at: "2026-11-21T12:00:00.000Z",
  });
  // Primeira abertura não é sobrescrita.
  assertEquals(
    calls.some((c) =>
      c.table === "daily_payment_email_attempts" && c.op === "is" &&
      c.args[0] === "opened_at" && c.args[1] === null
    ),
    true,
  );
});

Deno.test("email.clicked uses the click columns", async () => {
  const calls: Call[] = [];
  await recordEmailEngagement(
    fakeAdmin("payment_notification_email_attempts", calls),
    { type: "email.clicked", data: { email_id: "mail_2" } },
    new Date("2026-11-21T13:00:00.000Z"),
  );
  const updates = calls.filter((c) => c.op === "update");
  assertEquals(updates[0].args[0], { clicked_at: "2026-11-21T13:00:00.000Z" });
  assertEquals(updates[1].args[0], {
    email_clicked_at: "2026-11-21T13:00:00.000Z",
  });
});

Deno.test("other events and unknown e-mails never write", async () => {
  const calls: Call[] = [];
  assertEquals(
    await recordEmailEngagement(fakeAdmin(null, calls), {
      type: "email.delivered",
      data: { email_id: "mail_3" },
    }),
    "IGNORED",
  );
  assertEquals(
    await recordEmailEngagement(fakeAdmin(null, calls), {
      type: "email.opened",
      data: {},
    }),
    "IGNORED",
  );
  assertEquals(
    await recordEmailEngagement(fakeAdmin(null, calls), {
      type: "email.opened",
      data: { email_id: "mail_not_billing" },
    }),
    "UNKNOWN_EMAIL",
  );
  assertEquals(calls.filter((c) => c.op === "update"), []);
});
