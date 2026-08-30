import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { sendWhatsTextDetailed } from "../_shared/evolution-send.ts";
import { authorizeRequest } from "../_shared/request-auth.ts";
import {
  loadTenantCentralWhatsAppInstance,
  loadTenantWhatsAppInstance,
  safeCommunicationText,
} from "../_shared/tenant-communication.ts";
import {
  canonicalScheduleVersion,
  dateInSaoPaulo,
  DEFAULT_CLASS_REMINDER_TEMPLATE,
  hasAnyManualReminderIdentityField,
  type ManualClassSourceType,
  type ManualReminderIdentity,
  manualReminderReceipt,
  manualReminderWindow,
  normalizeStudentPhone,
  parseManualReminderIdentity,
  providerReceiptDecision,
  recurringBookingMatchesDate,
  renderReminderTemplate,
  rescheduleNotificationReceipt,
  SCHEDULE_CONFIRMATION_REF_DATE,
  scheduleVersionHash,
  timeInSaoPaulo,
} from "./core.ts";

const EVOLUTION_API_BASE = (Deno.env.get("EVOLUTION_API_URL") ||
  "https://api.2b.app.br").trim().replace(/\/+$/, "");
const API_TOKEN = (Deno.env.get("EVOLUTION_API_KEY") || "").trim();
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type NotificationAction =
  | "CLASS_REMINDER"
  | "RESCHEDULE_SCHEDULED"
  | "SCHEDULE_CONFIRMATION"
  | "WOLFIE_ASSIGNMENT";
type AdminClient = any;

interface RequestBody {
  action?: unknown;
  source_id?: unknown;
  source_type?: unknown;
  class_date?: unknown;
  assignment_id?: unknown;
}

interface ValidatedOccurrence {
  sourceId: string;
  sourceType: ManualClassSourceType;
  classDate: string;
  teacherId: string;
  teacherName: string;
  studentName: string;
  studentPhone: string;
  classTime: string;
  meetingLink: string;
  notificationRevision: number | null;
}

interface TeacherDetails {
  name: string;
  template: string | null;
  meetingLink: string;
  automationEnabled: boolean | null;
}

class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function parseAction(value: unknown): NotificationAction | null {
  const normalized = safeCommunicationText(value, 40).toUpperCase();
  return [
      "CLASS_REMINDER",
      "RESCHEDULE_SCHEDULED",
      "SCHEDULE_CONFIRMATION",
      "WOLFIE_ASSIGNMENT",
    ].includes(normalized)
    ? normalized as NotificationAction
    : null;
}

function validTime(value: unknown): string {
  const time = String(value || "").trim().slice(0, 5);
  return /^\d{2}:\d{2}$/.test(time) ? time : "";
}

async function loadStudent(
  admin: AdminClient,
  tenantId: string,
  studentId: string,
): Promise<{ name: string; phone: string; meetingLink: string }> {
  const [profileResult, membershipResult] = await Promise.all([
    admin.from("profiles")
      .select(
        "id,tenant_id,role,full_name,phone,attendance_phone,meeting_link,lifecycle_status,is_test_account",
      )
      .eq("id", studentId)
      .maybeSingle(),
    admin.from("tenant_memberships")
      .select("user_id")
      .eq("tenant_id", tenantId)
      .eq("user_id", studentId)
      .eq("role", "STUDENT")
      .eq("status", "ACTIVE")
      .maybeSingle(),
  ]);
  const { data, error } = profileResult;
  if (error) throw new ApiError(503, "student_validation_unavailable");
  if (membershipResult.error) {
    throw new ApiError(503, "student_membership_validation_unavailable");
  }
  if (
    !data || String(data.tenant_id || "") !== tenantId ||
    String(data.role || "").toUpperCase() !== "STUDENT" ||
    String(data.lifecycle_status || "").trim().toLowerCase() !== "active" ||
    String(membershipResult.data?.user_id || "") !== studentId
  ) throw new ApiError(404, "student_not_available_for_occurrence");
  if (data.is_test_account !== false) {
    // Fail-closed: fixtures (e registros antigos sem marcação explícita)
    // nunca podem gerar comunicação externa.
    throw new ApiError(409, "test_fixture_external_delivery_suppressed");
  }

  const studentName = safeCommunicationText(data.full_name, 180);
  const studentPhone = normalizeStudentPhone(data.attendance_phone) ||
    normalizeStudentPhone(data.phone);
  if (!studentPhone) {
    throw new ApiError(409, "canonical_destination_unavailable");
  }
  return {
    name: studentName,
    phone: studentPhone,
    meetingLink: safeCommunicationText(data.meeting_link, 300),
  };
}

