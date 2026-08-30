import type { PaymentAdminClient } from "./payment-auth.ts";

export type EnrollmentProcessingState =
  | "PROFILE_READY"
  | "CUSTOMER_READY"
  | "BILLING_READY"
  | "AWAITING_PAYMENT"
  | "FAILED_RETRYABLE"
  | "COMPLETED";

export type EnrollmentPaymentKind =
  | "ENROLLMENT_FEE"
  | "ONE_TIME"
  | "PRO_RATA"
  | "SUBSCRIPTION_ACTIVATION";

export type EnrollmentPaymentObservation = {
  tenantId: string;
  studentId: string;
  offerId: string | null;
  providerPaymentId: string;
  providerCustomerId: string;
  providerSubscriptionId: string | null;
  paymentKind: EnrollmentPaymentKind;
  outcome: "SETTLED" | "PENDING" | "UNSETTLED";
  providerValue: number;
  externalReference: string;
  providerStatus: string;
  dueDate: string;
  billingType: "PIX" | "BOLETO" | "CREDIT_CARD";
  description: string;
};

export type EnrollmentPaymentObservationBinding = {
  offerId: string | null;
  paymentKind: EnrollmentPaymentKind;
  externalReference: string;
};

export type EnrollmentPaymentObservationFailureDisposition =
  | "SUPPRESS"
  | "TRIAGE"
  | "RETRY";

const SAFE_OBSERVATION_SUPPRESSION_REASONS = new Set([
  "student_lifecycle_inactive",
  "provider_observation_stale",
]);

const TRANSIENT_OBSERVATION_RPC_CODES = new Set([
  "40001", // serialization_failure
  "40P01", // deadlock_detected
  "55P03", // lock_not_available / lock timeout
  "57014", // query_canceled / statement timeout
  "57P01", // admin_shutdown
  "53300", // too_many_connections
  "53400", // configuration_limit_exceeded
  "PGRST000",
  "PGRST001",
  "PGRST002",
  "PGRST003",
]);

export class EnrollmentPaymentObservationError extends Error {
  constructor(
    readonly reason: string,
    readonly retryable: boolean,
    readonly databaseCode: string | null = null,
    message = reason,
  ) {
    super(message);
    this.name = "EnrollmentPaymentObservationError";
  }
}

function enrollmentObservationRpcErrorIsTransient(code: unknown): boolean {
  const normalized = String(code || "").trim().toUpperCase();
  // A missing database code is how fetch/network failures are commonly
  // surfaced by the client. Known SQL/PostgREST contract errors are final.
  return !normalized || normalized.startsWith("08") ||
    TRANSIENT_OBSERVATION_RPC_CODES.has(normalized);
}

export function enrollmentPaymentObservationFailureDisposition(
  error: unknown,
): EnrollmentPaymentObservationFailureDisposition {
  if (!(error instanceof EnrollmentPaymentObservationError)) return "RETRY";
  if (SAFE_OBSERVATION_SUPPRESSION_REASONS.has(error.reason)) {
    return "SUPPRESS";
  }
  return error.retryable ? "RETRY" : "TRIAGE";
}

const SAFE_ERROR_CODES = new Set([
  "asaas_not_configured",
  "customer_sync_failed",
  "billing_creation_failed",
  "payment_creation_failed",
  "payment_check_failed",
  "profile_update_failed",
  "booking_update_failed",
  "temporary_provider_error",
  "internal_error",
]);

export function safeEnrollmentErrorCode(value: unknown): string {
  const normalized = String(value || "").trim().toLowerCase();
  return SAFE_ERROR_CODES.has(normalized) ? normalized : "internal_error";
}

export function safeEnrollmentErrorMessage(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value || "");
  // Nunca persiste payloads, chaves ou respostas integrais de provedores.
  return message
    .replace(/\$aact_[A-Za-z0-9_-]+/g, "[secret]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [secret]")
    .slice(0, 300);
}

export async function markEnrollmentStage(
  admin: PaymentAdminClient,
  offerId: string,
  userId: string,
  state: EnrollmentProcessingState,
  extra: {
    metadata?: Record<string, unknown>;
    errorCode?: string | null;
    errorMessage?: string | null;
  } = {},
): Promise<void> {
  if (!offerId || !userId) return;

  const update: Record<string, unknown> = {
    processing_state: state,
    processing_updated_at: new Date().toISOString(),
    processing_error_code: extra.errorCode ?? null,
    processing_error_message: extra.errorMessage ?? null,
  };

  if (extra.metadata) {
    const { data: current, error: loadError } = await admin
      .from("offers")
      .select("metadata")
      .eq("id", offerId)
      .eq("processing_by", userId)
      .maybeSingle();
    if (loadError) {
      throw new Error(`progress_lookup_failed: ${loadError.message}`);
    }
    update.metadata = { ...(current?.metadata || {}), ...extra.metadata };
  }

  const { error } = await admin
    .from("offers")
    .update(update)
    .eq("id", offerId)
    .eq("processing_by", userId)
    .neq("processing_state", "COMPLETED");
  if (error) throw new Error(`progress_update_failed: ${error.message}`);
}

export async function markEnrollmentFailure(
  admin: PaymentAdminClient,
  offerId: string,
  userId: string,
  code: unknown,
  error: unknown,
): Promise<void> {
  try {
    await markEnrollmentStage(admin, offerId, userId, "FAILED_RETRYABLE", {
      errorCode: safeEnrollmentErrorCode(code),
      errorMessage: safeEnrollmentErrorMessage(error),
    });
  } catch (progressError) {
    console.error("[enrollment-progress] failed to persist retryable error", {
      type: progressError instanceof Error
        ? progressError.name
        : "UnknownError",
    });
  }
}

