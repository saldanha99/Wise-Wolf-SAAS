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
  hasExclusiveActiveTargetMembership,
  type LifecycleStatus,
  normalizeEnrollmentPlan,
  normalizeSchoolAdminAction,
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
  method: "DELETE",
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
  payments: OffboardingPaymentSnapshot[];
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
    if (!UUID_PATTERN.test(id) || seenLocal.has(id)) {
      throw new Error("offboarding_snapshot_invalid");
    }
    if (asaasPaymentId && seenProvider.has(asaasPaymentId)) {
      throw new Error("offboarding_provider_payment_duplicate");
    }
    seenLocal.add(id);
    if (asaasPaymentId) seenProvider.add(asaasPaymentId);
    return { id, asaasPaymentId };
  });
}

async function beginStudentOffboarding(
  admin: SupabaseClient,
  input: {
    tenantId: string;
    studentId: string;
    requestedBy: string | null;
    targetStatus: "suspended" | "offboarded";
    reason: string | null;
  },
): Promise<
  | { kind: "CLAIMED"; claim: OffboardingClaim }
  | { kind: "IN_PROGRESS" }
  | { kind: "COMPLETED" }
  | { kind: "REVIEW_REQUIRED" }
> {
  const token = crypto.randomUUID();
  const { data, error } = await admin.rpc("begin_student_offboarding", {
    p_tenant_id: input.tenantId,
    p_student_id: input.studentId,
    p_requested_by: input.requestedBy,
    p_target_status: input.targetStatus,
    p_reason: input.reason,
    p_claim_token: token,
    p_lease_seconds: 300,
  });
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
  if (
    !UUID_PATTERN.test(id) || returnedToken !== token ||
    !["suspended", "offboarded"].includes(targetStatus)
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
      customerId: String(result.customer_id || "").trim(),
      subscriptionId: String(result.subscription_id || "").trim(),
      enrollmentPaymentId: String(result.enrollment_payment_id || "").trim(),
      payments: parseOffboardingPayments(result.payment_snapshot),
    },
  };
}

