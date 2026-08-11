/// <reference lib="deno.ns" />

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  clientIp,
  overdueConfirmationKey,
  overdueSummary,
  parseBillingType,
  parseCreditCard,
  parseSubscriptionPayments,
  paymentNoLongerNeedsCharge,
  safeProviderMessage,
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
      },
      {
        id: "pay_aug",
        subscription: "sub_1",
        status: "OVERDUE",
        dueDate: "2026-08-10",
        value: 229,
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
      confirmationKey: "pay_1|pay_2",
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
    "pay_a|pay_b",
  );
});

Deno.test("não repete cobrança já confirmada ou em análise", () => {
  assertEquals(paymentNoLongerNeedsCharge("CONFIRMED"), true);
  assertEquals(paymentNoLongerNeedsCharge("awaiting_risk_analysis"), true);
  assertEquals(paymentNoLongerNeedsCharge("OVERDUE"), false);
  assertEquals(paymentNoLongerNeedsCharge("PENDING"), false);
});
