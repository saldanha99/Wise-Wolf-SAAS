/// <reference lib="deno.ns" />

import {
  assertEquals,
  assertMatch,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  formatManualPixMessage,
  hasOpenNonPixPayment,
  nextUpcomingDueDate,
  normalizeBrazilianPhone,
  paymentBelongsToStudent,
  selectOpenPixPayment,
} from "./core.ts";

Deno.test("normaliza telefone brasileiro sem aceitar destino incompleto", () => {
  assertEquals(normalizeBrazilianPhone("(11) 98888-7777"), "5511988887777");
  assertEquals(normalizeBrazilianPhone("5511988887777"), "5511988887777");
  assertEquals(normalizeBrazilianPhone("123"), null);
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
  assertEquals(selectOpenPixPayment([
    { id: "pay-card", status: "PENDING", billingType: "CREDIT_CARD", dueDate: "2026-08-10" },
    { id: "pay-next", status: "PENDING", billingType: "PIX", dueDate: "2026-09-10" },
    { id: "pay-old", status: "OVERDUE", billingType: "BOLETO", dueDate: "2026-07-10" },
  ])?.id, "pay-old");
});

Deno.test("reconhece mensalidade pelo aluno ou pela assinatura da matrícula", () => {
  assertEquals(paymentBelongsToStudent(
    { externalReference: "student-1" },
    "student-1",
    "sub-1",
  ), true);
  assertEquals(paymentBelongsToStudent(
    { externalReference: "enrollment:offer:subscription", subscription: "sub-1" },
    "student-1",
    "sub-1",
  ), true);
  assertEquals(paymentBelongsToStudent(
    { externalReference: "enrollment:fee" },
    "student-1",
    "sub-1",
  ), false);
});

Deno.test("detecta cobrança aberta incompatível para impedir duplicidade", () => {
  assertEquals(hasOpenNonPixPayment([
    { id: "pay-card", status: "PENDING", billingType: "CREDIT_CARD" },
  ]), true);
  assertEquals(hasOpenNonPixPayment([
    { id: "pay-paid", status: "RECEIVED", billingType: "CREDIT_CARD" },
  ]), false);
});

Deno.test("mensagem contém valor, vencimento e código sem link genérico", () => {
  const message = formatManualPixMessage({
    studentName: "Ednalva Josefa",
    value: 169,
    dueDate: "2026-09-10",
    pixPayload: "000201PIX-COPIA-E-COLA",
  });
  assertMatch(message, /Olá, Ednalva!/);
  assertMatch(message, /R\$\s*169,00/);
  assertMatch(message, /10\/09\/2026/);
  assertMatch(message, /000201PIX-COPIA-E-COLA/);
  assertMatch(message, /vinculada ao seu cadastro/);
});
