/// <reference lib="deno.ns" />

import {
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const migration = await Deno.readTextFile(
  new URL(
    "../../migrations/20260830170000_fence_whatsapp_occurrence_receipts.sql",
    import.meta.url,
  ),
);

Deno.test("queue worker seals delivery before its only provider POST", () => {
  const genericFence = source.lastIndexOf("beginNotificationSubmission(");
  const paymentFence = source.lastIndexOf(
    "beginPaymentConfirmationSubmission(",
  );
  const jidLookup = source.lastIndexOf("resolveWhatsAppDestination({");
  const send = source.indexOf(
    "const providerResult = await sendWhatsTextToResolvedDestinationDetailed(",
  );
  const paymentFinish = source.lastIndexOf(
    "finalizePaymentConfirmationSubmission(",
  );

  assert(jidLookup >= 0 && jidLookup < genericFence);
  assert(jidLookup < paymentFence);
  assert(genericFence >= 0 && genericFence < send);
  assert(paymentFence >= 0 && paymentFence < send);
  assert(send >= 0 && send < paymentFinish);
  assert(
    !source.includes('.from("automation_sent").insert(') &&
      !source.includes('.from("automation_sent").delete()'),
    "occurrence receipts must be managed atomically by the database fence",
  );
});

Deno.test("payment and lesson transitions use purpose-built atomic bridges", () => {
  assertStringIncludes(
    source,
    '"begin_payment_confirmation_delivery_submission"',
  );
  assertStringIncludes(source, '"finalize_payment_confirmation_delivery"');
  assertStringIncludes(source, '"begin_notification_delivery_submission"');
  assertStringIncludes(source, '"recover_notification_delivery_submission"');
  assertStringIncludes(source, "{ p_limit: 5, p_lease_seconds: 300 }");
  assertStringIncludes(migration, "receipt_state = 'SEALED'");
  assertStringIncludes(migration, "notification_provider_binding_changed");
  assertStringIncludes(migration, "notification_queue_sync_lesson_receipt");
  assertStringIncludes(migration, "lesson_authorized_snapshot_changed");
  assertStringIncludes(
    migration,
    "notification_kind_canonical_collision_groups",
  );
  assertStringIncludes(
    migration,
    "provider_destination = v_provider_destination",
  );
  assertStringIncludes(migration.toLowerCase(), "for update");
});
