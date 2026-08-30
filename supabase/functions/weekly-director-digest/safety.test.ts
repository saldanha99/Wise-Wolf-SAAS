/// <reference lib="deno.ns" />

import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

const source = await Deno.readTextFile(
  new URL("./index.ts", import.meta.url),
);

Deno.test("weekly financial digest fences one provider POST in durable order", () => {
  const claim = source.indexOf("claimFinancialReportMessage(");
  const mark = source.indexOf("markFinancialReportMessageSubmitting(", claim);
  const send = source.indexOf("sendWhatsTextDetailed(", mark);
  const finish = source.indexOf("finishFinancialReportMessage(", send);
  assert(claim >= 0 && claim < mark);
  assert(mark < send);
  assert(send < finish);
  assert(!source.includes("EVOLUTION_API_BASE"));
});

Deno.test("weekly digest trusts historical markers and scopes integration", () => {
  const legacy = source.indexOf("const { data: dup,");
  const claim = source.indexOf("claimFinancialReportMessage(");
  const integration = source.indexOf("resolveEvolutionIntegration(");
  assert(legacy >= 0 && legacy < claim);
  assert(integration >= 0 && integration < claim);
  assert(source.includes('notificationKind: "WEEKLY_DIGEST"'));
});