async function loadTeacher(
  admin: AdminClient,
  tenantId: string,
  teacherId: string,
): Promise<TeacherDetails> {
  const { data, error } = await admin.from("profiles")
    .select(
      "id,tenant_id,role,full_name,date_automation_enabled,lifecycle_status,lesson_reminder_template,meeting_link,is_test_account",
    )
    .eq("id", teacherId)
    .maybeSingle();
  if (error) throw new ApiError(503, "teacher_validation_unavailable");
  if (
    !data || String(data.tenant_id || "") !== tenantId ||
    String(data.role || "").toUpperCase() !== "TEACHER" ||
    String(data.lifecycle_status || "").toLowerCase() !== "active"
  ) throw new ApiError(404, "teacher_not_available_for_occurrence");
  if (data.is_test_account !== false) {
    throw new ApiError(409, "test_fixture_external_delivery_suppressed");
  }
  const { data: membership, error: membershipError } = await admin
    .from("tenant_memberships").select("user_id")
    .eq("tenant_id", tenantId).eq("user_id", teacherId)
    .eq("role", "TEACHER").eq("status", "ACTIVE").maybeSingle();
  if (membershipError) {
    throw new ApiError(503, "teacher_membership_validation_unavailable");
  }
  if (String(membership?.user_id || "") !== teacherId) {
    throw new ApiError(404, "teacher_not_available_for_occurrence");
  }
  const name = safeCommunicationText(data.full_name, 120);
  if (!name) throw new ApiError(409, "teacher_name_unavailable");
  return {
    name,
    template: safeCommunicationText(data.lesson_reminder_template, 4096) ||
      null,
    meetingLink: safeCommunicationText(data.meeting_link, 300),
    automationEnabled: typeof data.date_automation_enabled === "boolean"
      ? data.date_automation_enabled
      : null,
  };
}

function requireOwnedTeacher(
  callerRole: string,
  callerId: string,
  occurrenceTeacherId: string,
): void {
  if (callerRole === "TEACHER" && occurrenceTeacherId !== callerId) {
    throw new ApiError(403, "occurrence_does_not_belong_to_teacher");
  }
}

async function loadBookingOccurrence(
  admin: AdminClient,
  tenantId: string,
  callerId: string,
  callerRole: string,
  identity: ManualReminderIdentity,
): Promise<Omit<ValidatedOccurrence, "teacherName">> {
  const { data, error } = await admin.from("bookings")
    .select(
      "id,tenant_id,teacher_id,student_id,day_of_week,time_slot,date,start_date,status",
    )
    .eq("id", identity.sourceId).eq("tenant_id", tenantId).maybeSingle();
  if (error) throw new ApiError(503, "occurrence_validation_unavailable");
  if (!data || String(data.status || "").toUpperCase() !== "SCHEDULED") {
    throw new ApiError(404, "class_occurrence_not_found");
  }

  const teacherId = String(data.teacher_id || "");
  const studentId = String(data.student_id || "");
  requireOwnedTeacher(callerRole, callerId, teacherId);
  const fixedDate = String(data.date || "").slice(0, 10);
  const startsOn = String(data.start_date || "").slice(0, 10);
  const matches = fixedDate
    ? fixedDate === identity.classDate
    : (!startsOn || startsOn <= identity.classDate) &&
      recurringBookingMatchesDate(data.day_of_week, identity.classDate);
  if (!teacherId || !studentId || !matches) {
    throw new ApiError(409, "class_date_does_not_match_occurrence");
  }
  const student = await loadStudent(admin, tenantId, studentId);
  return {
    sourceId: identity.sourceId,
    sourceType: identity.sourceType,
    classDate: identity.classDate,
    teacherId,
    studentName: student.name,
    studentPhone: student.phone,
    classTime: validTime(data.time_slot),
    meetingLink: student.meetingLink,
    notificationRevision: null,
  };
}

