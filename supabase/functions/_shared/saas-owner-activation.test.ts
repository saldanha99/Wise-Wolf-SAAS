import {
  activationFailureStatus,
  claimSaasOwnerActivation,
  classifySaasOwnerActivationIdentity,
  repairSaasOwnerAccess,
  stageSaasOwnerActivationPayload,
  submitSaasOwnerActivationOnce,
  suppressSaasOwnerActivation,
} from "./saas-owner-activation.ts";
import {
  AccountActivationProviderError,
  preparedAccountActivationFromStoredPayload,
  resendErrorCode,
  sendPreparedAccountActivation,
} from "./account-invite.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("activation delivery classifies known pre-submit and HTTP rejection failures", () => {
  assert(
    activationFailureStatus(new Error("RESEND_API_KEY is unavailable")) ===
      "FAILED",
    "missing provider configuration should be a known failure",
  );
  assert(
    activationFailureStatus(
      new Error("Activation email failed with status 422"),
    ) === "FAILED",
    "provider 4xx should be a known failure",
  );
  assert(
    activationFailureStatus(new TypeError("connection reset")) === "UNKNOWN",
    "network outcome must remain ambiguous",
  );
  assert(
    activationFailureStatus(
      new Error("Activation email failed with status 503"),
    ) === "UNKNOWN",
    "provider 5xx must remain ambiguous",
  );
  for (const status of [408, 425, 429, 500, 503]) {
    assert(
      activationFailureStatus(
        new AccountActivationProviderError(status, ""),
      ) === "UNKNOWN",
      `provider status ${status} must remain ambiguous`,
    );
  }
  assert(
    activationFailureStatus(
      new AccountActivationProviderError(
        409,
        "invalid_idempotent_request",
      ),
    ) === "FAILED",
    "different-payload idempotency corruption must fail closed",
  );
  assert(
    activationFailureStatus(
      new AccountActivationProviderError(409, ""),
    ) === "UNKNOWN",
    "unparseable 409 response must remain ambiguous",
  );
});

Deno.test("activation claim preserves the exact generated fencing token", async () => {
  let observedToken = "";
  const admin = {
    rpc(name: string, args: Record<string, unknown>) {
      assert(name === "claim_saas_owner_activation", "unexpected RPC");
      observedToken = String(args.p_claim_token || "");
      return Promise.resolve({
        data: {
          ok: true,
          action: "SUBMIT_ONCE",
          claim_token: observedToken,
        },
        error: null,
      });
    },
  };

  const claim = await claimSaasOwnerActivation(admin as never, {
    checkoutId: "00000000-0000-4000-8000-00000000a001",
    tenantId: "tenant-a",
    ownerEmail: "owner@example.invalid",
  });
  assert(claim.action === "SUBMIT_ONCE", "claim was not accepted");
  assert(claim.claimToken === observedToken, "claim token drifted");
  assert(observedToken.length > 20, "claim token was not generated");
});

Deno.test("activation claim accepts a provider-idempotent recovery token", async () => {
  let observedToken = "";
  const admin = {
    rpc(_name: string, args: Record<string, unknown>) {
      observedToken = String(args.p_claim_token || "");
      return Promise.resolve({
        data: {
          ok: true,
          action: "RESUME_IDEMPOTENT",
          claim_token: observedToken,
          provider_payload: '  {"exact":true}  ',
        },
        error: null,
      });
    },
  };

  const claim = await claimSaasOwnerActivation(admin as never, {
    checkoutId: "00000000-0000-4000-8000-00000000a013",
    tenantId: "tenant-a",
    ownerEmail: "owner@example.invalid",
  });
  assert(
    claim.action === "RESUME_IDEMPOTENT" &&
      claim.claimToken === observedToken &&
      claim.providerPayload === '  {"exact":true}  ',
    "idempotent recovery claim was rejected",
  );
});

Deno.test("Resend conflict parser only recognizes explicit provider codes", () => {
  assert(
    resendErrorCode({ name: "invalid_idempotent_request" }) ===
      "invalid_idempotent_request",
    "documented idempotency conflict was not recognized",
  );
  assert(
    resendErrorCode({ message: "same key" }) === "",
    "free-form provider text was trusted as an idempotency proof",
  );
});

