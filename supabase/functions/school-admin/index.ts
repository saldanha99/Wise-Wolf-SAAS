/// <reference lib="deno.ns" />

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  createClient,
  type SupabaseClient,
} from "https://esm.sh/@supabase/supabase-js@2.93.3";
import {
  authorizeRequest,
  methodNotAllowed,
  type RequestAuthContext,
} from "../_shared/request-auth.ts";
import {
  isEligibleForDunning,
  type LifecycleStatus,
  normalizeEnrollmentPlan,
  normalizeSchoolAdminAction,
} from "./core.ts";

const MAX_BODY_BYTES = 16_384;
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

function asaasConfiguration(): { baseUrl: string; apiKey: string } {
  const rawUrl = (Deno.env.get("ASAAS_API_URL") ||
    "https://api-sandbox.asaas.com").trim();
  const apiKey = (Deno.env.get("ASAAS_API_KEY") ||
    Deno.env.get("ASAAS_ACCESS_TOKEN") || "").trim();
  if (!apiKey) {
    throw new ApiError(503, "ASAAS_UNAVAILABLE", "Billing is unavailable");
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ApiError(503, "ASAAS_UNAVAILABLE", "Billing is unavailable");
  }
  if (parsed.protocol !== "https:") {
    throw new ApiError(503, "ASAAS_UNAVAILABLE", "Billing is unavailable");
  }
  const normalized = rawUrl.replace(/\/+$/, "").replace(/\/v3$/, "")
    .replace(/\/api\/v3$/, "").replace(/\/api$/, "");
  const prefix = parsed.hostname === "api.asaas.com" ||
      parsed.hostname === "api-sandbox.asaas.com"
    ? "/v3"
    : "/api/v3";
  return { baseUrl: `${normalized}${prefix}`, apiKey };
}

