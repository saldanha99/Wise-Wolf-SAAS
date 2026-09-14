import {
  resolveAsaasIntegration,
  type ResolvedAsaasIntegration,
} from "../_shared/tenant-integration-broker.ts";

type Row = Record<string, unknown>;
export const BOUND_PAYMENT_COLUMNS =
  "id,tenant_id,student_id,asaas_payment_id,asaas_id,provider_customer_id,value,status,provider_status,refunded_amount,due_date,raw_payload,updated_at,authoritative_subscription_id,last_authoritative_observed_at,last_provider_event_id,last_provider_event_at,last_provider_event_rank";
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const row = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Row
    : {};
const cents = (value: unknown) =>
  typeof value === "number" || typeof value === "string"
    ? Math.round(Number(value) * 100)
    : NaN;
export class BoundPaymentObservationError extends Error {
  constructor(readonly code: string, readonly retryable = false) {
    super(code);
    this.name = "BoundPaymentObservationError";
  }
}
function reject(code: string): never {
  throw new BoundPaymentObservationError(code);
}
function integrationIdentity(value: ResolvedAsaasIntegration) {
  return JSON.stringify([
    value.integrationId,
    value.tenantId,
    value.version,
    value.mode,
    value.environment,
    value.baseUrl,
  ]);
}
function financialSnapshot(value: Row): string {
  return JSON.stringify(
    [
      "id",
      "customer",
      "subscription",
      "externalReference",
      "value",
      "status",
      "dueDate",
      "paymentDate",
      "creditDate",
      "estimatedCreditDate",
      "deleted",
      "refundedValue",
      "refunds",
      "chargeback",
    ].map((key) => value[key] ?? null),
  );
}

/** Provider responses may contain card tokens or personal details. Only the
 * financial proof fields cross the database boundary. */
export function minimalBoundProviderSnapshot(value: Row, parent = false): Row {
  const fields = parent
    ? ["id", "customer", "status", "deleted", "externalReference"]
    : [
      "id",
      "customer",
      "subscription",
      "externalReference",
      "value",
      "status",
      "dueDate",
      "paymentDate",
      "creditDate",
      "estimatedCreditDate",
      "deleted",
      "refundedValue",
    ];
  const result: Row = {};
  for (const field of fields) {
    if (value[field] !== undefined) result[field] = value[field];
  }
  if (!parent && Array.isArray(value.refunds)) {
    result.refunds = value.refunds.map((refund) => {
      const item = row(refund);
      return Object.fromEntries(
        ["id", "status", "value"].filter((field) => item[field] !== undefined)
          .map((field) => [field, item[field]]),
      );
    });
  }
  if (!parent && value.chargeback !== undefined && value.chargeback !== null) {
    result.chargeback = {
      status: text(row(value.chargeback).status) || "UNKNOWN",
    };
  }
  return result;
}

/** Identity only: status/due dates come from the fresh GET, not the old local
 * subscription pointer. SQL repeats these checks under locks before updating. */
