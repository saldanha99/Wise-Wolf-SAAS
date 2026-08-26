import type { EvolutionSendResult } from "../_shared/evolution-send.ts";

type RpcClient = {
  rpc: (
    name: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: unknown }>;
};

export type PaymentSplitMessageClaim = {
  ok: boolean;
  action:
    | "SUBMIT_ONCE"
    | "IN_PROGRESS"
    | "ALREADY_FINAL"
    | "REVIEW_REQUIRED";
  attempt_id?: string;
  claim_token?: string;
  status?: string;
  reason?: string;
};

function validClaim(value: unknown): value is PaymentSplitMessageClaim {
  if (!value || typeof value !== "object") return false;
  const claim = value as Record<string, unknown>;
  if (typeof claim.ok !== "boolean" || typeof claim.action !== "string") {
    return false;
  }
  if (claim.action === "REVIEW_REQUIRED") return true;
  return typeof claim.attempt_id === "string";
}

export async function claimPaymentSplitMessage(
  admin: RpcClient,
  input: { tenantId: string; paymentId: string },
): Promise<PaymentSplitMessageClaim> {
  const claimToken = crypto.randomUUID();
  const { data, error } = await admin.rpc(
    "claim_asaas_payment_split_message",
    {
      p_tenant_id: input.tenantId,
      p_payment_id: input.paymentId,
      p_claim_token: claimToken,
      p_lease_seconds: 300,
    },
  );
  if (error || !validClaim(data)) {
    throw new Error("payment_split_message_claim_failed");
  }
  return data;
}

export async function markPaymentSplitMessageSubmitting(
  admin: RpcClient,
  claim: PaymentSplitMessageClaim,
): Promise<{ ok: boolean; action?: string; status?: string; reason?: string }> {
  if (!claim.attempt_id || !claim.claim_token) {
    throw new Error("payment_split_message_claim_token_missing");
  }
  const { data, error } = await admin.rpc(
    "mark_asaas_payment_split_message_submitting",
    {
      p_attempt_id: claim.attempt_id,
      p_claim_token: claim.claim_token,
    },
  );
  if (error || !data || typeof data !== "object") {
    throw new Error("payment_split_message_claim_lost");
  }
  return data as {
    ok: boolean;
    action?: string;
    status?: string;
    reason?: string;
  };
}

export async function finishPaymentSplitMessage(
  admin: RpcClient,
  claim: PaymentSplitMessageClaim,
  input: {
    status: "SENT" | "FAILED" | "UNKNOWN" | "SUPPRESSED";
    providerHttpStatus?: number | null;
    error?: string | null;
  },
): Promise<void> {
  if (!claim.attempt_id || !claim.claim_token) {
    throw new Error("payment_split_message_claim_token_missing");
  }
  const { data, error } = await admin.rpc(
    "finish_asaas_payment_split_message",
    {
      p_attempt_id: claim.attempt_id,
      p_claim_token: claim.claim_token,
      p_status: input.status,
      p_provider_http_status: input.providerHttpStatus ?? null,
      p_error: input.error?.slice(0, 200) || null,
    },
  );
  const result = data as Record<string, unknown> | null;
  if (error || result?.ok !== true) {
    throw new Error("payment_split_message_finish_failed");
  }
}

export function paymentSplitMessageFinish(result: EvolutionSendResult): {
  status: "SENT" | "FAILED" | "UNKNOWN";
  providerHttpStatus: number | null;
  error: string | null;
} {
  if (result.outcome === "accepted") {
    return {
      status: "SENT",
      providerHttpStatus: result.httpStatus,
      error: null,
    };
  }
  if (result.outcome === "ambiguous") {
    return {
      status: "UNKNOWN",
      providerHttpStatus: result.httpStatus,
      error: "provider_delivery_outcome_unknown",
    };
  }
  return {
    status: "FAILED",
    providerHttpStatus: result.httpStatus,
    error: "provider_delivery_rejected",
  };
}
