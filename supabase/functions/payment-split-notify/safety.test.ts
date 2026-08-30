/// <reference lib="deno.ns" />

import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

const source = await Deno.readTextFile(
  new URL("./index.ts", import.meta.url),
);

Deno.test("payment notifications consume only the transactional outbox", () => {
  assert(source.includes('"management_payment_notification_pending"'));
  assert(source.includes("management_notification_payment_id"));
  assert(!source.includes('supabase.rpc("payment_split_pending")'));
  assert(
    !source.includes('supabase.rpc("management_payment_confirmation_pending")'),
  );
});

Deno.test("split and simple confirmation share one submit-once fence", () => {
  const claim = source.indexOf("claimManagementPaymentNotification(");
  const sourceSnapshot = source.indexOf(
    "loadManagementPaymentNotificationSource(",
    claim,
  );
  const begin = source.indexOf(
    "beginManagementPaymentNotificationSubmission(",
    sourceSnapshot,
  );
  const credentialResolve = source.indexOf(
    "resolveEvolutionIntegration(",
    begin,
  );
  const authorize = source.indexOf(
    "authorizeManagementPaymentNotificationSubmission(",
    credentialResolve,
  );
  const send = source.indexOf(
    "sendWhatsTextToResolvedDestinationDetailed(",
    authorize,
  );
  const finish = source.indexOf(
    "finishManagementPaymentNotification(",
    send,
  );
  assert(claim >= 0, "durable outbox claim is required");
  assert(claim < sourceSnapshot, "claim must precede canonical source read");
  assert(sourceSnapshot < begin, "source must precede the PREPARED fence");
  assert(
    begin < credentialResolve,
    "provider endpoint/credential was resolved before PREPARED",
  );
  assert(
    credentialResolve < authorize,
    "fresh provider config must precede provider authorization",
  );
  assert(authorize < send, "sealed SUBMITTING must immediately precede POST");
  assert(send < finish, "provider outcome must be durably finished");
  const finalFenceToPost = source.slice(authorize, send);
  assert(
    !finalFenceToPost.includes("await supabase.") &&
      !finalFenceToPost.includes("resolveEvolutionIntegration(") &&
      !finalFenceToPost.includes("resolveWhatsAppDestination("),
    "mutable provider lookup was inserted after the final database fence",
  );
  assert(!source.includes("processPaymentConfirmation("));
});

Deno.test("the provider POST uses only sealed destination, instance and body", () => {
  const send = source.indexOf(
    "sendWhatsTextToResolvedDestinationDetailed(",
  );
  const finish = source.indexOf("managementPaymentNotificationFinish(", send);
  const providerBlock = source.slice(send, finish);
  assert(providerBlock.includes("authorization.provider_instance_name"));
  assert(providerBlock.includes("authorization.provider_destination"));
  assert(providerBlock.includes("authorization.message_body"));
  assert(!providerBlock.includes("resolveWhatsAppDestination"));
});

Deno.test("management route requires authenticated provider receipts", () => {
  assert(source.includes("requireDeliveryReceipts: true"));
});

Deno.test("test fixtures are rejected again before message construction", () => {
  assert(source.includes("sourceSnapshot.is_test_fixture === true"));
});