Deno.test("stored activation recovery preserves the exact staged provider body", () => {
  const previousKey = Deno.env.get("RESEND_API_KEY");
  Deno.env.set("RESEND_API_KEY", "test-key");
  try {
    const payload =
      ` {"from":"Wise Wolf <test@example.invalid>","to":["owner@example.invalid"],"subject":"Ative seu acesso à Wise Wolf","html":"<a>token</a>"} `;
    const prepared = preparedAccountActivationFromStoredPayload({
      payload,
      expectedEmail: "OWNER@example.invalid",
      idempotencyKey: "saas-owner-activation/checkout-a",
    });
    assert(
      prepared.payload === payload,
      "staged payload bytes drifted on retry",
    );
    assert(
      prepared.idempotencyKey === "saas-owner-activation/checkout-a",
      "staged payload lost its stable provider key",
    );
  } finally {
    if (previousKey === undefined) Deno.env.delete("RESEND_API_KEY");
    else Deno.env.set("RESEND_API_KEY", previousKey);
  }
});

Deno.test("identity disposition maps checkout-bound and dormant owner identities", async () => {
  const admin = {
    rpc(name: string, args: Record<string, unknown>) {
      assert(
        name === "classify_saas_owner_activation_identity",
        "unexpected RPC",
      );
      if (args.p_claim_token === "claim-checkout-identity") {
        return Promise.resolve({
          data: { ok: true, action: "CHECKOUT_IDENTITY" },
          error: null,
        });
      }
      if (args.p_claim_token === "claim-dormant-identity") {
        return Promise.resolve({
          data: { ok: true, action: "DORMANT_CHECKOUT_IDENTITY" },
          error: null,
        });
      }
      if (args.p_claim_token === "claim-existing-account") {
        return Promise.resolve({
          data: { ok: true, action: "EXISTING_ACCOUNT" },
          error: null,
        });
      }
      if (args.p_claim_token === "claim-not-required") {
        return Promise.resolve({
          data: { ok: true, action: "NOT_REQUIRED" },
          error: null,
        });
      }
      return Promise.resolve({
        data: { ok: false, action: "REVIEW_REQUIRED", reason: "invalid" },
        error: null,
      });
    },
  };
  const checkoutIdentity = await classifySaasOwnerActivationIdentity(
    admin as never,
    {
      checkoutId: "checkout-a",
      claimToken: "claim-checkout-identity",
      ownerUserId: "owner-a",
    },
  );
  const dormantIdentity = await classifySaasOwnerActivationIdentity(
    admin as never,
    {
      checkoutId: "checkout-a",
      claimToken: "claim-dormant-identity",
      ownerUserId: "owner-a",
    },
  );
  const existingIdentity = await classifySaasOwnerActivationIdentity(
    admin as never,
    {
      checkoutId: "checkout-a",
      claimToken: "claim-existing-account",
      ownerUserId: "owner-a",
    },
  );
  const notRequiredIdentity = await classifySaasOwnerActivationIdentity(
    admin as never,
    {
      checkoutId: "checkout-a",
      claimToken: "claim-not-required",
      ownerUserId: "owner-a",
    },
  );
  assert(
    checkoutIdentity === "CHECKOUT_IDENTITY",
    "checkout-owned identity was misclassified",
  );
  assert(
    dormantIdentity === "DORMANT_CHECKOUT_IDENTITY",
    "dormant checkout identity was misclassified",
  );
  assert(
    existingIdentity === "EXISTING_ACCOUNT",
    "an existing operational account was misclassified",
  );
  assert(
    notRequiredIdentity === "NOT_REQUIRED",
    "non-operational checkout identity was misclassified",
  );
  let reviewRejected = false;
  try {
    await classifySaasOwnerActivationIdentity(admin as never, {
      checkoutId: "checkout-a",
      claimToken: "claim-review-required",
      ownerUserId: "owner-a",
    });
  } catch (error) {
    reviewRejected = error instanceof Error &&
      error.message === "saas_owner_identity_classification_invalid";
  }
  assert(reviewRejected, "identity review fallback was not surfaced");
});

Deno.test("payload staging binds checkout, claim, identity and exact body", async () => {
  const observed: Record<string, unknown> = {};
  const admin = {
    rpc(name: string, args: Record<string, unknown>) {
      assert(name === "stage_saas_owner_activation_payload", "unexpected RPC");
      Object.assign(observed, args);
      return Promise.resolve({
        data: { ok: true, action: "STAGED" },
        error: null,
      });
    },
  };
  const payload = '{"exact":true}';
  const result = await stageSaasOwnerActivationPayload(admin as never, {
    checkoutId: "checkout-a",
    claimToken: "claim-a",
    ownerUserId: "owner-a",
    providerPayload: payload,
  });
  assert(result === "STAGED", "staging result drifted");
  assert(observed.p_provider_payload === payload, "payload was reserialized");
  assert(observed.p_owner_user_id === "owner-a", "identity was not bound");
});

