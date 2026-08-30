/// <reference lib="deno.ns" />

import {
  assertEquals,
  assertMatch,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  formatManualPixMessage,
  hasOpenNonPixPayment,
  manualPixIssuanceIdFromReference,
  manualPixProviderReference,
  nextUpcomingDueDate,
  normalizeBrazilianPhone,
  paymentBelongsToStudent,
  paymentOccupiesDueDate,
  providerPaymentMatchesManualIssuance,
  providerPaymentMatchesMonthlyCompetence,
  recurringPaymentSourceKey,
  selectExactMonthlyPixPayment,
  selectOpenPixPayment,
} from "./core.ts";

Deno.test("normaliza telefone brasileiro sem aceitar destino incompleto", () => {
  assertEquals(normalizeBrazilianPhone("(11) 98888-7777"), "5511988887777");
  assertEquals(normalizeBrazilianPhone("5511988887777"), "5511988887777");
  assertEquals(normalizeBrazilianPhone("123"), null);
});

Deno.test("referência Pix manual é única por emissão e continua vinculada ao aluno", () => {
  const issuanceId = "10000000-0000-4000-8000-000000000001";
  const studentId = "20000000-0000-4000-8000-000000000002";
  const reference = manualPixProviderReference(issuanceId, studentId);
  assertEquals(reference, `manual-pix:${issuanceId}:student:${studentId}`);
  assertEquals(
    manualPixIssuanceIdFromReference(reference, studentId),
    issuanceId,
  );
  assertEquals(
    manualPixIssuanceIdFromReference(reference, "student-other"),
    null,
  );
  assertEquals(
    paymentBelongsToStudent(
      { externalReference: reference },
      studentId,
      "",
    ),
    true,
  );
  assertEquals(
    paymentBelongsToStudent(
      { externalReference: "other-product:student:student-1" },
      "student-1",
      "",
    ),
    false,
  );
});

Deno.test("recuperação Pix exige identidade e valores exatos da emissão", () => {
  const expected = {
    externalReference: "manual-pix:issuance-1:student:student-1",
    customerId: "cus_1",
    dueDate: "2026-09-10",
    value: 169,
    splitPolicy: { kind: "NONE" as const },
  };
  const match = {
    id: "pay_1",
    externalReference: expected.externalReference,
    customer: expected.customerId,
    billingType: "PIX",
    dueDate: expected.dueDate,
    value: 169,
  };
  assertEquals(providerPaymentMatchesManualIssuance(match, expected), true);
  assertEquals(
    providerPaymentMatchesManualIssuance(
      { ...match, subscription: "sub_unexpected" },
      expected,
    ),
    false,
    "uma mensalidade recorrente não pode ocupar a emissão manual",
  );
  assertEquals(
    providerPaymentMatchesManualIssuance(
      { ...match, customer: "cus_other" },
      expected,
    ),
    false,
  );
  assertEquals(
    providerPaymentMatchesManualIssuance({ ...match, value: 168.99 }, expected),
    false,
  );
  assertEquals(
    providerPaymentMatchesManualIssuance(
      {
        ...match,
        split: [{ walletId: "wallet_unexpected", percentualValue: 90 }],
      },
      expected,
    ),
    false,
  );
});

Deno.test("adoção recorrente deriva apenas a chave original comprovável", () => {
  const studentId = "20000000-0000-4000-8000-000000000002";
  const subscriptionId = "sub_1";
  const offerId = "10000000-0000-4000-8000-000000000001";
  assertEquals(
    recurringPaymentSourceKey(
      {
        subscription: subscriptionId,
        externalReference: `enrollment:${offerId}:subscription`,
      },
      studentId,
      subscriptionId,
    ),
    `subscription:${offerId}`,
  );
  assertEquals(
    recurringPaymentSourceKey(
      { subscription: subscriptionId, externalReference: studentId },
      studentId,
      subscriptionId,
    ),
    `subscription:${studentId}`,
  );
  assertEquals(
    recurringPaymentSourceKey(
      { subscription: subscriptionId, externalReference: "legacy-unknown" },
      studentId,
      subscriptionId,
    ),
    null,
  );
  assertEquals(
    recurringPaymentSourceKey(
      {
        subscription: "sub_other",
        externalReference: `enrollment:${offerId}:subscription`,
      },
      studentId,
      subscriptionId,
    ),
    null,
  );
});

Deno.test("vencimento no próprio dia avança para o mês seguinte", () => {
  assertEquals(
    nextUpcomingDueDate(new Date("2026-08-10T15:00:00Z"), 10),
    "2026-09-10",
  );
  assertEquals(
    nextUpcomingDueDate(new Date("2026-08-09T15:00:00Z"), 10),
    "2026-08-10",
  );
});

Deno.test("prioriza a cobrança Pix aberta mais antiga", () => {
  assertEquals(
    selectOpenPixPayment([
      {
        id: "pay-card",
        status: "PENDING",
        billingType: "CREDIT_CARD",
        dueDate: "2026-08-10",
      },
      {
        id: "pay-next",
        status: "PENDING",
        billingType: "PIX",
        dueDate: "2026-09-10",
      },
      {
        id: "pay-old",
        status: "OVERDUE",
        billingType: "BOLETO",
        dueDate: "2026-07-10",
      },
    ])?.id,
    "pay-old",
  );
});

