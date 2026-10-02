import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  dailyCollectionText,
  dailyProviderEligible,
  deliverDailyEmail,
  schoolDate,
  validInvoiceUrl,
} from "./daily.ts";

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