Deno.test("existing-account suppression and terminal access repair use fenced RPCs", async () => {
  const calls: string[] = [];
  const admin = {
    rpc(name: string) {
      calls.push(name);
      return Promise.resolve({
        data: name === "suppress_saas_owner_activation"
          ? { ok: true, action: "SUPPRESSED", status: "SUPPRESSED" }
          : { ok: true, action: "REPAIRED", status: "SENT" },
        error: null,
      });
    },
  };
  await suppressSaasOwnerActivation(admin as never, {
    checkoutId: "checkout-a",
    claimToken: "claim-a",
    ownerUserId: "owner-a",
    reason: "existing_owner_account",
  });
  const repaired = await repairSaasOwnerAccess(admin as never, {
    checkoutId: "checkout-a",
    ownerUserId: "owner-a",
  });
  assert(repaired === "REPAIRED", "terminal access was not repaired");
  assert(
    calls.join(",") ===
      "suppress_saas_owner_activation,repair_saas_owner_access",
    "suppression or repair bypassed its database fence",
  );
});

Deno.test("terminal repair preflight distinguishes inactive checkout from missing identity", async () => {
  const admin = {
    rpc(_name: string, args: Record<string, unknown>) {
      return Promise.resolve({
        data: args.p_owner_user_id === null
          ? {
            ok: false,
            action: "REVIEW_REQUIRED",
            reason: "owner_identity_required_for_access_repair",
          }
          : { ok: true, action: "NOT_REQUIRED" },
        error: null,
      });
    },
  };
  const missingIdentity = await repairSaasOwnerAccess(admin as never, {
    checkoutId: "checkout-a",
    ownerUserId: null,
  });
  assert(
    missingIdentity === "IDENTITY_REQUIRED",
    "active paid checkout did not request a replacement auth identity",
  );
  const inactive = await repairSaasOwnerAccess(admin as never, {
    checkoutId: "checkout-a",
    ownerUserId: "owner-a",
  });
  assert(
    inactive === "NOT_REQUIRED",
    "inactive checkout repair did not remain fail closed",
  );

  const cleanupAdmin = {
    rpc() {
      return Promise.resolve({
        data: { ok: true, action: "REPAIRED", status: "FAILED" },
        error: null,
      });
    },
  };
  const cleanup = await repairSaasOwnerAccess(cleanupAdmin as never, {
    checkoutId: "checkout-a",
    ownerUserId: "owner-a",
  });
  assert(cleanup === "REPAIRED", "edge no longer receives cleanup disposition");
});

Deno.test("different-payload idempotency conflict is never accepted as delivery proof", async () => {
  let calls = 0;
  const fetcher = (() => {
    calls += 1;
    return Promise.resolve(
      new Response(
        JSON.stringify({ name: "invalid_idempotent_request" }),
        { status: 409, headers: { "content-type": "application/json" } },
      ),
    );
  }) as typeof fetch;
  let failure: unknown = null;
  try {
    await sendPreparedAccountActivation({
      endpoint: "https://api.resend.com/emails",
      apiKey: "test-key",
      idempotencyKey: "saas-owner-activation/test-checkout",
      payload: JSON.stringify({ to: ["owner@example.invalid"] }),
    }, fetcher);
  } catch (error) {
    failure = error;
  }
  assert(
    failure instanceof AccountActivationProviderError &&
      failure.providerCode === "invalid_idempotent_request" &&
      activationFailureStatus(failure) === "FAILED",
    "different provider payload was mistaken for an accepted activation",
  );
  assert(calls === 1, "idempotent recovery repeated the provider request");
});

Deno.test("concurrent Resend idempotency conflict remains ambiguous", async () => {
  const fetcher = (() =>
    Promise.resolve(
      new Response(
        JSON.stringify({ name: "concurrent_idempotent_requests" }),
        { status: 409, headers: { "content-type": "application/json" } },
      ),
    )) as typeof fetch;
  let rejected = false;
  try {
    await sendPreparedAccountActivation({
      endpoint: "https://api.resend.com/emails",
      apiKey: "test-key",
      idempotencyKey: "saas-owner-activation/test-checkout",
      payload: JSON.stringify({ to: ["owner@example.invalid"] }),
    }, fetcher);
  } catch (error) {
    rejected = error instanceof Error &&
      error.message.includes("concurrent_idempotent_requests");
  }
  assert(rejected, "concurrent provider request was treated as accepted");
});

Deno.test("active activation lease fails closed instead of completing the inbox", async () => {
  const admin = {
    rpc() {
      return Promise.resolve({
        data: { ok: true, action: "IN_PROGRESS", status: "CLAIMED" },
        error: null,
      });
    },
  };
  let rejected = false;
  try {
    await claimSaasOwnerActivation(admin as never, {
      checkoutId: "00000000-0000-4000-8000-00000000a002",
      tenantId: "tenant-a",
      ownerEmail: "owner@example.invalid",
    });
  } catch (error) {
    rejected = error instanceof Error &&
      error.message === "saas_activation_claim_in_progress";
  }
  assert(rejected, "active lease did not fail closed");
});

