/// <reference lib="deno.ns" />

import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

const source = await Deno.readTextFile(
  new URL("./index.ts", import.meta.url),
);

Deno.test("payment split persists claim, SUBMITTING and outcome around one POST", () => {
  const claim = source.indexOf("claimPaymentSplitMessage(");
  const mark = source.indexOf("markPaymentSplitMessageSubmitting(", claim);
  const send = source.indexOf("sendWhatsTextDetailed(", mark);
  const finish = source.indexOf("finishPaymentSplitMessage(", send);
  assert(claim >= 0, "durable claim is required");
  assert(claim < mark, "claim must precede SUBMITTING");
  assert(mark < send, "SUBMITTING must precede provider POST");
  assert(send < finish, "provider outcome must be durably finished");
  assert(!source.includes('.from("automation_sent").delete()'));
});

Deno.test("payment split resolves a tenant-scoped integration before fencing", () => {
  const integration = source.indexOf("resolveEvolutionIntegration(");
  const claim = source.indexOf("claimPaymentSplitMessage(");
  assert(integration >= 0 && integration < claim);
  assert(source.includes('tenantId,\n          "message.send_text"'));
});

Deno.test("payment split trusts legacy sent markers before creating a new claim", () => {
  const legacy = source.indexOf("const { data: legacySent");
  const claim = source.indexOf("claimPaymentSplitMessage(");
  assert(legacy >= 0 && legacy < claim);
  assert(source.includes("if (legacySent)"));
});
