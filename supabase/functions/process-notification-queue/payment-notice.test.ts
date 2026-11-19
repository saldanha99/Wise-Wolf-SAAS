import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isPaymentNoticeQueueKind,
  paymentNoticeQueueOutcome,
  processPaymentNoticeQueueItem,
} from "./payment-notice.ts";

const wa = (
  status: "SENT" | "FAILED" | "UNKNOWN" | "SUPPRESSED" | "SKIPPED",
  retryAfterSeconds = 0,
) => ({ status, sentNow: status === "SENT", reason: "r", retryAfterSeconds });

Deno.test("only the replacement notice kinds take the payment notice branch", () => {
  for (
    const kind of [
      "PAYMENT_CREATED",
      "PAYMENT_UPDATED",
      "PAYMENT_RECEIVED_EMAIL",
    ]
  ) {
    assertEquals(isPaymentNoticeQueueKind(kind), true, kind);
  }
  for (
    const kind of [
      "PAYMENT_CONFIRMED",
      "PAYMENT_CONFIRMED_WHATSAPP",
      "LESSON_REMINDER",
      "payment_created",
    ]
  ) assertEquals(isPaymentNoticeQueueKind(kind), false, kind);
});

Deno.test("queue row never retries an ambiguous or accepted WhatsApp", () => {
  assertEquals(
    paymentNoticeQueueOutcome(wa("SENT"), "", "SENT").queueStatus,
    "skipped",
  );
  assertEquals(
    paymentNoticeQueueOutcome(wa("SUPPRESSED"), "", "SENT").queueStatus,
    "skipped",
  );
  assertEquals(
    paymentNoticeQueueOutcome(wa("UNKNOWN"), "", "SENT").queueStatus,
    "uncertain",
  );
  assertEquals(
    paymentNoticeQueueOutcome(wa("FAILED"), "", "SENT").queueStatus,
    "failed",
  );
  const throttled = paymentNoticeQueueOutcome(wa("SKIPPED", 90), "", "SENT");
  assertEquals(throttled.queueStatus, "deferred");
  assertEquals(throttled.deferSeconds, 90);
  assertEquals(
    paymentNoticeQueueOutcome(wa("SENT"), "", "ALREADY_ATTEMPTED").reason,
    "payment_notice:wa=sent;email=already_attempted",
  );
});

Deno.test("e-mail-only notices map an ambiguous result to uncertain", () => {
  assertEquals(
    paymentNoticeQueueOutcome(null, "email_only", "SENT").queueStatus,
    "skipped",
  );
  assertEquals(
    paymentNoticeQueueOutcome(null, "email_only", "UNKNOWN").queueStatus,
    "uncertain",
  );
  assertEquals(
    paymentNoticeQueueOutcome(null, "email_only", "RESULT_NOT_PERSISTED")
      .queueStatus,
    "uncertain",
  );
  assertEquals(
    paymentNoticeQueueOutcome(null, "email_only", "REJECTED").queueStatus,
    "failed",
  );
  assertEquals(
    paymentNoticeQueueOutcome(null, "conta de teste", "RECIPIENT_UNVERIFIED")
      .queueStatus,
    "skipped",
  );
});

Deno.test("a queue row without its payment binding fails before any lookup", async () => {
  const untouched = new Proxy({}, {
    get() {
      throw new Error("no database access expected");
    },
  });
  const result = await processPaymentNoticeQueueItem(untouched, {
    tenant_id: "t",
    student_id: "s",
    source_id: null,
    class_date: "2026-12-10",
    notification_kind: "PAYMENT_CREATED",
  });
  assertEquals(result.queueStatus, "failed");
  assertEquals(result.reason, "payment_notice_binding_missing");
});

Deno.test("a pending notice whose invoice is no longer pending is skipped without sending", async () => {
  const client = {
    from: (table: string) => {
      if (table !== "student_payments") throw new Error(`unexpected ${table}`);
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () =>
          Promise.resolve({
            data: {
              id: "p",
              tenant_id: "t",
              student_id: "s",
              status: "RECEIVED",
              due_date: "2026-12-10",
              value: 187,
              asaas_payment_id: "pay_1",
              exclusion_reason: null,
              refunded_amount: 0,
            },
            error: null,
          }),
      };
      return chain;
    },
  };
  const result = await processPaymentNoticeQueueItem(client, {
    tenant_id: "t",
    student_id: "s",
    source_id: "p",
    class_date: "2026-12-10",
    notification_kind: "PAYMENT_UPDATED",
  });
  assertEquals(result.queueStatus, "skipped");
  assertEquals(result.reason, "payment_notice_source_changed");
});
