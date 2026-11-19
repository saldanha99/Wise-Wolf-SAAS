import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  deliverPaymentNoticeEmail,
  paymentEmailIdempotencyKey,
  resolveVerifiedPaymentEmail,
} from "./payment-email.ts";

function emailClient(
  events: string[],
  insertError: { code: string } | null = null,
) {
  return {
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => {
        events.push(`claim:${table}:${row.kind}:${row.ref_date}`);
        return {
          select: () => ({
            single: () =>
              Promise.resolve(
                insertError
                  ? { data: null, error: insertError }
                  : { data: { id: "intent" }, error: null },
              ),
          }),
        };
      },
      update: (value: { status: string }) => {
        events.push(`finish:${value.status}`);
        return { eq: () => ({ eq: () => Promise.resolve({ error: null }) }) };
      },
    }),
  };
}
const env = (key: string) =>
  key === "RESEND_API_KEY" ? "fixture-key" : "fixture@example.invalid";
const notice = {
  kind: "PAYMENT_DUE_REMINDER_D0_EMAIL" as const,
  tenantId: "fixture",
  paymentId: "local-1",
  studentId: "student-1",
  refDate: "2026-12-10",
  email: "payer@example.invalid",
  subject: "Sua mensalidade vence hoje - Escola\n",
  text: "body",
};

Deno.test("payment notice e-mail persists its intent before POST with a stable idempotency key", async () => {
  const events: string[] = [];
  const transport: typeof fetch = (_url, init) => {
    events.push("post");
    const headers = init?.headers as Record<string, string>;
    assertEquals(
      headers["Idempotency-Key"],
      paymentEmailIdempotencyKey(notice),
    );
    const body = JSON.parse(String(init?.body));
    assert(!String(body.subject).includes("\n"));
    return Promise.resolve(Response.json({ id: "mail_fixture" }));
  };
  assertEquals(
    await deliverPaymentNoticeEmail(
      emailClient(events),
      notice,
      transport,
      env,
    ),
    "SENT",
  );
  assertEquals(events, [
    "claim:payment_notification_email_attempts:PAYMENT_DUE_REMINDER_D0_EMAIL:2026-12-10",
    "post",
    "finish:SENT",
  ]);
  assertEquals(
    paymentEmailIdempotencyKey(notice),
    "payment-notice-payment_due_reminder_d0_email-fixture-local-1-2026-12-10",
  );
});

Deno.test("a duplicate intent (same invoice, kind and date) never reaches the provider", async () => {
  const events: string[] = [];
  const transport: typeof fetch = () => {
    events.push("post");
    return Promise.resolve(Response.json({ id: "x" }));
  };
  assertEquals(
    await deliverPaymentNoticeEmail(
      emailClient(events, { code: "23505" }),
      notice,
      transport,
      env,
    ),
    "ALREADY_ATTEMPTED",
  );
  // Cerca do banco recusou (destinatário/estado): sem POST.
  assertEquals(
    await deliverPaymentNoticeEmail(
      emailClient(events, { code: "P0001" }),
      notice,
      transport,
      env,
    ),
    "CLAIM_FAILED",
  );
  assert(!events.includes("post"));
});

Deno.test("ambiguous network result is terminal UNKNOWN and 4xx is REJECTED", async () => {
  const events: string[] = [];
  const timeout: typeof fetch = () => {
    events.push("post");
    throw new Error("network timeout");
  };
  assertEquals(
    await deliverPaymentNoticeEmail(emailClient(events), notice, timeout, env),
    "UNKNOWN",
  );
  assertEquals(events.slice(-2), ["post", "finish:UNKNOWN"]);
  const rejected: typeof fetch = () =>
    Promise.resolve(Response.json({ message: "bad" }, { status: 422 }));
  assertEquals(
    await deliverPaymentNoticeEmail(emailClient([]), notice, rejected, env),
    "REJECTED",
  );
  const noEnv = () => undefined;
  assertEquals(
    await deliverPaymentNoticeEmail(emailClient([]), notice, timeout, noEnv),
    "PROVIDER_UNAVAILABLE",
  );
  assertEquals(
    await deliverPaymentNoticeEmail(
      emailClient([]),
      // deno-lint-ignore no-explicit-any
      { ...notice, kind: "PAYMENT_OVERDUE_EMAIL" as any },
      timeout,
      env,
    ),
    "CLAIM_FAILED",
  );
});

function profileClient(rows: Record<string, Record<string, unknown>>, auth: {
  email: string;
  email_confirmed_at: string | null;
}) {
  return {
    from: () => ({
      select: () => {
        let id = "";
        const chain = {
          eq: (column: string, value: string) => {
            if (column === "id") id = value;
            return chain;
          },
          maybeSingle: () =>
            Promise.resolve({ data: rows[id] ?? null, error: null }),
        };
        return chain;
      },
    }),
    auth: {
      admin: {
        getUserById: () =>
          Promise.resolve({ data: { user: auth }, error: null }),
      },
    },
  };
}

Deno.test("e-mail recipient is the verified holder or the linked guardian with matching address", async () => {
  const holder = {
    id: "s1",
    role: "STUDENT",
    email: "Aluno@Example.invalid",
    is_test_account: false,
  };
  assertEquals(
    await resolveVerifiedPaymentEmail(
      profileClient({ s1: holder }, {
        email: "aluno@example.invalid",
        email_confirmed_at: "2026-01-01",
      }),
      "s1",
      "t",
    ),
    { email: "aluno@example.invalid", guardian: false },
  );
  assertEquals(
    await resolveVerifiedPaymentEmail(
      profileClient({ s1: holder }, {
        email: "aluno@example.invalid",
        email_confirmed_at: null,
      }),
      "s1",
      "t",
    ),
    null,
  );
  assertEquals(
    await resolveVerifiedPaymentEmail(
      profileClient({ s1: { ...holder, is_test_account: true } }, {
        email: "aluno@example.invalid",
        email_confirmed_at: "2026-01-01",
      }),
      "s1",
      "t",
    ),
    null,
  );
  const dependent = {
    ...holder,
    email: "kid@example.invalid",
    guardian_id: "g1",
    guardian_email: "mae@example.invalid",
  };
  const guardian = { id: "g1", email: "mae@example.invalid" };
  assertEquals(
    await resolveVerifiedPaymentEmail(
      profileClient({ s1: dependent, g1: guardian }, {
        email: "mae@example.invalid",
        email_confirmed_at: "2026-01-01",
      }),
      "s1",
      "t",
    ),
    { email: "mae@example.invalid", guardian: true },
  );
  // Endereço do responsável diferente do contato financeiro: nada sai.
  assertEquals(
    await resolveVerifiedPaymentEmail(
      profileClient({
        s1: { ...dependent, guardian_email: "outro@example.invalid" },
        g1: guardian,
      }, { email: "mae@example.invalid", email_confirmed_at: "2026-01-01" }),
      "s1",
      "t",
    ),
    null,
  );
  // Dependente sem responsável vinculado nunca cai no e-mail do filho.
  assertEquals(
    await resolveVerifiedPaymentEmail(
      profileClient({
        s1: { ...holder, guardian_id: null, guardian_cpf: "123" },
      }, { email: "aluno@example.invalid", email_confirmed_at: "2026-01-01" }),
      "s1",
      "t",
    ),
    null,
  );
});