async function callAsaas(
  path: string,
  method: "POST" | "DELETE",
  payload?: Record<string, unknown>,
): Promise<number> {
  const config = asaasConfiguration();
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        access_token: config.apiKey,
      },
      body: payload ? JSON.stringify(payload) : undefined,
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
    newValues: { requested: true, plan_id: planId },
  }, true);
  const { data: offerId, error: offerError } = await userClient.rpc(
    "create_enrollment_offer",
    {
      p_payload: {
        unitId: tenantId,
        value: normalizedPlan.value,
        planDuration: normalizedPlan.planDuration,
        classesPerWeek: normalizedPlan.classesPerWeek,
        dueDay: 10,
        enrollmentFee: 0,
        requiresEnrollment: normalizedPlan.planDuration !== 0,
        startDate: new Date().toISOString().slice(0, 10),
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
    newValues: { offer_id: offerId, plan_id: planId },
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
        .select("id,role,tenant_id,lifecycle_status,subscription_id")
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

      let subscriptionCancelled = false;
      let futurePaymentsCancelled = 0;
      let futurePaymentIds: string[] = [];
      if (isStudent && action.status !== "active") {
        if (target.subscription_id) {
          await callAsaas(
            `/subscriptions/${encodeURIComponent(target.subscription_id)}`,
            "DELETE",
          );
          subscriptionCancelled = true;
        }
        if (action.status === "offboarded") {
          const today = new Date().toISOString().slice(0, 10);
          const { data: futurePayments, error: paymentsError } = await admin
            .from("student_payments")
            .select("id,asaas_payment_id,asaas_id")
            .eq("tenant_id", tenantId)
            .eq("student_id", target.id)
            .eq("status", "PENDING")
            .gte("due_date", today);
          if (paymentsError) {
            throw new ApiError(
              503,
              "DATA_UNAVAILABLE",
              "Could not validate future billing",
            );
          }
          for (const payment of futurePayments || []) {
            const externalId = payment.asaas_payment_id || payment.asaas_id;
            if (externalId) {
              await callAsaas(
                `/payments/${encodeURIComponent(externalId)}`,
                "DELETE",
              );
            }
          }
          futurePaymentIds = (futurePayments || []).map((payment) =>
            payment.id
          );
        }
      }

      const patch = lifecyclePatch(action.status, action.reason);
      const { data: updated, error: updateError } = await admin.from("profiles")
        .update(patch)
        .eq("tenant_id", tenantId)
        .eq("role", expectedRole)
        .eq("id", target.id)
        .select("id")
        .maybeSingle();
      if (updateError || !updated) {
        throw new ApiError(
          500,
          "ACCOUNT_UPDATE_FAILED",
          "Account was not updated",
        );
      }

      if (futurePaymentIds.length) {
        const { data: cancelled, error: cancelError } = await admin
          .from("student_payments")
          .update({ status: "CANCELLED", updated_at: new Date().toISOString() })
          .eq("tenant_id", tenantId)
          .eq("student_id", target.id)
          .in("id", futurePaymentIds)
          .select("id");
        if (
          cancelError || (cancelled?.length || 0) !== futurePaymentIds.length
        ) {
          throw new ApiError(
            500,
            "BILLING_STATE_UPDATE_FAILED",
            "Billing was cancelled but local reconciliation is required",
          );
        }
        futurePaymentsCancelled = cancelled.length;
      }

      const billing = { subscriptionCancelled, futurePaymentsCancelled };
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

    const today = new Date().toISOString().slice(0, 10);
    const { data: payments, error: paymentError } = await admin
      .from("student_payments")
      .select(
        "id,student_id,tenant_id,status,due_date,asaas_payment_id,asaas_id",
      )
      .eq("tenant_id", tenantId)
      .or(
        `asaas_payment_id.eq.${action.paymentId},asaas_id.eq.${action.paymentId}`,
      )
      .limit(2);
    if (paymentError) {
      throw new ApiError(503, "DATA_UNAVAILABLE", "Could not validate payment");
    }
    if (!payments?.length) {
      throw new ApiError(404, "PAYMENT_NOT_FOUND", "Payment not found");
    }
    if (payments.length !== 1) {
      throw new ApiError(409, "PAYMENT_AMBIGUOUS", "Payment is ambiguous");
    }
    const payment = payments[0];
    if (!isEligibleForDunning(payment.status, payment.due_date, today)) {
      throw new ApiError(
        409,
        "PAYMENT_NOT_OVERDUE",
        "Only an overdue payment can be sent to debt collection",
      );
    }
    const externalPaymentId = payment.asaas_payment_id || payment.asaas_id;
    if (externalPaymentId !== action.paymentId || !payment.student_id) {
      throw new ApiError(409, "PAYMENT_INVALID", "Payment is not eligible");
    }

    const { data: student, error: studentError } = await admin.from("profiles")
      .select("full_name,cpf,phone,postal_code,address,address_number")
      .eq("tenant_id", tenantId)
      .eq("role", "STUDENT")
      .eq("id", payment.student_id)
      .maybeSingle();
    if (studentError) {
      throw new ApiError(503, "DATA_UNAVAILABLE", "Could not validate student");
    }
    const cpf = String(student?.cpf || "").replace(/\D/g, "");
    const phone = String(student?.phone || "").replace(/\D/g, "");
    const postalCode = String(student?.postal_code || "").replace(/\D/g, "");
    if (
      !student?.full_name || ![11, 14].includes(cpf.length) ||
      phone.length < 10 || phone.length > 13 || postalCode.length !== 8 ||
      !student.address || !student.address_number
    ) {
      throw new ApiError(
        422,
        "STUDENT_REGISTRATION_INCOMPLETE",
        "Student registration is incomplete for debt collection",
      );
    }

    await writeAudit(admin, auth.context, tenantId, req, {
      action: "serasaNegativarRequested",
      resourceType: "payment",
      resourceId: payment.id,
      oldValues: { status: payment.status },
      newValues: { requested: true },
    }, true);
    const providerStatus = await callAsaas("/paymentDunnings", "POST", {
      type: "SERASA",
      paymentId: action.paymentId,
      description: "Cobranca de debito em aberto",
      customerName: student.full_name,
      customerCpfCnpj: cpf,
      customerPrimaryPhone: phone,
      customerPostalCode: postalCode,
      customerAddress: student.address,
      customerAddressNumber: student.address_number,
    });
    await writeAudit(admin, auth.context, tenantId, req, {
      action: "serasaNegativar",
      resourceType: "payment",
      resourceId: payment.id,
      oldValues: { status: payment.status },
      newValues: { requested: true, provider_status: providerStatus },
    });
    return json({ ok: true, asaasStatus: providerStatus });
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
