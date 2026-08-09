import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  authorizeRequest,
  hasTenantAccess,
  methodNotAllowed,
} from "../_shared/request-auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

type NotificationType = "DIRECTOR_NEW_CONTRACT" | "STUDENT_APPROVED";
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const jsonResponse = (
  status: number,
  payload: Record<string, unknown>,
): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const normalizeBrazilianPhone = (raw: string | null): string | null => {
  let phone = (raw ?? "").replace(/\D/g, "");
  if (phone.length === 10 || phone.length === 11) phone = `55${phone}`;
  return phone.length >= 12 && phone.length <= 13 ? phone : null;
};
const safeMessageLabel = (raw: string | null, fallback: string): string =>
  (raw ?? fallback).replace(/[\r\n\t]+/g, " ").trim().slice(0, 120) || fallback;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return methodNotAllowed(corsHeaders);

  const auth = await authorizeRequest(req, {
    corsHeaders,
    allowedRoles: ["STUDENT", "SCHOOL_ADMIN", "SUPER_ADMIN"],
  });
  if (auth.ok === false) return auth.response;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return jsonResponse(400, { error: "Invalid JSON body" });
  }
  if (
    typeof rawBody !== "object" ||
    rawBody === null ||
    Array.isArray(rawBody)
  ) {
    return jsonResponse(400, { error: "JSON body must be an object" });
  }

  const body = rawBody as {
    type?: unknown;
    data?: unknown;
  };
  const notificationType = typeof body.type === "string"
    ? body.type
    : "";
  const requestData = typeof body.data === "object" &&
      body.data !== null &&
      !Array.isArray(body.data)
    ? body.data as { student_id?: unknown }
    : {};
  const studentId = typeof requestData.student_id === "string"
    ? requestData.student_id.trim()
    : "";

  if (
    !uuidPattern.test(studentId) ||
    !["DIRECTOR_NEW_CONTRACT", "STUDENT_APPROVED"].includes(notificationType)
  ) {
    return jsonResponse(400, {
      error: "A valid type and data.student_id are required",
    });
  }

  const caller = auth.context.profile!;
  if (
    notificationType === "DIRECTOR_NEW_CONTRACT" &&
    caller.role === "STUDENT" &&
    caller.id !== studentId
  ) {
    return jsonResponse(403, {
      error: "Students can only notify their own enrollment",
    });
  }
  if (
    notificationType === "STUDENT_APPROVED" &&
    !["SCHOOL_ADMIN", "SUPER_ADMIN"].includes(caller.role)
  ) {
    return jsonResponse(403, { error: "Administrator role required" });
  }

  const admin = auth.context.admin;
  const { data: student, error: studentError } = await admin
    .from("profiles")
    .select(
      "id, role, tenant_id, full_name, phone, class_frequency, contract_accepted, accepted_at, created_at, documentation_status, is_test_account",
    )
    .eq("id", studentId)
    .maybeSingle();

  if (studentError) {
    console.error("Enrollment notification student lookup failed", {
      code: studentError.code,
    });
    return jsonResponse(500, { error: "Could not validate student" });
  }
  if (!student || student.role !== "STUDENT" || !student.tenant_id) {
    return jsonResponse(404, { error: "Student not found" });
  }
  if (!hasTenantAccess(auth.context, student.tenant_id)) {
    return jsonResponse(403, { error: "Student is outside the allowed tenant" });
  }
  if (
    notificationType === "DIRECTOR_NEW_CONTRACT" &&
    student.contract_accepted !== true
  ) {
    return jsonResponse(409, { error: "The enrollment contract is not accepted" });
  }
  if (
    notificationType === "STUDENT_APPROVED" &&
    student.documentation_status !== "APPROVED"
  ) {
    return jsonResponse(409, {
      error: "The student documentation is not approved",
    });
  }

  if (student.is_test_account === true) {
    return jsonResponse(200, {
      success: true,
      skipped: "test_fixture",
    });
  }

  let recipient: string | null = null;
  let message = "";
  const notificationKind = notificationType as NotificationType;

  if (notificationType === "DIRECTOR_NEW_CONTRACT") {
    const { data: director, error: directorError } = await admin
      .from("profiles")
      .select("phone, owner_phone")
      .eq("tenant_id", student.tenant_id)
      .eq("role", "SCHOOL_ADMIN")
      .limit(1)
      .maybeSingle();

    if (directorError) {
      console.error("Enrollment notification director lookup failed", {
        code: directorError.code,
      });
      return jsonResponse(500, { error: "Could not load tenant administrator" });
    }

    recipient = normalizeBrazilianPhone(director?.phone || director?.owner_phone);
    const frequency = Number.parseInt(String(student.class_frequency ?? ""), 10);
    const frequencyLabel = Number.isFinite(frequency) && frequency > 0
      ? `${frequency}x/semana`
      : "frequência cadastrada";
    message =
      `🐺 NOVA MATRÍCULA! ${safeMessageLabel(student.full_name, "Um aluno")} assinou o contrato (${frequencyLabel}). Acesse o painel para validar.`;
  } else {
    recipient = normalizeBrazilianPhone(student.phone);
    const portalUrl = (Deno.env.get("SYSTEM_URL") ??
      "https://system.wisewolflanguage.com.br").trim().replace(/\/+$/, "");
    message =
      `Seja bem-vindo, ${safeMessageLabel(student.full_name, "aluno")}! 🐺 Sua matrícula foi validada. Acesse seu portal aqui: ${portalUrl}`;
  }

  if (!recipient) {
    return jsonResponse(422, {
      error: "The notification recipient has no valid phone number",
    });
  }

  const sourceTimestamp = student.accepted_at || student.created_at;
  const sourceDate = new Date(sourceTimestamp);
  if (!sourceTimestamp || Number.isNaN(sourceDate.getTime())) {
    return jsonResponse(500, {
      error: "Student enrollment timestamp is unavailable",
    });
  }
  const notificationDate = sourceDate.toISOString().slice(0, 10);
  const idempotencyFilter = admin
    .from("notification_queue")
    .select("id, status")
    .eq("source_id", student.id)
    .eq("source_type", "profile")
    .eq("class_date", notificationDate)
    .eq("notification_kind", notificationKind)
    .limit(1);
  const { data: existing, error: existingError } =
    await idempotencyFilter.maybeSingle();

  if (existingError) {
    console.error("Enrollment notification idempotency lookup failed", {
      code: existingError.code,
    });
    return jsonResponse(500, { error: "Could not queue notification" });
  }
  if (existing) {
    if (existing.status === "failed") {
      const { data: requeued, error: requeueError } = await admin
        .from("notification_queue")
        .update({
          status: "pending",
          attempts: 0,
          last_error: null,
          scheduled_for: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id)
        .eq("status", "failed")
        .select("id, status")
        .maybeSingle();
      if (requeueError) {
        console.error("Enrollment notification requeue failed", {
          code: requeueError.code,
        });
        return jsonResponse(500, { error: "Could not requeue notification" });
      }
      if (requeued) {
        return jsonResponse(202, {
          success: true,
          queued: true,
          queue_id: requeued.id,
          retried: true,
        });
      }
    }
    return jsonResponse(200, {
      success: true,
      skipped: "already_queued",
      queue_status: existing.status,
    });
  }

  const { data: queued, error: queueError } = await admin
    .from("notification_queue")
    .insert({
      tenant_id: student.tenant_id,
      student_id: student.id,
      student_name: student.full_name,
      student_phone: recipient,
      message_body: message,
      scheduled_for: new Date().toISOString(),
      status: "pending",
      attempts: 0,
      source_id: student.id,
      source_type: "profile",
      class_date: notificationDate,
      notification_kind: notificationKind,
    })
    .select("id, status")
    .single();

  if (queueError) {
    if (queueError.code === "23505") {
      return jsonResponse(200, {
        success: true,
        skipped: "already_queued",
      });
    }
    console.error("Enrollment notification queue insert failed", {
      code: queueError.code,
    });
    return jsonResponse(500, { error: "Could not queue notification" });
  }

  return jsonResponse(202, {
    success: true,
    queued: true,
    queue_id: queued.id,
  });
});
