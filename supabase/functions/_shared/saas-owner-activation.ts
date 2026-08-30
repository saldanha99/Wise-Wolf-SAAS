/// <reference lib="deno.ns" />

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.93.3";
import { AccountActivationProviderError } from "./account-invite.ts";

type RpcResult = Record<string, unknown>;

export type SaasOwnerActivationClaim =
  | {
    action: "SUBMIT_ONCE";
    claimToken: string;
  }
  | {
    action: "RESUME_IDEMPOTENT";
    claimToken: string;
    providerPayload: string;
  }
  | {
    action: "ALREADY_FINAL";
    status: string;
  };

export type SaasOwnerActivationDelivery = {
  status: "SENT" | "FAILED" | "UNKNOWN" | "SUPPRESSED";
  providerMessageId: string | null;
  error: string | null;
};

export type SaasOwnerActivationIdentityDisposition =
  | "CHECKOUT_IDENTITY"
  | "DORMANT_CHECKOUT_IDENTITY"
  | "EXISTING_ACCOUNT"
  | "NOT_REQUIRED";

function rpcText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function safeErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error || "unknown"))
    .slice(0, 500);
}

export function activationFailureStatus(
  error: unknown,
): "FAILED" | "UNKNOWN" {
  if (error instanceof AccountActivationProviderError) {
    if (
      error.status === 408 || error.status === 425 || error.status === 429 ||
      error.status >= 500 ||
      (error.status === 409 &&
        error.providerCode !== "invalid_idempotent_request")
    ) return "UNKNOWN";
    return "FAILED";
  }
  const message = safeErrorMessage(error);
  if (
    message === "RESEND_API_KEY is unavailable" ||
    message === "Could not generate activation link" ||
    message === "Activation redirect validation failed" ||
    message === "Stored activation payload is invalid" ||
    /Activation email failed with status 4\d\d/.test(message)
  ) {
    return "FAILED";
  }
  return "UNKNOWN";
}

export async function claimSaasOwnerActivation(
  admin: SupabaseClient,
  input: {
    checkoutId: string;
    tenantId: string;
    ownerEmail: string;
  },
): Promise<SaasOwnerActivationClaim> {
  const claimToken = crypto.randomUUID();
  const { data, error } = await admin.rpc("claim_saas_owner_activation", {
    p_checkout_id: input.checkoutId,
    p_tenant_id: input.tenantId,
    p_owner_email: input.ownerEmail,
    p_claim_token: claimToken,
    p_lease_seconds: 300,
  });
  if (error) {
    throw new Error(`saas_activation_claim_${error.code || "failed"}`);
  }

  const result = (data || {}) as RpcResult;
  const action = rpcText(result.action);
  if (result.ok !== true) {
    throw new Error(
      `saas_activation_claim_${rpcText(result.reason) || "rejected"}`,
    );
  }
  if (action === "IN_PROGRESS") {
    throw new Error("saas_activation_claim_in_progress");
  }
  if (action === "ALREADY_FINAL") {
    return {
      action,
      status: rpcText(result.status) || "UNKNOWN",
    };
  }
  if (
    !["SUBMIT_ONCE", "RESUME_IDEMPOTENT"].includes(action) ||
    rpcText(result.claim_token) !== claimToken
  ) {
    throw new Error("saas_activation_claim_invalid_response");
  }
  if (action === "RESUME_IDEMPOTENT") {
    const providerPayload = typeof result.provider_payload === "string"
      ? result.provider_payload
      : "";
    if (providerPayload.length < 2 || providerPayload.length > 50_000) {
      throw new Error("saas_activation_claim_invalid_response");
    }
    return { action, claimToken, providerPayload };
  }
  return { action: "SUBMIT_ONCE", claimToken };
}

export async function stageSaasOwnerActivationPayload(
  admin: SupabaseClient,
  input: {
    checkoutId: string;
    claimToken: string;
    ownerUserId: string;
    providerPayload: string;
  },
): Promise<"STAGED" | "SUPPRESSED"> {
  const { data, error } = await admin.rpc(
    "stage_saas_owner_activation_payload",
    {
      p_checkout_id: input.checkoutId,
      p_claim_token: input.claimToken,
      p_owner_user_id: input.ownerUserId,
      p_provider_payload: input.providerPayload,
    },
  );
  if (error) {
    throw new Error(`saas_activation_stage_${error.code || "failed"}`);
  }
  const result = (data || {}) as RpcResult;
  if (result.ok === true && rpcText(result.action) === "STAGED") {
    return "STAGED";
  }
  if (rpcText(result.action) === "SUPPRESSED") return "SUPPRESSED";
  throw new Error(
    `saas_activation_stage_${rpcText(result.reason) || "rejected"}`,
  );
}

