/// <reference lib="deno.ns" />

// Travas estáticas dos avisos que substituem as notificações pagas do Asaas.

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const read = (path: string) =>
  Deno.readTextFile(new URL(path, import.meta.url));
const migration = await read(
  "../../migrations/20261119120000_avisos_da_escola_no_lugar_do_asaas.sql",
);
const notice = await read("./payment-notice.ts");
const webhook = await read("../asaas-webhook/index.ts");
const queue = await read("../process-notification-queue/index.ts");
const reminders = await read("../notify-payment-due/index.ts");

Deno.test("fence admits the new kinds only for a pending invoice on the right date", () => {
  assertStringIncludes(
    migration,
    "create or replace function public.mark_asaas_outbound_message_submitting(",
  );
  assertStringIncludes(
    migration,
    "attempt_row.notification_kind = 'PAYMENT_CREATED_WHATSAPP'",
  );
  assertStringIncludes(migration, "'^PAYMENT_UPDATED_WHATSAPP_[0-9]{8}$'");
  assertStringIncludes(migration, "'^PAYMENT_DUE_REMINDER_D(10|0)_[0-9]{8}$'");
  assertStringIncludes(
    migration,
    "upper(pg_catalog.btrim(coalesce(source_payment.status, ''))) <> 'PENDING'",
  );
  assertStringIncludes(
    migration,
    "private.student_payment_provider_block_reason(source_payment.id) is not null",
  );
  assertStringIncludes(
    migration,
    "source_payment.due_date <> school_today + 10",
  );
  assertStringIncludes(migration, "source_payment.due_date <> school_today\n");
  assertStringIncludes(
    migration,
    "<> pg_catalog.right(attempt_row.notification_kind, 8)",
  );
  assertStringIncludes(
    migration,
    "payment_notification_invalid := coalesce(payment_notification_invalid, true);",
  );
  // Comunicação desligada na escola também bloqueia os novos avisos.
  assertStringIncludes(
    migration,
    "'PAYMENT_OVERDUE_10', 'PAYMENT_OVERDUE_20'\n  ) or payment_notice_kind then",
  );
  // Os nomes antigos continuam com as mesmas regras.
  assertStringIncludes(
    migration,
    "then source_payment_status not in ('RECEIVED', 'RECEIVED_IN_CASH', 'PAGO')",
  );
  assertStringIncludes(
    migration,
    "when attempt_row.notification_kind = 'PAYMENT_DUE_REMINDER'\n          then source_payment_status <> 'PENDING'",
  );
  assertStringIncludes(
    migration,
    "grant execute on function public.mark_asaas_outbound_message_submitting(uuid, uuid) to service_role;",
  );
});

Deno.test("e-mail intents are unique per invoice/kind/date, private and fenced", () => {
  assertStringIncludes(
    migration,
    "create table if not exists public.payment_notification_email_attempts",
  );
  assertStringIncludes(
    migration,
    "unique (tenant_id, payment_id, kind, ref_date)",
  );
  assertStringIncludes(
    migration,
    "provider_idempotency_key text not null unique",
  );
  for (
    const kind of [
      "PAYMENT_CREATED_EMAIL",
      "PAYMENT_UPDATED_EMAIL",
      "PAYMENT_DUE_REMINDER_D10_EMAIL",
      "PAYMENT_DUE_REMINDER_D0_EMAIL",
      "PAYMENT_RECEIVED_EMAIL",
    ]
  ) assertStringIncludes(migration, `'${kind}'`);
  assertStringIncludes(
    migration,
    "alter table public.payment_notification_email_attempts enable row level security;",
  );
  assertStringIncludes(
    migration,
    "revoke all on public.payment_notification_email_attempts from public, anon, authenticated;",
  );
  assertStringIncludes(
    migration,
    "before insert on public.payment_notification_email_attempts",
  );
  assertStringIncludes(migration, "u.email_confirmed_at is not null");
  assertStringIncludes(migration, "not public.is_student_notifiable(p.id)");
  // Escopo: nada de cron ou outras tabelas nesta migration.
  assert(
    !/cron\.schedule|alter table public\.student_payments/i.test(migration),
  );
});

Deno.test("notice WhatsApp keeps the durable claim → permit → SUBMITTING → POST → finish order", () => {
  const start = notice.indexOf(
    "export async function deliverPaymentNoticeWhatsApp",
  );
  const helper = notice.slice(start);
  const claim = helper.indexOf("claimOutboundMessage(");
  const permit = helper.indexOf("requestOutboundPermit(");
  const mark = helper.indexOf("markOutboundMessageSubmittingDecision(");
  const send = helper.indexOf("sendWhatsTextToResolvedDestinationDetailed(");
  const finish = helper.indexOf("finishOutboundMessage(");
  assert(start >= 0);
  assert(
    claim >= 0 && claim < permit && permit < mark && mark < send &&
      send < finish,
  );
  assertEquals(
    (notice.match(/sendWhatsTextToResolvedDestinationDetailed\(/g) || [])
      .length,
    1,
  );
});

Deno.test("webhook enqueues notices only after the snapshot and adds the Asaas receipt", () => {
  const snapshot = webhook.indexOf("Provider snapshot applied: ${event}");
  const enqueue = webhook.indexOf("await enqueuePaymentNotice(supabase, {");
  assert(snapshot >= 0 && enqueue > snapshot);
  assertStringIncludes(webhook, "receiptSuffix(payment.transactionReceiptUrl)");
  assertStringIncludes(webhook, 'notification_kind: "PAYMENT_RECEIVED_EMAIL"');
  assertStringIncludes(webhook, "localStatus: activeEventLocalStatus");
  assertStringIncludes(webhook, "due_reminder_sent_at: null");
});

Deno.test("queue worker routes notices to their own fence before the generic submission", () => {
  const branch = queue.indexOf(
    "if (isPaymentNoticeQueueKind(notificationKind)) {",
  );
  const generic = queue.indexOf(
    "beginNotificationSubmission(\n          supabaseClient",
  );
  assert(branch >= 0 && generic > branch);
  assertEquals(
    (queue.match(/sendWhatsTextToResolvedDestinationDetailed\(/g) || []).length,
    1, // único POST, do caminho genérico
  );
});

Deno.test("D-10/D0 re-read Asaas before the durable send and record the marker after SENT", () => {
  const start = reminders.indexOf("async function lembretesD10D0(");
  const end = reminders.indexOf("\nasync function", start + 20);
  const fn = reminders.slice(start, end);
  const reread = fn.indexOf("readAsaasNoticePayment(");
  const send = fn.indexOf("deliverPaymentNotification(");
  const marker = fn.indexOf("recordAutomationSent(");
  const email = fn.indexOf("deliverPaymentNoticeEmail(");
  assert(start >= 0);
  assert(reread >= 0 && reread < send && send < marker && marker < email);
  assertStringIncludes(fn, "await aindaEstuda(");
  assertStringIncludes(fn, "collectionBlockReason(");
  assertStringIncludes(fn, "paymentMessagedToday(");
});
