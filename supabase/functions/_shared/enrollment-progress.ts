import type { PaymentAdminClient } from "./payment-auth.ts";

export type EnrollmentProcessingState =
  | "PROFILE_READY"
  | "CUSTOMER_READY"
  | "BILLING_READY"
  | "AWAITING_PAYMENT"
  | "FAILED_RETRYABLE"
  | "COMPLETED";

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
    if (loadError) throw new Error(`progress_lookup_failed: ${loadError.message}`);
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
      type: progressError instanceof Error ? progressError.name : "UnknownError",
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
