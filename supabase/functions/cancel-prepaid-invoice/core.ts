export type Json = Record<string, unknown>;
export type Source = Json & {
  payment_id: string;
  tenant_id: string;
  student_id: string;
  provider_payment_id: string;
  customer_id: string;
  subscription_id: string | null;
  due_date: string;
  value: number;
  status: string;
};
export type Integration = {
  integrationId: string;
  tenantId: string;
  provider: "asaas";
  version: number;
  environment: "platform" | "production" | "sandbox";
  mode: "PLATFORM_MANAGED_ROOT" | "PLATFORM_MANAGED_SUBACCOUNT" | "TENANT_BYOK";
  baseUrl: string;
  apiKey: string;
};
export type ProviderResponse = { status: number; body: Json };
export interface Dependencies {
  claim: (operation: string, actor: string, token: string) => Promise<Json>;
  resolve: (
    tenant: string,
    purpose: "payment.read" | "payment.delete",
  ) => Promise<Integration>;
  get: (source: Source, integration: Integration) => Promise<ProviderResponse>;
  verifyCanonical: (
    source: Source,
    provider: Json,
    integration: Integration,
  ) => Promise<boolean>;
  revalidate: (
    tenant: string,
    integration: Integration,
  ) => Promise<Integration>;
  begin: (
    operation: string,
    actor: string,
    token: string,
    provider: Json,
    integration: Json,
  ) => Promise<Json>;
  remove: (
    source: Source,
    integration: Integration,
  ) => Promise<ProviderResponse>;
  finish: (
    operation: string,
    actor: string,
    token: string,
    outcome: string,
    proof: Json,
  ) => Promise<Json>;
  token: () => string;
}
const string = (value: unknown) => typeof value === "string" ? value : "";
export const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value);
const cents = (value: unknown) => {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (!/^\d+(\.\d{1,2})?$/.test(String(value))) return null;
  const amount = Math.round(Number(value) * 100);
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
};
export function matchesInvoice(source: Source, body: Json): boolean {
  return string(body.id) === source.provider_payment_id &&
    string(body.customer) === source.customer_id &&
    string(body.subscription) === (source.subscription_id || "") &&
    string(body.dueDate) === source.due_date &&
    cents(source.value) !== null && cents(body.value) === cents(source.value);
}
export const safeProof = (body: Json): Json =>
  Object.fromEntries(
    ["id", "customer", "subscription", "dueDate", "value", "status", "deleted"]
      .filter((key) => body[key] !== undefined)
      .map((key) => [key, body[key]]),
  );

/** One explicit intent, at most one DELETE. Retries after the boundary only GET. */
export async function processCancellation(
  operation: string,
  actor: string,
  deps: Dependencies,
): Promise<Json> {
  if (!uuid(operation) || !uuid(actor)) {
    return { ok: false, error: "invalid_request" };
  }
  const token = deps.token();
  let claimed = false;
  let crossedBoundary = false;
  let reconcile = false;
  const finish = async (outcome: string, proof: Json): Promise<Json> => {
    try {
      const result = await deps.finish(operation, actor, token, outcome, proof);
      return result.ok === true
        ? result
        : { ok: false, status: "UNKNOWN", error: "result_not_recorded" };
    } catch {
      return { ok: false, status: "UNKNOWN", error: "result_not_recorded" };
    }
  };
  try {
    const claim = await deps.claim(operation, actor, token);
    if (claim.ok !== true) {
      return { ok: false, error: "operation_not_authorized" };
    }
    if (claim.action === "TERMINAL") {
      return { ok: true, status: claim.status, already_processed: true };
    }
    if (claim.action === "IN_PROGRESS") {
      return { ok: true, status: "IN_PROGRESS" };
    }
    if (
      !["SUBMIT_ONCE", "RECONCILE_ONLY"].includes(string(claim.action)) ||
      claim.token !== token || !claim.source
    ) {
      return { ok: false, error: "invalid_claim" };
    }
    claimed = true;
    reconcile = claim.action === "RECONCILE_ONLY";
    const source = claim.source as Source;
    if (
      !source.tenant_id || !uuid(source.student_id) ||
      !source.provider_payment_id || !source.customer_id ||
      !/^\d{4}-\d{2}-\d{2}$/.test(source.due_date) ||
      cents(source.value) === null
    ) {
      return await finish("REVIEW", { reason: "invalid_source_snapshot" });
    }
    const integration = await deps.resolve(
      source.tenant_id,
      reconcile ? "payment.read" : "payment.delete",
    );
    if (integration.tenantId !== source.tenant_id) {
      return await finish("REVIEW", { reason: "integration_scope_changed" });
    }
    const lookup = await deps.get(source, integration);
    if (lookup.status !== 200 || !matchesInvoice(source, lookup.body)) {
      return await finish(reconcile ? "UNKNOWN" : "REVIEW", {
        reason: lookup.status === 404
          ? "provider_not_found_not_deletion_proof"
          : "provider_identity_or_lookup_failed",
        http_status: lookup.status,
      });
    }
    if (
      lookup.body.deleted === true &&
      !["PENDING", "OVERDUE", "CANCELLED", "DELETED"].includes(
        string(lookup.body.status),
      )
    ) {
      return await finish("REVIEW", {
        reason: "deleted_invoice_has_financial_evidence",
        ...safeProof(lookup.body),
      });
    }
    if (lookup.body.deleted === true) {
      return await finish("GET_DELETED", safeProof(lookup.body));
    }
    // A fresh GET proving that the invoice remains live resolves uncertainty,
    // but never silently creates a second destructive attempt.
    if (reconcile) {
      return await finish("REVIEW", {
        reason: "provider_still_live_manual_review_required",
        ...safeProof(lookup.body),
      });
    }
    if (
      !["PENDING", "OVERDUE"].includes(string(lookup.body.status)) ||
      !(await deps.verifyCanonical(source, lookup.body, integration))
    ) {
      return await finish("REVIEW", {
        reason: "invoice_not_pending_or_identity_unproven",
        ...safeProof(lookup.body),
      });
    }
    const currentIntegration = await deps.revalidate(
      source.tenant_id,
      integration,
    );
    const boundary = await deps.begin(
      operation,
      actor,
      token,
      safeProof(lookup.body),
      {
        tenant_id: currentIntegration.tenantId,
        integration_id: currentIntegration.integrationId,
        version: currentIntegration.version,
        environment: currentIntegration.environment,
        mode: currentIntegration.mode,
      },
    );
    if (boundary.ok !== true) {
      return await finish("REVIEW", {
        reason: "source_or_authority_changed_before_delete",
      });
    }
    crossedBoundary = true;
    const removed = await deps.remove(source, currentIntegration);
    if (
      removed.status === 200 && removed.body.deleted === true &&
      removed.body.id === source.provider_payment_id
    ) {
      return await finish("DELETE_CONFIRMED", {
        id: removed.body.id,
        deleted: true,
      });
    }
    return await finish("UNKNOWN", {
      reason: "delete_not_proven",
      http_status: removed.status,
    });
  } catch {
    return claimed
      ? await finish(crossedBoundary || reconcile ? "UNKNOWN" : "REVIEW", {
        reason: crossedBoundary
          ? "delete_response_uncertain"
          : reconcile
          ? "reconciliation_unavailable"
          : "precheck_unavailable",
      })
      : { ok: false, error: "operation_unavailable" };
  }
}