async function loadRescheduleOccurrence(
  admin: AdminClient,
  tenantId: string,
  callerId: string,
  callerRole: string,
  identity: ManualReminderIdentity,
): Promise<Omit<ValidatedOccurrence, "teacherName">> {
  const { data, error } = await admin.from("reschedules")
    .select(
      "id,tenant_id,teacher_id,student_id,date,time,used_at,notification_revision",
    )
    .eq("id", identity.sourceId).eq("tenant_id", tenantId).maybeSingle();
  if (error) throw new ApiError(503, "occurrence_validation_unavailable");
  if (
    !data || data.used_at ||
    String(data.date || "").slice(0, 10) !== identity.classDate
  ) throw new ApiError(404, "class_occurrence_not_found");

  const teacherId = String(data.teacher_id || "");
  const studentId = String(data.student_id || "");
  requireOwnedTeacher(callerRole, callerId, teacherId);
  if (!teacherId || !studentId) {
    throw new ApiError(409, "occurrence_relationship_unavailable");
  }
  const notificationRevision = Number(data.notification_revision);
  if (
    !Number.isSafeInteger(notificationRevision) || notificationRevision < 1
  ) throw new ApiError(503, "reschedule_revision_unavailable");
  const student = await loadStudent(admin, tenantId, studentId);
  return {
    sourceId: identity.sourceId,
    sourceType: identity.sourceType,
    classDate: identity.classDate,
    teacherId,
    studentName: student.name,
    studentPhone: student.phone,
    classTime: validTime(data.time),
    meetingLink: student.meetingLink,
    notificationRevision,
  };
}

async function loadAppointmentOccurrence(
  admin: AdminClient,
  tenantId: string,
  callerId: string,
  callerRole: string,
  identity: ManualReminderIdentity,
): Promise<Omit<ValidatedOccurrence, "teacherName">> {
  const { data, error } = await admin.from("appointments")
    .select(
      "id,tenant_id,teacher_id,professor_id,student_name,student_phone,start_time,status",
    )
    .eq("id", identity.sourceId).eq("tenant_id", tenantId).maybeSingle();
  if (error) throw new ApiError(503, "occurrence_validation_unavailable");
  if (!data || String(data.status || "").toLowerCase() !== "scheduled") {
    throw new ApiError(404, "class_occurrence_not_found");
  }

  const candidateTeachers = [data.teacher_id, data.professor_id]
    .map((value) => String(value || "")).filter(Boolean);
  const teacherId = callerRole === "TEACHER"
    ? candidateTeachers.find((id) => id === callerId) || ""
    : candidateTeachers[0] || "";
  requireOwnedTeacher(callerRole, callerId, teacherId);
  const appointmentDate = dateInSaoPaulo(String(data.start_time || ""));
  const studentName = safeCommunicationText(data.student_name, 180);
  const studentPhone = normalizeStudentPhone(data.student_phone);
  if (!teacherId || appointmentDate !== identity.classDate) {
    throw new ApiError(409, "class_date_does_not_match_occurrence");
  }
  if (!studentPhone) {
    throw new ApiError(409, "canonical_destination_unavailable");
  }
  return {
    sourceId: identity.sourceId,
    sourceType: identity.sourceType,
    classDate: identity.classDate,
    teacherId,
    studentName,
    studentPhone,
    classTime: timeInSaoPaulo(String(data.start_time || "")) || "",
    meetingLink: "",
    notificationRevision: null,
  };
}

async function validateOccurrence(
  admin: AdminClient,
  tenantId: string,
  callerId: string,
  callerRole: string,
  identity: ManualReminderIdentity,
  requireToday: boolean,
): Promise<ValidatedOccurrence> {
  if (requireToday && identity.classDate !== dateInSaoPaulo(new Date())) {
    throw new ApiError(409, "manual_reminder_is_only_available_on_class_date");
  }
  const occurrence = identity.sourceType === "BOOKING"
    ? await loadBookingOccurrence(
      admin,
      tenantId,
      callerId,
      callerRole,
      identity,
    )
    : identity.sourceType === "RESCHEDULE"
    ? await loadRescheduleOccurrence(
      admin,
      tenantId,
      callerId,
      callerRole,
      identity,
    )
    : await loadAppointmentOccurrence(
      admin,
      tenantId,
      callerId,
      callerRole,
      identity,
    );
  if (requireToday) {
    let startAt = "";
    if (identity.sourceType === "APPOINTMENT") {
      const { data, error } = await admin.from("appointments")
        .select("start_time,status")
        .eq("id", identity.sourceId).eq("tenant_id", tenantId).maybeSingle();
      if (error) {
        throw new ApiError(503, "occurrence_timing_validation_unavailable");
      }
      if (
        !data || String(data.status || "").toLowerCase() !== "scheduled" ||
        dateInSaoPaulo(String(data.start_time || "")) !== identity.classDate
      ) throw new ApiError(404, "class_occurrence_not_found");
      startAt = String(data.start_time || "");
    } else {
      const { data, error } = await admin.from("upcoming_classes")
        .select("source_id,source_type,tenant_id,class_date,start_at")
        .eq("source_id", identity.sourceId)
        .eq("source_type", identity.sourceType.toLowerCase())
        .eq("tenant_id", tenantId)
        .eq("class_date", identity.classDate)
        .maybeSingle();
      if (error) {
        throw new ApiError(503, "occurrence_timing_validation_unavailable");
      }
      if (!data) throw new ApiError(404, "class_occurrence_not_found");
      startAt = String(data.start_at || "");
    }
    const window = manualReminderWindow({ startAt });
    if (window.ok === false) throw new ApiError(409, window.reason);
  }
  const teacher = await loadTeacher(admin, tenantId, occurrence.teacherId);
  return {
    ...occurrence,
    teacherName: teacher.name,
    meetingLink: occurrence.meetingLink || teacher.meetingLink,
  };
}

