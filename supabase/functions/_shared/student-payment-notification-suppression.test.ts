/// <reference lib="deno.ns" />

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function source(relativePath: string): Promise<string> {
  return await Deno.readTextFile(new URL(relativePath, import.meta.url));
}

function assertIncludes(haystack: string, needle: string, context: string) {
  assert(haystack.includes(needle), `${context}: missing ${needle}`);
}

function assertOrdered(
  haystack: string,
  needles: string[],
  context: string,
) {
  let cursor = -1;
  for (const needle of needles) {
    const next = haystack.indexOf(needle, cursor + 1);
    assert(next > cursor, `${context}: ${needle} is missing or out of order`);
    cursor = next;
  }
}

Deno.test("exact payment policy covers every current Wise Wolf external channel", async () => {
  const migration = await source(
    "../../migrations/20260901171000_suppress_one_off_student_payment_notifications.sql",
  );

  for (
    const kind of [
      "MANUAL_PIX_CREATED",
      "PAYMENT_CONFIRMED_CAPI",
      "PAYMENT_CONFIRMED_WHATSAPP",
      "PAYMENT_DUE_REMINDER",
      "PAYMENT_OVERDUE_3",
      "PAYMENT_OVERDUE_10",
      "PAYMENT_OVERDUE_20",
      "PAYMENT_SPLIT",
      "PAYMENT_RECEIVED",
    ]
  ) {
    assertIncludes(migration, `'${kind}'`, "suppression kind allowlist");
  }

  for (
    const trigger of [
      "suppress_exact_student_payment_outbound_attempt",
      "suppress_exact_student_payment_queue_notification",
      "suppress_exact_management_payment_notification",
    ]
  ) {
    assertIncludes(migration, trigger, "durable database boundary");
  }

  assertIncludes(
    migration,
    "submit_attempt_count <> 0",
    "pre-provider validation",
  );
  assertIncludes(
    migration,
    "provider_entity_id is not null",
    "pre-provider validation",
  );
  assertIncludes(migration, "submitted_at is not null", "pre-provider validation");
  assertIncludes(migration, "raise exception", "fail-closed boundary");

  // Matching is only by the exact provider/local/externalReference identities.
  // Due date is validated when the policy is created, but is intentionally not
  // a resolver fallback that could mute October for the same student.
  const resolver = migration.slice(
    migration.indexOf("create or replace function private.student_payment_notification_suppression_id"),
    migration.indexOf("create or replace function private.suppress_student_payment_outbound_attempt"),
  );
  assert(!resolver.includes("suppression.due_date"), "resolver falls back to due date");
  assertIncludes(resolver, "creation.provider_entity_id", "provider identity resolver");
  assertIncludes(resolver, "payment.asaas_payment_id", "local identity resolver");
  assertIncludes(resolver, "externalReference", "webhook-race resolver");

  // The policy affects Wise Wolf delivery attempts only. It must never mutate
  // Asaas customer notification settings or a subscription.
  for (
    const forbidden of [
      "customerNotificationDisabled",
      "notificationDisabled",
      "update_asaas_subscription",
      "/subscriptions/",
    ]
  ) {
    assert(!migration.includes(forbidden), `provider settings affected: ${forbidden}`);
  }
});

Deno.test("all payment producers cross a durable fence before provider POST", async () => {
  const manualPix = await source("../generate-student-manual-pix/index.ts");
  const manualSegment = manualPix.slice(
    manualPix.indexOf('notificationKind: "MANUAL_PIX_CREATED"'),
  );
  assertOrdered(
    manualSegment,
    [
      'notificationKind: "MANUAL_PIX_CREATED"',
      "markOutboundMessageSubmitting",
      "sendWhatsapp",
    ],
    "manual PIX WhatsApp",
  );

  const webhook = await source("../asaas-webhook/index.ts");
  const capi = webhook.slice(webhook.indexOf("async function deliverMetaPurchaseOnce"));
  assertOrdered(
    capi,
    [
      'notificationKind: "PAYMENT_CONFIRMED_CAPI"',
      "markOutboundMessageSubmittingDecision",
      "sendMetaCapiEvent",
    ],
    "payment confirmation CAPI",
  );
  assertIncludes(
    webhook,
    'notification_kind: "PAYMENT_CONFIRMED"',
    "raw confirmation queue producer",
  );

  const queue = await source("../process-notification-queue/index.ts");
  const queueSegment = queue.slice(
    queue.indexOf('notificationKind: "PAYMENT_CONFIRMED_WHATSAPP"'),
  );
  assertOrdered(
    queueSegment,
    [
      'notificationKind: "PAYMENT_CONFIRMED_WHATSAPP"',
      "beginPaymentConfirmationSubmission",
      "sendWhatsTextToResolvedDestinationDetailed",
    ],
    "queued payment confirmation WhatsApp",
  );

  const due = await source("../notify-payment-due/index.ts");
  const dueSegment = due.slice(due.indexOf("async function deliverPaymentNotification"));
  assertOrdered(
    dueSegment,
    [
      "claimOutboundMessage",
      "markOutboundMessageSubmittingDecision",
      "sendWhatsTextDetailed",
    ],
    "due and overdue WhatsApp",
  );
  const dueCore = await source("../notify-payment-due/core.ts");
  for (const kind of ["PAYMENT_OVERDUE_3", "PAYMENT_OVERDUE_10", "PAYMENT_OVERDUE_20"]) {
    assertIncludes(dueCore, kind, "overdue notification producer");
  }

  const management = await source("../payment-split-notify/index.ts");
  const managementSegment = management.slice(
    management.indexOf("claimManagementPaymentNotification"),
  );
  assertOrdered(
    managementSegment,
    [
      "claimManagementPaymentNotification",
      "authorizeManagementPaymentNotificationSubmission",
      "sendWhatsTextToResolvedDestinationDetailed",
    ],
    "management payment WhatsApp",
  );
});
