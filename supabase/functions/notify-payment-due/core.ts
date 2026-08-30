import type { EvolutionSendResult } from "../_shared/evolution-send.ts";

export type PaymentNotificationFinalState =
  | "SENT"
  | "FAILED"
  | "UNKNOWN";

export type PaymentNotificationFinish = {
  status: PaymentNotificationFinalState;
  providerHttpStatus: number | null;
  error: string | null;
};

export type PaymentRecipientProfile = {
  full_name?: unknown;
  phone?: unknown;
  guardian_id?: unknown;
  guardian_cpf?: unknown;
  guardian_name?: unknown;
  guardian_phone?: unknown;
};

export type PaymentRecipientResolution =
  | {
    ok: true;
    phone: string;
    firstName: string;
    recipient: "STUDENT" | "FINANCIAL_GUARDIAN";
  }
  | {
    ok: false;
    reason:
      | "financial_guardian_phone_missing_or_invalid"
      | "student_phone_missing_or_invalid";
    recipient: "STUDENT" | "FINANCIAL_GUARDIAN";
  };

function normalizedText(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function normalizedDigits(value: unknown): string {
  return normalizedText(value).replace(/\D/g, "");
}

function normalizePaymentPhone(value: unknown): string | null {
  let phone = normalizedDigits(value);
  if (phone.length === 10 || phone.length === 11) phone = `55${phone}`;
  return phone.length >= 12 && phone.length <= 15 ? phone : null;
}

/**
 * Resolve the current financial addressee from the authoritative student
 * profile. A dependent must never fall back to the child's phone: doing so
 * would disclose billing information to the wrong person and bypass the
 * payer selected during enrollment.
 */
export function resolvePaymentRecipient(
  profile: PaymentRecipientProfile,
): PaymentRecipientResolution {
  const hasFinancialGuardian = Boolean(
    normalizedText(profile.guardian_id) ||
      normalizedDigits(profile.guardian_cpf),
  );
  const recipient = hasFinancialGuardian
    ? "FINANCIAL_GUARDIAN" as const
    : "STUDENT" as const;
  const phone = normalizePaymentPhone(
    hasFinancialGuardian ? profile.guardian_phone : profile.phone,
  );

  if (!phone) {
    return {
      ok: false,
      reason: hasFinancialGuardian
        ? "financial_guardian_phone_missing_or_invalid"
        : "student_phone_missing_or_invalid",
      recipient,
    };
  }

  const fullName = normalizedText(
    hasFinancialGuardian ? profile.guardian_name : profile.full_name,
  );
  return {
    ok: true,
    phone,
    firstName: fullName.split(" ")[0] ||
      (hasFinancialGuardian ? "Responsável" : "Aluno"),
    recipient,
  };
}

/**
 * Keep provider ambiguity terminal. Retrying a timeout/5xx can deliver the
 * same financial message twice because Evolution exposes no idempotency key.
 */
export function paymentNotificationFinish(
  result: EvolutionSendResult,
): PaymentNotificationFinish {
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

export function overdueNotificationKind(
  milestone: number,
): "PAYMENT_OVERDUE_3" | "PAYMENT_OVERDUE_10" | "PAYMENT_OVERDUE_20" {
  if (milestone === 3) return "PAYMENT_OVERDUE_3";
  if (milestone === 10) return "PAYMENT_OVERDUE_10";
  if (milestone === 20) return "PAYMENT_OVERDUE_20";
  throw new Error("unsupported_payment_overdue_milestone");
}