export async function completeEnrollment(
  admin: PaymentAdminClient,
  offerId: string,
  userId: string,
): Promise<Record<string, unknown>> {
  const { data, error } = await admin.rpc("complete_enrollment_offer", {
    p_offer_id: offerId,
    p_user_id: userId,
  });
  if (error) throw new Error(`enrollment_completion_failed: ${error.message}`);
  if (!data?.success) {
    throw new Error(String(data?.error || "enrollment_completion_failed"));
  }
  return data as Record<string, unknown>;
}

export async function applyEnrollmentPaymentObservation(
  admin: PaymentAdminClient,
  input: EnrollmentPaymentObservation,
): Promise<Record<string, unknown>> {
  const { data, error } = await admin.rpc(
    "apply_enrollment_payment_observation",
    {
      p_tenant_id: input.tenantId,
      p_student_id: input.studentId,
      p_offer_id: input.offerId,
      p_provider_payment_id: input.providerPaymentId,
      p_provider_customer_id: input.providerCustomerId,
      p_provider_subscription_id: input.providerSubscriptionId,
      p_payment_kind: input.paymentKind,
      p_outcome: input.outcome,
      p_provider_value: input.providerValue,
      p_external_reference: input.externalReference,
      p_provider_status: input.providerStatus,
      p_due_date: input.dueDate,
      p_billing_type: input.billingType,
      p_description: input.description,
    },
  );
  if (error) {
    const databaseCode = String(error.code || "").trim().toUpperCase() || null;
    const retryable = enrollmentObservationRpcErrorIsTransient(databaseCode);
    throw new EnrollmentPaymentObservationError(
      retryable
        ? "enrollment_observation_temporarily_unavailable"
        : "enrollment_observation_database_rejected",
      retryable,
      databaseCode,
      `enrollment_observation_failed: ${error.message}`,
    );
  }
  if (data?.ok !== true) {
    const reason = String(
      data?.reason || "enrollment_observation_rejected",
    ).trim().toLowerCase();
    throw new EnrollmentPaymentObservationError(reason, false);
  }
  return data as Record<string, unknown>;
}

export async function resolveEnrollmentPaymentObservationBinding(
  admin: PaymentAdminClient,
  input: {
    tenantId: string;
    studentId: string;
    providerPaymentId: string;
    externalReference: string | null;
    outcome: "SETTLED" | "PENDING" | "UNSETTLED";
  },
): Promise<EnrollmentPaymentObservationBinding | null> {
  const { data, error } = await admin.rpc(
    "resolve_enrollment_payment_observation_binding",
    {
      p_tenant_id: input.tenantId,
      p_student_id: input.studentId,
      p_provider_payment_id: input.providerPaymentId,
      p_external_reference: input.externalReference,
      p_outcome: input.outcome,
    },
  );
  if (error) {
    const databaseCode = String(error.code || "").trim().toUpperCase() || null;
    const retryable = enrollmentObservationRpcErrorIsTransient(databaseCode);
    throw new EnrollmentPaymentObservationError(
      retryable
        ? "enrollment_binding_temporarily_unavailable"
        : "enrollment_binding_database_rejected",
      retryable,
      databaseCode,
      `enrollment_binding_failed: ${error.message}`,
    );
  }
  if (data?.ok !== true) {
    throw new EnrollmentPaymentObservationError(
      String(data?.reason || "enrollment_binding_rejected").trim()
        .toLowerCase(),
      false,
    );
  }
  if (data.action === "NONE") return null;
  const paymentKind = String(data.payment_kind || "").trim().toUpperCase();
  const offerId = data.offer_id === null
    ? null
    : String(data.offer_id || "").trim();
  const externalReference = String(data.external_reference || "").trim();
  if (
    data.action !== "BOUND" ||
    ![
      "ENROLLMENT_FEE",
      "ONE_TIME",
      "PRO_RATA",
      "SUBSCRIPTION_ACTIVATION",
    ].includes(paymentKind) ||
    (!offerId && paymentKind !== "ENROLLMENT_FEE") ||
    !externalReference
  ) {
    throw new EnrollmentPaymentObservationError(
      "enrollment_binding_result_invalid",
      false,
    );
  }
  return {
    offerId,
    paymentKind: paymentKind as EnrollmentPaymentKind,
    externalReference,
  };
}

/**
 * A full provider refund removes the financial prerequisite even after the
 * offer was completed. Commercial/audit side effects are deliberately kept;
 * the database RPC reopens only the access/payment state and raises triage for
 * a refund that happened after completion.
 */
export async function reopenEnrollmentForUnsettledPayment(
  admin: PaymentAdminClient,
  offerId: string,
  userId: string,
  providerPaymentId: string,
  reason: "payment_refunded" | "payment_not_settled",
): Promise<Record<string, unknown>> {
  const { data, error } = await admin.rpc(
    "reopen_enrollment_offer_for_unsettled_payment",
    {
      p_offer_id: offerId,
      p_user_id: userId,
      p_provider_payment_id: providerPaymentId,
      p_reason: reason,
    },
  );
  if (error) {
    throw new Error(`enrollment_payment_reopen_failed: ${error.message}`);
  }
  if (!data?.ok) {
    throw new Error(String(data?.reason || "enrollment_payment_reopen_failed"));
  }
  return data as Record<string, unknown>;
}