Deno.test("terminal activation attempt is never claimed for resend", async () => {
  const admin = {
    rpc() {
      return Promise.resolve({
        data: { ok: true, action: "ALREADY_FINAL", status: "UNKNOWN" },
        error: null,
      });
    },
  };
  const claim = await claimSaasOwnerActivation(admin as never, {
    checkoutId: "00000000-0000-4000-8000-00000000a003",
    tenantId: "tenant-a",
    ownerEmail: "owner@example.invalid",
  });
  assert(
    claim.action === "ALREADY_FINAL" && claim.status === "UNKNOWN",
    "terminal attempt became retryable",
  );
});

Deno.test("activation crosses SUBMITTING once before calling the provider", async () => {
  const calls: string[] = [];
  const admin = {
    rpc(name: string, args: Record<string, unknown>) {
      calls.push(name);
      if (name === "mark_saas_owner_activation_submitting") {
        return Promise.resolve({
          data: { ok: true, action: "SUBMIT_ONCE", status: "SUBMITTING" },
          error: null,
        });
      }
      assert(name === "finish_saas_owner_activation", "unexpected RPC");
      assert(args.p_status === "SENT", "success was not finalized as SENT");
      assert(
        args.p_provider_message_id === "email_provider_1",
        "provider message id was not persisted",
      );
      return Promise.resolve({
        data: { ok: true, action: "FINALIZED", status: "SENT" },
        error: null,
      });
    },
  };

  const delivered = await submitSaasOwnerActivationOnce(admin as never, {
    checkoutId: "00000000-0000-4000-8000-00000000a004",
    claimToken: "00000000-0000-4000-8000-00000000a005",
    ownerUserId: "00000000-0000-4000-8000-00000000a006",
    send: async () => {
      calls.push("provider");
      return { providerMessageId: "email_provider_1" };
    },
  });
  assert(delivered.status === "SENT", "delivery did not complete");
  assert(
    calls.join(",") ===
      "mark_saas_owner_activation_submitting,provider,finish_saas_owner_activation",
    "provider call did not stay between durable transitions",
  );
});

Deno.test("ambiguous activation outcome is terminal and recorded once", async () => {
  let providerCalls = 0;
  const admin = {
    rpc(name: string, args: Record<string, unknown>) {
      if (name === "mark_saas_owner_activation_submitting") {
        return Promise.resolve({
          data: { ok: true, action: "SUBMIT_ONCE", status: "SUBMITTING" },
          error: null,
        });
      }
      assert(args.p_status === "UNKNOWN", "network failure was not ambiguous");
      assert(
        String(args.p_last_error).includes("connection reset"),
        "ambiguous reason was not persisted",
      );
      return Promise.resolve({
        data: { ok: true, action: "FINALIZED", status: "UNKNOWN" },
        error: null,
      });
    },
  };

  const delivered = await submitSaasOwnerActivationOnce(admin as never, {
    checkoutId: "00000000-0000-4000-8000-00000000a007",
    claimToken: "00000000-0000-4000-8000-00000000a008",
    ownerUserId: "00000000-0000-4000-8000-00000000a009",
    send: () => {
      providerCalls += 1;
      return Promise.reject(new TypeError("connection reset"));
    },
  });
  assert(delivered.status === "UNKNOWN", "ambiguity was erased");
  assert(providerCalls === 1, "provider was called more than once");
});

Deno.test("suppressed activation never reaches the provider", async () => {
  let providerCalls = 0;
  const admin = {
    rpc(name: string) {
      assert(
        name === "mark_saas_owner_activation_submitting",
        "suppression should stop before finish",
      );
      return Promise.resolve({
        data: {
          ok: false,
          action: "SUPPRESSED",
          reason: "saas_owner_access_not_ready_before_activation",
        },
        error: null,
      });
    },
  };
  const delivered = await submitSaasOwnerActivationOnce(admin as never, {
    checkoutId: "00000000-0000-4000-8000-00000000a010",
    claimToken: "00000000-0000-4000-8000-00000000a011",
    ownerUserId: "00000000-0000-4000-8000-00000000a012",
    send: () => {
      providerCalls += 1;
      return Promise.resolve();
    },
  });
  assert(delivered.status === "SUPPRESSED", "suppression was not surfaced");
  assert(providerCalls === 0, "suppressed delivery reached the provider");
});
