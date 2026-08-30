/// <reference lib="deno.ns" />

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const source = await Deno.readTextFile(
  new URL("./index.ts", import.meta.url),
);

Deno.test("payment reminders fence every irreversible send in durable order", () => {
  const helperStart = source.indexOf(
    "async function deliverPaymentNotification",
  );
  const helperEnd = source.indexOf("\nasync function", helperStart + 20);
  const helper = source.slice(
    helperStart,
    helperEnd === -1 ? source.length : helperEnd,
  );
  const claim = helper.indexOf("claimOutboundMessage(");
  const mark = helper.indexOf("markOutboundMessageSubmittingDecision(");
  const send = helper.indexOf("sendWhatsTextDetailed(");
  const finish = helper.indexOf("finishOutboundMessage(");

  assert(helperStart >= 0, "durable delivery helper is required");
  assert(claim >= 0 && claim < mark, "claim must precede mark");
  assert(mark < send, "SUBMITTING must be durable before provider POST");
  assert(send < finish, "provider outcome must be durably finished");
  assertEquals((helper.match(/sendWhatsTextDetailed\(/g) || []).length, 1);
});

Deno.test("payment reminder scope is exact and test accounts are suppressed", () => {
  assert(source.includes('.eq("tenant_id", charge.tenant_id)'));
  assert(source.includes('.eq("role", "STUDENT")'));
  assert(source.includes("student?.is_test_account === true"));
  assert(
    source.includes("guardian_id, guardian_cpf, guardian_name, guardian_phone"),
  );
  assert(source.includes("resolvePaymentRecipient(student)"));
  assert(source.includes('notificationKind: "PAYMENT_DUE_REMINDER"'));
  assert(source.includes("notificationKind: kind"));
});

Deno.test("legacy markers are repaired only after durable SENT", () => {
  assert(source.includes('delivery.status === "SENT"'));
  assert(!source.includes('automation_sent").delete()'));
  assert(
    !source.includes(
      'due_reminder_sent_at: new Date().toISOString() }).eq("id", id)',
    ),
  );
});
