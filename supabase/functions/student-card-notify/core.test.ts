import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  cardFailureMessage,
  parseCardSource,
  sendCardNotice,
  verifyCardProof,
} from "./core.ts";

export const source = {
  tenant_id: "school-test",
  student_id: "student-test",
  payment_id: "payment-test",
  provider_payment_id: "pay_test",
  customer_id: "cus_test",
  subscription_id: "sub_test",
  value: 100,
  due_date: "2026-09-14",
  event_id: "evt_test",
  event_hash: "a".repeat(64),
  event_at: "2026-09-14T12:00:00Z",
  billing_type: "CREDIT_CARD" as const,
  recipient_phone: "5511999990000",
  recipient_name: "Responsável QA",
  student_name: "Aluno QA",
  card_last4: "1234",
};
export const payment = {
  id: "pay_test",
  customer: "cus_test",
  subscription: "sub_test",
  value: 100,
  dueDate: "2026-09-14",
  status: "OVERDUE",
  billingType: "CREDIT_CARD",
  deleted: false,
  creditCard: {
    creditCardNumber: "1234",
    creditCardToken: "SECRET_MARKER",
    holderName: "PII_MARKER",
  },
};
export const subscription = {
  id: "sub_test",
  customer: "cus_test",
  status: "ACTIVE",
  billingType: "CREDIT_CARD",
  deleted: false,
  creditCard: { creditCardNumber: "1234", creditCardToken: "SECRET_MARKER" },
};

Deno.test("source rejects wrong recipient and keeps only contract fields", () => {
  assertEquals(parseCardSource({ ...source, arbitrary: "SECRET" }), source);
  for (
    const recipient_phone of ["", "5511999990000@g.us", "+5511999990000", "bad"]
  ) {
    assertEquals(parseCardSource({ ...source, recipient_phone }), null);
  }
  for (const due_date of ["2026-02-31", "2026-9-14", ""]) {
    assertEquals(parseCardSource({ ...source, due_date }), null);
  }
  assertEquals(parseCardSource({ ...source, value: 1.001 }), null);
  assertEquals(
    parseCardSource({ ...source, provider_payment_id: "../pay_other" }),
    null,
  );
});

Deno.test("proof snapshots exclude card tokens and personal provider fields", () => {
  const checked = verifyCardProof(source, payment, subscription);
  assertEquals(checked.ok, true);
  assertEquals(JSON.stringify(checked).includes("SECRET_MARKER"), false);
  assertEquals(JSON.stringify(checked).includes("PII_MARKER"), false);
  if (checked.ok) assertEquals(checked.proof.payment.creditCardLast4, "1234");
});

for (
  const [name, changed, expected] of [
    ["other payment", { id: "pay_other" }, "identity_mismatch"],
    ["other customer", { customer: "cus_other" }, "identity_mismatch"],
    ["other subscription", { subscription: "sub_other" }, "identity_mismatch"],
    ["changed value", { value: 101 }, "snapshot_changed"],
    ["changed due date", { dueDate: "2026-10-14" }, "snapshot_changed"],
    ["paid", { status: "RECEIVED" }, "provider_settled"],
    ["confirmed", { status: "CONFIRMED" }, "provider_settled"],
    ["cash", { status: "RECEIVED_IN_CASH" }, "provider_settled"],
    ["refund value", { refundedValue: 1 }, "provider_reversal"],
    ["refund list", { refunds: [{ status: "DONE" }] }, "provider_reversal"],
    ["dispute", { chargeback: { status: "REQUESTED" } }, "provider_reversal"],
    ["refund status", { status: "REFUNDED" }, "provider_reversal"],
    ["deleted", { deleted: true }, "provider_deleted"],
    ["boleto", { billingType: "BOLETO" }, "provider_not_eligible"],
    [
      "card replaced",
      { creditCard: { creditCardNumber: "4321" } },
      "snapshot_changed",
    ],
  ] as const
) {
  Deno.test(`proof rejects ${name}`, () => {
    const checked = verifyCardProof(
      source,
      { ...payment, ...changed },
      subscription,
    );
    assertEquals(checked.ok, false);
    if (!checked.ok) assertEquals(checked.reason, expected);
  });
}

Deno.test("subscription must be same payer, active and card", () => {
  for (
    const change of [{ customer: "cus_other" }, { status: "INACTIVE" }, {
      billingType: "PIX",
    }, { deleted: true }]
  ) {
    assertEquals(
      verifyCardProof(source, payment, { ...subscription, ...change }).ok,
      false,
    );
  }
});

Deno.test("message is factual with authenticated navigation, never card collection", () => {
  const message = cardFailureMessage(
    source,
    "Escola QA",
    "https://portal.example.invalid/student?id=secret",
  );
  assertStringIncludes(message, "Não foi possível processar no cartão");
  assertStringIncludes(
    message,
    "https://portal.example.invalid/financeiro/forma-pagamento",
  );
  assertStringIncludes(message, "Não envie número do cartão");
  assertEquals(message.includes("id=secret"), false);
  assertEquals(message.includes("expirado"), false);
  assertEquals(message.includes("sem limite"), false);
});

for (
  const [status, outcome] of [
    [201, "accepted"],
    [400, "rejected"],
    [401, "rejected"],
    [408, "ambiguous"],
    [429, "ambiguous"],
    [500, "ambiguous"],
  ] as const
) {
  Deno.test(`send HTTP ${status} records ${outcome} with exactly one POST`, async () => {
    let calls = 0;
    const fetcher = ((_: unknown, init: RequestInit) => {
      calls++;
      assertEquals(init.method, "POST");
      assertEquals(init.redirect, "error");
      return Promise.resolve(
        new Response(JSON.stringify({ key: { id: "message-test" } }), {
          status,
        }),
      );
    }) as typeof fetch;
    const sent = await sendCardNotice(
      {
        baseUrl: "https://example.invalid",
        apiKey: "test",
        instanceName: "qa",
      },
      source.recipient_phone,
      "test",
      fetcher,
    );
    assertEquals(calls, 1);
    assertEquals(sent.outcome, outcome);
    assertEquals(
      sent.messageId,
      outcome === "accepted" ? "message-test" : null,
    );
  });
}

Deno.test("network failure is ambiguous, with no retry or sensitive exception output", async () => {
  let calls = 0;
  const sent = await sendCardNotice(
    { baseUrl: "https://example.invalid", apiKey: "test", instanceName: "qa" },
    source.recipient_phone,
    "test",
    (() => {
      calls++;
      throw new Error(`SECRET_MARKER ${source.recipient_phone}`);
    }) as typeof fetch,
  );
  assertEquals(calls, 1);
  assertEquals(sent, {
    outcome: "ambiguous",
    messageId: null,
    httpStatus: null,
  });
});
