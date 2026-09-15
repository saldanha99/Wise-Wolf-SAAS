/// <reference lib="deno.ns" />

import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  clientIp,
  overdueChargeFactsMatch,
  overdueConfirmationKey,
  overduePaymentSnapshot,
  overdueSummary,
  parseBillingType,
  parseCreditCard,
  parseSubscriptionPayments,
  paymentNoLongerNeedsCharge,
  providerSubscriptionCardMatchesLast4,
  safeProviderMessage,
  validateOverdueCardObligations,
} from "./core.ts";

Deno.test("aceita apenas as tres formas de pagamento suportadas", () => {
  assertEquals(parseBillingType(" pix "), "PIX");
  assertEquals(parseBillingType("BOLETO"), "BOLETO");
  assertEquals(parseBillingType("credit_card"), "CREDIT_CARD");
  assertEquals(parseBillingType("UNDEFINED"), null);
});

Deno.test("normaliza o cartao sem reter caracteres de formatacao", () => {
  assertEquals(
    parseCreditCard({
      holderName: "  Titular Teste ",
      number: "4111 1111 1111 1111",
      expiryMonth: "9",
      expiryYear: "2030",
      ccv: "123",
    }),
    {
      holderName: "Titular Teste",
      number: "4111111111111111",
      expiryMonth: "09",
      expiryYear: "2030",
      ccv: "123",
    },
  );
});

Deno.test("rejeita cartao incompleto", () => {
  assertEquals(
    parseCreditCard({ holderName: "A", number: "123", ccv: "1" }),
    null,
  );
});

Deno.test("confirma o cartão apenas por campo explícito e últimos quatro dígitos", () => {
  assertEquals(
    providerSubscriptionCardMatchesLast4(
      { creditCard: { creditCardNumber: "**** **** **** 1111" } },
      "1111",
    ),
    true,
  );
  assertEquals(
    providerSubscriptionCardMatchesLast4(
      { creditCardNumber: "4111111111112222" },
      "2222",
    ),
    true,
  );
  assertEquals(
    providerSubscriptionCardMatchesLast4(
      { creditCard: { creditCardToken: "token-ending-1111" } },
      "1111",
    ),
    false,
  );
  assertEquals(providerSubscriptionCardMatchesLast4({}, "1111"), false);
});

Deno.test("usa o primeiro IP encaminhado e rejeita texto arbitrario", () => {
  assertEquals(
    clientIp(new Headers({ "x-forwarded-for": "203.0.113.2, 10.0.0.1" })),
    "203.0.113.2",
  );
  assertEquals(clientIp(new Headers({ "x-forwarded-for": "not-an-ip" })), null);
});

Deno.test("oculta sequencias que parecem cartao ou documento", () => {
  assertEquals(
    safeProviderMessage("Cartao 4111111111111111 CPF 287.188.848-57 recusado"),
    "Cartao [cartao oculto] CPF [documento oculto] recusado",
  );
});

Deno.test("seleciona somente cobranças vencidas da assinatura correta", () => {
  assertEquals(
    parseSubscriptionPayments([
      {
        id: "pay_future",
        subscription: "sub_1",
        status: "PENDING",
        dueDate: "2026-09-10",
        value: 229,
      },
      {
        id: "pay_other",
        subscription: "sub_2",
        status: "OVERDUE",
        dueDate: "2026-07-10",
        value: 229,
      },
      {
        id: "pay_aug",
        subscription: "sub_1",
        status: "OVERDUE",
        dueDate: "2026-08-10",
        value: 229,
      },
      {
        id: "pay_jul",
        subscription: "sub_1",
        status: "OVERDUE",
        dueDate: "2026-07-10",
        value: 229,
        billingType: "PIX",
      },
      {
        id: "pay_deleted",
        subscription: "sub_1",
        status: "OVERDUE",
        dueDate: "2026-06-10",
        value: 229,
        deleted: true,
      },
    ], "sub_1"),
    [
      {
        id: "pay_jul",
        subscription: "sub_1",
        status: "OVERDUE",
        dueDate: "2026-07-10",
        value: 229,
        billingType: "PIX",
      },
      {
        id: "pay_aug",
        subscription: "sub_1",
        status: "OVERDUE",
        dueDate: "2026-08-10",
        value: 229,
        billingType: null,
      },
    ],
  );
});