export async function suppressSaasOwnerActivation(
  admin: SupabaseClient,
  input: {
    checkoutId: string;
    claimToken: string;
    ownerUserId: string;
    reason: "existing_owner_account" | "owner_activation_not_required";
  },
): Promise<void> {
  const { data, error } = await admin.rpc("suppress_saas_owner_activation", {
    p_checkout_id: input.checkoutId,
    p_claim_token: input.claimToken,
    p_owner_user_id: input.ownerUserId,
    p_reason: input.reason,
  });
  if (error) {
    throw new Error(`saas_activation_suppress_${error.code || "failed"}`);
  }
  const result = (data || {}) as RpcResult;
  if (
    result.ok !== true || rpcText(result.action) !== "SUPPRESSED" ||
    rpcText(result.status) !== "SUPPRESSED"
  ) {
    throw new Error(
      `saas_activation_suppress_${rpcText(result.reason) || "rejected"}`,
    );
  }
}

export async function repairSaasOwnerAccess(
  admin: SupabaseClient,
  input: { checkoutId: string; ownerUserId: string | null },
): Promise<
  | "REPAIRED"
  | "NOT_REQUIRED"
  | "IDENTITY_REQUIRED"
> {
  const { data, error } = await admin.rpc("repair_saas_owner_access", {
    p_checkout_id: input.checkoutId,
    p_owner_user_id: input.ownerUserId,
  });
  if (error) {
    throw new Error(`saas_owner_access_repair_${error.code || "failed"}`);
  }
  const result = (data || {}) as RpcResult;
  const action = rpcText(result.action);
  if (
    result.ok === true &&
    (action === "REPAIRED" || action === "NOT_REQUIRED")
  ) return action;
  if (
    result.ok === false && action === "REVIEW_REQUIRED" &&
    rpcText(result.reason) === "owner_identity_required_for_access_repair"
  ) return "IDENTITY_REQUIRED";
  throw new Error(
    `saas_owner_access_repair_${rpcText(result.reason) || "rejected"}`,
  );
}

export async function classifySaasOwnerActivationIdentity(
  admin: SupabaseClient,
  input: { checkoutId: string; claimToken: string; ownerUserId: string },
): Promise<SaasOwnerActivationIdentityDisposition> {
  const { data, error } = await admin.rpc(
    "classify_saas_owner_activation_identity",
    {
      p_checkout_id: input.checkoutId,
      p_claim_token: input.claimToken,
      p_owner_user_id: input.ownerUserId,
    },
  );
  if (error) {
    throw new Error(
      `saas_owner_identity_classification_${error.code || "failed"}`,
    );
  }
  const result = (data || {}) as RpcResult;
  const action = rpcText(result.action);
  if (result.ok !== true) {
    if (result.reason) {
      throw new Error(
        `saas_owner_identity_classification_${rpcText(result.reason)}`,
      );
    }
    throw new Error("saas_owner_identity_classification_failed");
  }
  if (
    action === "CHECKOUT_IDENTITY" || action === "DORMANT_CHECKOUT_IDENTITY" ||
    action === "EXISTING_ACCOUNT" || action === "NOT_REQUIRED"
  ) return action;
  throw new Error("saas_owner_identity_classification_invalid_action");
}

export async function submitSaasOwnerActivationOnce(
  admin: SupabaseClient,
  input: {
    checkoutId: string;
    claimToken: string;
    ownerUserId: string;
    send: () => Promise<void | { providerMessageId?: string | null }>;
  },
): Promise<SaasOwnerActivationDelivery> {
  const { data: markedData, error: markError } = await admin.rpc(
    "mark_saas_owner_activation_submitting",
    {
      p_checkout_id: input.checkoutId,
      p_claim_token: input.claimToken,
      p_owner_user_id: input.ownerUserId,
    },
  );
  if (markError) {
    throw new Error(`saas_activation_mark_${markError.code || "failed"}`);
  }
  const marked = (markedData || {}) as RpcResult;
  if (marked.ok !== true) {
    if (rpcText(marked.action) === "SUPPRESSED") {
      return {
        status: "SUPPRESSED",
        providerMessageId: null,
        error: rpcText(marked.reason) || "saas_activation_suppressed",
      };
    }
    throw new Error(
      `saas_activation_mark_${rpcText(marked.reason) || "rejected"}`,
    );
  }
  if (rpcText(marked.status) !== "SUBMITTING") {
    throw new Error("saas_activation_mark_invalid_response");
  }

  let status: "SENT" | "FAILED" | "UNKNOWN" = "SENT";
  let providerMessageId: string | null = null;
  let deliveryError: string | null = null;
  try {
    const sent = await input.send();
    if (sent && typeof sent === "object") {
      providerMessageId = rpcText(sent.providerMessageId) || null;
    }
  } catch (error) {
    status = activationFailureStatus(error);
    deliveryError = safeErrorMessage(error);
  }

  const { data: finishedData, error: finishError } = await admin.rpc(
    "finish_saas_owner_activation",
    {
      p_checkout_id: input.checkoutId,
      p_claim_token: input.claimToken,
      p_status: status,
      p_provider_message_id: providerMessageId,
      p_last_error: deliveryError,
    },
  );
  if (finishError) {
    throw new Error(`saas_activation_finish_${finishError.code || "failed"}`);
  }
  const finished = (finishedData || {}) as RpcResult;
  if (finished.ok !== true || rpcText(finished.status) !== status) {
    throw new Error(
      `saas_activation_finish_${rpcText(finished.reason) || "rejected"}`,
    );
  }

  return { status, providerMessageId, error: deliveryError };
}
