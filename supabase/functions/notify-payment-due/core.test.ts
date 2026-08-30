import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  overdueNotificationKind,
  paymentNotificationFinish,
  resolvePaymentRecipient,
} from "./core.ts";

Deno.test("payment reminder routes a dependent only to the financial guardian", () => {
  assertEquals(
    resolvePaymentRecipient({
      full_name: "Aluno Menor",
      phone: "(11) 91111-1111",
      guardian_id: "guardian-1",
      guardian_cpf: "123.456.789-00",
      guardian_name: "  Maria   Responsável  ",
      guardian_phone: "(11) 98888-7777",
    }),
    {
      ok: true,
      phone: "5511988887777",
      firstName: "Maria",
      recipient: "FINANCIAL_GUARDIAN",
    },
  );
});

Deno.test("dependent reminder fails closed when the guardian phone is invalid", () => {
  assertEquals(
    resolvePaymentRecipient({
      full_name: "Aluno Menor",
      phone: "(11) 91111-1111",
      guardian_cpf: "123.456.789-00",
      guardian_name: "Maria Responsável",
      guardian_phone: null,
    }),
    {
      ok: false,
      reason: "financial_guardian_phone_missing_or_invalid",
      recipient: "FINANCIAL_GUARDIAN",
    },
  );
});

Deno.test("payment reminder keeps an independent student's current phone", () => {
  assertEquals(
    resolvePaymentRecipient({
      full_name: "  João   Aluno ",
      phone: "11977776666",
      guardian_id: " ",
      guardian_cpf: null,
      guardian_phone: "11999990000",
    }),
    {
      ok: true,
      phone: "5511977776666",
      firstName: "João",
      recipient: "STUDENT",
    },
  );
});

Deno.test("payment reminder maps an accepted provider response to SENT", () => {
  assertEquals(
    paymentNotificationFinish({
      outcome: "accepted",
      messageId: "message-1",
      httpStatus: 201,
    }),
    { status: "SENT", providerHttpStatus: 201, error: null },
  );
});

Deno.test("payment reminder never retries an ambiguous provider outcome", () => {
  assertEquals(
    paymentNotificationFinish({
      outcome: "ambiguous",
      messageId: null,
      httpStatus: 504,
    }),
    {
      status: "UNKNOWN",
      providerHttpStatus: 504,
      error: "provider_delivery_outcome_unknown",
    },
  );
  assertEquals(
    paymentNotificationFinish({
      outcome: "ambiguous",
      messageId: null,
      httpStatus: null,
    }).status,
    "UNKNOWN",
  );
});

Deno.test("payment reminder records a definitive rejection as FAILED", () => {
  assertEquals(
    paymentNotificationFinish({
      outcome: "rejected",
      messageId: null,
      httpStatus: 400,
    }),
    {
      status: "FAILED",
      providerHttpStatus: 400,
      error: "provider_delivery_rejected",
    },
  );
});

Deno.test("overdue milestones have a closed durable notification kind", () => {
  assertEquals(overdueNotificationKind(3), "PAYMENT_OVERDUE_3");
  assertEquals(overdueNotificationKind(10), "PAYMENT_OVERDUE_10");
  assertEquals(overdueNotificationKind(20), "PAYMENT_OVERDUE_20");
  assertThrows(
    () => overdueNotificationKind(4),
    Error,
    "unsupported_payment_overdue_milestone",
  );
});