Deno.test("resume quantidade, total e vencimento mais antigo", () => {
  assertEquals(
    overdueSummary([
      {
        id: "pay_1",
        subscription: "sub_1",
        status: "OVERDUE",
        dueDate: "2026-07-10",
        value: 169.9,
      },
      {
        id: "pay_2",
        subscription: "sub_1",
        status: "OVERDUE",
        dueDate: "2026-08-10",
        value: 229.01,
      },
    ]),
    {
      count: 2,
      total: 398.91,
      oldestDueDate: "2026-07-10",
      confirmationKey:
        'OVERDUE_V2:[["pay_1",16990,"2026-07-10",null,"OVERDUE","sub_1"],["pay_2",22901,"2026-08-10",null,"OVERDUE","sub_1"]]',
    },
  );
});

Deno.test("gera confirmação estável inclusive quando não há vencidas", () => {
  assertEquals(overdueConfirmationKey([]), "NO_OVERDUE_PAYMENTS");
  assertEquals(
    overdueConfirmationKey([
      {
        id: "pay_b",
        subscription: "sub_1",
        status: "OVERDUE",
        dueDate: "2026-08-10",
        value: 10,
      },
      {
        id: "pay_a",
        subscription: "sub_1",
        status: "OVERDUE",
        dueDate: "2026-07-10",
        value: 10,
      },
    ]),
    'OVERDUE_V2:[["pay_a",1000,"2026-07-10",null,"OVERDUE","sub_1"],["pay_b",1000,"2026-08-10",null,"OVERDUE","sub_1"]]',
  );
});

Deno.test("confirmação invalida mudanças financeiras da mesma fatura sem incluir dados do cartão", () => {
  const payment = {
    id: "pay_same",
    subscription: "sub_1",
    status: "OVERDUE",
    dueDate: "2026-08-10",
    value: 229.01,
    billingType: "PIX",
    creditCardToken: "SECRET_TOKEN",
    creditCard: { number: "4111111111111111", ccv: "123" },
  };
  const original = overdueConfirmationKey([payment]);
  for (
    const change of [
      { value: 229.02 },
      { dueDate: "2026-08-11" },
      { billingType: "CREDIT_CARD" },
      { status: "CONFIRMED" },
      { subscription: "sub_changed" },
      { id: "pay_other" },
    ]
  ) {
    assertEquals(
      overdueConfirmationKey([{ ...payment, ...change }]) === original,
      false,
    );
  }
  for (
    const reversal of [{ refundedValue: 1 }, {
      chargeback: { status: "REQUESTED" },
    }, { refunds: [{ status: "REQUESTED", value: 1 }] }]
  ) {
    assertEquals(
      overdueChargeFactsMatch(payment, { ...payment, ...reversal }),
      false,
    );
    assertThrows(
      () =>
        parseSubscriptionPayments(
          [{ ...payment, ...reversal }],
          payment.subscription,
        ),
      Error,
      "overdue_provider_reversal_requires_review",
    );
  }
  assertEquals(original.includes("SECRET_TOKEN"), false);
  assertEquals(original.includes("4111111111111111"), false);
  assertEquals(original.includes("ccv"), false);
  const other = { ...payment, id: "pay_other", value: 50 };
  assertEquals(
    overdueConfirmationKey([payment, other]),
    overdueConfirmationKey([other, payment]),
  );
});

