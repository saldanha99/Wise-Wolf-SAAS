function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const processStart = source.indexOf("async function processSaasCheckoutEvent(");
const processEnd = source.indexOf(
  "\nasync function listAllPaymentRefunds(",
  processStart,
);
const processSource = source.slice(processStart, processEnd);

Deno.test("SaaS webhook requires exact provider event identity for ordered apply", () => {
  assert(
    processStart >= 0 && processEnd > processStart,
    "SaaS processor missing",
  );
  assert(
    processSource.includes(
      'const providerEventId = typeof body.id === "string" ? body.id.trim() : "";',
    ),
    "provider event id is not frozen from the webhook envelope",
  );
  assert(
    processSource.includes(
      "const providerEventAt = asaasDateToIso(body.dateCreated);",
    ),
    "provider event creation time is not canonicalized",
  );
  assert(
    processSource.includes("saas_provider_event_ordering_identity_missing"),
    "missing provider order identity does not fail closed",
  );
  assert(
    processSource.includes("p_provider_event_id: providerEventId") &&
      processSource.includes("p_event_created_at: providerEventAt"),
    "ordered SaaS RPC does not receive exact event id/time",
  );
});

Deno.test("SaaS stale and terminal events cannot resume provisioning or activation", () => {
  const applyAt = processSource.indexOf('"apply_saas_checkout_billing_event"');
  const reviewAt = processSource.indexOf(
    'applied.action === "REVIEW_REQUIRED"',
  );
  const staleAt = processSource.indexOf('applied.action === "STALE_IGNORED"');
  const provisionAt = processSource.indexOf(
    'applied.action === "PROVISION_REQUIRED"',
  );
  const activationAt = processSource.indexOf(
    "await resumePendingSaasOwnerActivation(supabase, checkoutId);",
    provisionAt,
  );

  assert(applyAt >= 0, "ordered SaaS apply is missing");
  assert(
    reviewAt > applyAt && staleAt > reviewAt,
    "ordered rejection actions are not handled after apply",
  );
  assert(
    provisionAt > staleAt && activationAt > provisionAt,
    "stale/terminal events can reach provisioning or owner activation",
  );
  assert(
    processSource.includes('applied.action === "STALE_ENTITY_APPLIED"') &&
      processSource.includes('applied.action === "TERMINAL_IGNORED"') &&
      processSource.includes('applied.action === "TERMINAL_REPLAY_IGNORED"'),
    "stale entity or terminal outcomes are not stopped before access effects",
  );
  assert(
    processSource.includes("} else if (PAID_EVENTS.has(event)) {") &&
      processSource.indexOf("} else if (PAID_EVENTS.has(event)) {") <
        activationAt,
    "non-settlement events can resume SaaS owner activation",
  );
  assert(
    processSource.includes("throw new AsaasTriageError(") &&
      processSource.includes("await finishSaasBillingEvent(") &&
      processSource.includes('claim.eventKey, "PROCESSED"'),
    "review/stale outcomes do not have durable inbox dispositions",
  );
});

Deno.test("processed SaaS settlement replay repairs only eligible owner activation", () => {
  const duplicateStart = processSource.indexOf("if (claim.duplicate) {");
  const duplicateEnd = processSource.indexOf("\n  try {", duplicateStart);
  const duplicateSource = processSource.slice(duplicateStart, duplicateEnd);

  assert(
    duplicateStart >= 0 && duplicateEnd > duplicateStart,
    "processed replay branch is missing",
  );
  assert(
    duplicateSource.includes("PAID_EVENTS.has(event)") &&
      duplicateSource.includes('"PROVISIONING"') &&
      duplicateSource.includes('"PROVISIONING_FAILED"') &&
      duplicateSource.includes('"PROVISIONED"') &&
      duplicateSource.includes("checkout.tenant_id.trim()"),
    "processed replay does not require a settled event and eligible checkout",
  );
  assert(
    duplicateSource.includes(
      "await resumePendingSaasOwnerActivation(supabase, checkoutId);",
    ) && duplicateSource.indexOf("await resumePendingSaasOwnerActivation") <
        duplicateSource.lastIndexOf("return true;"),
    "processed replay returns before owner activation recovery",
  );
  assert(
    !duplicateSource.includes("apply_saas_checkout_billing_event") &&
      !duplicateSource.includes("provision_paid_saas_checkout"),
    "processed replay reapplies finance or provisioning",
  );
});
