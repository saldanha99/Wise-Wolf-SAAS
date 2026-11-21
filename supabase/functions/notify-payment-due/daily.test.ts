import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  dailyCollectionText,
  dailyProviderEligible,
  deliverDailyEmail,
  runDailyCollections,
  schoolDate,
  validInvoiceUrl,
} from "./daily.ts";
import { claimOutboundMessage } from "../_shared/student-billing-period-guard.ts";
import { DEFAULT_PAYMENT_EMAIL_LOGO_URL } from "../_shared/payment-email.ts";

const charge = {
  id: "local",
  tenant_id: "fixture",
  student_id: "student",
  asaas_payment_id: "pay_fixture",
  value: 187,
  due_date: "2026-09-10",
  invoice_url: null,
};
const student = {
  asaas_customer_id: "cus_fixture",
  subscription_id: "sub_fixture",
};
const provider = {
  id: "pay_fixture",
  customer: "cus_fixture",
  subscription: "sub_fixture",
  status: "OVERDUE",
  dueDate: "2026-09-10",
  value: 187,
  deleted: false,
  invoiceUrl: "https://www.asaas.com/i/fixture",
};

Deno.test("daily collection requires a live overdue invoice belonging to this student", () => {
  assert(dailyProviderEligible(charge, student, provider, "2026-10-02"));
  for (
    const change of [
      { status: "RECEIVED" },
      { deleted: true },
      { customer: "cus_other" },
      { subscription: "sub_other" },
      { id: "pay_other" },
      { dueDate: "2026-10-02" },
      { value: 0 },
      { value: NaN },
    ]
  ) {
    assert(
      !dailyProviderEligible(
        charge,
        student,
        { ...provider, ...change },
        "2026-10-02",
      ),
    );
  }
  assert(
    !dailyProviderEligible(
      charge,
      { ...student, subscription_id: null },
      provider,
      "2026-10-02",
    ),
  );
});

Deno.test("daily collection calendar uses Brasília including the UTC date boundary", () => {
  assertEquals(schoolDate(new Date("2026-10-03T01:00:00Z")), "2026-10-02");
  assertEquals(schoolDate(new Date("2026-10-03T12:00:00Z")), "2026-10-03");
});

Deno.test("daily collection message identifies the guardian, invoice and day without invented threats", () => {
  const body = dailyCollectionText({
    studentName: "Aluna",
    brandName: "Escola",
    value: 149,
    dueDate: "2026-09-15",
    date: "2026-10-02",
    guardian: true,
    invoiceUrl: provider.invoiceUrl,
  });
  assert(body.includes("Ao responsável financeiro"));
  assert(body.includes("R$ 149,00"));
  assert(body.includes("15/09/2026"));
  assert(body.includes("02/10/2026"));
  assert(!/negativa|perder|judicial|bloqueio automático/.test(body));
  assert(validInvoiceUrl(provider.invoiceUrl));
  assert(!validInvoiceUrl("https://asaas.com.evil.invalid/invoice"));
  assert(!validInvoiceUrl("https://user:pass@asaas.com/i/fixture"));
});

