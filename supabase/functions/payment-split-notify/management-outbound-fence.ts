import type { EvolutionSendResult } from "../_shared/evolution-send.ts";

type RpcClient = {
  rpc: (
    name: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: unknown }>;
};

export type ManagementMessageKind =
  | "PAYMENT_CONFIRMED"
  | "MONTHLY_PAYMENT_CLOSE";

export type ManagementMessageClaim = {
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

function validClaim(value: unknown): value is ManagementMessageClaim {
  if (!value || typeof value !== "object") return false;
  const claim = value as Record<string, unknown>;
  if (typeof claim.ok !== "boolean" || typeof claim.action !== "string") {
    return false;
  }
  if (claim.action === "REVIEW_REQUIRED") return true;
  return typeof claim.attempt_id === "string";
}

export async function claimManagementGroupMessage(
  admin: RpcClient,
  input: {
    tenantId: string;
    notificationKind: ManagementMessageKind;
    subjectId: string;
    refDate: string;
  },
): Promise<ManagementMessageClaim> {
  const { data, error } = await admin.rpc("claim_management_group_message", {
    p_tenant_id: input.tenantId,
    p_notification_kind: input.notificationKind,
    p_subject_id: input.subjectId,
    p_ref_date: input.refDate,
    p_claim_token: crypto.randomUUID(),
    p_lease_seconds: 300,
  });
  if (error || !validClaim(data)) {
    throw new Error("management_group_message_claim_failed");
  }
  return data;
}

export async function markManagementGroupMessageSubmitting(
  admin: RpcClient,
  claim: ManagementMessageClaim,
): Promise<{ ok: boolean; action?: string; status?: string; reason?: string }> {
  if (!claim.attempt_id || !claim.claim_token) {
    throw new Error("management_group_message_claim_token_missing");
  }
  const { data, error } = await admin.rpc(
    "mark_management_group_message_submitting",
    {
      p_attempt_id: claim.attempt_id,
      p_claim_token: claim.claim_token,
    },
  );
  if (error || !data || typeof data !== "object") {
    throw new Error("management_group_message_claim_lost");
  }
  return data as {
    ok: boolean;
    action?: string;
    status?: string;
    reason?: string;
  };
}

export async function finishManagementGroupMessage(
  admin: RpcClient,
  claim: ManagementMessageClaim,
  input: {
    status: "SENT" | "FAILED" | "UNKNOWN" | "SUPPRESSED";
    providerHttpStatus?: number | null;
    error?: string | null;
  },
): Promise<void> {
  if (!claim.attempt_id || !claim.claim_token) {
    throw new Error("management_group_message_claim_token_missing");
  }
  const { data, error } = await admin.rpc("finish_management_group_message", {
    p_attempt_id: claim.attempt_id,
    p_claim_token: claim.claim_token,
    p_status: input.status,
    p_provider_http_status: input.providerHttpStatus ?? null,
    p_error: input.error?.slice(0, 200) || null,
  });
  const result = data as Record<string, unknown> | null;
  if (error || result?.ok !== true) {
    throw new Error("management_group_message_finish_failed");
  }
}

export async function applyMonthlyPaymentClosureDeliveryResult(
  admin: RpcClient,
  input: {
    tenantId: string;
    periodStart: string;
    attemptId: string;
  },
): Promise<boolean> {
  const { data, error } = await admin.rpc(
    "apply_monthly_payment_closure_delivery_result",
    {
      p_tenant_id: input.tenantId,
      p_period_start: input.periodStart,
      p_attempt_id: input.attemptId,
    },
  );
  if (error || data !== true) {
    throw new Error("monthly_payment_closure_delivery_result_failed");
  }
  return true;
}

export function managementGroupMessageFinish(result: EvolutionSendResult): {
  status: "SENT" | "FAILED" | "UNKNOWN";
  providerHttpStatus: number | null;
  error: string | null;
} {
  if (result.outcome === "accepted") {
    return {
      // This legacy monthly ledger has no provider-message-id column and no
      // receipt correlation. A 2xx therefore cannot prove group delivery.
      status: "UNKNOWN",
      providerHttpStatus: result.httpStatus,
      error: result.messageId
        ? "provider_acceptance_without_receipt_correlation"
        : "provider_acceptance_without_message_id",
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