export function validateBoundPaymentEvidence(
  local: Row,
  payment: Row,
  parent: Row | null,
  event?: Row,
): void {
  if (
    [
      "REFUNDED",
      "REFUND_REQUESTED",
      "REFUND_IN_PROGRESS",
      "CHARGEBACK_REQUESTED",
      "CHARGEBACK_DISPUTE",
      "AWAITING_CHARGEBACK_REVERSAL",
      "DELETED",
      "CANCELLED",
    ]
      .includes(text(local.provider_status).toUpperCase())
  ) {
    reject("bound_local_financial_review_required");
  }
  const ids = [
    ...new Set(
      [local.asaas_payment_id, local.asaas_id].map(text).filter(Boolean),
    ),
  ];
  if (
    !text(local.id) || !text(local.tenant_id) || !text(local.student_id) ||
    ids.length !== 1 || ids[0] !== text(payment.id)
  ) reject("bound_payment_identity_mismatch");
  if (
    !/^pay_[A-Za-z0-9]+$/.test(ids[0]) ||
    !/^cus_[A-Za-z0-9]+$/.test(text(payment.customer))
  ) reject("bound_provider_identity_invalid");
  if (
    text(local.provider_customer_id) &&
    text(local.provider_customer_id) !== text(payment.customer)
  ) reject("bound_customer_mismatch");
  if (
    !Number.isFinite(cents(payment.value)) || cents(payment.value) <= 0 ||
    cents(payment.value) !== cents(local.value)
  ) reject("bound_amount_mismatch");
  if (
    Number(local.refunded_amount ?? 0) > 0 ||
    Number(payment.refundedValue ?? 0) > 0 || payment.deleted === true ||
    (payment.chargeback !== undefined && payment.chargeback !== null) ||
    row(row(local.raw_payload).payment).chargeback != null ||
    (Array.isArray(payment.refunds) &&
      payment.refunds.some((refund) =>
        ["DONE", "REQUESTED", "IN_PROGRESS"].includes(text(row(refund).status))
      ))
  ) reject("bound_payment_reversal_present");
  if (
    !["CONFIRMED", "RECEIVED", "RECEIVED_IN_CASH"].includes(
      text(payment.status),
    )
  ) reject("bound_payment_not_positive_proof");
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(text(payment.dueDate)) ||
    (payment.status === "RECEIVED" &&
      !/^\d{4}-\d{2}-\d{2}$/.test(text(payment.creditDate))) ||
    (payment.status === "RECEIVED_IN_CASH" &&
      !/^\d{4}-\d{2}-\d{2}$/.test(text(payment.paymentDate)))
  ) reject("bound_payment_dates_unproven");
  const raw = row(local.raw_payload);
  const knownSubscription = text(local.authoritative_subscription_id) ||
    text(row(raw.payment).subscription) || text(raw.subscription);
  const subscription = text(payment.subscription);
  if (knownSubscription && knownSubscription !== subscription) {
    reject("bound_subscription_changed");
  }
  if (subscription) {
    if (
      !parent || text(parent.id) !== subscription ||
      text(parent.customer) !== text(payment.customer) ||
      parent.deleted === true ||
      !["ACTIVE", "INACTIVE", "EXPIRED"].includes(text(parent.status))
    ) reject("bound_parent_identity_mismatch");
  } else if (parent) reject("bound_parent_unexpected");
  if (
    event &&
    (text(event.id) !== ids[0] ||
      text(event.customer) !== text(payment.customer) ||
      text(event.subscription) !== subscription ||
      cents(event.value) !== cents(payment.value))
  ) reject("bound_event_identity_mismatch");
}