function emailClient(events: string[], duplicate = false): SupabaseClient {
  return {
    from: () => ({
      insert: () => {
        events.push("claim");
        return {
          select: () => ({
            single: () =>
              Promise.resolve(
                duplicate
                  ? { data: null, error: { code: "23505" } }
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
  } as unknown as SupabaseClient;
}
const env = (key: string) =>
  key === "RESEND_API_KEY" ? "fixture-key" : "fixture@example.invalid";

Deno.test("daily email persists its intent before POST and refuses a duplicate day", async () => {
  const events: string[] = [];
  const transport: typeof fetch = (_url, init) => {
    events.push("post");
    assert(
      String((init?.headers as Record<string, string>)["Idempotency-Key"])
        .includes("2026-10-02"),
    );
    return Promise.resolve(Response.json({ id: "mail_fixture" }));
  };
  assertEquals(
    await deliverDailyEmail(
      emailClient(events),
      charge,
      "2026-10-02",
      "fixture@example.invalid",
      "body",
      "Escola",
      transport,
      env,
    ),
    "SENT",
  );
  assertEquals(events, ["claim", "post", "finish:SENT"]);
  const dup: string[] = [];
  assertEquals(
    await deliverDailyEmail(
      emailClient(dup, true),
      charge,
      "2026-10-02",
      "fixture@example.invalid",
      "body",
      "Escola",
      transport,
      env,
    ),
    "ALREADY_ATTEMPTED",
  );
  assertEquals(dup, ["claim"]);
});

Deno.test("daily email treats an ambiguous network result as terminal for that day", async () => {
  const events: string[] = [];
  const transport: typeof fetch = () => {
    events.push("post");
    throw new Error("network timeout");
  };
  assertEquals(
    await deliverDailyEmail(
      emailClient(events),
      charge,
      "2026-10-02",
      "fixture@example.invalid",
      "body",
      "Escola",
      transport,
      env,
    ),
    "UNKNOWN",
  );
  assertEquals(events, ["claim", "post", "finish:UNKNOWN"]);
});

Deno.test("daily email sends branded HTML with the escaped text as alternative", async () => {
  let sent: Record<string, unknown> = {};
  const transport: typeof fetch = (_url, init) => {
    sent = JSON.parse(String(init?.body));
    return Promise.resolve(Response.json({ id: "mail_fixture" }));
  };
  const body = "Olá! A mensalidade de <Ana & Bia>.\n\nLink: " +
    provider.invoiceUrl;
  assertEquals(
    await deliverDailyEmail(
      emailClient([]),
      { ...charge, tenant_id: "school-wise-wolf" },
      "2026-10-02",
      "fixture@example.invalid",
      body,
      "Wise Wolf",
      transport,
      (key) =>
        key === "RESEND_API_KEY"
          ? "fixture-key"
          : key === "RESEND_FROM_EMAIL"
          ? "Wise Wolf Financeiro <naoresponder@wisewolflanguage.com.br>"
          : undefined,
    ),
    "SENT",
  );
  assertEquals(sent.text, body);
  assertEquals(sent.subject, "Pagamento pendente — Wise Wolf");
  assertEquals(
    sent.from,
    "Wise Wolf Financeiro <naoresponder@wisewolflanguage.com.br>",
  );
  const html = String(sent.html);
  assert(html.includes(DEFAULT_PAYMENT_EMAIL_LOGO_URL));
  assert(html.includes("&lt;Ana &amp; Bia&gt;"));
  assert(!html.includes("<Ana"));
});

type Filter = { table: string; method: string; args: unknown[] };

// Cliente falso encadeável: cada tabela devolve uma resposta fixa e registra os
// filtros aplicados, para provar que a trava do dia não olha a instância.
function dailyRunClient(
  responses: Record<string, unknown>,
  filters: Filter[],
): SupabaseClient {
  const builder = (table: string) => {
    const response = responses[table] ?? { data: null, error: null };
    const chain: Record<string, unknown> = {};
    for (
      const method of [
        "select",
        "eq",
        "in",
        "lt",
        "gte",
        "like",
        "neq",
        "order",
        "range",
        "limit",
      ]
    ) {
      chain[method] = (...args: unknown[]) => {
        filters.push({ table, method, args });
        return chain;
      };
    }
    chain.maybeSingle = () => Promise.resolve(response);
    chain.then = (resolve: (value: unknown) => unknown) => resolve(response);
    return chain;
  };
  return {
    from: builder,
    auth: {
      admin: {
        getUserById: () =>
          Promise.resolve({ data: { user: null }, error: null }),
      },
    },
  } as unknown as SupabaseClient;
}

function dailyRun(previousNoticeToday: number) {
  const filters: Filter[] = [];
  const sends: { instance: string; kind: string }[] = [];
  const client = dailyRunClient({
    daily_payment_collection_settings: {
      data: [{ tenant_id: "school-wise-wolf" }],
      error: null,
    },
    student_payments: {
      data: [{
        ...charge,
        tenant_id: "school-wise-wolf",
        invoice_url: provider.invoiceUrl,
      }],
      error: null,
    },
    profiles: {
      data: {
        id: "student",
        role: "STUDENT",
        full_name: "Aluna",
        email: "aluna@example.invalid",
        asaas_customer_id: "cus_fixture",
        subscription_id: "sub_fixture",
        contract_accepted: true,
        status: "Ativo",
        lifecycle_status: "active",
        is_test_account: false,
        guardian_id: null,
        guardian_cpf: null,
        guardian_email: null,
      },
      error: null,
    },
    asaas_outbound_message_attempts: {
      count: previousNoticeToday,
      error: null,
    },
  }, filters);
  return {
    filters,
    sends,
    run: () =>
      runDailyCollections(client, "2026-10-02", {
        readProvider: () => Promise.resolve(provider),
        stillStudies: () => Promise.resolve(true),
        recipient: () =>
          Promise.resolve({
            ok: true,
            motivo: "",
            nome: "Aluna",
            brandName: "Wise Wolf",
            phone: "5511999999999",
            instance: "financeiro-ww",
          }),
        whatsapp: (_charge, input) => {
          sends.push({ instance: input.instance, kind: input.kind });
          return Promise.resolve({
            status: "SENT",
            sentNow: true,
            reason: "sent",
          });
        },
      }),
  };
}

Deno.test("daily dunning goes through the resolved finance instance", async () => {
  const fixture = dailyRun(0);
  const result = await fixture.run();
  assertEquals(fixture.sends, [{
    instance: "financeiro-ww",
    kind: "PAYMENT_OVERDUE_DAILY_20261002",
  }]);
  assertEquals(result.whatsapp_sent, 1);
});

Deno.test("a notice accepted today on ANY instance blocks the finance instance", async () => {
  const fixture = dailyRun(1);
  const result = await fixture.run();
  assertEquals(fixture.sends, []);
  assertEquals(result.whatsapp_sent, 0);
  const history = fixture.filters.filter((f) =>
    f.table === "asaas_outbound_message_attempts"
  );
  assert(history.length > 0);
  assert(
    history.every((f) =>
      !JSON.stringify(f.args).toLowerCase().includes("instance")
    ),
  );
});

Deno.test("the durable outbound fence is keyed by invoice and kind, never by instance", async () => {
  let params: Record<string, unknown> = {};
  const admin = {
    rpc: (_name: string, args: Record<string, unknown>) => {
      params = args;
      return Promise.resolve({ data: null, error: { message: "fixture" } });
    },
  };
  // deno-lint-ignore no-explicit-any
  await claimOutboundMessage(admin as any, {
    tenantId: "school-wise-wolf",
    studentId: "student",
    providerEntityId: "local",
    notificationKind: "PAYMENT_OVERDUE_DAILY_20261002",
  }).catch(() => null);
  assertEquals(
    Object.keys(params).filter((key) => key.includes("instance")),
    [],
  );
  assertEquals(params.p_provider_entity_id, "local");
  assertEquals(params.p_notification_kind, "PAYMENT_OVERDUE_DAILY_20261002");
});
