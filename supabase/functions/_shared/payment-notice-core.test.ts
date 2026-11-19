import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  addDaysISO,
  buildPaymentNoticeMessage,
  buildPaymentReceiptEmail,
  d0ExtrasToRead,
  daysUntilDue,
  dueReminderStage,
  normalizeDigitableLine,
  normalizePixCopyPaste,
  noticeProviderEligible,
  paymentNoticeEmailKind,
  paymentNoticeEnqueueDecision,
  paymentNoticeWhatsAppKind,
  receiptSuffix,
  validReceiptUrl,
} from "./payment-notice-core.ts";

const LINE = "00190000090275928800021932978170187890000005000";
const PIX =
  "00020101021226820014br.gov.bcb.pix2560qrpix.bradesco.com.br/qr/v2/fixture5204000053039865802BR5905ESCOLA6009SAO PAULO62070503***6304ABCD";

Deno.test("due reminder stages follow the Asaas calendar: exactly D-10 and D0", () => {
  assertEquals(dueReminderStage("2026-11-19", "2026-11-29"), "D10");
  assertEquals(dueReminderStage("2026-11-19", "2026-11-19"), "D0");
  // D-3 (1 a 3 dias) continua no fluxo antigo; nada além disso.
  for (const due of ["2026-11-20", "2026-11-22", "2026-11-28", "2026-11-30"]) {
    assertEquals(dueReminderStage("2026-11-19", due), null);
  }
  assertEquals(dueReminderStage("2026-11-19", "2026-11-18"), null);
  assertEquals(dueReminderStage("2026-11-19", "invalid"), null);
  // Virada de mês/ano e horário de verão não deslocam o dia.
  assertEquals(addDaysISO("2026-12-25", 10), "2027-01-04");
  assertEquals(daysUntilDue("2026-02-26", "2026-03-08"), 10);
});

Deno.test("durable WhatsApp kinds carry the due date so a new due date is a new notice", () => {
  assertEquals(
    paymentNoticeWhatsAppKind("CREATED", "2026-12-10"),
    "PAYMENT_CREATED_WHATSAPP",
  );
  assertEquals(
    paymentNoticeWhatsAppKind("UPDATED", "2026-12-10"),
    "PAYMENT_UPDATED_WHATSAPP_20261210",
  );
  assertEquals(
    paymentNoticeWhatsAppKind("D10", "2026-12-10"),
    "PAYMENT_DUE_REMINDER_D10_20261210",
  );
  assertEquals(
    paymentNoticeWhatsAppKind("D0", "2026-12-10"),
    "PAYMENT_DUE_REMINDER_D0_20261210",
  );
  for (const stage of ["CREATED", "UPDATED", "D10", "D0"] as const) {
    const kind = paymentNoticeWhatsAppKind(stage, "2026-12-10");
    assert(/^[A-Z0-9_]{1,80}$/.test(kind), kind);
  }
  assertThrows(() => paymentNoticeWhatsAppKind("D0", "10/12/2026"));
  assertEquals(paymentNoticeEmailKind("D0"), "PAYMENT_DUE_REMINDER_D0_EMAIL");
});

Deno.test("D0 message carries digitable line and Pix when available", () => {
  const msg = buildPaymentNoticeMessage({
    stage: "D0",
    name: "Maria",
    brandName: "Wise Wolf",
    value: 187,
    dueDate: "2026-12-10",
    invoiceUrl: "https://www.asaas.com/i/fixture",
    digitableLine: LINE,
    pixCopyPaste: PIX,
  });
  assertStringIncludes(msg.whatsapp, "*hoje*");
  assertStringIncludes(msg.whatsapp, "*R$ 187,00*");
  assertStringIncludes(msg.whatsapp, "https://www.asaas.com/i/fixture");
  assertStringIncludes(msg.whatsapp, LINE);
  assertStringIncludes(msg.whatsapp, PIX);
  assert(
    !msg.email.includes("*R$") && !msg.email.includes("*hoje*"),
    "e-mail é texto puro",
  );
  assertStringIncludes(msg.email, LINE);
  assertStringIncludes(msg.subject, "vence hoje");
});

