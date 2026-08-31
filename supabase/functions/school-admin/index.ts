/// <reference lib="deno.ns" />

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  createClient,
  type SupabaseClient,
} from "https://esm.sh/@supabase/supabase-js@2.93.3";
import {
  AsaasCapabilityFenceError,
  type AsaasMutationPurpose,
  revalidateAsaasMutationCapability,
} from "../_shared/asaas-capability-fence.ts";
import { guardAsaasMutationTarget } from "../_shared/asaas-mutation-guard.ts";
import {
  authorizeRequest,
  methodNotAllowed,
  type RequestAuthContext,
} from "../_shared/request-auth.ts";
import {
  type AsaasIntegrationPurpose,
  resolveAsaasIntegration,
  type ResolvedAsaasIntegration,
} from "../_shared/tenant-integration-broker.ts";
import {
  enrollmentLeadMatchesTrial,
  hasExclusiveActiveTargetMembership,
  type LifecycleStatus,
  normalizeEnrollmentPlan,
  normalizeSchoolAdminAction,
  STUDENT_OFFBOARDING_BILLING_POLICIES,
  type StudentOffboardingBillingPolicy,
} from "./core.ts";

const MAX_BODY_BYTES = 16_384;
const TERMINAL_PAYMENT_STATUSES = new Set([
  "RECEIVED",
  "CONFIRMED",
  "RECEIVED_IN_CASH",
  "REFUNDED",
  "PARTIALLY_REFUNDED",
  "CHARGEBACK_REQUESTED",
  "CHARGEBACK_DISPUTE",
  "AWAITING_CHARGEBACK_REVERSAL",
  "DUNNING_RECEIVED",
  "DUNNING_REQUESTED",
]);
const DELETABLE_PAYMENT_STATUSES = new Set(["PENDING", "OVERDUE"]);
const DELETED_UNSETTLED_PAYMENT_STATUSES = new Set([
  ...DELETABLE_PAYMENT_STATUSES,
  "CANCELLED",
  "DELETED",
]);
const PROVIDER_CANCELLED_PAYMENT_STATUSES = new Set(["CANCELLED", "DELETED"]);
const NON_LIVE_COMPETENCE_PAYMENT_STATUSES = new Set([
  "CANCELLED",
  "DELETED",
  "REFUNDED",
  "REVERSED",
]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function requestBody(req: Request): Promise<Record<string, unknown>> {
  const declaredLength = Number(req.headers.get("content-length") || "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new ApiError(413, "PAYLOAD_TOO_LARGE", "Request is too large");
  }
  const raw = await req.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    throw new ApiError(413, "PAYLOAD_TOO_LARGE", "Request is too large");
  }
  try {
    const parsed = JSON.parse(raw || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not_an_object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Request must be valid JSON");
  }
}

async function resolveActiveTenant(
  context: RequestAuthContext,
): Promise<string> {
  if (context.profile?.role === "SCHOOL_ADMIN" && context.profile.tenant_id) {
    return context.profile.tenant_id;
  }
  if (context.profile?.role !== "SUPER_ADMIN" || !context.userId) {
    throw new ApiError(403, "ROLE_FORBIDDEN", "Administrator access required");
  }

  const { data: selectedContext, error: contextError } = await context.admin
    .from("tenant_user_contexts")
    .select("tenant_id")
    .eq("user_id", context.userId)
    .maybeSingle();
  if (contextError || !selectedContext?.tenant_id) {
    throw new ApiError(
      403,
      "ACTIVE_TENANT_REQUIRED",
      "Select an active tenant before continuing",
    );
  }

  const { data: membership, error: membershipError } = await context.admin
    .from("tenant_memberships")
    .select("tenant_id")
    .eq("user_id", context.userId)
    .eq("tenant_id", selectedContext.tenant_id)
    .eq("status", "ACTIVE")
    .maybeSingle();
  if (membershipError || !membership) {
    throw new ApiError(
      403,
      "ACTIVE_TENANT_REQUIRED",
      "The selected tenant membership is not active",
    );
  }
  return selectedContext.tenant_id;
}

async function requireOperationalTenant(
  admin: SupabaseClient,
  tenantId: string,
): Promise<void> {
  const { data, error } = await admin.from("tenants")
    .select("saas_status")
    .eq("id", tenantId)
    .maybeSingle();
  if (error) {
    throw new ApiError(
      503,
      "TENANT_STATUS_UNAVAILABLE",
      "Tenant status is temporarily unavailable",
    );
  }
  const status = String(data?.saas_status || "").trim().toLowerCase();
  if (!new Set(["active", "trial", "trialing"]).has(status)) {
    throw new ApiError(
      403,
      "TENANT_INACTIVE",
      "The selected tenant is not active",
    );
  }
}

function clientIp(req: Request): string | null {
  const value = req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0] || "";
  const normalized = value.trim();
  return normalized && normalized.length <= 64 ? normalized : null;
}

async function writeAudit(
  admin: SupabaseClient,
  context: RequestAuthContext,
  tenantId: string,
  req: Request,
  values: {
    action: string;
    resourceType: string;
    resourceId: string;
    oldValues: Record<string, unknown> | null;
    newValues: Record<string, unknown>;
  },
  required = false,
): Promise<void> {
  const { error } = await admin.from("audit_logs").insert({
    tenant_id: tenantId,
    user_id: context.userId,
    user_role: context.profile?.role,
    action: values.action,
    resource_type: values.resourceType,
    resource_id: values.resourceId,
    old_values: values.oldValues,
    new_values: values.newValues,
    ip_address: clientIp(req),
  });
  if (error) {
    console.error("School admin audit write failed", { code: error.code });
    if (required) {
      throw new ApiError(
        503,
        "AUDIT_UNAVAILABLE",
        "The operation was not started because audit is unavailable",
      );
    }
  }
}

async function schoolAsaasIntegration(
  admin: SupabaseClient,
  tenantId: string,
  purpose: AsaasIntegrationPurpose,
): Promise<ResolvedAsaasIntegration> {
  try {
    return await resolveAsaasIntegration(admin, tenantId, purpose);
  } catch {
    throw new ApiError(
      503,
      "ASAAS_UNAVAILABLE",
      "Billing is unavailable for the selected tenant",
    );
  }
}