interface Dependencies {
  resolve?(
    client: any,
    tenantId: string,
    purpose: "payment.read" | "subscription.read",
  ): Promise<ResolvedAsaasIntegration>;
  get?(integration: ResolvedAsaasIntegration, path: string): Promise<Row>;
}
async function providerGet(
  integration: ResolvedAsaasIntegration,
  path: string,
  timeoutMs = 8_000,
): Promise<Row> {
  let response: Response;
  try {
    response = await fetch(`${integration.baseUrl}${path}`, {
      method: "GET",
      headers: { accept: "application/json", access_token: integration.apiKey },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
  } catch {
    throw new BoundPaymentObservationError("bound_provider_unavailable", true);
  }
  if (!response.ok) {
    throw new BoundPaymentObservationError(
      "bound_provider_lookup_rejected",
      response.status === 429 || response.status >= 500,
    );
  }
  return row(await response.json().catch(() => null));
}

export async function observeBoundPayment(
  client: any,
  localPaymentId: string,
  tenantId: string,
  eventPayload?: Row,
  dependencies: Dependencies = {},
): Promise<Row> {
  const loaded = await client.from("student_payments").select(
    BOUND_PAYMENT_COLUMNS,
  ).eq("id", localPaymentId).eq("tenant_id", tenantId).maybeSingle();
  if (loaded.error) {
    throw new BoundPaymentObservationError(
      "bound_local_lookup_unavailable",
      true,
    );
  }
  const local = row(loaded.data);
  if (!local.id || !local.student_id || local.tenant_id !== tenantId) {
    reject("bound_local_payment_missing");
  }
  const providerIds = [
    ...new Set(
      [local.asaas_payment_id, local.asaas_id].map(text).filter(Boolean),
    ),
  ];
  if (providerIds.length !== 1 || !/^pay_[A-Za-z0-9]+$/.test(providerIds[0])) {
    reject("bound_provider_alias_ambiguous");
  }
  const resolve = dependencies.resolve ?? resolveAsaasIntegration;
  const deadline = Date.now() + 20_000;
  const get = async (integration: ResolvedAsaasIntegration, path: string) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new BoundPaymentObservationError(
        "bound_provider_deadline_exceeded",
        true,
      );
    }
    const response = dependencies.get
      ? await dependencies.get(integration, path)
      : await providerGet(integration, path, Math.min(8_000, remaining));
    return minimalBoundProviderSnapshot(
      response,
      path.startsWith("/subscriptions/"),
    );
  };
  const integration = await resolve(client, tenantId, "payment.read");
  const payment = await get(
    integration,
    `/payments/${encodeURIComponent(providerIds[0])}`,
  );
  let parent: Row | null = null;
  if (text(payment.subscription)) {
    const parentIntegration = await resolve(
      client,
      tenantId,
      "subscription.read",
    );
    if (
      integrationIdentity(parentIntegration) !==
        integrationIdentity(integration) ||
      parentIntegration.apiKey !== integration.apiKey
    ) reject("bound_integration_changed");
    parent = await get(
      parentIntegration,
      `/subscriptions/${encodeURIComponent(text(payment.subscription))}`,
    );
  }
  validateBoundPaymentEvidence(
    local,
    payment,
    parent,
    eventPayload ? row(eventPayload.payment) : undefined,
  );
  // Re-read the payment after its parent so a rebind/value/status change during
  // verification cannot authorize the earlier mixed snapshot.
  const freshPayment = await get(
    integration,
    `/payments/${encodeURIComponent(providerIds[0])}`,
  );
  if (financialSnapshot(freshPayment) !== financialSnapshot(payment)) {
    throw new BoundPaymentObservationError(
      "bound_provider_snapshot_changed",
      true,
    );
  }
  if (parent) {
    const freshParent = await get(
      integration,
      `/subscriptions/${encodeURIComponent(text(payment.subscription))}`,
    );
    if (
      JSON.stringify([
        freshParent.id,
        freshParent.customer,
        freshParent.status,
        freshParent.externalReference ?? null,
        freshParent.deleted ?? null,
      ]) !==
        JSON.stringify([
          parent.id,
          parent.customer,
          parent.status,
          parent.externalReference ?? null,
          parent.deleted ?? null,
        ])
    ) {
      throw new BoundPaymentObservationError(
        "bound_parent_snapshot_changed",
        true,
      );
    }
  }
  const observedAt = new Date().toISOString();
  const finalIntegration = await resolve(client, tenantId, "payment.read");
  if (
    integrationIdentity(finalIntegration) !==
      integrationIdentity(integration) ||
    finalIntegration.apiKey !== integration.apiKey
  ) reject("bound_integration_changed");
  if (Date.now() > deadline) {
    throw new BoundPaymentObservationError(
      "bound_provider_deadline_exceeded",
      true,
    );
  }
  if (eventPayload) {
    const eventStatus = text(row(eventPayload.payment).status);
    if (eventStatus !== text(payment.status)) {
      if (
        eventStatus === "CONFIRMED" &&
        ["RECEIVED", "RECEIVED_IN_CASH"].includes(text(payment.status))
      ) return { ok: true, action: "IGNORED", id: local.id };
      reject("bound_event_status_not_corroborated");
    }
  }
  const applied = await client.rpc(
    "apply_authoritative_bound_student_payment",
    {
      p_expected_local_snapshot: local,
      p_integration_id: finalIntegration.integrationId,
      p_integration_version: finalIntegration.version,
      p_integration_mode: finalIntegration.mode,
      p_authoritative_payment: payment,
      p_authoritative_subscription: parent,
      p_observed_at: observedAt,
      p_source_event_id: eventPayload ? text(eventPayload.id) : null,
    },
  );
  if (applied.error) {
    throw new BoundPaymentObservationError("bound_database_unavailable", true);
  }
  const result = row(applied.data);
  if (result.ok !== true) {
    reject(text(result.reason) || "bound_observation_not_applied");
  }
  if (result.action !== "IGNORED") {
    const recompute = await client.rpc("recompute_student_financial_status", {
      p_tenant_id: tenantId,
      p_student_id: local.student_id,
    });
    if (recompute.error || row(recompute.data).ok !== true) {
      throw new BoundPaymentObservationError(
        "bound_financial_recompute_unavailable",
        true,
      );
    }
  }
  return result;
}