Deno.test("não repete cobrança já confirmada ou em análise", () => {
  assertEquals(paymentNoLongerNeedsCharge("CONFIRMED"), true);
  assertEquals(paymentNoLongerNeedsCharge("awaiting_risk_analysis"), true);
  assertEquals(paymentNoLongerNeedsCharge("OVERDUE"), false);
  assertEquals(paymentNoLongerNeedsCharge("PENDING"), false);
});

Deno.test("a leitura final aceita somente a conversão autorizada para cartão sem alterar dinheiro ou vencimento", () => {
  const approved = {
    id: "pay_same",
    subscription: "sub_1",
    status: "OVERDUE",
    dueDate: "2026-08-10",
    value: 100,
    billingType: "PIX",
  };
  assertEquals(
    overdueChargeFactsMatch(approved, {
      ...approved,
      billingType: "CREDIT_CARD",
    }),
    true,
  );
  for (
    const change of [
      { value: 101 },
      { dueDate: "2026-08-11" },
      { status: "CONFIRMED" },
      { subscription: "sub_other" },
      { billingType: "BOLETO" },
      { id: "pay_other" },
    ]
  ) {
    assertEquals(
      overdueChargeFactsMatch(approved, { ...approved, ...change }),
      false,
    );
  }
  assertEquals(overduePaymentSnapshot(approved), {
    id: "pay_same",
    subscription: "sub_1",
    status: "OVERDUE",
    dueDate: "2026-08-10",
    value_cents: 10000,
    billingType: "PIX",
  });
});

Deno.test("guard de obrigação falha fechado e transmite somente snapshot financeiro mínimo", async () => {
  const payment = {
    id: "pay_same",
    subscription: "sub_1",
    status: "OVERDUE",
    dueDate: "2026-08-10",
    value: 100,
    billingType: "PIX",
    creditCardToken: "NEVER_SEND",
  };
  const input = {
    tenantId: "school-qa",
    studentId: "student-qa",
    subscriptionId: "sub_1",
    payments: [payment],
  };
  for (
    const response of [
      { data: null, error: { code: "missing" } },
      { data: { ok: false, reason: "covered" }, error: null },
      { data: { ok: "true" }, error: null },
      { data: [], error: null },
    ]
  ) {
    assertEquals(
      await validateOverdueCardObligations(
        { rpc: async () => response },
        input,
      ),
      false,
    );
  }
  assertEquals(
    await validateOverdueCardObligations({
      rpc: async () => {
        throw new Error("unavailable");
      },
    }, input),
    false,
  );
  assertEquals(
    await validateOverdueCardObligations({
      rpc: async (name, args) => {
        assertEquals(name, "validate_student_overdue_card_obligations");
        assertEquals(JSON.stringify(args).includes("NEVER_SEND"), false);
        assertEquals(args.p_payment_snapshots, [
          overduePaymentSnapshot(payment),
        ]);
        return { data: { ok: true }, error: null };
      },
    }, input),
    true,
  );
});

Deno.test({
  name: "valida obrigações antes do PUT e nova trava financeira antes do POST",
  permissions: { read: true },
  async fn() {
    const source = await Deno.readTextFile(
      new URL("./index.ts", import.meta.url),
    );
    const validation = source.indexOf(
      "!await validateOverdueCardObligations(",
    );
    const cardPut = source.indexOf("`/subscriptions/${encodedId}/creditCard`");
    assertEquals(validation > 0 && validation < cardPut, true);
    assertEquals(
      source.includes('"mark_student_overdue_card_charge_submitting_v2"'),
      true,
    );
    assertEquals(
      source.includes('"mark_student_overdue_card_charge_submitting"'),
      false,
    );
    const check = source.indexOf(
      "if (!overdueChargeFactsMatch(payment, finalGuard.entity))",
    );
    const mark = source.indexOf("!await markChargeSubmitting(");
    const post = source.indexOf(
      "`/payments/${encodedPaymentId}/payWithCreditCard`",
    );
    assertEquals(check > 0 && check < mark && mark < post, true);
  },
});