type Receipt = { kind: string; subject_id: string; ref_date: string };
type PreparedNotification = {
  studentPhone: string;
  message: string;
  instanceOwnerId: string;
  receipt: Receipt;
  wolfieAssignmentId?: string;
};

function uuid(value: unknown): string | null {
  const candidate = typeof value === "string" ? value.trim() : "";
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(candidate)
    ? candidate
    : null;
}

function actionReceipt(
  kind: string,
  tenantId: string,
  subject: string,
  date: string,
): Receipt {
  return { kind, subject_id: `${tenantId}:${subject}`, ref_date: date };
}

async function prepareNotification(
  admin: AdminClient,
  tenantId: string,
  callerId: string,
  callerRole: string,
  action: NotificationAction,
  body: RequestBody,
): Promise<PreparedNotification> {
  const today = dateInSaoPaulo(new Date()) ||
    new Date().toISOString().slice(0, 10);
  if (action === "WOLFIE_ASSIGNMENT") {
    const assignmentId = uuid(body.assignment_id);
    if (!assignmentId) throw new ApiError(400, "invalid_assignment_identity");
    const { data, error } = await admin.from("wolfie_assignments")
      .select(
        "id,tenant_id,teacher_id,student_id,topic,note,status,assigned_on",
      )
      .eq("id", assignmentId).eq("tenant_id", tenantId).maybeSingle();
    if (error) throw new ApiError(503, "assignment_validation_unavailable");
    if (!data || String(data.status || "").toUpperCase() === "CANCELLED") {
      throw new ApiError(404, "assignment_not_found");
    }
    requireOwnedTeacher(callerRole, callerId, String(data.teacher_id || ""));
    const student = await loadStudent(
      admin,
      tenantId,
      String(data.student_id || ""),
    );
    const topic = safeCommunicationText(data.topic, 120);
    const note = safeCommunicationText(data.note, 300);
    const message = `Oi, ${student.name.split(" ")[0]}! 🐺\n\n` +
      `Sua tarefa de hoje no Wolfie: *${topic}*.\n` +
      (note ? `${note}\n\n` : "\n") +
      "É rapidinho, e dá para fazer escrevendo ou falando:\n" +
      "https://system.wisewolflanguage.com.br/?tab=ai-tutor";
    return {
      studentPhone: student.phone,
      message,
      instanceOwnerId: String(data.teacher_id || ""),
      receipt: actionReceipt(
        "WOLFIE_ASSIGNMENT",
        tenantId,
        assignmentId,
        String(data.assigned_on || today).slice(0, 10),
      ),
      wolfieAssignmentId: assignmentId,
    };
  }

  const identity = parseManualReminderIdentity(body);
  if (!identity) throw new ApiError(400, "invalid_occurrence_identity");

  if (
    action === "RESCHEDULE_SCHEDULED" &&
    identity.sourceType !== "RESCHEDULE"
  ) throw new ApiError(400, "reschedule_notification_requires_reschedule");

  if (action === "SCHEDULE_CONFIRMATION") {
    if (identity.sourceType !== "BOOKING") {
      throw new ApiError(400, "schedule_confirmation_requires_booking");
    }
    const { data: seed, error } = await admin.from("bookings")
      .select("id,tenant_id,teacher_id,student_id,status")
      .eq("id", identity.sourceId).eq("tenant_id", tenantId).maybeSingle();
    if (error) throw new ApiError(503, "occurrence_validation_unavailable");
    if (!seed || String(seed.status || "").toUpperCase() !== "SCHEDULED") {
      throw new ApiError(404, "class_occurrence_not_found");
    }
    const teacherId = String(seed.teacher_id || "");
    const studentId = String(seed.student_id || "");
    requireOwnedTeacher(callerRole, callerId, teacherId);
    const [student, teacher, scheduleResult] = await Promise.all([
      loadStudent(admin, tenantId, studentId),
      loadTeacher(admin, tenantId, teacherId),
      admin.from("bookings").select("day_of_week,time_slot")
        .eq("tenant_id", tenantId).eq("teacher_id", teacherId)
        .eq("student_id", studentId)
        .in("status", ["SCHEDULED", "scheduled"])
        .order("day_of_week").order("time_slot"),
    ]);
    if (scheduleResult.error) {
      throw new ApiError(503, "schedule_validation_unavailable");
    }
    const scheduleRows = scheduleResult.data || [];
    const schedule = scheduleRows
      .map((row: any) =>
        `${safeCommunicationText(row.day_of_week, 30)} às ${
          validTime(row.time_slot)
        }`
      )
      .filter((value: string) => !value.endsWith("às ")).join(", ");
    if (!schedule) throw new ApiError(409, "canonical_schedule_unavailable");
    const scheduleVersion = canonicalScheduleVersion(scheduleRows);
    const scheduleHash = await scheduleVersionHash(scheduleVersion);
    if (!scheduleHash) {
      throw new ApiError(409, "canonical_schedule_unavailable");
    }
    return {
      studentPhone: student.phone,
      message: `Oi ${
        student.name.split(" ")[0]
      }, aqui é o ${teacher.name}! Seu horário de aulas foi confirmado: ${schedule}.`,
      instanceOwnerId: teacherId,
      receipt: {
        kind: "SCHEDULE_CONFIRMATION",
        subject_id:
          `${tenantId}:schedule:${teacherId}:${studentId}:${scheduleHash}`,
        ref_date: SCHEDULE_CONFIRMATION_REF_DATE,
      },
    };
  }

  const occurrence = await validateOccurrence(
    admin,
    tenantId,
    callerId,
    callerRole,
    identity,
    action === "CLASS_REMINDER",
  );
  const teacher = await loadTeacher(admin, tenantId, occurrence.teacherId);
  if (action === "CLASS_REMINDER" && teacher.automationEnabled !== false) {
    throw new ApiError(409, "manual_reminder_disabled_while_auto_is_enabled");
  }
  let receipt: Receipt;
  if (action === "CLASS_REMINDER") {
    receipt = manualReminderReceipt(tenantId, identity);
  } else {
    const notificationRevision = occurrence.notificationRevision;
    if (notificationRevision === null) {
      throw new ApiError(503, "reschedule_revision_unavailable");
    }
    receipt = rescheduleNotificationReceipt(
      tenantId,
      identity,
      notificationRevision,
    );
  }
  const firstName = occurrence.studentName.split(" ")[0];
  const { data: tenant, error: tenantError } = await admin.from("tenants")
    .select("name").eq("id", tenantId).maybeSingle();
  if (tenantError) throw new ApiError(503, "tenant_validation_unavailable");
  const message = action === "CLASS_REMINDER"
    ? renderReminderTemplate(
      teacher.template || DEFAULT_CLASS_REMINDER_TEMPLATE,
      {
        student_name: firstName,
        class_time: occurrence.classTime,
        class_link: occurrence.meetingLink,
        teacher_name: teacher.name,
        tenant_name: safeCommunicationText(tenant?.name, 160),
      },
    )
    : `Oi ${firstName}, aqui é o ${teacher.name}! Reposição agendada para ${
      identity.classDate.split("-").reverse().join("/")
    } às ${occurrence.classTime}.` +
      (occurrence.meetingLink ? `\n\n${occurrence.meetingLink}` : "");
  return {
    studentPhone: occurrence.studentPhone,
    message,
    instanceOwnerId: occurrence.teacherId,
    receipt,
  };
}