Deno.test("reuso mensal exige cliente, competência, valor e propósito exatos", () => {
  const expected = {
    studentId: "student-1",
    subscriptionId: "sub-1",
    customerId: "cus-1",
    dueDate: "2026-09-10",
    value: 169,
    splitPolicy: { kind: "NONE" as const },
  };
  const exact = {
    id: "pay-exact",
    status: "PENDING",
    billingType: "PIX",
    customer: "cus-1",
    dueDate: "2026-09-10",
    value: 169,
    subscription: "sub-1",
    externalReference: "enrollment:offer:subscription",
  };
  assertEquals(providerPaymentMatchesMonthlyCompetence(exact, expected), true);
  for (
    const divergent of [
      { ...exact, customer: "cus-other" },
      { ...exact, dueDate: "2026-10-10" },
      { ...exact, value: 168.99 },
      { ...exact, subscription: "sub-other", externalReference: "other" },
      { ...exact, status: "RECEIVED" },
      {
        ...exact,
        split: [{ walletId: "wallet_unexpected", percentualValue: 90 }],
      },
    ]
  ) {
    assertEquals(
      providerPaymentMatchesMonthlyCompetence(divergent, expected),
      false,
    );
  }
  assertEquals(
    selectExactMonthlyPixPayment([exact], expected)?.id,
    "pay-exact",
  );
  assertEquals(
    selectExactMonthlyPixPayment([exact, { ...exact }], expected),
    null,
  );
});

Deno.test("reuso Pix exige a carteira e o percentual congelados", () => {
  const expected = {
    studentId: "student-1",
    subscriptionId: "sub-1",
    customerId: "cus-1",
    dueDate: "2026-09-10",
    value: 169,
    splitPolicy: {
      kind: "PERCENTAGE" as const,
      walletId: "wallet_expected",
      percentualValue: 90,
    },
  };
  const payment = {
    id: "pay-exact",
    status: "PENDING",
    billingType: "PIX",
    customer: expected.customerId,
    dueDate: expected.dueDate,
    value: expected.value,
    subscription: expected.subscriptionId,
    split: [{ walletId: "wallet_expected", percentualValue: 90 }],
  };
  assertEquals(
    providerPaymentMatchesMonthlyCompetence(payment, expected),
    true,
  );
  assertEquals(
    providerPaymentMatchesMonthlyCompetence(
      { ...payment, split: undefined },
      expected,
    ),
    false,
  );
  assertEquals(
    providerPaymentMatchesMonthlyCompetence(
      {
        ...payment,
        split: [{ walletId: "wallet_expected", percentualValue: 89.999 }],
      },
      expected,
    ),
    false,
  );
});

Deno.test("reconhece mensalidade pelo aluno ou pela assinatura da matrícula", () => {
  assertEquals(
    paymentBelongsToStudent(
      { externalReference: "student-1" },
      "student-1",
      "sub-1",
    ),
    true,
  );
  assertEquals(
    paymentBelongsToStudent(
      {
        externalReference: "enrollment:offer:subscription",
        subscription: "sub-1",
      },
      "student-1",
      "sub-1",
    ),
    true,
  );
  assertEquals(
    paymentBelongsToStudent(
      { externalReference: "enrollment:fee" },
      "student-1",
      "sub-1",
    ),
    false,
  );
});

Deno.test("detecta cobrança aberta incompatível para impedir duplicidade", () => {
  assertEquals(
    hasOpenNonPixPayment([
      { id: "pay-card", status: "PENDING", billingType: "CREDIT_CARD" },
    ]),
    true,
  );
  assertEquals(
    hasOpenNonPixPayment([
      { id: "pay-paid", status: "RECEIVED", billingType: "CREDIT_CARD" },
    ]),
    false,
  );
});

Deno.test("bloqueia Pix durante negativacao ou analise de cartao", () => {
  for (
    const status of [
      "DUNNING_REQUESTED",
      "AWAITING_RISK_ANALYSIS",
      "APPROVED_BY_RISK_ANALYSIS",
      "AUTHORIZED",
    ]
  ) {
    assertEquals(
      hasOpenNonPixPayment([{
        id: `pay-${status}`,
        status,
        billingType: status === "DUNNING_REQUESTED" ? "BOLETO" : "CREDIT_CARD",
      }]),
      true,
      `${status} deve impedir uma cobranca Pix concorrente`,
    );
  }
  assertEquals(
    hasOpenNonPixPayment([{
      id: "pay-settled",
      status: "CONFIRMED",
      billingType: "CREDIT_CARD",
    }]),
    true,
    "CONFIRMED compromete o pagamento e deve bloquear um Pix concorrente",
  );
});

Deno.test("cobrança viva ou quitada ocupa a competência; estorno integral libera", () => {
  const dueDate = "2026-09-10";
  for (const status of ["PENDING", "CONFIRMED", "RECEIVED", "OVERDUE"]) {
    assertEquals(
      paymentOccupiesDueDate({ id: `pay-${status}`, status, dueDate }, dueDate),
      true,
      `${status} deve ocupar a competência`,
    );
  }
  for (const status of ["REFUNDED", "DELETED", "CANCELED"]) {
    assertEquals(
      paymentOccupiesDueDate({ id: `pay-${status}`, status, dueDate }, dueDate),
      false,
      `${status} deve liberar a competência`,
    );
  }
});

Deno.test("mensagem contém valor, vencimento e código sem link genérico", () => {
  const message = formatManualPixMessage({
    studentName: "Ednalva Josefa",
    value: 169,
    dueDate: "2026-09-10",
    pixPayload: "000201PIX-COPIA-E-COLA",
    brandName: "Escola Aurora",
  });
  assertMatch(message, /Olá, Ednalva!/);
  assertMatch(message, /R\$\s*169,00/);
  assertMatch(message, /10\/09\/2026/);
  assertMatch(message, /000201PIX-COPIA-E-COLA/);
  assertMatch(message, /mensalidade Escola Aurora/);
  assertMatch(message, /vinculada ao seu cadastro/);
});