async function callAsaas(
  admin: SupabaseClient,
  tenantId: string,
  purpose: AsaasMutationPurpose,
  expectedIntegration: ResolvedAsaasIntegration,
  path: string,
  method: "DELETE" | "PUT",
  body?: Record<string, unknown>,
): Promise<number> {
  let integration: ResolvedAsaasIntegration;
  try {
    integration = await revalidateAsaasMutationCapability(admin, {
      tenantId,
      purpose,
      expected: expectedIntegration,
    });
  } catch (error) {
    const unavailable = error instanceof AsaasCapabilityFenceError &&
      error.failure === "UNAVAILABLE";
    throw new ApiError(
      unavailable ? 503 : 409,
      unavailable ? "ASAAS_UNAVAILABLE" : "ASAAS_INTEGRATION_CHANGED",
      unavailable
        ? "Billing is unavailable for the selected tenant"
        : "Billing integration changed before provider mutation",
    );
  }
  let response: Response;
  try {
    response = await fetch(`${integration.baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        access_token: integration.apiKey,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ApiError(
      502,
      "ASAAS_REQUEST_FAILED",
      "Billing provider did not respond",
    );
  }
  if (!response.ok && !(method === "DELETE" && response.status === 404)) {
    throw new ApiError(
      502,
      "ASAAS_REQUEST_FAILED",
      "Billing provider rejected the operation",
    );
  }
  return response.status;
}

async function requireAsaasMutationIdentity(
  admin: SupabaseClient,
  integration: ResolvedAsaasIntegration,
  input: {
    operation: string;
    tenantId: string;
    studentId: string;
    resource: "subscription" | "payment";
    entityId: string;
    customerId: string;
    subscriptionId: string | null;
    subscriptionMatch: "entity_id" | "required" | "optional";
  },
): Promise<
  | { kind: "PRESENT"; entity: Record<string, unknown> }
  | { kind: "ABSENT" }
> {
  const guard = await guardAsaasMutationTarget({
    admin,
    baseUrl: integration.baseUrl,
    apiKey: integration.apiKey,
    operation: input.operation,
    target: {
      tenantId: input.tenantId,
      studentId: input.studentId,
      resource: input.resource,
      entityId: input.entityId,
      customerId: input.customerId,
      subscriptionId: input.subscriptionId,
      subscriptionMatch: input.subscriptionMatch,
    },
  });
  if (guard.ok === false) {
    if (guard.code === "NOT_FOUND") {
      // DELETE is idempotent: this is also the recovery path after the
      // provider committed a deletion but the previous HTTP response was
      // lost. Preserve an auditable signal instead of blocking local
      // offboarding forever.
      await admin.from("asaas_reconciliation_issues").insert({
        run_id: null,
        tenant_id: input.tenantId,
        source: "MUTATION_GUARD",
        kind: "ASAAS_MUTATION_TARGET_ALREADY_ABSENT",
        severity: "HIGH",
        provider_entity_id: input.entityId,
        local_entity_id: input.studentId,
        fingerprint:
          `asaas-mutation-absent:${input.resource}:${input.entityId}`,
        details: {
          operation: input.operation,
          desiredState: "DELETED",
        },
      });
      return { kind: "ABSENT" };
    }
    throw new ApiError(
      409,
      "ASAAS_IDENTITY_MISMATCH",
      "Billing binding requires review before this operation",
    );
  }
  return { kind: "PRESENT", entity: guard.entity };
}

function normalizedProviderText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

type DeletedOffboardingPaymentProofInput = {
  targetStatus: string;
  billingCancelFromDate: string | null;
  frozen: {
    id: string;
    asaasPaymentId: string;
    dueDate: string;
    value: number;
    status: string;
  };
  local: {
    id: unknown;
    primaryProviderId: unknown;
    legacyProviderId: unknown;
    dueDate: unknown;
    value: unknown;
    status: unknown;
    providerStatus: unknown;
    paidAt: unknown;
    creditedAt: unknown;
    ledgerEntryCreated: unknown;
    refundedAmount: unknown;
  };
  provider: Record<string, unknown>;
  customerId: string;
  subscriptionId: string;
};

export type DeletedOffboardingPaymentProofDisposition =
  | "OPEN_DELETABLE"
  | "ALREADY_RECONCILED";

export function classifyExactDeletedOffboardingPaymentProof(
  input: DeletedOffboardingPaymentProofInput,
): DeletedOffboardingPaymentProofDisposition | null {
  const cancelFrom = normalizedProviderText(input.billingCancelFromDate);
  const primaryProviderId = normalizedProviderText(
    input.local.primaryProviderId,
  );
  const legacyProviderId = normalizedProviderText(input.local.legacyProviderId);
  const localProviderId = primaryProviderId || legacyProviderId;
  const providerStatus = normalizedProviderText(input.provider.status)
    .toUpperCase();
  const localProviderStatus = normalizedProviderText(
    input.local.providerStatus || input.local.status,
  ).toUpperCase();
  const localAccountingStatus = normalizedProviderText(input.local.status)
    .toUpperCase();
  const frozenAccountingStatus = normalizedProviderText(input.frozen.status)
    .toUpperCase();
  const localValue = Number(input.local.value);
  const providerValue = Number(input.provider.value);
  const refundedAmount = Number(input.local.refundedAmount || 0);

  const exactUnsettledDeletion = input.targetStatus === "offboarded" &&
    /^\d{4}-\d{2}-\d{2}$/.test(cancelFrom) &&
    input.frozen.dueDate >= cancelFrom &&
    Boolean(input.frozen.asaasPaymentId) &&
    DELETABLE_PAYMENT_STATUSES.has(frozenAccountingStatus) &&
    input.local.id === input.frozen.id &&
    (!primaryProviderId || !legacyProviderId ||
      primaryProviderId === legacyProviderId) &&
    localProviderId === input.frozen.asaasPaymentId &&
    normalizedProviderText(input.local.dueDate) === input.frozen.dueDate &&
    Number.isFinite(localValue) && localValue > 0 &&
    Math.round(localValue * 100) === Math.round(input.frozen.value * 100) &&
    input.local.paidAt == null && input.local.creditedAt == null &&
    input.local.ledgerEntryCreated !== true && refundedAmount === 0 &&
    input.provider.deleted === true &&
    normalizedProviderText(input.provider.id) === input.frozen.asaasPaymentId &&
    normalizedProviderText(input.provider.customer) === input.customerId &&
    normalizedProviderText(input.provider.subscription) ===
      input.subscriptionId &&
    normalizedProviderText(input.provider.dueDate) === input.frozen.dueDate &&
    Number.isFinite(providerValue) && providerValue > 0 &&
    Math.round(providerValue * 100) ===
      Math.round(input.frozen.value * 100) &&
    DELETED_UNSETTLED_PAYMENT_STATUSES.has(providerStatus) &&
    !normalizedProviderText(input.provider.paymentDate) &&
    !normalizedProviderText(input.provider.creditDate);
  if (!exactUnsettledDeletion) return null;
  if (
    DELETABLE_PAYMENT_STATUSES.has(localAccountingStatus) &&
    localAccountingStatus === frozenAccountingStatus &&
    localProviderStatus === providerStatus &&
    DELETABLE_PAYMENT_STATUSES.has(providerStatus)
  ) {
    return "OPEN_DELETABLE";
  }
  if (
    localAccountingStatus === "CANCELLED" &&
    localProviderStatus === "DELETED"
  ) {
    return "ALREADY_RECONCILED";
  }
  return null;
}

export function isExactDeletedOffboardingPaymentProof(
  input: DeletedOffboardingPaymentProofInput,
): boolean {
  return classifyExactDeletedOffboardingPaymentProof(input) !== null;
}

/**
 * Legacy recurring resources predate canonical externalReference values.  An
 * administrator's fenced offboarding may still stop them, but only after an
 * authoritative GET and a second exact comparison with the immutable local
 * snapshot.  This exception is intentionally private to offboarding and never
 * weakens the shared mutation guard used by other operations.
 */
async function requireAsaasOffboardingIdentity(
  admin: SupabaseClient,
  integration: ResolvedAsaasIntegration,
  input: {
    operation: string;
    tenantId: string;
    studentId: string;
    resource: "subscription" | "payment";
    entityId: string;
    customerId: string;
    subscriptionId: string | null;
    subscriptionMatch: "entity_id" | "required" | "optional";
    localPayment?: OffboardingPaymentSnapshot;
    paymentDisposition?: "DELETE" | "PRESERVE";
  },
): Promise<
  | { kind: "PRESENT"; entity: Record<string, unknown> }
  | {
    kind: "ABSENT";
    evidence: "NOT_FOUND" | "DELETED";
    entity?: Record<string, unknown>;
  }
> {
  let response: Response;
  try {
    response = await fetch(
      `${integration.baseUrl}/${
        input.resource === "subscription" ? "subscriptions" : "payments"
      }/${encodeURIComponent(input.entityId)}`,
      {
        method: "GET",
        headers: { access_token: integration.apiKey },
        signal: AbortSignal.timeout(12_000),
      },
    );
  } catch {
    throw new ApiError(
      503,
      "ASAAS_IDENTITY_UNAVAILABLE",
      "Billing identity could not be verified",
    );
  }
  if (response.status === 404) {
    return { kind: "ABSENT", evidence: "NOT_FOUND" };
  }
  if (!response.ok) {
    throw new ApiError(
      503,
      "ASAAS_IDENTITY_UNAVAILABLE",
      "Billing identity could not be verified",
    );
  }
  const entity = await response.json().catch(() => null) as
    | Record<string, unknown>
    | null;
  if (!entity) {
    throw new ApiError(
      503,
      "ASAAS_IDENTITY_UNAVAILABLE",
      "Billing identity could not be verified",
    );
  }

  // Present modern resources stay on the canonical guard, including the
  // offer lookup for enrollment references. Deleted objects still go through
  // the exact frozen local/profile proof below so retries can converge.
  if (
    normalizedProviderText(entity.externalReference) && entity.deleted !== true
  ) {
    const canonical = await requireAsaasMutationIdentity(
      admin,
      integration,
      input,
    );
    if (canonical.kind === "ABSENT") {
      return { kind: "ABSENT", evidence: "NOT_FOUND" };
    }
  }

  const providerSubscription = normalizedProviderText(entity.subscription);
  const subscriptionMatches = input.resource === "subscription"
    ? input.subscriptionId === input.entityId
    : input.localPayment
    ? Boolean(input.subscriptionId) &&
      providerSubscription === input.subscriptionId
    : input.subscriptionMatch === "required"
    ? Boolean(input.subscriptionId) &&
      providerSubscription === input.subscriptionId
    : !providerSubscription || providerSubscription === input.subscriptionId;
  const baseMatches = normalizedProviderText(entity.id) === input.entityId &&
    normalizedProviderText(entity.customer) === input.customerId &&
    subscriptionMatches;
  const { data: customerBindings, error: customerBindingError } = await admin
    .from("profiles")
    .select("id,tenant_id,role,subscription_id")
    .eq("asaas_customer_id", input.customerId)
    .limit(2);
  let subscriptionBindings: Array<{ id: string }> = [];
  let subscriptionBindingError: unknown = null;
  if (input.subscriptionId) {
    const subscriptionResult = await admin.from("profiles")
      .select("id")
      .eq("subscription_id", input.subscriptionId)
      .limit(2);
    subscriptionBindings = subscriptionResult.data || [];
    subscriptionBindingError = subscriptionResult.error;
  }
  const targetBinding = customerBindings?.[0];
  const targetSubscriptionId = normalizedProviderText(
    targetBinding?.subscription_id,
  );
  if (
    !baseMatches || customerBindingError || subscriptionBindingError ||
    customerBindings?.length !== 1 || targetBinding?.id !== input.studentId ||
    targetBinding?.tenant_id !== input.tenantId ||
    targetBinding?.role !== "STUDENT" ||
    targetSubscriptionId !== (input.subscriptionId || "") ||
    (input.subscriptionId &&
      (subscriptionBindings.length !== 1 ||
        subscriptionBindings[0]?.id !== input.studentId))
  ) {
    throw new ApiError(
      409,
      "ASAAS_IDENTITY_MISMATCH",
      "Billing binding requires review before this operation",
    );
  }

  if (input.resource === "payment") {
    const expected = input.localPayment;
    const providerValue = Number(entity.value);
    const providerDueDate = normalizedProviderText(entity.dueDate);
    if (
      !expected || expected.asaasPaymentId !== input.entityId ||
      Math.round(providerValue * 100) !== Math.round(expected.value * 100) ||
      providerDueDate !== expected.dueDate
    ) {
      throw new ApiError(
        409,
        "ASAAS_IDENTITY_MISMATCH",
        "Billing binding requires review before this operation",
      );
    }
    const { data: local, error: localError } = await admin
      .from("student_payments")
      .select(
        "id,student_id,tenant_id,asaas_payment_id,asaas_id,value,due_date,status,provider_status",
      )
      .eq("id", expected.id)
      .eq("tenant_id", input.tenantId)
      .eq("student_id", input.studentId)
      .maybeSingle();
    const localProviderId = local
      ? normalizedProviderText(local.asaas_payment_id) ||
        normalizedProviderText(local.asaas_id)
      : "";
    const localStatus = String(local?.status || "").trim().toUpperCase();
    const providerStatus = normalizedProviderText(entity.status).toUpperCase();
    const localProviderStatus = normalizedProviderText(
      local?.provider_status || local?.status,
    ).toUpperCase();
    const localStatusMatches = input.paymentDisposition === "PRESERVE"
      ? entity.deleted !== true && localProviderStatus === providerStatus
      : DELETABLE_PAYMENT_STATUSES.has(localStatus) ||
        (entity.deleted === true && localStatus === "CANCELLED" &&
          localProviderStatus === "DELETED");
    if (
      localError || !local ||
      localProviderId !== input.entityId ||
      Math.round(Number(local.value) * 100) !==
        Math.round(expected.value * 100) ||
      String(local.due_date || "") !== expected.dueDate ||
      !localStatusMatches
    ) {
      throw new ApiError(
        409,
        "OFFBOARDING_SNAPSHOT_MISMATCH",
        "The account billing snapshot changed and requires review",
      );
    }
  }

  // A deleted provider object is authoritative proof that no further DELETE
  // is needed. Its local row is still finalized through the frozen snapshot.
  if (entity.deleted === true) {
    return { kind: "ABSENT", evidence: "DELETED", entity };
  }
  return { kind: "PRESENT", entity };
}

type AsaasSubscriptionPaymentSnapshot = {
  id: string;
  customerId: string;
  subscriptionId: string;
  dueDate: string;
  value: number;
  status: string;
  deleted: boolean;
};

type AsaasCustomerSubscriptionSnapshot = {
  id: string;
  customerId: string;
  status: string;
  deleted: boolean;
};

async function listAsaasSubscriptionPayments(
  integration: ResolvedAsaasIntegration,
  subscriptionId: string,
  customerId: string,
): Promise<AsaasSubscriptionPaymentSnapshot[]> {
  const payments: AsaasSubscriptionPaymentSnapshot[] = [];
  const seen = new Set<string>();
  const pageSize = 100;
  for (let offset = 0; offset < 2_000; offset += pageSize) {
    const url = new URL(
      `${integration.baseUrl.replace(/\/$/, "")}/subscriptions/${
        encodeURIComponent(subscriptionId)
      }/payments`,
    );
    url.searchParams.set("limit", String(pageSize));
    url.searchParams.set("offset", String(offset));
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: { access_token: integration.apiKey },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ApiError(
        503,
        "ASAAS_SUBSCRIPTION_PAYMENTS_UNAVAILABLE",
        "Subscription charges could not be verified",
      );
    }
    if (!response.ok) {
      throw new ApiError(
        503,
        "ASAAS_SUBSCRIPTION_PAYMENTS_UNAVAILABLE",
        "Subscription charges could not be verified",
      );
    }
    const body = await response.json().catch(() => null) as
      | Record<string, unknown>
      | null;
    const rows = Array.isArray(body?.data) ? body.data : null;
    if (!rows) {
      throw new ApiError(
        503,
        "ASAAS_SUBSCRIPTION_PAYMENTS_INVALID",
        "Subscription charges returned an invalid snapshot",
      );
    }
    for (const raw of rows) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new ApiError(
          503,
          "ASAAS_SUBSCRIPTION_PAYMENTS_INVALID",
          "Subscription charges returned an invalid snapshot",
        );
      }
      const row = raw as Record<string, unknown>;
      const id = normalizedProviderText(row.id);
      const rowCustomerId = normalizedProviderText(row.customer);
      const rowSubscriptionId = normalizedProviderText(row.subscription);
      const dueDate = normalizedProviderText(row.dueDate);
      const value = Number(row.value);
      const status = normalizedProviderText(row.status).toUpperCase();
      if (
        !id || id.length > 160 || seen.has(id) ||
        rowCustomerId !== customerId || rowSubscriptionId !== subscriptionId ||
        !/^\d{4}-\d{2}-\d{2}$/.test(dueDate) ||
        !Number.isFinite(value) || value <= 0 || !status
      ) {
        throw new ApiError(
          409,
          "ASAAS_SUBSCRIPTION_PAYMENT_IDENTITY_MISMATCH",
          "A subscription charge requires reconciliation",
        );
      }
      seen.add(id);
      payments.push({
        id,
        customerId: rowCustomerId,
        subscriptionId: rowSubscriptionId,
        dueDate,
        value,
        status,
        deleted: row.deleted === true,
      });
    }
    const hasMore = body?.hasMore === true;
    if (!hasMore) return payments;
    if (rows.length === 0) {
      throw new ApiError(
        503,
        "ASAAS_SUBSCRIPTION_PAYMENTS_INVALID",
        "Subscription charge pagination did not converge",
      );
    }
  }
  throw new ApiError(
    409,
    "ASAAS_SUBSCRIPTION_PAYMENTS_LIMIT",
    "The subscription has too many charges for an automatic lifecycle change",
  );
}

async function listAsaasCustomerSubscriptions(
  integration: ResolvedAsaasIntegration,
  customerId: string,
): Promise<AsaasCustomerSubscriptionSnapshot[]> {
  const subscriptions: AsaasCustomerSubscriptionSnapshot[] = [];
  const seen = new Set<string>();
  const pageSize = 100;
  for (let offset = 0; offset < 2_000; offset += pageSize) {
    const url = new URL(
      `${integration.baseUrl.replace(/\/$/, "")}/subscriptions`,
    );
    url.searchParams.set("customer", customerId);
    url.searchParams.set("includeDeleted", "true");
    url.searchParams.set("limit", String(pageSize));
    url.searchParams.set("offset", String(offset));
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: { access_token: integration.apiKey },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ApiError(
        503,
        "ASAAS_CUSTOMER_SUBSCRIPTIONS_UNAVAILABLE",
        "Customer subscriptions could not be verified",
      );
    }
    if (!response.ok) {
      throw new ApiError(
        503,
        "ASAAS_CUSTOMER_SUBSCRIPTIONS_UNAVAILABLE",
        "Customer subscriptions could not be verified",
      );
    }
    const body = await response.json().catch(() => null) as
      | Record<string, unknown>
      | null;
    const rows = Array.isArray(body?.data) ? body.data : null;
    if (!rows) {
      throw new ApiError(
        503,
        "ASAAS_CUSTOMER_SUBSCRIPTIONS_INVALID",
        "Customer subscriptions returned an invalid snapshot",
      );
    }
    for (const raw of rows) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new ApiError(
          503,
          "ASAAS_CUSTOMER_SUBSCRIPTIONS_INVALID",
          "Customer subscriptions returned an invalid snapshot",
        );
      }
      const row = raw as Record<string, unknown>;
      const id = normalizedProviderText(row.id);
      const rowCustomerId = normalizedProviderText(row.customer);
      const status = normalizedProviderText(row.status).toUpperCase();
      if (
        !id || id.length > 160 || seen.has(id) ||
        rowCustomerId !== customerId || !status
      ) {
        throw new ApiError(
          409,
          "ASAAS_CUSTOMER_SUBSCRIPTION_IDENTITY_MISMATCH",
          "A customer subscription requires reconciliation",
        );
      }
      seen.add(id);
      subscriptions.push({
        id,
        customerId: rowCustomerId,
        status,
        deleted: row.deleted === true,
      });
    }
    if (body?.hasMore !== true) return subscriptions;
    if (rows.length === 0) {
      throw new ApiError(
        503,
        "ASAAS_CUSTOMER_SUBSCRIPTIONS_INVALID",
        "Customer subscription pagination did not converge",
      );
    }
  }
  throw new ApiError(
    409,
    "ASAAS_CUSTOMER_SUBSCRIPTIONS_LIMIT",
    "The customer has too many subscriptions for an automatic lifecycle change",
  );
}

async function listAsaasCustomerPayments(
  integration: ResolvedAsaasIntegration,
  customerId: string,
): Promise<AsaasSubscriptionPaymentSnapshot[]> {
  const payments: AsaasSubscriptionPaymentSnapshot[] = [];
  const seen = new Set<string>();
  const pageSize = 100;
  for (let offset = 0; offset < 2_000; offset += pageSize) {
    const url = new URL(`${integration.baseUrl.replace(/\/$/, "")}/payments`);
    url.searchParams.set("customer", customerId);
    url.searchParams.set("limit", String(pageSize));
    url.searchParams.set("offset", String(offset));
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: { access_token: integration.apiKey },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ApiError(
        503,
        "ASAAS_CUSTOMER_PAYMENTS_UNAVAILABLE",
        "Customer charges could not be verified",
      );
    }
    if (!response.ok) {
      throw new ApiError(
        503,
        "ASAAS_CUSTOMER_PAYMENTS_UNAVAILABLE",
        "Customer charges could not be verified",
      );
    }
    const body = await response.json().catch(() => null) as
      | Record<string, unknown>
      | null;
    const rows = Array.isArray(body?.data) ? body.data : null;
    if (!rows) {
      throw new ApiError(
        503,
        "ASAAS_CUSTOMER_PAYMENTS_INVALID",
        "Customer charges returned an invalid snapshot",
      );
    }
    for (const raw of rows) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new ApiError(
          503,
          "ASAAS_CUSTOMER_PAYMENTS_INVALID",
          "Customer charges returned an invalid snapshot",
        );
      }
      const row = raw as Record<string, unknown>;
      const id = normalizedProviderText(row.id);
      const rowCustomerId = normalizedProviderText(row.customer);
      const subscriptionId = normalizedProviderText(row.subscription);
      const dueDate = normalizedProviderText(row.dueDate);
      const value = Number(row.value);
      const status = normalizedProviderText(row.status).toUpperCase();
      if (
        !id || id.length > 160 || seen.has(id) ||
        rowCustomerId !== customerId ||
        !/^\d{4}-\d{2}-\d{2}$/.test(dueDate) ||
        !Number.isFinite(value) || value <= 0 || !status
      ) {
        throw new ApiError(
          409,
          "ASAAS_CUSTOMER_PAYMENT_IDENTITY_MISMATCH",
          "A customer charge requires reconciliation",
        );
      }
      seen.add(id);
      payments.push({
        id,
        customerId: rowCustomerId,
        subscriptionId,
        dueDate,
        value,
        status,
        deleted: row.deleted === true,
      });
    }
    if (body?.hasMore !== true) return payments;
    if (rows.length === 0) {
      throw new ApiError(
        503,
        "ASAAS_CUSTOMER_PAYMENTS_INVALID",
        "Customer charge pagination did not converge",
      );
    }
  }
  throw new ApiError(
    409,
    "ASAAS_CUSTOMER_PAYMENTS_LIMIT",
    "The customer has too many charges for an automatic lifecycle change",
  );
}

function requireCompleteOffboardingPaymentSnapshot(
  claim: OffboardingClaim,
  providerPayments: AsaasSubscriptionPaymentSnapshot[],
): void {
  if (!claim.billingCancelFromDate) return;
  const localProviderIds = new Set(
    claim.payments.map((payment) => payment.asaasPaymentId).filter(Boolean),
  );
  for (const payment of providerPayments) {
    if (payment.deleted || payment.dueDate < claim.billingCancelFromDate) {
      continue;
    }
    if (DELETABLE_PAYMENT_STATUSES.has(payment.status)) {
      if (!localProviderIds.has(payment.id)) {
        throw new ApiError(
          409,
          "OFFBOARDING_PROVIDER_PAYMENT_UNSYNCED",
          "A provider charge is missing from the local billing snapshot",
        );
      }
      continue;
    }
    if (!new Set(["CANCELLED", "DELETED"]).has(payment.status)) {
      throw new ApiError(
        409,
        "OFFBOARDING_PROVIDER_PAYMENT_NOT_CANCELLABLE",
        "A provider charge in the cancellation period requires review",
      );
    }
  }
}

function requireOffboardingProviderCancellationComplete(
  claim: OffboardingClaim,
  providerPayments: AsaasSubscriptionPaymentSnapshot[],
): void {
  if (!claim.billingCancelFromDate) return;
  for (const payment of providerPayments) {
    if (payment.dueDate < claim.billingCancelFromDate) continue;
    if (
      payment.deleted || PROVIDER_CANCELLED_PAYMENT_STATUSES.has(payment.status)
    ) {
      continue;
    }
    throw new ApiError(
      409,
      "OFFBOARDING_PROVIDER_CANCELLATION_INCOMPLETE",
      "A provider charge survived the cancellation boundary and requires reconciliation",
    );
  }
}

type ProvenDeletedOpenPaymentState = {
  accountingStatus: "PENDING" | "OVERDUE";
  providerStatus: "PENDING" | "OVERDUE";
};

async function proveFrozenDeletedOffboardingPayments(
  admin: SupabaseClient,
  paymentIntegration: ResolvedAsaasIntegration | null,
  claim: OffboardingClaim,
  tenantId: string,
  studentId: string,
  providerPayments: AsaasSubscriptionPaymentSnapshot[],
): Promise<ReadonlyMap<string, ProvenDeletedOpenPaymentState>> {
  const proven = new Map<string, ProvenDeletedOpenPaymentState>();
  if (
    claim.targetStatus !== "offboarded" || !claim.billingCancelFromDate
  ) return proven;

  const liveProviderIds = new Set(
    providerPayments
      .filter((payment) =>
        !payment.deleted &&
        !PROVIDER_CANCELLED_PAYMENT_STATUSES.has(payment.status)
      )
      .map((payment) => payment.id),
  );
  for (const frozen of claim.payments) {
    if (!frozen.asaasPaymentId || liveProviderIds.has(frozen.asaasPaymentId)) {
      continue;
    }
    if (!paymentIntegration) {
      throw new ApiError(
        409,
        "OFFBOARDING_DELETED_PAYMENT_PROOF_UNAVAILABLE",
        "A locally open charge needs exact provider deletion evidence",
      );
    }

    const { data: local, error: localError } = await admin
      .from("student_payments")
      .select(
        "id,asaas_payment_id,asaas_id,value,due_date,status,provider_status,paid_at,credited_at,ledger_entry_created,refunded_amount",
      )
      .eq("id", frozen.id)
      .eq("tenant_id", tenantId)
      .eq("student_id", studentId)
      .maybeSingle();
    if (localError) {
      throw new ApiError(
        503,
        "SUBSCRIPTION_PAYMENT_SYNC_UNAVAILABLE",
        "Subscription charges could not be compared with the local ledger",
      );
    }
    if (!local) {
      throw new ApiError(
        409,
        "OFFBOARDING_SNAPSHOT_MISMATCH",
        "The account billing snapshot changed and requires review",
      );
    }

    const identity = await requireAsaasOffboardingIdentity(
      admin,
      paymentIntegration,
      {
        operation: "school_admin_offboarding_deleted_payment_inventory",
        tenantId,
        studentId,
        resource: "payment",
        entityId: frozen.asaasPaymentId,
        customerId: claim.customerId,
        subscriptionId: claim.subscriptionId || null,
        subscriptionMatch: "required",
        localPayment: frozen,
        paymentDisposition: "DELETE",
      },
    );
    const disposition = identity.kind === "ABSENT" &&
        identity.evidence === "DELETED" && identity.entity
      ? classifyExactDeletedOffboardingPaymentProof({
        targetStatus: claim.targetStatus,
        billingCancelFromDate: claim.billingCancelFromDate,
        frozen,
        local: {
          id: local.id,
          primaryProviderId: local.asaas_payment_id,
          legacyProviderId: local.asaas_id,
          dueDate: local.due_date,
          value: local.value,
          status: local.status,
          providerStatus: local.provider_status,
          paidAt: local.paid_at,
          creditedAt: local.credited_at,
          ledgerEntryCreated: local.ledger_entry_created,
          refundedAmount: local.refunded_amount,
        },
        provider: identity.entity,
        customerId: claim.customerId,
        subscriptionId: claim.subscriptionId,
      })
      : null;
    if (!disposition) {
      throw new ApiError(
        409,
        identity.kind === "ABSENT" && identity.evidence === "NOT_FOUND"
          ? "OFFBOARDING_DELETED_PAYMENT_NOT_PROVEN"
          : "SUBSCRIPTION_PAYMENT_LOCAL_ONLY",
        "A local open charge lacks exact provider deletion evidence",
      );
    }
    // A webhook may have already reconciled PAYMENT_DELETED while this
    // operation was between provider mutation and retry. Such a local row is
    // closed and therefore must not enter the narrowly-scoped local-open set.
    if (disposition === "OPEN_DELETABLE") {
      const accountingStatus = normalizedProviderText(local.status)
        .toUpperCase();
      const providerStatus = normalizedProviderText(
        local.provider_status || local.status,
      ).toUpperCase();
      if (
        !DELETABLE_PAYMENT_STATUSES.has(accountingStatus) ||
        !DELETABLE_PAYMENT_STATUSES.has(providerStatus)
      ) {
        throw new ApiError(
          409,
          "OFFBOARDING_DELETED_PAYMENT_LOCAL_STATE_CHANGED",
          "A proven deleted charge changed before offboarding could continue",
        );
      }
      proven.set(frozen.asaasPaymentId, {
        accountingStatus:
          accountingStatus as ProvenDeletedOpenPaymentState["accountingStatus"],
        providerStatus:
          providerStatus as ProvenDeletedOpenPaymentState["providerStatus"],
      });
    }
  }
  return proven;
}

async function requireSynchronizedLiveSubscriptionPayments(
  admin: SupabaseClient,
  tenantId: string,
  studentId: string,
  providerPayments: AsaasSubscriptionPaymentSnapshot[],
  provenDeletedOpenPayments: ReadonlyMap<
    string,
    ProvenDeletedOpenPaymentState
  > = new Map<string, ProvenDeletedOpenPaymentState>(),
): Promise<void> {
  const { data, error } = await admin.from("student_payments")
    .select(
      "id,asaas_payment_id,asaas_id,value,due_date,status,provider_status",
    )
    .eq("tenant_id", tenantId)
    .eq("student_id", studentId)
    .eq("payment_type", "SUBSCRIPTION");
  if (error) {
    throw new ApiError(
      503,
      "SUBSCRIPTION_PAYMENT_SYNC_UNAVAILABLE",
      "Subscription charges could not be compared with the local ledger",
    );
  }
  const localByProvider = new Map<string, Array<Record<string, unknown>>>();
  const collectibleLocalRows: Array<{
    providerId: string;
    status: string;
    accountingStatus: string;
  }> = [];
  for (const payment of data || []) {
    const primaryId = normalizedProviderText(payment.asaas_payment_id);
    const legacyId = normalizedProviderText(payment.asaas_id);
    if (primaryId && legacyId && primaryId !== legacyId) {
      throw new ApiError(
        409,
        "SUBSCRIPTION_PAYMENT_LOCAL_BINDING_DIVERGENT",
        "A local charge has divergent provider identifiers",
      );
    }
    const providerId = primaryId || legacyId;
    const localProviderStatus = normalizedProviderText(
      payment.provider_status || payment.status,
    ).toUpperCase();
    const localAccountingStatus = normalizedProviderText(payment.status)
      .toUpperCase();
    if (
      new Set(["PENDING", "OVERDUE", "CONFIRMED"]).has(localAccountingStatus)
    ) {
      collectibleLocalRows.push({
        providerId,
        status: localProviderStatus,
        accountingStatus: localAccountingStatus,
      });
    }
    if (!providerId) continue;
    const existing = localByProvider.get(providerId) || [];
    existing.push(payment as Record<string, unknown>);
    localByProvider.set(providerId, existing);
  }

  const liveProviderIds = new Set<string>();
  for (const provider of providerPayments) {
    if (
      provider.deleted ||
      PROVIDER_CANCELLED_PAYMENT_STATUSES.has(provider.status)
    ) continue;
    liveProviderIds.add(provider.id);
    const matches = localByProvider.get(provider.id) || [];
    if (matches.length !== 1) {
      throw new ApiError(
        409,
        matches.length === 0
          ? "SUBSCRIPTION_PAYMENT_PROVIDER_ONLY"
          : "SUBSCRIPTION_PAYMENT_LOCAL_BINDING_DUPLICATE",
        matches.length === 0
          ? "A provider charge is missing from the local student ledger"
          : "A provider charge is linked to more than one local payment",
      );
    }
    const local = matches[0];
    const localProviderStatus = normalizedProviderText(
      local.provider_status || local.status,
    ).toUpperCase();
    if (
      String(local.due_date || "") !== provider.dueDate ||
      Math.round(Number(local.value) * 100) !==
        Math.round(provider.value * 100) ||
      localProviderStatus !== provider.status
    ) {
      throw new ApiError(
        409,
        "SUBSCRIPTION_PAYMENT_SYNC_MISMATCH",
        "A provider charge requires local payment reconciliation",
      );
    }
  }
  const admittedDeletedProviderIds = new Set<string>();
  for (const local of collectibleLocalRows) {
    if (
      local.providerId && !liveProviderIds.has(local.providerId) &&
      provenDeletedOpenPayments.has(local.providerId)
    ) {
      const proof = provenDeletedOpenPayments.get(local.providerId)!;
      if (
        !DELETABLE_PAYMENT_STATUSES.has(local.accountingStatus) ||
        local.accountingStatus !== proof.accountingStatus ||
        local.status !== proof.providerStatus ||
        (localByProvider.get(local.providerId) || []).length !== 1
      ) {
        throw new ApiError(
          409,
          "OFFBOARDING_DELETED_PAYMENT_LOCAL_STATE_CHANGED",
          "A proven deleted charge changed before offboarding could continue",
        );
      }
      admittedDeletedProviderIds.add(local.providerId);
      continue;
    }
    if (!local.providerId || !liveProviderIds.has(local.providerId)) {
      throw new ApiError(
        409,
        local.providerId
          ? "SUBSCRIPTION_PAYMENT_LOCAL_ONLY"
          : "SUBSCRIPTION_PAYMENT_LOCAL_BINDING_MISSING",
        local.providerId
          ? "A local open charge no longer exists in the provider subscription"
          : "A local open charge has no provider identifier",
      );
    }
  }
  if (admittedDeletedProviderIds.size !== provenDeletedOpenPayments.size) {
    throw new ApiError(
      409,
      "OFFBOARDING_DELETED_PAYMENT_PROOF_SCOPE_MISMATCH",
      "Provider deletion evidence no longer matches the local cancellation snapshot",
    );
  }
}

type OffboardingCustomerInventory = {
  subscriptions: AsaasCustomerSubscriptionSnapshot[];
  recurringPayments: AsaasSubscriptionPaymentSnapshot[];
};

async function requireOffboardingCustomerInventory(
  admin: SupabaseClient,
  integration: ResolvedAsaasIntegration,
  paymentProofIntegration: ResolvedAsaasIntegration | null,
  claim: OffboardingClaim,
  tenantId: string,
  studentId: string,
): Promise<OffboardingCustomerInventory> {
  const { data: bindings, error: bindingError } = await admin.from("profiles")
    .select("id,tenant_id,role")
    .eq("asaas_customer_id", claim.customerId)
    .limit(2);
  if (
    bindingError || bindings?.length !== 1 ||
    bindings[0]?.id !== studentId || bindings[0]?.tenant_id !== tenantId ||
    bindings[0]?.role !== "STUDENT"
  ) {
    throw new ApiError(
      409,
      "OFFBOARDING_CUSTOMER_BINDING_AMBIGUOUS",
      "The provider customer is not uniquely bound to this student",
    );
  }
  const [subscriptions, payments] = await Promise.all([
    listAsaasCustomerSubscriptions(integration, claim.customerId),
    listAsaasCustomerPayments(integration, claim.customerId),
  ]);
  const activeSubscriptions = subscriptions.filter((subscription) =>
    !subscription.deleted && subscription.status === "ACTIVE"
  );
  if (
    activeSubscriptions.some((subscription) =>
      !claim.subscriptionId || subscription.id !== claim.subscriptionId
    )
  ) {
    throw new ApiError(
      409,
      claim.subscriptionId
        ? "OFFBOARDING_PROVIDER_SUBSCRIPTION_UNBOUND"
        : "OFFBOARDING_PROVIDER_SUBSCRIPTION_LOCAL_BINDING_MISSING",
      "An active provider subscription is not represented by the frozen student binding",
    );
  }
  const recurringPayments = payments.filter((payment) =>
    Boolean(payment.subscriptionId)
  );
  const provenDeletedOpenPayments = await proveFrozenDeletedOffboardingPayments(
    admin,
    paymentProofIntegration,
    claim,
    tenantId,
    studentId,
    recurringPayments,
  );
  await requireSynchronizedLiveSubscriptionPayments(
    admin,
    tenantId,
    studentId,
    recurringPayments,
    provenDeletedOpenPayments,
  );
  if (
    !claim.subscriptionId &&
    recurringPayments.some((payment) =>
      !payment.deleted &&
      !PROVIDER_CANCELLED_PAYMENT_STATUSES.has(payment.status)
    )
  ) {
    throw new ApiError(
      409,
      "OFFBOARDING_PROVIDER_PAYMENT_PARENT_UNBOUND",
      "A recurring provider charge has no frozen local subscription binding",
    );
  }
  return { subscriptions, recurringPayments };
}

function requireOffboardingCustomerPostcondition(
  claim: OffboardingClaim,
  inventory: OffboardingCustomerInventory,
): void {
  if (
    inventory.subscriptions.some((subscription) =>
      !subscription.deleted && subscription.status === "ACTIVE"
    )
  ) {
    throw new ApiError(
      409,
      "OFFBOARDING_CUSTOMER_SUBSCRIPTION_STILL_ACTIVE",
      "The customer still has an active recurring subscription",
    );
  }
  if (
    claim.targetStatus === "offboarded" && claim.billingCancelFromDate &&
    inventory.recurringPayments.some((payment) =>
      !payment.deleted &&
      !PROVIDER_CANCELLED_PAYMENT_STATUSES.has(payment.status) &&
      payment.dueDate >= claim.billingCancelFromDate!
    )
  ) {
    throw new ApiError(
      409,
      "OFFBOARDING_CUSTOMER_PAYMENT_STILL_OPEN",
      "The customer still has a recurring charge after the cancellation boundary",
    );
  }
}

function requireUniqueLiveProviderCompetences(
  providerPayments: AsaasSubscriptionPaymentSnapshot[],
): void {
  const liveCompetences = providerPayments
    .filter((payment) =>
      !payment.deleted &&
      !PROVIDER_CANCELLED_PAYMENT_STATUSES.has(payment.status)
    )
    .map((payment) => payment.dueDate.slice(0, 7));
  if (new Set(liveCompetences).size !== liveCompetences.length) {
    throw new ApiError(
      409,
      "REACTIVATION_DUPLICATE_PROVIDER_COMPETENCE",
      "The provider returned duplicate live charges for one competence",
    );
  }
}

function nextMonthStart(monthStart: string): string {
  const [year, month] = monthStart.split("-").map(Number);
  return new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
}

async function requireSinglePreservedCurrentInvoice(
  admin: SupabaseClient,
  claim: OffboardingClaim,
  tenantId: string,
  studentId: string,
  integration: ResolvedAsaasIntegration | null,
  providerPayments: AsaasSubscriptionPaymentSnapshot[] | null,
): Promise<void> {
  const periodEnd = nextMonthStart(claim.billingPeriodStart);
  const frozen = claim.preservedPayments.length === 1
    ? claim.preservedPayments[0]
    : null;
  if (
    claim.billingPolicy !== "CHARGE_CURRENT_MONTH" || !frozen ||
    frozen.dueDate < claim.billingPeriodStart || frozen.dueDate >= periodEnd
  ) {
    throw new ApiError(
      409,
      "OFFBOARDING_CURRENT_INVOICE_SNAPSHOT_INVALID",
      "The frozen retained competence is invalid",
    );
  }
  const { data, error } = await admin.from("student_payments")
    .select(
      "id,asaas_payment_id,asaas_id,value,due_date,status,provider_status",
    )
    .eq("tenant_id", tenantId)
    .eq("student_id", studentId)
    .eq("payment_type", "SUBSCRIPTION")
    .gte("due_date", claim.billingPeriodStart)
    .lt("due_date", periodEnd);
  if (error) {
    throw new ApiError(
      503,
      "OFFBOARDING_CURRENT_INVOICE_UNAVAILABLE",
      "The retained current competence could not be verified",
    );
  }
  const localLive = (data || []).filter((payment) =>
    !NON_LIVE_COMPETENCE_PAYMENT_STATUSES.has(
      normalizedProviderText(payment.status).toUpperCase(),
    )
  );
  if (localLive.length !== 1) {
    throw new ApiError(
      409,
      localLive.length === 0
        ? "OFFBOARDING_CURRENT_LOCAL_INVOICE_MISSING"
        : "OFFBOARDING_DUPLICATE_CURRENT_LOCAL_INVOICE",
      localLive.length === 0
        ? "No local charge exists for the competence that must be retained"
        : "More than one local charge exists for the retained competence",
    );
  }
  const local = localLive[0];
  if (
    !isExactPreservedOffboardingPaymentSnapshot(frozen, {
      id: local.id,
      primaryProviderId: local.asaas_payment_id,
      legacyProviderId: local.asaas_id,
      dueDate: local.due_date,
      value: local.value,
      status: local.status,
      providerStatus: local.provider_status,
    })
  ) {
    throw new ApiError(
      409,
      "OFFBOARDING_CURRENT_INVOICE_SNAPSHOT_MISMATCH",
      "The retained current charge changed after the operation was claimed",
    );
  }
  if (!integration || !claim.subscriptionId) {
    throw new ApiError(
      409,
      "OFFBOARDING_CURRENT_INVOICE_BINDING_MISSING",
      "The retained current charge has no verifiable provider binding",
    );
  }
  const preservedPayment = await requireAsaasOffboardingIdentity(
    admin,
    integration,
    {
      operation: "school_admin_offboarding_preserved_payment_preflight",
      tenantId,
      studentId,
      resource: "payment",
      entityId: frozen.asaasPaymentId,
      customerId: claim.customerId,
      subscriptionId: claim.subscriptionId,
      subscriptionMatch: "required",
      localPayment: frozen,
      paymentDisposition: "PRESERVE",
    },
  );
  if (preservedPayment.kind === "ABSENT") {
    throw new ApiError(
      409,
      "OFFBOARDING_CURRENT_PROVIDER_INVOICE_MISSING",
      "The retained current charge no longer exists at the provider",
    );
  }
  if (providerPayments === null) return;

  const providerLive = providerPayments.filter((payment) =>
    !payment.deleted &&
    payment.dueDate >= claim.billingPeriodStart &&
    payment.dueDate < periodEnd &&
    !NON_LIVE_COMPETENCE_PAYMENT_STATUSES.has(payment.status)
  );
  if (providerLive.length !== 1) {
    throw new ApiError(
      409,
      providerLive.length === 0
        ? "OFFBOARDING_CURRENT_PROVIDER_INVOICE_MISSING"
        : "OFFBOARDING_DUPLICATE_CURRENT_PROVIDER_INVOICE",
      providerLive.length === 0
        ? "No provider charge exists for the competence that must be retained"
        : "More than one provider charge exists for the retained competence",
    );
  }
  if (providerLive.length !== localLive.length) {
    throw new ApiError(
      409,
      "OFFBOARDING_CURRENT_INVOICE_SYNC_MISMATCH",
      "The retained current competence is not synchronized with the provider",
    );
  }
  const provider = providerLive[0];
  if (
    frozen.asaasPaymentId !== provider.id ||
    frozen.dueDate !== provider.dueDate ||
    Math.round(frozen.value * 100) !== Math.round(provider.value * 100) ||
    frozen.providerStatus !== provider.status
  ) {
    throw new ApiError(
      409,
      "OFFBOARDING_CURRENT_INVOICE_IDENTITY_MISMATCH",
      "The retained current charge requires payment reconciliation",
    );
  }
}

async function requireExclusiveActiveTargetMembership(
  admin: SupabaseClient,
  targetId: string,
  tenantId: string,
  expectedRole: "STUDENT" | "TEACHER",
): Promise<void> {
  const { data, error } = await admin.from("tenant_memberships")
    .select("tenant_id,role,status")
    .eq("user_id", targetId)
    .limit(2);
  if (error) {
    throw new ApiError(
      503,
      "TARGET_SCOPE_UNAVAILABLE",
      "Could not validate the account tenant membership",
    );
  }
  if (
    !hasExclusiveActiveTargetMembership(data || [], tenantId, expectedRole)
  ) {
    throw new ApiError(
      409,
      "TARGET_SCOPE_AMBIGUOUS",
      "The account does not have one exclusive active tenant membership",
    );
  }
}

function lifecyclePatch(
  status: LifecycleStatus,
  reason: string | null,
): Record<string, unknown> {
  const patch: Record<string, unknown> = { lifecycle_status: status };
  if (status === "suspended") {
    patch.suspended_at = new Date().toISOString();
    patch.suspended_reason = reason;
    patch.offboarding_status = null;
    patch.offboarding_completed_at = null;
    patch.offboarding_reason = null;
  } else if (status === "offboarded") {
    patch.suspended_at = null;
    patch.suspended_reason = null;
    patch.offboarding_status = "COMPLETED";
    patch.offboarding_completed_at = new Date().toISOString();
    patch.offboarding_reason = reason;
  } else {
    patch.suspended_at = null;
    patch.suspended_reason = null;
    patch.offboarding_status = null;
    patch.offboarding_completed_at = null;
    patch.offboarding_reason = null;
  }
  return patch;
}

type OffboardingPaymentSnapshot = {
  id: string;
  asaasPaymentId: string;
  dueDate: string;
  value: number;
  status: string;
};

type PreservedOffboardingPaymentSnapshot = OffboardingPaymentSnapshot & {
  status: string;
  providerStatus: string;
};

type OffboardingClaim = {
  id: string;
  token: string;
  action: "PROCEED" | "RECONCILE_REQUIRED" | "FINALIZE_REQUIRED";
  sourceStatus: string;
  targetStatus: "suspended" | "offboarded";
  customerId: string;
  subscriptionId: string;
  enrollmentPaymentId: string;
  billingPolicy: "KEEP_OPEN_INVOICES" | StudentOffboardingBillingPolicy;
  billingPeriodStart: string;
  billingCancelFromDate: string | null;
  effectiveEndDate: string;
  reason: string;
  payments: OffboardingPaymentSnapshot[];
  preservedPayments: PreservedOffboardingPaymentSnapshot[];
  providerSubscriptionFinalStatus: "INACTIVE" | "NOT_FOUND";
};

function parseOffboardingPayments(
  value: unknown,
): OffboardingPaymentSnapshot[] {
  if (!Array.isArray(value)) throw new Error("offboarding_snapshot_invalid");
  const seenLocal = new Set<string>();
  const seenProvider = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("offboarding_snapshot_invalid");
    }
    const row = item as Record<string, unknown>;
    const id = String(row.id || "").trim();
    const asaasPaymentId = String(row.asaas_payment_id || "").trim();
    const dueDate = String(row.due_date || "").trim();
    const value = Number(row.value);
    const status = normalizedProviderText(row.status).toUpperCase();
    if (!UUID_PATTERN.test(id) || seenLocal.has(id)) {
      throw new Error("offboarding_snapshot_invalid");
    }
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || !Number.isFinite(value) ||
      value <= 0 || !DELETABLE_PAYMENT_STATUSES.has(status)
    ) {
      throw new Error("offboarding_snapshot_invalid");
    }
    if (asaasPaymentId && seenProvider.has(asaasPaymentId)) {
      throw new Error("offboarding_provider_payment_duplicate");
    }
    seenLocal.add(id);
    if (asaasPaymentId) seenProvider.add(asaasPaymentId);
    return { id, asaasPaymentId, dueDate, value, status };
  });
}

function parsePreservedOffboardingPayments(
  value: unknown,
): PreservedOffboardingPaymentSnapshot[] {
  if (!Array.isArray(value)) throw new Error("offboarding_snapshot_invalid");
  const seenLocal = new Set<string>();
  const seenProvider = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("offboarding_snapshot_invalid");
    }
    const row = item as Record<string, unknown>;
    const id = String(row.id || "").trim();
    const asaasPaymentId = String(row.asaas_payment_id || "").trim();
    const dueDate = String(row.due_date || "").trim();
    const value = Number(row.value);
    const status = normalizedProviderText(row.status).toUpperCase();
    const providerStatus = normalizedProviderText(
      row.provider_status || row.status,
    ).toUpperCase();
    if (
      !UUID_PATTERN.test(id) || seenLocal.has(id) || !asaasPaymentId ||
      seenProvider.has(asaasPaymentId) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || !Number.isFinite(value) ||
      value <= 0 || !status || !providerStatus ||
      NON_LIVE_COMPETENCE_PAYMENT_STATUSES.has(status)
    ) {
      throw new Error("offboarding_snapshot_invalid");
    }
    seenLocal.add(id);
    seenProvider.add(asaasPaymentId);
    return { id, asaasPaymentId, dueDate, value, status, providerStatus };
  });
}

export function isExactPreservedOffboardingPaymentSnapshot(
  frozen: PreservedOffboardingPaymentSnapshot,
  local: {
    id: unknown;
    primaryProviderId: unknown;
    legacyProviderId: unknown;
    dueDate: unknown;
    value: unknown;
    status: unknown;
    providerStatus: unknown;
  },
): boolean {
  const primaryProviderId = normalizedProviderText(local.primaryProviderId);
  const legacyProviderId = normalizedProviderText(local.legacyProviderId);
  const localProviderId = primaryProviderId || legacyProviderId;
  const localStatus = normalizedProviderText(local.status).toUpperCase();
  const localProviderStatus = normalizedProviderText(
    local.providerStatus || local.status,
  ).toUpperCase();
  const localValue = Number(local.value);
  return local.id === frozen.id && Boolean(frozen.asaasPaymentId) &&
    (!primaryProviderId || !legacyProviderId ||
      primaryProviderId === legacyProviderId) &&
    localProviderId === frozen.asaasPaymentId &&
    normalizedProviderText(local.dueDate) === frozen.dueDate &&
    Number.isFinite(localValue) && localValue > 0 &&
    Math.round(localValue * 100) === Math.round(frozen.value * 100) &&
    localStatus === frozen.status &&
    localProviderStatus === frozen.providerStatus;
}

async function beginStudentOffboarding(
  admin: SupabaseClient,
  input: {
    tenantId: string;
    studentId: string;
    requestedBy: string | null;
    targetStatus: "suspended" | "offboarded";
    reason: string | null;
    billingPolicy: StudentOffboardingBillingPolicy | null;
    effectiveEndDate: string | null;
  },
): Promise<
  | { kind: "CLAIMED"; claim: OffboardingClaim }
  | { kind: "IN_PROGRESS" }
  | { kind: "COMPLETED" }
  | { kind: "REVIEW_REQUIRED" }
> {
  const token = crypto.randomUUID();
  const { data, error } = await admin.rpc(
    "begin_student_offboarding_with_billing_policy",
    {
      p_tenant_id: input.tenantId,
      p_student_id: input.studentId,
      p_requested_by: input.requestedBy,
      p_target_status: input.targetStatus,
      p_reason: input.reason,
      p_billing_policy: input.targetStatus === "offboarded"
        ? input.billingPolicy
        : "KEEP_OPEN_INVOICES",
      p_effective_end_date: input.effectiveEndDate ||
        saoPauloToday(),
      p_claim_token: token,
      p_lease_seconds: 300,
    },
  );
  if (error || !data || typeof data !== "object") {
    throw new ApiError(
      503,
      "OFFBOARDING_CLAIM_UNAVAILABLE",
      "Could not acquire the account operation fence",
    );
  }
  const result = data as Record<string, unknown>;
  const action = String(result.action || "").trim();
  if (action === "IN_PROGRESS") return { kind: "IN_PROGRESS" };
  if (action === "ALREADY_COMPLETED") return { kind: "COMPLETED" };
  if (result.ok !== true || action === "REVIEW_REQUIRED") {
    const operationId = String(result.operation_id || "").trim();
    if (UUID_PATTERN.test(operationId)) {
      // A snapshot/configuration review before the first provider call is
      // safely abortable. Post-provider BLOCKED operations deliberately stay
      // fenced for reconciliation; the RPC decides which case this is.
      await admin.rpc("abort_student_lifecycle_operation", {
        p_operation_id: operationId,
        p_claim_token: token,
        p_reason: "blocked_pre_provider_released",
      });
    }
    return { kind: "REVIEW_REQUIRED" };
  }
  if (
    !["PROCEED", "RECONCILE_REQUIRED", "FINALIZE_REQUIRED"].includes(action)
  ) {
    throw new ApiError(
      503,
      "OFFBOARDING_CLAIM_INVALID",
      "The account operation fence returned an invalid state",
    );
  }
  const id = String(result.operation_id || "").trim();
  const returnedToken = String(result.claim_token || "").trim();
  const targetStatus = String(result.target_lifecycle_status || "").trim();
  const billingPolicy = String(result.billing_policy || "").trim();
  const billingPeriodStart = String(result.billing_period_start || "").trim();
  const billingCancelFromDate = result.billing_cancel_from_date === null
    ? null
    : String(result.billing_cancel_from_date || "").trim();
  const effectiveEndDate = String(result.effective_end_date || "").trim();
  const reason = String(result.reason || "").trim();
  const customerId = String(result.customer_id || "").trim();
  const subscriptionId = String(result.subscription_id || "").trim();
  const providerSubscriptionFinalStatus = String(
    result.provider_subscription_final_status || "",
  ).trim().toUpperCase();
  let payments: OffboardingPaymentSnapshot[];
  let preservedPayments: PreservedOffboardingPaymentSnapshot[];
  try {
    payments = parseOffboardingPayments(result.payment_snapshot);
    preservedPayments = parsePreservedOffboardingPayments(
      result.preserved_payment_snapshot,
    );
  } catch {
    throw new ApiError(
      503,
      "OFFBOARDING_CLAIM_INVALID",
      "The account operation fence returned an invalid state",
    );
  }
  const expectedProviderSubscriptionFinalStatus =
    targetStatus === "offboarded" &&
      billingPolicy === "WAIVE_CURRENT_MONTH"
      ? "NOT_FOUND"
      : "INACTIVE";
  const mustPreserveCurrentPayment = targetStatus === "offboarded" &&
    billingPolicy === "CHARGE_CURRENT_MONTH";
  const billingPeriodEnd = /^\d{4}-\d{2}-\d{2}$/.test(billingPeriodStart)
    ? nextMonthStart(billingPeriodStart)
    : "";
  if (
    !UUID_PATTERN.test(id) || returnedToken !== token ||
    !["suspended", "offboarded"].includes(targetStatus) ||
    !new Set<string>([
      "KEEP_OPEN_INVOICES",
      ...STUDENT_OFFBOARDING_BILLING_POLICIES,
    ]).has(billingPolicy) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(billingPeriodStart) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(effectiveEndDate) ||
    !reason || reason.length > 500 ||
    (billingCancelFromDate !== null &&
      !/^\d{4}-\d{2}-\d{2}$/.test(billingCancelFromDate)) ||
    providerSubscriptionFinalStatus !==
      expectedProviderSubscriptionFinalStatus ||
    (mustPreserveCurrentPayment
      ? preservedPayments.length !== 1 ||
        preservedPayments[0].dueDate < billingPeriodStart ||
        preservedPayments[0].dueDate >= billingPeriodEnd
      : preservedPayments.length !== 0)
  ) {
    throw new ApiError(
      503,
      "OFFBOARDING_CLAIM_INVALID",
      "The account operation fence returned an invalid state",
    );
  }
  return {
    kind: "CLAIMED",
    claim: {
      id,
      token,
      action: action as OffboardingClaim["action"],
      sourceStatus: String(result.source_lifecycle_status || "").trim(),
      targetStatus: targetStatus as OffboardingClaim["targetStatus"],
      customerId,
      subscriptionId,
      enrollmentPaymentId: String(result.enrollment_payment_id || "").trim(),
      billingPolicy: billingPolicy as OffboardingClaim["billingPolicy"],
      billingPeriodStart,
      billingCancelFromDate,
      effectiveEndDate,
      reason,
      payments,
      preservedPayments,
      providerSubscriptionFinalStatus:
        providerSubscriptionFinalStatus as OffboardingClaim[
          "providerSubscriptionFinalStatus"
        ],
    },
  };
}

type ReactivationClaim = {
  id: string;
  token: string;
  action: "PROCEED" | "RECONCILE_REQUIRED" | "FINALIZE_REQUIRED";
  customerId: string;
  subscriptionId: string;
  dueDay: number;
  monthlyFee: number;
  providerSubscriptionFinalStatus: "ACTIVE";
};

async function beginStudentReactivation(
  admin: SupabaseClient,
  input: { tenantId: string; studentId: string; requestedBy: string | null },
): Promise<
  | { kind: "CLAIMED"; claim: ReactivationClaim }
  | { kind: "IN_PROGRESS" | "COMPLETED" | "REVIEW_REQUIRED" }
> {
  const token = crypto.randomUUID();
  const { data, error } = await admin.rpc("begin_student_reactivation", {
    p_tenant_id: input.tenantId,
    p_student_id: input.studentId,
    p_requested_by: input.requestedBy,
    p_claim_token: token,
    p_lease_seconds: 300,
  });
  if (error || !data || typeof data !== "object") {
    throw new ApiError(
      503,
      "REACTIVATION_CLAIM_UNAVAILABLE",
      "Could not acquire the account operation fence",
    );
  }
  const result = data as Record<string, unknown>;
  const action = String(result.action || "").trim();
  if (action === "IN_PROGRESS") return { kind: "IN_PROGRESS" };
  if (action === "ALREADY_COMPLETED") return { kind: "COMPLETED" };
  if (result.ok !== true || action === "REVIEW_REQUIRED") {
    return { kind: "REVIEW_REQUIRED" };
  }
  const id = String(result.operation_id || "").trim();
  const returnedToken = String(result.claim_token || "").trim();
  const customerId = String(result.customer_id || "").trim();
  const subscriptionId = String(result.subscription_id || "").trim();
  const dueDay = Number(result.due_day);
  const monthlyFee = Number(result.monthly_fee);
  const providerSubscriptionFinalStatus = String(
    result.provider_subscription_final_status || "",
  ).trim().toUpperCase();
  if (
    !UUID_PATTERN.test(id) || returnedToken !== token || !customerId ||
    !subscriptionId || !Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31 ||
    !Number.isFinite(monthlyFee) || monthlyFee <= 0 ||
    providerSubscriptionFinalStatus !== "ACTIVE" ||
    !["PROCEED", "RECONCILE_REQUIRED", "FINALIZE_REQUIRED"].includes(action)
  ) {
    throw new ApiError(
      503,
      "REACTIVATION_CLAIM_INVALID",
      "The account operation fence returned an invalid state",
    );
  }
  return {
    kind: "CLAIMED",
    claim: {
      id,
      token,
      action: action as ReactivationClaim["action"],
      customerId,
      subscriptionId,
      dueDay,
      monthlyFee,
      providerSubscriptionFinalStatus: "ACTIVE",
    },
  };
}

async function recordOffboardingProviderState(
  admin: SupabaseClient,
  claim: Pick<OffboardingClaim, "id" | "token">,
  status: "MUTATING" | "COMPLETE" | "UNKNOWN",
  error: string | null = null,
): Promise<void> {
  const { data, error: rpcError } = await admin.rpc(
    "record_student_offboarding_provider_state",
    {
      p_operation_id: claim.id,
      p_claim_token: claim.token,
      p_status: status,
      p_error: error,
    },
  );
  if (rpcError || data?.ok !== true) {
    throw new ApiError(
      409,
      "OFFBOARDING_CLAIM_LOST",
      "The account operation fence was lost",
    );
  }
}

async function abortStudentLifecycleOperation(
  admin: SupabaseClient,
  claim: Pick<OffboardingClaim, "id" | "token">,
  reason: string,
): Promise<void> {
  const { data, error } = await admin.rpc(
    "abort_student_lifecycle_operation",
    {
      p_operation_id: claim.id,
      p_claim_token: claim.token,
      p_reason: reason,
    },
  );
  if (error || data?.ok !== true) {
    throw new ApiError(
      409,
      "LIFECYCLE_ABORT_FAILED",
      "The account operation requires reconciliation",
    );
  }
}

async function bindOffboardingIntegrations(
  admin: SupabaseClient,
  claim: Pick<OffboardingClaim, "id" | "token">,
  subscription: ResolvedAsaasIntegration | null,
  payment: ResolvedAsaasIntegration | null,
): Promise<void> {
  const { data, error } = await admin.rpc(
    "bind_student_offboarding_integrations",
    {
      p_operation_id: claim.id,
      p_claim_token: claim.token,
      p_subscription_integration_id: subscription?.integrationId || null,
      p_subscription_version: subscription?.version || null,
      p_subscription_environment: subscription?.environment || null,
      p_subscription_mode: subscription?.mode || null,
      p_payment_integration_id: payment?.integrationId || null,
      p_payment_version: payment?.version || null,
      p_payment_environment: payment?.environment || null,
      p_payment_mode: payment?.mode || null,
    },
  );
  if (error || data?.ok !== true) {
    await admin.rpc("abort_student_lifecycle_operation", {
      p_operation_id: claim.id,
      p_claim_token: claim.token,
      p_reason: "blocked_pre_provider_released",
    });
    throw new ApiError(
      409,
      "OFFBOARDING_INTEGRATION_CHANGED",
      "The billing integration changed during the account operation",
    );
  }
}

function applicationOrigin(): string {
  const fallback = "https://system.wisewolflanguage.com.br";
  const configured = (Deno.env.get("APP_BASE_URL") || fallback).trim();
  try {
    const parsed = new URL(configured);
    return new Set([
        fallback,
        "https://app.wisewolflanguage.com.br",
      ]).has(parsed.origin)
      ? parsed.origin
      : fallback;
  } catch {
    return fallback;
  }
}

function saoPauloToday(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${value.year}-${value.month}-${value.day}`;
}

function nextStudentDueDate(
  dueDay: unknown,
  existingProviderDueDates: string[] = [],
): string {
  const preferredDay = Number(dueDay);
  if (
    !Number.isInteger(preferredDay) || preferredDay < 1 || preferredDay > 31
  ) {
    throw new ApiError(
      409,
      "REACTIVATION_DUE_DAY_INVALID",
      "The student billing day requires review",
    );
  }
  let threshold = saoPauloToday();
  let latestExistingCompetence = "";
  for (const dueDate of existingProviderDueDates) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
      throw new ApiError(
        409,
        "REACTIVATION_PROVIDER_DUE_DATE_INVALID",
        "An existing subscription charge requires review",
      );
    }
    if (dueDate > threshold) threshold = dueDate;
    if (dueDate.slice(0, 7) > latestExistingCompetence) {
      latestExistingCompetence = dueDate.slice(0, 7);
    }
  }
  let [targetYear, targetMonth] = threshold.split("-").map(Number);
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
    const day = String(Math.min(preferredDay, lastDay)).padStart(2, "0");
    const candidate = `${targetYear}-${
      String(targetMonth).padStart(2, "0")
    }-${day}`;
    if (
      candidate > threshold &&
      (!latestExistingCompetence ||
        candidate.slice(0, 7) > latestExistingCompetence)
    ) return candidate;
    targetMonth += 1;
    if (targetMonth === 13) {
      targetMonth = 1;
      targetYear += 1;
    }
  }
  throw new ApiError(
    409,
    "REACTIVATION_DUE_DATE_UNAVAILABLE",
    "A safe next subscription charge date could not be calculated",
  );
}

