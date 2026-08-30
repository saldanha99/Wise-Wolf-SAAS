function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const ensureStart = source.indexOf("async function ensureSaasOwnerAccess(");
const ensureEnd = source.indexOf("\ntype SaasBillingInboxClaim", ensureStart);
const ensureSource = source.slice(ensureStart, ensureEnd);

Deno.test("SaaS owner activation stages one exact payload before the provider boundary", () => {
  const claimAt = ensureSource.indexOf("claimSaasOwnerActivation(");
  const userCreateAt = ensureSource.indexOf(".createUser({");
  const preflightAt = ensureSource.indexOf("prepareAccountActivation(");
  const stageAt = ensureSource.indexOf("stageSaasOwnerActivationPayload(");
  const submitAt = ensureSource.indexOf("submitSaasOwnerActivationOnce(");
  const providerAt = ensureSource.indexOf("sendPreparedAccountActivation(");

  assert(
    ensureStart >= 0 && ensureEnd > ensureStart,
    "ensure function missing",
  );
  assert(claimAt >= 0, "activation is not durably claimed");
  assert(
    userCreateAt > claimAt,
    "account creation can precede the outbox claim",
  );
  assert(
    preflightAt > userCreateAt,
    "activation preflight does not follow owner access",
  );
  assert(
    stageAt > preflightAt && submitAt > stageAt,
    "exact payload is not staged before SUBMITTING",
  );
  assert(
    ensureSource.includes(
      "`saas-owner-activation/${provisioned.checkout_id}`",
    ) && ensureSource.includes("idempotencyKey,"),
    "Resend request has no stable checkout-scoped idempotency key",
  );
  assert(providerAt > submitAt, "email can bypass the SUBMITTING boundary");
  assert(
    ensureSource.includes("preparedAccountActivationFromStoredPayload({") &&
      ensureSource.includes("payload: activationClaim.providerPayload"),
    "idempotent recovery regenerates or reserializes the recovery link",
  );
  assert(
    ensureSource.includes("classifySaasOwnerActivationIdentity(") &&
      ensureSource.includes("identityDisposition"),
    "identity disposition must be classified before activation branching",
  );
});

Deno.test("existing identities and terminal replays use SQL access fences without direct ACL writes", () => {
  assert(
    ensureSource.includes('.eq("owner_user_id", userId)') &&
      ensureSource.includes('.in("status", [') &&
      ensureSource.includes('"UNKNOWN",') &&
      ensureSource.includes('"SUPPRESSED",'),
    "activation dedupe is not bound to the current auth identity",
  );
  assert(
    ensureSource.includes("suppressSaasOwnerActivation(") &&
      ensureSource.includes('reason: "existing_owner_account"') &&
      ensureSource.includes('reason: "owner_activation_not_required"'),
    "existing-account delivery is not suppressed through the atomic RPC",
  );
  assert(
    ensureSource.includes("repairSaasOwnerAccess(") &&
      ensureSource.includes("ownerUserId: null") &&
      ensureSource.includes('repairPreflight === "NOT_REQUIRED"') &&
      ensureSource.includes('repairPreflight === "REPAIRED"') &&
      ensureSource.includes('repairPreflight !== "IDENTITY_REQUIRED"'),
    "terminal replay cannot repair or triage missing owner access",
  );
  assert(
    ensureSource.includes(
      "const repairResult = await repairSaasOwnerAccess(",
    ) &&
      ensureSource.includes('repairResult === "REPAIRED"') &&
      ensureSource.includes('repairResult === "NOT_REQUIRED"') &&
      ensureSource.includes('case "CHECKOUT_IDENTITY"') &&
      ensureSource.includes('case "DORMANT_CHECKOUT_IDENTITY"') &&
      ensureSource.includes('case "EXISTING_ACCOUNT"') &&
      ensureSource.includes(
        'repairResult === "NOT_REQUIRED" && !createdForCheckout',
      ) &&
      ensureSource.includes("saas_owner_access_repair_identity_conflict"),
    "terminal repair and identity disposition are not fully enforced",
  );
  assert(
    !ensureSource.includes('.from("profiles")') &&
      !ensureSource.includes('.from("tenant_memberships")'),
    "Edge code can mutate owner ACL outside the checkout/tenant lock",
  );
  assert(
    !ensureSource.includes("owner_activation_requires_manual_recovery"),
    "identity handoff from another checkout must never fall back to manual recovery",
  );
});

Deno.test("exact SaaS event replay resumes a claimed activation without resending terminal outcomes", () => {
  assert(
    source.includes("async function resumePendingSaasOwnerActivation("),
    "activation recovery helper is missing",
  );
  assert(
    ["CLAIMED", "SUBMITTING", "UNKNOWN", "SENT", "FAILED", "SUPPRESSED"]
      .every((status) => source.includes(`"${status}",`)),
    "crash/timeout recovery or terminal ACL repair is unreachable",
  );
  assert(
    source.includes('throw new Error("saas_activation_delivery_unknown")'),
    "ambiguous activation delivery can incorrectly complete the billing inbox",
  );
  assert(
    source.includes(
      "await resumePendingSaasOwnerActivation(supabase, checkoutId);",
    ),
    "billing-event replay does not resume the activation outbox",
  );
  assert(
    source.includes(
      '.in("status", ["PAID", "PROVISIONING", "PROVISIONING_FAILED"]);',
    ),
    "a concurrent activation failure can overwrite a provisioned checkout",
  );
  assert(
    !ensureSource.includes('status: "PROVISIONED"'),
    "application code can overwrite a concurrent SaaS refund/cancellation",
  );
});