Deno.test("D0 falls back to the invoice link when line/Pix are missing or malformed", () => {
  for (
    const extras of [
      { digitableLine: null, pixCopyPaste: null },
      { digitableLine: "123", pixCopyPaste: "not-a-pix" },
      { digitableLine: `${LINE}\n<script>`, pixCopyPaste: `${PIX}\u0000` },
    ]
  ) {
    const msg = buildPaymentNoticeMessage({
      stage: "D0",
      name: "Maria",
      brandName: "Wise Wolf",
      value: 187,
      dueDate: "2026-12-10",
      invoiceUrl: "https://www.asaas.com/i/fixture",
      ...extras,
    });
    assertStringIncludes(
      msg.whatsapp,
      "Pague pelo link: https://www.asaas.com/i/fixture",
    );
    assert(!msg.whatsapp.includes("Linha digitável"));
    assert(!msg.whatsapp.includes("Pix copia e cola"));
  }
  assertEquals(normalizeDigitableLine(` ${LINE} `), LINE);
  assertEquals(normalizePixCopyPaste(PIX), PIX);
});

Deno.test("only D0 carries payment codes; other stages keep the link and their own wording", () => {
  const base = {
    name: "Maria",
    brandName: "Wise Wolf",
    value: 99.9,
    dueDate: "2026-12-10",
    invoiceUrl: "https://www.asaas.com/i/fixture",
    digitableLine: LINE,
    pixCopyPaste: PIX,
  };
  const created = buildPaymentNoticeMessage({ ...base, stage: "CREATED" });
  assertStringIncludes(created.whatsapp, "nova mensalidade");
  assertStringIncludes(created.whatsapp, "*R$ 99,90*");
  assertStringIncludes(created.whatsapp, "*10/12/2026*");
  assert(!created.whatsapp.includes(LINE));
  const updated = buildPaymentNoticeMessage({ ...base, stage: "UPDATED" });
  assertStringIncludes(updated.whatsapp, "novo vencimento");
  const d10 = buildPaymentNoticeMessage({ ...base, stage: "D10" });
  assertStringIncludes(d10.whatsapp, "daqui a 10 dias");
  for (const m of [created, updated, d10]) {
    assert(!/negativa|judicial|suspens/.test(m.whatsapp));
  }
  // Nome/brand com quebra de linha ou markdown não injeta formatação.
  const weird = buildPaymentNoticeMessage({
    ...base,
    stage: "CREATED",
    name: "*Maria*\nX",
  });
  assert(weird.whatsapp.startsWith("Oi Maria  X! "));
});

Deno.test("receipt URL is accepted only from the Asaas production host", () => {
  assertEquals(
    validReceiptUrl("https://www.asaas.com/comprovantes/123"),
    "https://www.asaas.com/comprovantes/123",
  );
  assert(validReceiptUrl("https://asaas.com/comprovantes/123"));
  for (
    const bad of [
      "http://www.asaas.com/comprovantes/123",
      "https://sandbox.asaas.com/comprovantes/123",
      "https://asaas.com.evil.invalid/c",
      "https://user:pass@www.asaas.com/c",
      "javascript:alert(1)",
      "",
      null,
      42,
    ]
  ) assertEquals(validReceiptUrl(bad), null, String(bad));
  assertEquals(receiptSuffix("https://evil.invalid/x"), "");
  assertEquals(
    receiptSuffix("https://www.asaas.com/comprovantes/1"),
    "\n\nComprovante: https://www.asaas.com/comprovantes/1",
  );
  const mail = buildPaymentReceiptEmail({
    name: "Maria",
    brandName: "Wise Wolf",
    value: 187,
    dueDate: "2026-12-10",
    receiptUrl: "https://sandbox.asaas.com/comprovantes/1",
  });
  assert(!mail.text.includes("Comprovante"));
  assertStringIncludes(mail.text, "R$ 187,00");
});

const decisionBase: Parameters<typeof paymentNoticeEnqueueDecision>[0] = {
  event: "PAYMENT_CREATED",
  paymentId: "local-1",
  providerStatus: "PENDING",
  localStatus: "PENDING",
  paymentType: "SUBSCRIPTION",
  billingType: "BOLETO",
  dueDate: "2026-12-10",
  previousDueDate: null,
  today: "2026-11-19",
  value: 187,
  deleted: false,
  isTestAccount: false,
};

Deno.test("webhook enqueues PAYMENT_CREATED once per invoice for a pending student charge", () => {
  const d = paymentNoticeEnqueueDecision(decisionBase);
  assertEquals(d.enqueue, true);
  assertEquals(d.kind, "PAYMENT_CREATED");
  assertEquals(d.idempotencyKey, "payment-notice:created:local-1");
  assertEquals(d.dueDateChanged, false);
  assert(
    paymentNoticeEnqueueDecision({ ...decisionBase, dueDate: "2026-11-19" })
      .enqueue,
  );
  assert(
    paymentNoticeEnqueueDecision({ ...decisionBase, paymentType: "PRO_RATA" })
      .enqueue,
  );
});