async function createEnrollmentOffer(
  req: Request,
  context: RequestAuthContext,
  tenantId: string,
  leadId: string,
  opportunityId: string,
  requestId: string,
  planId: string,
  teacherId: string,
  schedule: Array<{ day: string; time: string }>,
  startDate: string,
  billingStartMonth: string,
  dueDay: number,
  enableProRata: boolean,
): Promise<Response> {
  const admin = context.admin;
  const [leadResult, opportunityResult, planResult] = await Promise.all([
    admin.from("crm_leads")
      .select("id,tenant_id,name,phone,status,student_id")
      .eq("tenant_id", tenantId)
      .eq("id", leadId)
      .maybeSingle(),
    admin.from("opportunities")
      .select(
        "id,tenant_id,student_id,student_name,student_phone,status,kind,conversion_status,trial_status,feedback_required,winner_teacher_id,professor_id,trial_appointment_id",
      )
      .eq("tenant_id", tenantId)
      .eq("id", opportunityId)
      .maybeSingle(),
    admin.from("student_pricing_plans")
      .select(
        "id,tenant_id,monthly_price,fidelity_months,classes_per_week,active",
      )
      .eq("tenant_id", tenantId)
      .eq("id", planId)
      .eq("active", true)
      .maybeSingle(),
  ]);
  if (leadResult.error || opportunityResult.error || planResult.error) {
    throw new ApiError(
      503,
      "DATA_UNAVAILABLE",
      "Could not validate enrollment",
    );
  }
  if (!leadResult.data || !opportunityResult.data || !planResult.data) {
    throw new ApiError(
      404,
      "ENROLLMENT_INPUT_NOT_FOUND",
      "Lead or plan not found",
    );
  }
  if (String(leadResult.data.status || "").toUpperCase() !== "TRIAL_DONE") {
    throw new ApiError(
      409,
      "TRIAL_NOT_COMPLETED",
      "The trial lesson must be completed before enrollment",
    );
  }
  const leadStudentId = String(leadResult.data.student_id || "").trim();
  const opportunityStudentId = String(opportunityResult.data.student_id || "")
    .trim();
  const leadPhone = normalizedPhone(leadResult.data.phone);
  const opportunityPhone = normalizedPhone(
    opportunityResult.data.student_phone,
  );
  if (
    !enrollmentLeadMatchesTrial(
      leadStudentId,
      opportunityStudentId,
      leadPhone,
      opportunityPhone,
    )
  ) {
    throw new ApiError(
      409,
      "TRIAL_LEAD_BINDING_MISMATCH",
      "The completed trial does not belong to this lead",
    );
  }
  if (
    String(opportunityResult.data.kind || "").toUpperCase() !== "TRIAL" ||
    String(opportunityResult.data.status || "").toUpperCase() !== "CLAIMED" ||
    String(opportunityResult.data.conversion_status || "").toUpperCase() !==
      "OPEN" ||
    String(opportunityResult.data.trial_status || "").toUpperCase() !==
      "DONE" ||
    !opportunityResult.data.trial_appointment_id ||
    !String(
      opportunityResult.data.winner_teacher_id ||
        opportunityResult.data.professor_id || "",
    ).trim()
  ) {
    throw new ApiError(
      409,
      "TRIAL_GRAPH_NOT_ELIGIBLE",
      "The trial lifecycle is not eligible for enrollment",
    );
  }
  if (opportunityResult.data.feedback_required) {
    const { data: feedback, error: feedbackError } = await admin
      .from("trial_feedback")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("opportunity_id", opportunityId)
      .eq("booking_id", opportunityResult.data.trial_appointment_id)
      .eq(
        "teacher_id",
        opportunityResult.data.winner_teacher_id ||
          opportunityResult.data.professor_id,
      )
      .maybeSingle();
    if (feedbackError) {
      throw new ApiError(
        503,
        "DATA_UNAVAILABLE",
        "Could not validate trial feedback",
      );
    }
    if (!feedback) {
      throw new ApiError(
        409,
        "TRIAL_FEEDBACK_REQUIRED",
        "The trial feedback must be completed before enrollment",
      );
    }
  }

  let normalizedPlan: ReturnType<typeof normalizeEnrollmentPlan>;
  try {
    normalizedPlan = normalizeEnrollmentPlan(planResult.data);
  } catch {
    throw new ApiError(409, "INVALID_PLAN", "The selected plan is invalid");
  }
  if (schedule.length !== normalizedPlan.classesPerWeek) {
    throw new ApiError(
      409,
      "SCHEDULE_FREQUENCY_MISMATCH",
      `Preencha exatamente ${normalizedPlan.classesPerWeek} horarios para este plano`,
    );
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim() || "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")?.trim() || "";
  const authorization = req.headers.get("authorization")?.trim() || "";
  if (!supabaseUrl || !anonKey || !authorization) {
    throw new ApiError(
      503,
      "ENROLLMENT_UNAVAILABLE",
      "Enrollment is unavailable",
    );
  }
  const userClient = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: authorization } },
  });
  const origin = applicationOrigin();
  await writeAudit(admin, context, tenantId, req, {
    action: "createEnrollmentOfferRequested",
    resourceType: "crm_lead",
    resourceId: leadId,
    oldValues: { status: leadResult.data.status },
    newValues: {
      requested: true,
      opportunity_id: opportunityId,
      request_id: requestId,
      plan_id: planId,
      teacher_id: teacherId,
      schedule,
      start_date: startDate,
      billing_start_month: billingStartMonth,
      due_day: dueDay,
      pro_rata: enableProRata,
    },
  }, true);
  const { data: offerId, error: offerError } = await userClient.rpc(
    "create_enrollment_offer",
    {
      p_payload: {
        unitId: tenantId,
        value: normalizedPlan.value,
        planDuration: normalizedPlan.planDuration,
        classesPerWeek: normalizedPlan.classesPerWeek,
        dueDay,
        enrollmentFee: 0,
        requiresEnrollment: normalizedPlan.planDuration !== 0,
        professorId: teacherId,
        schedule: schedule.map((slot) => ({ ...slot, teacherId })),
        startDate,
        billingStartMonth,
        enableProRata,
        studentName: leadResult.data.name || undefined,
        studentPhone: leadResult.data.phone || undefined,
        opportunityId,
        requestId,
        _linkOrigin: origin,
      },
    },
  );
  if (offerError || typeof offerId !== "string") {
    console.error("Enrollment offer creation failed", {
      code: offerError?.code || "invalid_result",
    });
    const reason = String(offerError?.message || "").toLowerCase();
    if (reason.includes("tenant_legal_identity_incomplete")) {
      throw new ApiError(
        409,
        "SCHOOL_IDENTITY_INCOMPLETE",
        "Complete a Identidade da escola, incluindo a assinatura valida do representante, antes de gerar o link",
      );
    }
    if (
      reason.includes("teacher_slot_") ||
      reason.includes("enrollment_schedule_") ||
      reason.includes("inactive_enrollment_teacher")
    ) {
      throw new ApiError(
        409,
        "TEACHER_SCHEDULE_UNAVAILABLE",
        "Um dos horarios nao esta disponivel para o professor escolhido",
      );
    }
    throw new ApiError(
      503,
      "ENROLLMENT_OFFER_FAILED",
      "Could not create the enrollment offer",
    );
  }

  await writeAudit(admin, context, tenantId, req, {
    action: "createEnrollmentOffer",
    resourceType: "crm_lead",
    resourceId: leadId,
    oldValues: { status: leadResult.data.status },
    newValues: {
      offer_id: offerId,
      opportunity_id: opportunityId,
      request_id: requestId,
      plan_id: planId,
      teacher_id: teacherId,
      schedule,
      start_date: startDate,
      billing_start_month: billingStartMonth,
      due_day: dueDay,
      pro_rata: enableProRata,
    },
  });
  return json({
    ok: true,
    enrollmentUrl: `${origin}/matricula?offer=${encodeURIComponent(offerId)}`,
  });
}

