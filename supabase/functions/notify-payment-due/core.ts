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