async function recordOffboardingProviderState(
  admin: SupabaseClient,
  claim: OffboardingClaim,
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

async function bindOffboardingIntegrations(
  admin: SupabaseClient,
  claim: OffboardingClaim,
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

async function createEnrollmentOffer(
  req: Request,
  context: RequestAuthContext,
  tenantId: string,
  leadId: string,
  planId: string,
  teacherId: string,
  schedule: Array<{ day: string; time: string }>,
  startDate: string,
  billingStartMonth: string,
  dueDay: number,
  enableProRata: boolean,
): Promise<Response> {
  const admin = context.admin;
  const [leadResult, planResult] = await Promise.all([
    admin.from("crm_leads")
      .select("id,tenant_id,name,phone,status")
      .eq("tenant_id", tenantId)
      .eq("id", leadId)
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
  if (leadResult.error || planResult.error) {
    throw new ApiError(
      503,
      "DATA_UNAVAILABLE",
      "Could not validate enrollment",
    );
  }
  if (!leadResult.data || !planResult.data) {
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
          "id,role,tenant_id,lifecycle_status,subscription_id,asaas_customer_id,enrollment_payment_id,enrollment_fee_paid",
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
          requested: true,
        },
      }, true);

      if (isStudent && action.status !== "active") {
        const begun = await beginStudentOffboarding(admin, {
          tenantId,
          studentId: target.id,
          requestedBy: auth.context.userId,
          targetStatus: action.status,
          reason: action.reason,
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
        const claim = begun.claim;
        if (
          claim.targetStatus !== action.status ||
          claim.customerId !== String(target.asaas_customer_id || "").trim() ||
          claim.subscriptionId !==
            String(target.subscription_id || "").trim() ||
          claim.enrollmentPaymentId !==
            String(target.enrollment_payment_id || "").trim()
        ) {
          throw new ApiError(
            409,
            "OFFBOARDING_SNAPSHOT_MISMATCH",
            "The account billing snapshot changed and requires review",
          );
        }
        const paymentTargets = [
          ...claim.payments.flatMap((payment) =>
            payment.asaasPaymentId
              ? [{
                kind: "RECURRING" as const,
                localId: payment.id,
                asaasPaymentId: payment.asaasPaymentId,
              }]
              : []
          ),
          ...(claim.enrollmentPaymentId
            ? [{
              kind: "ENROLLMENT" as const,
              localId: null,
              asaasPaymentId: claim.enrollmentPaymentId,
            }]
            : []),
        ];
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

        let subscriptionPresent = false;
        const presentPayments: string[] = [];
        if (claim.action !== "FINALIZE_REQUIRED") {
          const [subscriptionIntegration, paymentIntegration] = await Promise
            .all([
              claim.subscriptionId
                ? schoolAsaasIntegration(
                  admin,
                  tenantId,
                  "subscription.delete",
                )
                : Promise.resolve(null),
              externalPaymentIds.length
                ? schoolAsaasIntegration(admin, tenantId, "payment.delete")
                : Promise.resolve(null),
            ]);
          await bindOffboardingIntegrations(
            admin,
            claim,
            subscriptionIntegration,
            paymentIntegration,
          );
          if (claim.subscriptionId && subscriptionIntegration) {
            const subscriptionPresence = await requireAsaasMutationIdentity(
              admin,
              subscriptionIntegration,
              {
                operation: "school_admin_offboarding_subscription_delete",
                tenantId,
                studentId: target.id,
                resource: "subscription",
                entityId: claim.subscriptionId,
                customerId: claim.customerId,
                subscriptionId: claim.subscriptionId,
                subscriptionMatch: "entity_id",
              },
            );
            if (subscriptionPresence.kind === "PRESENT") {
              const providerStatus = String(
                subscriptionPresence.entity.status || "",
              ).trim().toUpperCase();
              if (providerStatus === "ACTIVE") {
                subscriptionPresent = true;
              } else if (
                !new Set(["INACTIVE", "EXPIRED"]).has(providerStatus)
              ) {
                throw new ApiError(
                  409,
                  "OFFBOARDING_SUBSCRIPTION_STATUS_UNSAFE",
                  "The subscription status requires reconciliation",
                );
              }
            }
          }
          for (const payment of paymentTargets) {
            const externalId = payment.asaasPaymentId;
            if (paymentIntegration) {
              const presence = await requireAsaasMutationIdentity(
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
                },
              );
              if (presence.kind === "PRESENT") {
                const providerStatus = String(
                  presence.entity.status || "",
                ).trim().toUpperCase();
                if (providerStatus === "PENDING") {
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
          await recordOffboardingProviderState(admin, claim, "MUTATING");
          try {
            if (
              claim.subscriptionId && subscriptionIntegration &&
              subscriptionPresent
            ) {
              await callAsaas(
                admin,
                tenantId,
                "subscription.delete",
                subscriptionIntegration,
                `/subscriptions/${encodeURIComponent(claim.subscriptionId)}`,
                "DELETE",
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
        }

        const { data: finalized, error: finalizeError } = await admin.rpc(
          "finalize_student_offboarding",
          {
            p_operation_id: claim.id,
            p_claim_token: claim.token,
          },
        );
        if (finalizeError || finalized?.ok !== true) {
          throw new ApiError(
            409,
            "OFFBOARDING_FINALIZE_FAILED",
            "Provider billing was stopped, but the local snapshot changed",
          );
        }
        const billing = {
          subscriptionCancelled: Boolean(claim.subscriptionId),
          futurePaymentsCancelled: Number(
            finalized.future_payments_cancelled || 0,
          ),
        };
        await writeAudit(admin, auth.context, tenantId, req, {
          action: action.action,
          resourceType: "student",
          resourceId: target.id,
          oldValues: { lifecycle_status: target.lifecycle_status },
          newValues: {
            lifecycle_status: action.status,
            reason: action.reason,
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

      // Teacher lifecycle and student reactivation have no provider mutation,
      // but still finalize with a compare-and-swap on the original snapshot.
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