async function releaseReceipt(
  admin: AdminClient,
  receipt: Receipt,
): Promise<boolean> {
  const { error } = await admin.from("automation_sent").delete()
    .eq("kind", receipt.kind).eq("subject_id", receipt.subject_id)
    .eq("ref_date", receipt.ref_date);
  if (error) {
    console.error("manual_reminder_receipt_release_failed", {
      code: error.code,
      subject: receipt.subject_id,
    });
    return false;
  }
  return true;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  try {
    const authorization = await authorizeRequest(req, {
      corsHeaders,
      allowedRoles: ["TEACHER", "SCHOOL_ADMIN", "SUPER_ADMIN"],
    });
    if (authorization.ok === false) return authorization.response;
    const { admin, profile: caller, userId } = authorization.context;
    const tenantId = caller?.tenant_id;
    if (!caller || !userId || !tenantId) {
      return json({ error: "tenant_access_required" }, 403);
    }
    const body = await req.json().catch(() => null) as RequestBody | null;
    if (!body || typeof body !== "object") {
      return json({ error: "invalid_request_body" }, 400);
    }

    const action = parseAction(body.action);
    if (!action) return json({ error: "unsupported_notification_action" }, 400);
    if (
      action !== "WOLFIE_ASSIGNMENT" &&
      !hasAnyManualReminderIdentityField(body)
    ) return json({ error: "occurrence_identity_required" }, 400);

    const prepared = await prepareNotification(
      admin,
      tenantId,
      userId,
      caller.role,
      action,
      body,
    );
    if (!EVOLUTION_API_BASE || !API_TOKEN) {
      return json({ error: "evolution_api_key_not_configured" }, 503);
    }
    const activeInstance = caller.role === "TEACHER"
      ? await loadTenantWhatsAppInstance(
        admin,
        tenantId,
        prepared.instanceOwnerId,
        "student",
      )
      : await loadTenantCentralWhatsAppInstance(admin, tenantId, "student");
    if (!activeInstance) {
      return json({ error: "whatsapp_instance_unavailable" }, 409);
    }
    if (!prepared.message) {
      return json({ error: "notification_message_empty" }, 400);
    }

    // Claim atômico antes do provedor. CLASS_REMINDER usa a mesma chave do
    // worker AUTO, portanto exatamente um dos caminhos consegue enviar.
    const { error: claimError } = await admin.from("automation_sent")
      .insert(prepared.receipt);
    if (claimError?.code === "23505") {
      return json({
        error: "notification_already_claimed",
        delivery: "already_claimed",
        idempotent: true,
        receipt_preserved: true,
      }, 409);
    }
    if (claimError) {
      console.error("notification_receipt_claim_failed", {
        code: claimError.code,
        subject: prepared.receipt.subject_id,
      });
      return json({ error: "notification_receipt_unavailable" }, 503);
    }

    const providerResult = await sendWhatsTextDetailed({
      base: EVOLUTION_API_BASE,
      keys: [API_TOKEN],
      instance: activeInstance,
      to: prepared.studentPhone,
      text: prepared.message,
      delayMs: 1000,
    });
    const decision = providerReceiptDecision(providerResult);
    if (decision.delivery === "accepted") {
      if (prepared.wolfieAssignmentId) {
        const { error: markerError } = await admin.from("wolfie_assignments")
          .update({ sent_at: new Date().toISOString() })
          .eq("id", prepared.wolfieAssignmentId).eq("tenant_id", tenantId);
        if (markerError) {
          // A entrega já aconteceu. O receipt permanece: uma falha no marker
          // nunca transforma sucesso do provedor em reenvio.
          return json({
            error: "notification_delivered_marker_failed",
            delivery: "accepted",
            receipt_preserved: true,
          }, 503);
        }
      }
      return json({
        success: true,
        delivery: "accepted",
        idempotent: false,
        provider_message_id: providerResult.messageId,
      });
    }
    if (decision.releaseReceipt) {
      const released = await releaseReceipt(admin, prepared.receipt);
      if (!released) {
        return json({
          error: "notification_provider_rejected_receipt_preserved",
          status: providerResult.httpStatus,
          receipt_preserved: true,
        }, 503);
      }
    }
    if (decision.delivery === "rejected") {
      return json({
        error: "notification_provider_rejected",
        status: providerResult.httpStatus,
        receipt_released: true,
      }, 502);
    }
    // Timeout, 408/425/429, 5xx e rede são ambíguos. Preservar o receipt
    // impede repetir uma mensagem que o provedor pode já ter aceitado.
    return json({
      error: "notification_delivery_unknown",
      status: providerResult.httpStatus,
      receipt_preserved: true,
    }, 503);
  } catch (error) {
    if (error instanceof ApiError) {
      return json({ error: error.code }, error.status);
    }
    console.error("send_class_notification_failed", {
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
    return json({ error: "notification_failed" }, 500);
  }
});