function normalizedPhone(value: unknown): string | null {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
  return digits.length >= 12 && digits.length <= 15 ? digits : null;
}

function brtLabel(value: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

function brtDate(value: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

async function requestTrialReschedule(
  req: Request,
  context: RequestAuthContext,
  tenantId: string,
  opportunityId: string,
  requestedStartTime: string,
): Promise<Response> {
  const admin = context.admin;
  const { data: opportunity, error: opportunityError } = await admin
    .from("opportunities")
    .select(
      "id,tenant_id,trial_appointment_id,winner_teacher_id,professor_id,student_name,student_phone",
    )
    .eq("tenant_id", tenantId)
    .eq("id", opportunityId)
    .maybeSingle();
  if (opportunityError) {
    throw new ApiError(
      503,
      "DATA_UNAVAILABLE",
      "Could not validate the trial lesson",
    );
  }
  if (!opportunity?.trial_appointment_id) {
    throw new ApiError(
      404,
      "TRIAL_NOT_FOUND",
      "The trial lesson was not found",
    );
  }

  const { data: appointment, error: appointmentError } = await admin
    .from("appointments")
    .select("id,tenant_id,teacher_id,professor_id,start_time,status")
    .eq("tenant_id", tenantId)
    .eq("id", opportunity.trial_appointment_id)
    .maybeSingle();
  if (appointmentError) {
    throw new ApiError(
      503,
      "DATA_UNAVAILABLE",
      "Could not validate the appointment",
    );
  }
  if (
    !appointment ||
    !["scheduled", "no_show"].includes(
      String(appointment.status || "").toLowerCase(),
    )
  ) {
    throw new ApiError(
      409,
      "TRIAL_NOT_SCHEDULED",
      "Only a scheduled or no-show trial can be changed",
    );
  }

  const teacherId = String(
    opportunity.winner_teacher_id || opportunity.professor_id ||
      appointment.teacher_id || appointment.professor_id || "",
  );
  if (
    !teacherId ||
    String(appointment.teacher_id || appointment.professor_id || "") !==
      teacherId
  ) {
    throw new ApiError(
      409,
      "TRIAL_OWNER_MISMATCH",
      "The trial teacher is inconsistent",
    );
  }
  const [{ data: membership, error: membershipError }, profileResult] =
    await Promise.all([
      admin.from("tenant_memberships")
        .select("user_id")
        .eq("tenant_id", tenantId)
        .eq("user_id", teacherId)
        .eq("role", "TEACHER")
        .eq("status", "ACTIVE")
        .maybeSingle(),
      admin.from("profiles").select("id,full_name,phone").eq("id", teacherId)
        .maybeSingle(),
    ]);
  if (membershipError || profileResult.error) {
    throw new ApiError(
      503,
      "DATA_UNAVAILABLE",
      "Could not validate the teacher",
    );
  }
  const teacherPhone = normalizedPhone(profileResult.data?.phone);
  if (!membership || !teacherPhone) {
    throw new ApiError(
      409,
      "TEACHER_UNAVAILABLE",
      "The active teacher needs a valid WhatsApp number",
    );
  }

  await writeAudit(admin, context, tenantId, req, {
    action: "requestTrialRescheduleRequested",
    resourceType: "opportunity",
    resourceId: opportunityId,
    oldValues: { start_time: appointment.start_time },
    newValues: { requested_start_time: requestedStartTime, requested: true },
  }, true);

  const { data: result, error: requestError } = await admin.rpc(
    "create_trial_reschedule_confirmation",
    {
      p_tenant_id: tenantId,
      p_opportunity_id: opportunityId,
      p_appointment_id: appointment.id,
      p_teacher_id: teacherId,
      p_lead_id: null,
      p_requested_start_time: requestedStartTime,
    },
  );
  if (requestError || !result?.ok) {
    throw new ApiError(
      409,
      "TRIAL_RESCHEDULE_REJECTED",
      "The reschedule request was not accepted",
    );
  }
  if (result.same_time) {
    return json({
      ok: true,
      pendingTeacherConfirmation: false,
      sameTime: true,
    });
  }

  const requestId = String(result.request_id || "");
  const replyCode = String(result.reply_code || "");
  if (!UUID_PATTERN.test(requestId) || !/^[A-F0-9]{8}$/.test(replyCode)) {
    throw new ApiError(
      503,
      "TRIAL_RESCHEDULE_FAILED",
      "The request was not persisted",
    );
  }
  const message = `🔄 *Confirmação de remarcação — #${replyCode}*\n\n` +
    `📋 *Aluno:* ${
      String(opportunity.student_name || "Aluno").slice(0, 120)
    }\n` +
    `⏰ Atual: ${brtLabel(appointment.start_time)}\n` +
    `➡️ Pedido: ${brtLabel(requestedStartTime)}\n\n` +
    `*A agenda ainda NÃO foi alterada.*\n` +
    `Responda *SIM #${replyCode}* se consegue atender ou *NÃO #${replyCode}* se não consegue.`;
  const { error: queueError } = await admin.from("notification_queue").upsert({
    tenant_id: tenantId,
    teacher_id: null,
    student_id: null,
    student_name: profileResult.data?.full_name || "Professor",
    student_phone: teacherPhone,
    message_body: message,
    scheduled_for: new Date().toISOString(),
    status: "pending",
    attempts: 0,
    source_id: requestId,
    source_type: "trial_reschedule",
    class_date: brtDate(requestedStartTime),
    notification_kind: "TRIAL_RESCHEDULE_CONFIRMATION",
  }, {
    onConflict: "source_id,source_type,class_date,notification_kind",
    ignoreDuplicates: true,
  });
  if (queueError) {
    await admin.from("trial_reschedule_requests")
      .update({ status: "SUPERSEDED", responded_at: new Date().toISOString() })
      .eq("id", requestId)
      .eq("status", "PENDING");
    throw new ApiError(
      503,
      "TRIAL_NOTIFICATION_FAILED",
      "The teacher was not notified and the agenda was not changed",
    );
  }

  await writeAudit(admin, context, tenantId, req, {
    action: "requestTrialReschedule",
    resourceType: "trial_reschedule_request",
    resourceId: requestId,
    oldValues: { start_time: appointment.start_time },
    newValues: {
      requested_start_time: requestedStartTime,
      teacher_id: teacherId,
      notification_queued: true,
    },
  });
  return json({
    ok: true,
    requestId,
    pendingTeacherConfirmation: true,
  });
}

export async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return methodNotAllowed(corsHeaders);

  try {
    const auth = await authorizeRequest(req, {
      corsHeaders,
      allowedRoles: ["SCHOOL_ADMIN", "SUPER_ADMIN"],
    });
    if (auth.ok === false) return auth.response;
    const tenantId = await resolveActiveTenant(auth.context);
    await requireOperationalTenant(auth.context.admin, tenantId);
    const body = await requestBody(req);
    let action: ReturnType<typeof normalizeSchoolAdminAction>;
    try {
      action = normalizeSchoolAdminAction(body);
    } catch {
      throw new ApiError(400, "INVALID_REQUEST", "Invalid request");
    }

    if (action.action === "createEnrollmentOffer") {
      return await createEnrollmentOffer(
        req,
        auth.context,
        tenantId,
        action.leadId,
        action.opportunityId,
        action.requestId,
        action.planId,
        action.teacherId,
        action.schedule,
        action.startDate,
        action.billingStartMonth,
        action.dueDay,
        action.enableProRata,
      );
    }

    if (action.action === "requestTrialReschedule") {
      return await requestTrialReschedule(
        req,
        auth.context,
        tenantId,
        action.opportunityId,
        action.requestedStartTime,
      );
    }

    const admin = auth.context.admin;
    if (
      action.action === "setStudentLifecycle" ||
      action.action === "setTeacherLifecycle"
    ) {
      const isStudent = action.action === "setStudentLifecycle";
      const expectedRole = isStudent ? "STUDENT" : "TEACHER";
      const { data: target, error: targetError } = await admin.from("profiles")
        .select(
          "id,role,tenant_id,lifecycle_status,subscription_id,asaas_customer_id,enrollment_payment_id,enrollment_fee_paid,due_day,monthly_fee",
        )
        .eq("tenant_id", tenantId)
        .eq("role", expectedRole)
        .eq("id", action.targetId)
        .maybeSingle();
      if (targetError) {
        throw new ApiError(
          503,
          "DATA_UNAVAILABLE",
          "Could not validate account",
        );
      }
      if (!target) {
        throw new ApiError(404, "ACCOUNT_NOT_FOUND", "Account not found");
      }
      await requireExclusiveActiveTargetMembership(
        admin,
        target.id,
        tenantId,
        expectedRole,
      );

      await writeAudit(admin, auth.context, tenantId, req, {
        action: `${action.action}Requested`,
        resourceType: isStudent ? "student" : "teacher",
        resourceId: target.id,
        oldValues: { lifecycle_status: target.lifecycle_status },
        newValues: {
          lifecycle_status: action.status,
          reason: action.reason,
          billing_policy: action.action === "setStudentLifecycle"
            ? action.billingPolicy
            : null,
          requested: true,
        },
      }, true);

      if (
        action.action === "setStudentLifecycle" && action.status !== "active"
      ) {
        const begun = await beginStudentOffboarding(admin, {
          tenantId,
          studentId: target.id,
          requestedBy: auth.context.userId,
          targetStatus: action.status,
          reason: action.reason,
          billingPolicy: action.billingPolicy,
          effectiveEndDate: action.effectiveEndDate,
        });
        if (begun.kind === "IN_PROGRESS") {
          throw new ApiError(
            409,
            "OFFBOARDING_IN_PROGRESS",
            "The account operation is already in progress",
          );
        }
        if (begun.kind === "REVIEW_REQUIRED") {
          throw new ApiError(
            409,
            "OFFBOARDING_REVIEW_REQUIRED",
            "The account billing snapshot changed and requires review",
          );
        }
        if (begun.kind === "COMPLETED") {
          return json({
            ok: true,
            id: target.id,
            lifecycle_status: action.status,
            billing: {
              subscriptionCancelled: false,
              futurePaymentsCancelled: 0,
            },
            idempotent: true,
          });
        }
        if (begun.kind !== "CLAIMED") {
          throw new ApiError(
            503,
            "OFFBOARDING_CLAIM_INVALID",
            "The account operation fence returned an invalid state",
          );
        }
        const claim = begun.claim;
        if (
          claim.targetStatus !== action.status ||
          claim.customerId !== String(target.asaas_customer_id || "").trim() ||
          claim.subscriptionId !==
            String(target.subscription_id || "").trim() ||
          claim.enrollmentPaymentId !==
            String(target.enrollment_payment_id || "").trim() ||
          (action.status === "offboarded" &&
            claim.billingPolicy !== action.billingPolicy) ||
          claim.reason !== action.reason
        ) {
          throw new ApiError(
            409,
            "OFFBOARDING_SNAPSHOT_MISMATCH",
            "The account billing snapshot changed and requires review",
          );
        }
        // The policy governs recurring tuition only. A one-time enrollment fee
        // is a separate receivable and must never be silently deleted by a
        // pause or monthly-fee waiver.
        const paymentTargets = claim.payments.flatMap((payment) =>
          payment.asaasPaymentId
            ? [{
              kind: "RECURRING" as const,
              localId: payment.id,
              asaasPaymentId: payment.asaasPaymentId,
            }]
            : []
        );
        const externalPaymentIds = paymentTargets.map((payment) =>
          payment.asaasPaymentId
        );
        const uniqueExternalPaymentIds = [...new Set(externalPaymentIds)];
        if (uniqueExternalPaymentIds.length !== externalPaymentIds.length) {
          throw new ApiError(
            409,
            "OFFBOARDING_PAYMENT_BINDING_DUPLICATE",
            "A provider payment is linked more than once",
          );
        }

        const preserveCurrentInvoices = claim.targetStatus === "suspended" ||
          claim.billingPolicy === "CHARGE_CURRENT_MONTH";
        const subscriptionPurpose = preserveCurrentInvoices
          ? "subscription.update" as const
          : "subscription.delete" as const;
        if (
          claim.providerSubscriptionFinalStatus === "INACTIVE" &&
          !claim.subscriptionId
        ) {
          await abortStudentLifecycleOperation(
            admin,
            claim,
            "subscription_absent_new_enrollment_required",
          );
          throw new ApiError(
            409,
            "NEW_ENROLLMENT_REQUIRED",
            "The student has no recurring subscription to inactivate",
          );
        }
        let subscriptionMutationNeeded = false;
        const presentPayments: string[] = [];
        if (claim.action !== "FINALIZE_REQUIRED") {
          try {
            const [customerAuditIntegration, paymentIntegration] = await Promise
              .all([
                claim.customerId
                  ? schoolAsaasIntegration(
                    admin,
                    tenantId,
                    subscriptionPurpose,
                  )
                  : Promise.resolve(null),
                externalPaymentIds.length
                  ? schoolAsaasIntegration(admin, tenantId, "payment.delete")
                  : Promise.resolve(null),
              ]);
            const subscriptionIntegration = claim.subscriptionId
              ? customerAuditIntegration
              : null;
            const customerInventory = customerAuditIntegration
              ? await requireOffboardingCustomerInventory(
                admin,
                customerAuditIntegration,
                paymentIntegration,
                claim,
                tenantId,
                target.id,
              )
              : null;
            await bindOffboardingIntegrations(
              admin,
              claim,
              subscriptionIntegration,
              paymentIntegration,
            );
            let preservedProviderPayments:
              | AsaasSubscriptionPaymentSnapshot[]
              | null = customerInventory
                ? customerInventory.recurringPayments.filter((payment) =>
                  payment.subscriptionId === claim.subscriptionId
                )
                : null;
            if (claim.subscriptionId && subscriptionIntegration) {
              const subscriptionPresence =
                await requireAsaasOffboardingIdentity(
                  admin,
                  subscriptionIntegration,
                  {
                    operation: preserveCurrentInvoices
                      ? "school_admin_offboarding_subscription_inactivate"
                      : "school_admin_offboarding_subscription_delete",
                    tenantId,
                    studentId: target.id,
                    resource: "subscription",
                    entityId: claim.subscriptionId,
                    customerId: claim.customerId,
                    subscriptionId: claim.subscriptionId,
                    subscriptionMatch: "entity_id",
                  },
                );
              if (
                subscriptionPresence.kind === "ABSENT" &&
                claim.providerSubscriptionFinalStatus !== "NOT_FOUND"
              ) {
                throw new ApiError(
                  409,
                  "NEW_ENROLLMENT_REQUIRED",
                  "The previous subscription no longer exists",
                );
              }
              if (subscriptionPresence.kind === "PRESENT") {
                const providerStatus = String(
                  subscriptionPresence.entity.status || "",
                ).trim().toUpperCase();
                if (claim.providerSubscriptionFinalStatus === "INACTIVE") {
                  subscriptionMutationNeeded = providerStatus === "ACTIVE";
                  if (
                    !new Set(["ACTIVE", "INACTIVE"]).has(providerStatus)
                  ) {
                    throw new ApiError(
                      409,
                      "OFFBOARDING_SUBSCRIPTION_STATUS_UNSAFE",
                      "The subscription status requires reconciliation",
                    );
                  }
                } else if (
                  new Set(["ACTIVE", "INACTIVE", "EXPIRED"]).has(providerStatus)
                ) {
                  subscriptionMutationNeeded = true;
                } else {
                  throw new ApiError(
                    409,
                    "OFFBOARDING_SUBSCRIPTION_STATUS_UNSAFE",
                    "The subscription status requires reconciliation",
                  );
                }
                if (claim.targetStatus === "offboarded") {
                  preservedProviderPayments =
                    await listAsaasSubscriptionPayments(
                      subscriptionIntegration,
                      claim.subscriptionId,
                      claim.customerId,
                    );
                  requireCompleteOffboardingPaymentSnapshot(
                    claim,
                    preservedProviderPayments,
                  );
                }
              }
            }
            if (claim.billingPolicy === "CHARGE_CURRENT_MONTH") {
              await requireSinglePreservedCurrentInvoice(
                admin,
                claim,
                tenantId,
                target.id,
                customerAuditIntegration,
                preservedProviderPayments,
              );
            }
            for (const payment of paymentTargets) {
              const externalId = payment.asaasPaymentId;
              if (paymentIntegration) {
                const localSnapshot = payment.kind === "RECURRING"
                  ? claim.payments.find((candidate) =>
                    candidate.id === payment.localId
                  )
                  : undefined;
                const presence = await requireAsaasOffboardingIdentity(
                  admin,
                  paymentIntegration,
                  {
                    operation: "school_admin_offboarding_payment_delete",
                    tenantId,
                    studentId: target.id,
                    resource: "payment",
                    entityId: externalId,
                    customerId: claim.customerId,
                    subscriptionId: claim.subscriptionId || null,
                    subscriptionMatch: "optional",
                    localPayment: localSnapshot,
                  },
                );
                if (presence.kind === "PRESENT") {
                  const providerStatus = String(
                    presence.entity.status || "",
                  ).trim().toUpperCase();
                  if (DELETABLE_PAYMENT_STATUSES.has(providerStatus)) {
                    presentPayments.push(externalId);
                  } else if (
                    TERMINAL_PAYMENT_STATUSES.has(providerStatus) &&
                    payment.kind === "RECURRING"
                  ) {
                    const { data: localPayment, error: localPaymentError } =
                      await admin.from("student_payments")
                        .select("status")
                        .eq("id", payment.localId)
                        .eq("tenant_id", tenantId)
                        .eq("student_id", target.id)
                        .maybeSingle();
                    if (
                      localPaymentError || !localPayment ||
                      !TERMINAL_PAYMENT_STATUSES.has(
                        String(localPayment.status || "").trim().toUpperCase(),
                      )
                    ) {
                      throw new ApiError(
                        409,
                        "OFFBOARDING_PAYMENT_EVENT_PENDING",
                        "A terminal provider payment is awaiting local reconciliation",
                      );
                    }
                  } else if (TERMINAL_PAYMENT_STATUSES.has(providerStatus)) {
                    // Enrollment fee state is never rewritten by offboarding;
                    // a terminal provider object therefore needs no deletion.
                  } else {
                    throw new ApiError(
                      409,
                      "OFFBOARDING_PAYMENT_STATUS_UNSAFE",
                      "A provider payment status requires reconciliation",
                    );
                  }
                }
              }
            }

            // All identities are proven before crossing the durable mutation
            // fence. A retry only GETs and deletes resources still present.
            await requireExclusiveActiveTargetMembership(
              admin,
              target.id,
              tenantId,
              "STUDENT",
            );
            await recordOffboardingProviderState(admin, claim, "MUTATING");
            try {
              if (
                claim.subscriptionId && subscriptionIntegration &&
                subscriptionMutationNeeded
              ) {
                await callAsaas(
                  admin,
                  tenantId,
                  subscriptionPurpose,
                  subscriptionIntegration,
                  `/subscriptions/${encodeURIComponent(claim.subscriptionId)}`,
                  preserveCurrentInvoices ? "PUT" : "DELETE",
                  preserveCurrentInvoices ? { status: "INACTIVE" } : undefined,
                );
              }
              for (const externalId of presentPayments) {
                if (paymentIntegration) {
                  await callAsaas(
                    admin,
                    tenantId,
                    "payment.delete",
                    paymentIntegration,
                    `/payments/${encodeURIComponent(externalId)}`,
                    "DELETE",
                  );
                }
              }
              let finalSubscriptionStatus = claim.subscriptionId
                ? ""
                : "NOT_FOUND";
              if (claim.subscriptionId) {
                if (!subscriptionIntegration) {
                  throw new ApiError(
                    409,
                    "OFFBOARDING_SUBSCRIPTION_BINDING_MISSING",
                    "The recurring subscription has no verifiable provider binding",
                  );
                }
                const finalSubscription = await requireAsaasOffboardingIdentity(
                  admin,
                  subscriptionIntegration,
                  {
                    operation:
                      "school_admin_offboarding_subscription_postcondition",
                    tenantId,
                    studentId: target.id,
                    resource: "subscription",
                    entityId: claim.subscriptionId,
                    customerId: claim.customerId,
                    subscriptionId: claim.subscriptionId,
                    subscriptionMatch: "entity_id",
                  },
                );
                finalSubscriptionStatus = finalSubscription.kind ===
                    "PRESENT"
                  ? String(finalSubscription.entity.status || "").trim()
                    .toUpperCase()
                  : "NOT_FOUND";
                if (
                  claim.targetStatus === "offboarded" &&
                  finalSubscriptionStatus === "INACTIVE"
                ) {
                  const finalProviderPayments =
                    await listAsaasSubscriptionPayments(
                      subscriptionIntegration,
                      claim.subscriptionId,
                      claim.customerId,
                    );
                  requireOffboardingProviderCancellationComplete(
                    claim,
                    finalProviderPayments,
                  );
                }
              }
              if (
                finalSubscriptionStatus !==
                  claim.providerSubscriptionFinalStatus
              ) {
                throw new ApiError(
                  409,
                  "OFFBOARDING_SUBSCRIPTION_POSTCONDITION_FAILED",
                  claim.providerSubscriptionFinalStatus === "INACTIVE"
                    ? "The recurring subscription was not safely inactivated"
                    : "The recurring subscription was not safely deleted",
                );
              }
              for (const payment of paymentTargets) {
                if (!paymentIntegration) continue;
                const localSnapshot = claim.payments.find((candidate) =>
                  candidate.id === payment.localId
                );
                const finalPayment = await requireAsaasOffboardingIdentity(
                  admin,
                  paymentIntegration,
                  {
                    operation: "school_admin_offboarding_payment_postcondition",
                    tenantId,
                    studentId: target.id,
                    resource: "payment",
                    entityId: payment.asaasPaymentId,
                    customerId: claim.customerId,
                    subscriptionId: claim.subscriptionId || null,
                    subscriptionMatch: "optional",
                    localPayment: localSnapshot,
                  },
                );
                const finalPaymentStatus = finalPayment.kind === "PRESENT"
                  ? normalizedProviderText(finalPayment.entity.status)
                    .toUpperCase()
                  : "DELETED";
                if (
                  !PROVIDER_CANCELLED_PAYMENT_STATUSES.has(finalPaymentStatus)
                ) {
                  throw new ApiError(
                    409,
                    "OFFBOARDING_PAYMENT_POSTCONDITION_FAILED",
                    "A recurring charge was not safely cancelled",
                  );
                }
              }
              if (customerAuditIntegration) {
                const [subscriptions, customerPayments] = await Promise.all([
                  listAsaasCustomerSubscriptions(
                    customerAuditIntegration,
                    claim.customerId,
                  ),
                  listAsaasCustomerPayments(
                    customerAuditIntegration,
                    claim.customerId,
                  ),
                ]);
                const finalCustomerInventory: OffboardingCustomerInventory = {
                  subscriptions,
                  recurringPayments: customerPayments.filter((payment) =>
                    Boolean(payment.subscriptionId)
                  ),
                };
                requireOffboardingCustomerPostcondition(
                  claim,
                  finalCustomerInventory,
                );
                if (claim.billingPolicy === "CHARGE_CURRENT_MONTH") {
                  await requireSinglePreservedCurrentInvoice(
                    admin,
                    claim,
                    tenantId,
                    target.id,
                    customerAuditIntegration,
                    finalCustomerInventory.recurringPayments.filter(
                      (payment) =>
                        payment.subscriptionId === claim.subscriptionId,
                    ),
                  );
                }
              }
            } catch (providerError) {
              await recordOffboardingProviderState(
                admin,
                claim,
                "UNKNOWN",
                providerError instanceof Error
                  ? providerError.name
                  : "provider_request_failed",
              );
              throw providerError;
            }
            await recordOffboardingProviderState(admin, claim, "COMPLETE");
          } catch (operationError) {
            await admin.rpc("abort_student_lifecycle_operation", {
              p_operation_id: claim.id,
              p_claim_token: claim.token,
              p_reason: "pre_provider_validation_failed",
            });
            throw operationError;
          }
        }

        const { data: finalized, error: finalizeError } = await admin.rpc(
          "finalize_student_offboarding_with_billing_policy",
          {
            p_operation_id: claim.id,
            p_claim_token: claim.token,
          },
        );
        if (
          finalizeError || finalized?.ok !== true ||
          normalizedProviderText(
              finalized?.provider_subscription_final_status,
            ).toUpperCase() !== claim.providerSubscriptionFinalStatus
        ) {
          throw new ApiError(
            409,
            "OFFBOARDING_FINALIZE_FAILED",
            "Provider billing was stopped, but the local snapshot changed",
          );
        }
        const billing = {
          subscriptionCancelled: Boolean(claim.subscriptionId) &&
            !preserveCurrentInvoices,
          subscriptionAction: !claim.subscriptionId
            ? "NONE"
            : preserveCurrentInvoices
            ? "INACTIVATED"
            : "DELETED",
          paymentsCancelled: Number(finalized.payments_cancelled || 0),
          periodsExempted: Number(finalized.billing_periods_exempted || 0),
          policy: claim.billingPolicy,
          periodStart: claim.billingPeriodStart,
          effectiveEndDate: claim.effectiveEndDate,
          schedulesCancelled: Number(finalized.schedules_cancelled || 0),
        };
        await writeAudit(admin, auth.context, tenantId, req, {
          action: action.action,
          resourceType: "student",
          resourceId: target.id,
          oldValues: { lifecycle_status: target.lifecycle_status },
          newValues: {
            lifecycle_status: action.status,
            reason: claim.reason,
            billing_policy: action.billingPolicy,
            billing,
            operation_id: claim.id,
          },
        });
        return json({
          ok: true,
          id: target.id,
          lifecycle_status: action.status,
          billing,
        });
      }

      if (
        action.action === "setStudentLifecycle" &&
        action.status === "active" &&
        String(target.lifecycle_status || "").trim().toLowerCase() !== "active"
      ) {
        if (
          String(target.lifecycle_status || "").trim().toLowerCase() !==
            "suspended"
        ) {
          throw new ApiError(
            409,
            "NEW_ENROLLMENT_REQUIRED",
            "A definitively offboarded student needs a new enrollment",
          );
        }
        const begun = await beginStudentReactivation(admin, {
          tenantId,
          studentId: target.id,
          requestedBy: auth.context.userId,
        });
        if (begun.kind === "IN_PROGRESS") {
          throw new ApiError(
            409,
            "REACTIVATION_IN_PROGRESS",
            "The student reactivation is already in progress",
          );
        }
        if (begun.kind === "REVIEW_REQUIRED") {
          throw new ApiError(
            409,
            "REACTIVATION_REVIEW_REQUIRED",
            "The subscription binding requires review before reactivation",
          );
        }
        if (begun.kind === "COMPLETED") {
          return json({
            ok: true,
            id: target.id,
            lifecycle_status: "active",
            billing: { subscriptionReactivated: false },
            idempotent: true,
          });
        }
        if (begun.kind !== "CLAIMED") {
          throw new ApiError(
            503,
            "REACTIVATION_CLAIM_INVALID",
            "The account operation fence returned an invalid state",
          );
        }
        const claim = begun.claim;
        if (
          claim.customerId !== String(target.asaas_customer_id || "").trim() ||
          claim.subscriptionId !== String(target.subscription_id || "").trim()
        ) {
          throw new ApiError(
            409,
            "REACTIVATION_SNAPSHOT_MISMATCH",
            "The subscription binding changed before reactivation",
          );
        }
        if (claim.action !== "FINALIZE_REQUIRED") {
          try {
            const integration = await schoolAsaasIntegration(
              admin,
              tenantId,
              "subscription.update",
            );
            await bindOffboardingIntegrations(admin, claim, integration, null);
            const presence = await requireAsaasOffboardingIdentity(
              admin,
              integration,
              {
                operation: "school_admin_student_reactivation",
                tenantId,
                studentId: target.id,
                resource: "subscription",
                entityId: claim.subscriptionId,
                customerId: claim.customerId,
                subscriptionId: claim.subscriptionId,
                subscriptionMatch: "entity_id",
              },
            );
            if (presence.kind === "ABSENT") {
              throw new ApiError(
                409,
                "NEW_ENROLLMENT_REQUIRED",
                "The previous subscription no longer exists",
              );
            }
            const providerStatus = String(presence.entity.status || "")
              .trim().toUpperCase();
            if (!new Set(["ACTIVE", "INACTIVE"]).has(providerStatus)) {
              throw new ApiError(
                409,
                "REACTIVATION_SUBSCRIPTION_STATUS_UNSAFE",
                "The subscription status requires review",
              );
            }
            const providerValue = Number(presence.entity.value);
            if (
              !Number.isFinite(providerValue) ||
              Math.round(providerValue * 100) !==
                Math.round(claim.monthlyFee * 100)
            ) {
              throw new ApiError(
                409,
                "REACTIVATION_SUBSCRIPTION_VALUE_MISMATCH",
                "The subscription amount no longer matches the student plan",
              );
            }
            const existingProviderPayments =
              await listAsaasSubscriptionPayments(
                integration,
                claim.subscriptionId,
                claim.customerId,
              );
            requireUniqueLiveProviderCompetences(existingProviderPayments);
            await requireSynchronizedLiveSubscriptionPayments(
              admin,
              tenantId,
              target.id,
              existingProviderPayments,
            );
            const safeNextDueDate = nextStudentDueDate(
              claim.dueDay,
              existingProviderPayments
                .filter((payment) =>
                  !payment.deleted &&
                  !PROVIDER_CANCELLED_PAYMENT_STATUSES.has(payment.status)
                )
                .map((payment) => payment.dueDate),
            );
            const currentNextDueDate = normalizedProviderText(
              presence.entity.nextDueDate,
            );
            const currentNextDueDateIsSafe =
              /^\d{4}-\d{2}-\d{2}$/.test(currentNextDueDate) &&
              currentNextDueDate === safeNextDueDate;
            const requestedNextDueDate = safeNextDueDate;
            await requireExclusiveActiveTargetMembership(
              admin,
              target.id,
              tenantId,
              "STUDENT",
            );
            await recordOffboardingProviderState(admin, claim, "MUTATING");
            try {
              if (providerStatus === "INACTIVE" || !currentNextDueDateIsSafe) {
                await callAsaas(
                  admin,
                  tenantId,
                  "subscription.update",
                  integration,
                  `/subscriptions/${encodeURIComponent(claim.subscriptionId)}`,
                  "PUT",
                  {
                    status: "ACTIVE",
                    nextDueDate: requestedNextDueDate,
                  },
                );
              }
              const verified = await requireAsaasOffboardingIdentity(
                admin,
                integration,
                {
                  operation: "school_admin_student_reactivation_postcondition",
                  tenantId,
                  studentId: target.id,
                  resource: "subscription",
                  entityId: claim.subscriptionId,
                  customerId: claim.customerId,
                  subscriptionId: claim.subscriptionId,
                  subscriptionMatch: "entity_id",
                },
              );
              if (verified.kind === "ABSENT") {
                throw new ApiError(
                  409,
                  "REACTIVATION_SUBSCRIPTION_DISAPPEARED",
                  "The subscription disappeared while it was being reactivated",
                );
              }
              const verifiedStatus = normalizedProviderText(
                verified.entity.status,
              ).toUpperCase();
              const verifiedNextDueDate = normalizedProviderText(
                verified.entity.nextDueDate,
              );
              const verifiedValue = Number(verified.entity.value);
              if (
                verifiedStatus !== claim.providerSubscriptionFinalStatus ||
                !/^\d{4}-\d{2}-\d{2}$/.test(verifiedNextDueDate) ||
                verifiedNextDueDate !== requestedNextDueDate ||
                !Number.isFinite(verifiedValue) ||
                Math.round(verifiedValue * 100) !==
                  Math.round(claim.monthlyFee * 100)
              ) {
                throw new ApiError(
                  409,
                  "REACTIVATION_SUBSCRIPTION_POSTCONDITION_FAILED",
                  "The provider did not confirm the expected active subscription terms",
                );
              }
              const verifiedPayments = await listAsaasSubscriptionPayments(
                integration,
                claim.subscriptionId,
                claim.customerId,
              );
              await requireSynchronizedLiveSubscriptionPayments(
                admin,
                tenantId,
                target.id,
                verifiedPayments,
              );
              requireUniqueLiveProviderCompetences(verifiedPayments);
            } catch (providerError) {
              await recordOffboardingProviderState(
                admin,
                claim,
                "UNKNOWN",
                providerError instanceof Error
                  ? providerError.name
                  : "provider_request_failed",
              );
              throw providerError;
            }
            await recordOffboardingProviderState(admin, claim, "COMPLETE");
          } catch (operationError) {
            try {
              await abortStudentLifecycleOperation(
                admin,
                claim,
                "pre_provider_validation_failed",
              );
            } catch {
              // Once the provider fence is MUTATING, UNKNOWN, or COMPLETE the
              // abort is expected to fail closed. Keep the original failure so
              // the caller receives the operation's real reconciliation cause.
            }
            throw operationError;
          }
        }
        const { data: finalized, error: finalizeError } = await admin.rpc(
          "finalize_student_reactivation",
          { p_operation_id: claim.id, p_claim_token: claim.token },
        );
        if (
          finalizeError || finalized?.ok !== true ||
          normalizedProviderText(
              finalized?.provider_subscription_final_status,
            ).toUpperCase() !== claim.providerSubscriptionFinalStatus
        ) {
          throw new ApiError(
            409,
            "REACTIVATION_FINALIZE_FAILED",
            "The subscription was reactivated, but the local snapshot changed",
          );
        }
        const billing = { subscriptionReactivated: true };
        await writeAudit(admin, auth.context, tenantId, req, {
          action: "setStudentLifecycle",
          resourceType: "student",
          resourceId: target.id,
          oldValues: { lifecycle_status: target.lifecycle_status },
          newValues: {
            lifecycle_status: "active",
            billing,
            operation_id: claim.id,
          },
        });
        return json({
          ok: true,
          id: target.id,
          lifecycle_status: "active",
          billing,
        });
      }

      // Teacher lifecycle and already-active student idempotency have no
      // provider mutation, but still finalize with a compare-and-swap.
      await requireExclusiveActiveTargetMembership(
        admin,
        target.id,
        tenantId,
        expectedRole,
      );
      const patch = lifecyclePatch(action.status, action.reason);
      const { data: updated, error: updateError } = await admin.from("profiles")
        .update(patch)
        .eq("tenant_id", tenantId)
        .eq("role", expectedRole)
        .eq("id", target.id)
        .eq("lifecycle_status", target.lifecycle_status)
        .select("id")
        .maybeSingle();
      if (updateError || !updated) {
        throw new ApiError(
          409,
          "ACCOUNT_SNAPSHOT_CHANGED",
          "Account changed before the update could be finalized",
        );
      }

      const billing = {
        subscriptionCancelled: false,
        futurePaymentsCancelled: 0,
      };
      await writeAudit(admin, auth.context, tenantId, req, {
        action: action.action,
        resourceType: isStudent ? "student" : "teacher",
        resourceId: target.id,
        oldValues: { lifecycle_status: target.lifecycle_status },
        newValues: {
          lifecycle_status: action.status,
          reason: action.reason,
          billing,
        },
      });
      return json({
        ok: true,
        id: target.id,
        lifecycle_status: action.status,
        billing,
      });
    }

    // Negativacao permanece indisponivel ate haver claim/outbox transacional,
    // payload homologado pelo Asaas e retomada idempotente. Nao chame o
    // provedor: retries HTTP nao podem criar pedidos duplicados.
    return json({
      error: "Debt collection is temporarily unavailable",
      code: "DUNNING_DISABLED_PENDING_SAFE_OUTBOX",
      retryable: false,
    }, 503);
  } catch (error) {
    if (error instanceof ApiError) {
      return json({ error: error.message, code: error.code }, error.status);
    }
    console.error("School admin request failed", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return json(
      { error: "Unexpected server error", code: "INTERNAL_ERROR" },
      500,
    );
  }
}

if (import.meta.main) serve(handleRequest);
