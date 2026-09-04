export type ProviderDeliveryOutcome = "ACCEPTED" | "REJECTED" | "UNCERTAIN";

export function requireRootAutomationRows<T>(
  label: string,
  result: { data: T[] | null; error: unknown },
): T[] {
  if (result.error) {
    const error = result.error as { code?: unknown; message?: unknown };
    const detail = String(error.code || error.message || "query").trim();
    throw new Error(`${label}_query_failed:${detail || "query"}`);
  }
  if (!Array.isArray(result.data)) {
    throw new Error(`${label}_query_failed:missing_data`);
  }
  return result.data;
}

export function requireAutomationReceiptInsert(
  result: {
    data: { id?: unknown } | null;
    error: { code?: unknown; message?: unknown } | null;
  },
): { id: string } | null {
  if (result.error) {
    if (String(result.error.code || "") === "23505") return null;
    const detail = String(
      result.error.code || result.error.message || "query",
    ).trim();
    throw new Error(
      `automation_receipt_insert_failed:${detail || "query"}`,
    );
  }
  const id = String(result.data?.id || "").trim();
  if (!id) throw new Error("automation_receipt_insert_failed:missing_id");
  return { id };
}

export function classifyProviderHttpResponse(
  status: number,
): ProviderDeliveryOutcome {
  if (status >= 200 && status < 300) return "ACCEPTED";
  // Timeout e erro interno podem acontecer depois de o provedor ter aceitado o
  // POST. Nesses casos, repetir automaticamente arrisca mensagem duplicada.
  if (status === 408 || status >= 500) return "UNCERTAIN";
  return "REJECTED";
}

export interface AutomationClaimStore {
  hasReceipt(kind: string, subjectId: string): Promise<boolean>;
  insertReceipt(input: {
    kind: string;
    subjectId: string;
    refDate: string;
  }): Promise<{ id: string } | null>;
  deleteReceiptById(id: string): Promise<void>;
}

export interface AutomationClaimReceipt {
  id: string;
  undo(): Promise<void>;
}

export async function claimAutomationDelivery(
  store: AutomationClaimStore,
  kind: string,
  subjectId: string,
  refDate: string,
): Promise<AutomationClaimReceipt | null> {
  if (await store.hasReceipt(kind, subjectId)) return null;

  const inserted = await store.insertReceipt({ kind, subjectId, refDate });
  const receiptId = String(inserted?.id || "").trim();
  if (!receiptId) return null;

  return {
    id: receiptId,
    undo: () => store.deleteReceiptById(receiptId),
  };
}

export function shouldReleaseAutomationClaim(
  outcome: ProviderDeliveryOutcome,
): boolean {
  return outcome === "REJECTED";
}

export function isOpenConversionStatus(value: unknown): boolean {
  return String(value || "").trim().toUpperCase() === "OPEN";
}

export function isPendingEnrollmentLinkStatus(value: unknown): boolean {
  return String(value || "").trim().toUpperCase() === "PENDING";
}

export type EnrollmentOfferSnapshot = {
  id?: unknown;
  kind?: unknown;
  opportunity_id?: unknown;
  revoked_at?: unknown;
  consumed_at?: unknown;
  expires_at?: unknown;
  processing_state?: unknown;
};

const normalizedText = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

/**
 * An enrollment proposal remains meaningful while it is actively available,
 * already being processed, or consumed. A revoked/expired NOT_STARTED offer
 * must never suppress the commercial recovery flow.
 */
export function isMeaningfulEnrollmentOffer(
  offer: EnrollmentOfferSnapshot,
  opportunityId: string,
  nowMs: number,
): boolean {
  if (
    normalizedText(offer.kind).toUpperCase() !== "ENROLLMENT" ||
    normalizedText(offer.opportunity_id) !== normalizedText(opportunityId)
  ) return false;

  if (normalizedText(offer.consumed_at)) return true;

  const state = normalizedText(offer.processing_state).toUpperCase();
  if (state && state !== "NOT_STARTED") return true;

  if (normalizedText(offer.revoked_at)) return false;
  const expiresAt = Date.parse(normalizedText(offer.expires_at));
  return Number.isFinite(expiresAt) && expiresAt > nowMs;
}

/** A reminder can only target an untouched offer that is still redeemable. */
export function isEnrollmentOfferReminderEligible(
  offer: EnrollmentOfferSnapshot,
  opportunityId: string,
  nowMs: number,
): boolean {
  if (
    normalizedText(offer.kind).toUpperCase() !== "ENROLLMENT" ||
    normalizedText(offer.opportunity_id) !== normalizedText(opportunityId) ||
    normalizedText(offer.revoked_at) ||
    normalizedText(offer.consumed_at)
  ) return false;

  const state = normalizedText(offer.processing_state).toUpperCase();
  if (state && state !== "NOT_STARTED") return false;

  const expiresAt = Date.parse(normalizedText(offer.expires_at));
  return Number.isFinite(expiresAt) && expiresAt > nowMs;
}