Deno.test("webhook never enqueues for paid, card, enrollment, fixture, deleted or overdue charges", () => {
  const blocked: Array<[Partial<typeof decisionBase>, string]> = [
    [{ event: "PAYMENT_RECEIVED" }, "event_not_notified"],
    [{ event: "PAYMENT_OVERDUE" }, "event_not_notified"],
    [{ providerStatus: "RECEIVED" }, "provider_not_pending"],
    [{ localStatus: "RECEIVED" }, "local_not_pending"],
    [{ localStatus: null }, "local_not_pending"],
    [{ billingType: "CREDIT_CARD" }, "card_automatic"],
    [{ paymentType: "ENROLLMENT" }, "payment_type_not_notified"],
    [{ paymentType: "REFUND" }, "payment_type_not_notified"],
    [{ isTestAccount: true }, "test_account"],
    [{ deleted: true }, "payment_deleted"],
    [{ dueDate: "2026-11-18" }, "already_overdue"],
    [{ value: 0 }, "value_invalid"],
  ];
  for (const [change, reason] of blocked) {
    const d = paymentNoticeEnqueueDecision({ ...decisionBase, ...change });
    assertEquals(d.enqueue, false, reason);
    assertEquals(d.reason, reason);
  }
});

Deno.test("PAYMENT_UPDATED enqueues only when the due date changed, keyed by the new date", () => {
  const same = paymentNoticeEnqueueDecision({
    ...decisionBase,
    event: "PAYMENT_UPDATED",
    previousDueDate: "2026-12-10",
  });
  assertEquals(same.enqueue, false);
  assertEquals(same.reason, "updated_without_due_date_change");
  const unknownPrevious = paymentNoticeEnqueueDecision({
    ...decisionBase,
    event: "PAYMENT_UPDATED",
  });
  assertEquals(unknownPrevious.enqueue, false);
  const moved = paymentNoticeEnqueueDecision({
    ...decisionBase,
    event: "PAYMENT_UPDATED",
    previousDueDate: "2026-12-05",
  });
  assertEquals(moved.enqueue, true);
  assertEquals(moved.kind, "PAYMENT_UPDATED");
  assertEquals(moved.dueDateChanged, true);
  assertEquals(
    moved.idempotencyKey,
    "payment-notice:updated:local-1:2026-12-10",
  );
});

Deno.test("provider re-read must still be the same pending, non-card invoice with an Asaas link", () => {
  const local = {
    asaas_payment_id: "pay_1",
    due_date: "2026-12-10",
    value: 187,
  };
  const provider = {
    id: "pay_1",
    status: "PENDING",
    dueDate: "2026-12-10",
    value: 187,
    billingType: "BOLETO",
    invoiceUrl: "https://www.asaas.com/i/pay_1",
    transactionReceiptUrl: null,
    customer: "cus_1",
    subscription: "sub_1",
    deleted: false,
  };
  assertEquals(noticeProviderEligible(local, provider).ok, true);
  for (
    const [change, reason] of [
      [{ status: "RECEIVED" }, "provider_not_pending"],
      [{ deleted: true }, "provider_not_pending"],
      [{ id: "pay_2" }, "provider_mismatch"],
      [{ dueDate: "2026-12-11" }, "provider_due_changed"],
      [{ value: 190 }, "provider_value_changed"],
      [{ billingType: "CREDIT_CARD" }, "card_automatic"],
      [
        { invoiceUrl: "https://sandbox.asaas.com/i/x" },
        "invoice_link_unavailable",
      ],
      [{ invoiceUrl: null }, "invoice_link_unavailable"],
    ] as const
  ) {
    const result = noticeProviderEligible(local, { ...provider, ...change });
    assertEquals(result.ok, false);
    assertEquals(result.reason, reason);
  }
  assertEquals(d0ExtrasToRead("BOLETO"), { boleto: true, pix: true });
  assertEquals(d0ExtrasToRead("UNDEFINED"), { boleto: true, pix: true });
  assertEquals(d0ExtrasToRead("PIX"), { boleto: false, pix: true });
  assertEquals(d0ExtrasToRead("CREDIT_CARD"), { boleto: false, pix: false });
});
