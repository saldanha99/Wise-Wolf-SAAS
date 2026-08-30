import type { EvolutionSendResult } from "./evolution-send.ts";

type RpcClient = {
  rpc: (
    name: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: unknown }>;
};

export type FinancialReportKind =
  | "DRE_REPORT"
  | "WEEKLY_DIGEST"
  | "MONTHLY_CLOSING";

export type FinancialReportMessageClaim = {
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

function validClaim(value: unknown): value is FinancialReportMessageClaim {
  if (!value || typeof value !== "object") return false;
  const claim = value as Record<string, unknown>;
  if (typeof claim.ok !== "boolean" || typeof claim.action !== "string") {
    return false;
  }
  if (claim.action === "REVIEW_REQUIRED") return true;
  return typeof claim.attempt_id === "string";
}

export async function claimFinancialReportMessage(
  admin: RpcClient,
  input: {
    tenantId: string;
    notificationKind: FinancialReportKind;
    subjectId: string;
    refDate: string;
  },
): Promise<FinancialReportMessageClaim> {
  const claimToken = crypto.randomUUID();
  const { data, error } = await admin.rpc(
    "claim_financial_report_message",
    {
      p_tenant_id: input.tenantId,
      p_notification_kind: input.notificationKind,
      p_subject_id: input.subjectId,
      p_ref_date: input.refDate,
      p_claim_token: claimToken,
      p_lease_seconds: 300,
    },
  );
  if (error || !validClaim(data)) {
    throw new Error("financial_report_message_claim_failed");
  }
  return data;
}

export async function markFinancialReportMessageSubmitting(
  admin: RpcClient,
  claim: FinancialReportMessageClaim,
): Promise<{ ok: boolean; action?: string; status?: string; reason?: string }> {
  if (!claim.attempt_id || !claim.claim_token) {
    throw new Error("financial_report_message_claim_token_missing");
  }
  const { data, error } = await admin.rpc(
    "mark_financial_report_message_submitting",
    {
      p_attempt_id: claim.attempt_id,
      p_claim_token: claim.claim_token,
    },
  );
  if (error || !data || typeof data !== "object") {
    throw new Error("financial_report_message_claim_lost");
  }
  return data as {
    ok: boolean;
    action?: string;
    status?: string;
    reason?: string;
  };
}

export async function finishFinancialReportMessage(
  admin: RpcClient,
  claim: FinancialReportMessageClaim,
  input: {
    status: "SENT" | "FAILED" | "UNKNOWN" | "SUPPRESSED";
    providerHttpStatus?: number | null;
    error?: string | null;
  },
): Promise<void> {
  if (!claim.attempt_id || !claim.claim_token) {
    throw new Error("financial_report_message_claim_token_missing");
  }
  const { data, error } = await admin.rpc(
    "finish_financial_report_message",
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
    throw new Error("financial_report_message_finish_failed");
  }
}

export function financialReportMessageFinish(result: EvolutionSendResult): {
  status: "SENT" | "FAILED" | "UNKNOWN";
  providerHttpStatus: number | null;
  error: string | null;
} {
  if (result.outcome === "accepted") {
    if (!result.messageId) {
      return {
        status: "UNKNOWN",
        providerHttpStatus: result.httpStatus,
        error: "provider_acceptance_without_message_id",
      };
    }
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

/**
 * Version the teacher-closing notification by its exact financial snapshot.
 * A recalculation is a legitimate new message only when lessons or amount
 * changed; retries of the same snapshot must collide in the durable fence.
 */
export function monthlyTeacherClosingSubject(input: {
  teacherId: string;
  month: string;
  closingId: string;
  lessons: unknown;
  amount: unknown;
}): string {
  const teacherId = input.teacherId.trim().toLowerCase();
  const closingId = input.closingId.trim().toLowerCase();
  const lessons = Number(input.lessons);
  const amount = Number(input.amount);
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  if (
    !uuid.test(teacherId) || !uuid.test(closingId) ||
    !/^\d{4}-(0[1-9]|1[0-2])$/.test(input.month) ||
    !Number.isInteger(lessons) || lessons < 0 ||
    !Number.isFinite(amount)
  ) {
    throw new Error("invalid_monthly_teacher_closing_subject");
  }
  const amountCents = Math.round(amount * 100);
  if (!Number.isSafeInteger(amountCents)) {
    throw new Error("invalid_monthly_teacher_closing_subject");
  }
  return `${teacherId}:${input.month}:${closingId}:${lessons}:${amountCents}`;
}
