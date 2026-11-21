import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DEFAULT_PAYMENT_EMAIL_LOGO_URL,
  deliverPaymentNoticeEmail,
  escapeHtml,
  paymentEmailIdempotencyKey,
  paymentEmailLogoUrl,
  renderPaymentEmailHtml,
  resolveVerifiedPaymentEmail,
  WISE_WOLF_TENANT_ID,
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
  brandName: "Escola",
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

Deno.test("payment e-mail HTML escapes every student/guardian value and keeps the wording", () => {
  const text =
    `Oi <script>alert(1)</script> & "Ana" 'B'! Aqui é a Escola.\n\n` +
    `Pague pelo link: https://www.asaas.com/i/abc?x=1&y=2\n\n` +
    `Linha digitável do boleto:\n0019 3373 <b>`;
  const html = renderPaymentEmailHtml({
    text,
    brandName: 'Escola "<img src=x>"',
    logoUrl: null,
  });
  assert(!html.includes("<script>"));
  assert(!html.includes("<b>"));
  assert(!html.includes("<img src=x>"));
  assert(
    html.includes(
      "&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;Ana&quot; &#39;B&#39;",
    ),
  );
  assert(html.includes("Escola &quot;&lt;img src=x&gt;&quot;"));
  assert(
    html.includes(
      '<a href="https://www.asaas.com/i/abc?x=1&amp;y=2" style="color:#0F766E">',
    ),
  );
  assert(html.includes("Linha digitável do boleto:<br>0019 3373 &lt;b&gt;"));
  assert(!html.includes("<img"));
  assertEquals(escapeHtml(`<&>"'`), "&lt;&amp;&gt;&quot;&#39;");
});

Deno.test("payment e-mail HTML links only Asaas URLs", () => {
  const html = renderPaymentEmailHtml({
    text: "Ana https://evil.invalid/x https://asaas.com.evil.invalid/y",
    brandName: "Escola",
    logoUrl: null,
  });
  assert(!html.includes("<a "));
});

Deno.test("payment e-mail logo is the public Wise Wolf URL only for the Wise Wolf tenant", () => {
  const none = () => undefined;
  assertEquals(
    paymentEmailLogoUrl(WISE_WOLF_TENANT_ID, none),
    DEFAULT_PAYMENT_EMAIL_LOGO_URL,
  );
  assertEquals(
    DEFAULT_PAYMENT_EMAIL_LOGO_URL,
    "https://system.wisewolflanguage.com.br/assets/brand/wise-wolf-logo.png",
  );
  assertEquals(paymentEmailLogoUrl("other-school", none), null);
  assertEquals(
    paymentEmailLogoUrl(
      WISE_WOLF_TENANT_ID,
      () => "https://cdn.example.invalid/logo.png",
    ),
    "https://cdn.example.invalid/logo.png",
  );
  assertEquals(
    paymentEmailLogoUrl(WISE_WOLF_TENANT_ID, () => "http://insecure/logo.png"),
    null,
  );
  const html = renderPaymentEmailHtml({
    text: "body",
    brandName: "Wise Wolf",
    logoUrl: DEFAULT_PAYMENT_EMAIL_LOGO_URL,
  });
  assert(
    html.includes(
      `<img src="${DEFAULT_PAYMENT_EMAIL_LOGO_URL}" alt="Wise Wolf"`,
    ),
  );
  assert(!html.includes("base64"));
});

Deno.test("payment notice e-mail sends HTML plus the unchanged text alternative and the display-name sender", async () => {
  let sent: Record<string, unknown> = {};
  const transport: typeof fetch = (_url, init) => {
    sent = JSON.parse(String(init?.body));
    return Promise.resolve(Response.json({ id: "mail_fixture" }));
  };
  const from = "Wise Wolf Financeiro <naoresponder@wisewolflanguage.com.br>";
  const displayEnv = (key: string) =>
    key === "RESEND_API_KEY"
      ? "fixture-key"
      : key === "RESEND_FROM_EMAIL"
      ? ` ${from} `
      : undefined;
  const text = "Oi <Ana>!\n\nPague pelo link: https://www.asaas.com/i/x";
  assertEquals(
    await deliverPaymentNoticeEmail(
      emailClient([]),
      {
        ...notice,
        tenantId: WISE_WOLF_TENANT_ID,
        text,
        brandName: "Wise Wolf",
      },
      transport,
      displayEnv,
    ),
    "SENT",
  );
  assertEquals(sent.from, from);
  assertEquals(sent.text, text);
  assertEquals(sent.subject, "Sua mensalidade vence hoje - Escola ");
  const html = String(sent.html);
  assert(html.includes(DEFAULT_PAYMENT_EMAIL_LOGO_URL));
  assert(html.includes("Oi &lt;Ana&gt;!"));
  assert(!html.includes("<Ana>"));
});

Deno.test("remetente da cobrança: PAYMENT_RESEND_FROM_EMAIL tem prioridade e o geral é o padrão", async () => {
  const { paymentFromEmail } = await import("./payment-email.ts");
  const env = (values: Record<string, string>) => (key: string) => values[key];
  if (
    paymentFromEmail(env({
      PAYMENT_RESEND_FROM_EMAIL:
        " Wise Wolf Financeiro <naoresponder@wisewolflanguage.com.br> ",
      RESEND_FROM_EMAIL: "naoresponder@wisewolflanguage.com.br",
    })) !== "Wise Wolf Financeiro <naoresponder@wisewolflanguage.com.br>"
  ) throw new Error("prioridade do remetente da cobrança");
  if (
    paymentFromEmail(
      env({
        PAYMENT_RESEND_FROM_EMAIL: "  ",
        RESEND_FROM_EMAIL: "naoresponder@wisewolflanguage.com.br",
      }),
    ) !==
      "naoresponder@wisewolflanguage.com.br"
  ) throw new Error("vazio cai no remetente geral");
  if (paymentFromEmail(env({})) !== undefined) throw new Error("sem remetente");
});
