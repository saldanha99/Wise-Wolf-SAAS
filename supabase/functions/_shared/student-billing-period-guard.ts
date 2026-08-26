import type { PaymentAdminClient } from "./payment-auth.ts";

export type StudentBillingPeriodClaim = {
  ok: boolean;
  action:
    | "SUBMIT_ONCE"
    | "RECONCILE_REQUIRED"
    | "ALREADY_BOUND"
    | "IN_PROGRESS"
    | "CONFLICT"
    | "REVIEW_REQUIRED";
  attempt_id: string;
  claim_token?: string;
  provider_entity_id?: string;
  status?: string;
  reason?: string;
  retry_after_seconds?: number;
};

function validClaim(value: unknown): value is StudentBillingPeriodClaim {
  if (!value || typeof value !== "object") return false;
  const claim = value as Record<string, unknown>;
  return typeof claim.ok === "boolean" &&
    typeof claim.action === "string" &&
    typeof claim.attempt_id === "string";
}

export async function claimStudentBillingPeriod(
  admin: PaymentAdminClient,
  input: {
    tenantId: string;
    studentId: string;
    dueDate: string;
    source: "MANUAL_PIX" | "SUBSCRIPTION";
    sourceKey: string;
    requestFingerprint: string;
  },
): Promise<StudentBillingPeriodClaim> {
  const claimToken = crypto.randomUUID();
  const { data, error } = await admin.rpc(
    "claim_asaas_student_billing_period",
    {
      p_tenant_id: input.tenantId,
      p_student_id: input.studentId,
      p_due_date: input.dueDate,
      p_source: input.source,
      p_source_key: input.sourceKey,
      p_request_fingerprint: input.requestFingerprint,
      p_claim_token: claimToken,
      p_lease_seconds: 300,
    },
  );
  if (error || !validClaim(data)) {
    throw new Error("student_billing_period_claim_failed");
  }
  return data;
}

export async function markStudentBillingPeriodSubmitting(
  admin: PaymentAdminClient,
  claim: StudentBillingPeriodClaim,
): Promise<void> {
  if (!claim.claim_token) {
    throw new Error("student_billing_claim_token_missing");
  }
  const { data, error } = await admin.rpc(
    "mark_asaas_student_billing_period_submitting",
    {
      p_attempt_id: claim.attempt_id,
      p_claim_token: claim.claim_token,
    },
  );
  if (error || data?.ok !== true) {
    throw new Error("student_billing_period_claim_lost");
  }
}

export async function recordStudentBillingPeriodState(
  admin: PaymentAdminClient,
  claim: StudentBillingPeriodClaim,
  input: {
    status: "RETRY" | "UNKNOWN" | "BOUND" | "FAILED" | "BLOCKED";
    providerEntityId?: string | null;
    error?: string | null;
  },
): Promise<void> {
  if (!claim.claim_token) {
    throw new Error("student_billing_claim_token_missing");
  }
  const { data, error } = await admin.rpc(
    "record_asaas_student_billing_period_state",
    {
      p_attempt_id: claim.attempt_id,
      p_claim_token: claim.claim_token,
      p_status: input.status,
      p_provider_entity_id: input.providerEntityId?.trim() || null,
      p_error: input.error?.slice(0, 200) || null,
    },
  );
  if (error || data?.ok !== true) {
    throw new Error("student_billing_period_state_failed");
  }
}

export type OutboundMessageClaim = {
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

function validOutboundMessageClaim(
  value: unknown,
): value is OutboundMessageClaim {
  if (!value || typeof value !== "object") return false;
  const claim = value as Record<string, unknown>;
  if (typeof claim.ok !== "boolean" || typeof claim.action !== "string") {
    return false;
  }
  if (claim.action === "REVIEW_REQUIRED") {
    return claim.attempt_id === undefined ||
      typeof claim.attempt_id === "string";
  }
  return typeof claim.attempt_id === "string";
}

export async function claimOutboundMessage(
  admin: PaymentAdminClient,
  input: {
    tenantId: string;
    studentId: string;
    providerEntityId: string;
    notificationKind: string;
  },
): Promise<OutboundMessageClaim> {
  const { data, error } = await admin.rpc("claim_asaas_outbound_message", {
    p_tenant_id: input.tenantId,
    p_student_id: input.studentId,
    p_provider_entity_id: input.providerEntityId,
    p_notification_kind: input.notificationKind,
    p_claim_token: crypto.randomUUID(),
    p_lease_seconds: 300,
  });
  if (error || !validOutboundMessageClaim(data)) {
    throw new Error("outbound_message_claim_failed");
  }
  return data as OutboundMessageClaim;
}

export async function markOutboundMessageSubmittingDecision(
  admin: PaymentAdminClient,
  claim: OutboundMessageClaim,
): Promise<{ ok: boolean; action?: string; status?: string; reason?: string }> {
  if (!claim.attempt_id || !claim.claim_token) {
    throw new Error("outbound_message_claim_token_missing");
  }
  const { data, error } = await admin.rpc(
    "mark_asaas_outbound_message_submitting",
    { p_attempt_id: claim.attempt_id, p_claim_token: claim.claim_token },
  );
  if (error || !data || typeof data !== "object") {
    throw new Error("outbound_message_claim_lost");
  }
  return data as {
    ok: boolean;
    action?: string;
    status?: string;
    reason?: string;
  };
}

export async function markOutboundMessageSubmitting(
  admin: PaymentAdminClient,
  claim: OutboundMessageClaim,
): Promise<void> {
  const decision = await markOutboundMessageSubmittingDecision(admin, claim);
  if (decision.ok !== true || decision.status !== "SUBMITTING") {
    throw new Error("outbound_message_claim_lost");
  }
}

export async function finishOutboundMessage(
  admin: PaymentAdminClient,
  claim: OutboundMessageClaim,
  input: {
    status: "SENT" | "FAILED" | "UNKNOWN" | "SUPPRESSED";
    providerHttpStatus?: number | null;
    error?: string | null;
  },
): Promise<void> {
  if (!claim.attempt_id || !claim.claim_token) {
    throw new Error("outbound_message_claim_token_missing");
  }
  const { data, error } = await admin.rpc("finish_asaas_outbound_message", {
    p_attempt_id: claim.attempt_id,
    p_claim_token: claim.claim_token,
    p_status: input.status,
    p_provider_http_status: input.providerHttpStatus ?? null,
    p_error: input.error?.slice(0, 200) || null,
  });
  if (error || data?.ok !== true) {
    throw new Error("outbound_message_finish_failed");
  }
}
