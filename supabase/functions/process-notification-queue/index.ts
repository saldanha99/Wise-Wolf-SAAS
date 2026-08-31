/// <reference lib="deno.ns" />
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  createClient,
  type SupabaseClient,
} from "https://esm.sh/@supabase/supabase-js@2.93.3";
import { authorizeAutomation } from "../_shared/automation-auth.ts";
import {
  resolveWhatsAppDestination,
  sendWhatsTextToResolvedDestinationDetailed,
} from "../_shared/evolution-send.ts";
import { claimOutboundMessage } from "../_shared/student-billing-period-guard.ts";
import { resolveEvolutionIntegration } from "../_shared/tenant-integration-broker.ts";
import {
  loadTenantCentralWhatsAppInstance,
  loadTenantWhatsAppInstance,
  loadTenantWhatsAppRoute,
  safeCommunicationText,
} from "../_shared/tenant-communication.ts";
import {
  dateInSaoPaulo,
  DEFAULT_CLASS_REMINDER_TEMPLATE,
  normalizeStudentPhone,
  recurringBookingMatchesDate,
  renderReminderTemplate,
  timeInSaoPaulo,
} from "../send-class-notification/core.ts";
import {
  isTrialLifecycleNotificationKind,
  lessonReminderFreshness,
  normalizeNotificationKind,
  normalizeQueueDestination,
  notificationRetryDelaySeconds,
  queueAudience,
  queueDeliveryDecision,
  renderConflictTeacherAlert,
} from "./core.ts";

// Processa a fila de notificações (lembretes de aula, avisos) e envia via WhatsApp.
//
// Resolução de instância (em ordem):
//   1. Instância canônica conectada do professor com membership ACTIVE no tenant;
//   2. Fallback: instância CENTRAL da escola (WhatsApp do admin do tenant).
// A maioria dos professores não tem instância própria conectada — por isso o fallback
// central é essencial para os lembretes realmente saírem.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

type QueueRelation<T> = T | T[] | null;

type DeliveryIntegration = {
  integrationId: string;
  version: number;
  baseUrl: string;
  apiKey: string;
};

type TeacherRelation = {
  id: string;
  tenant_id: string | null;
};

type StudentRelation = {
  id: string;
  is_test_account: boolean | null;
  tenant_id: string | null;
  phone: string | null;
  guardian_id: string | null;
  guardian_cpf: string | null;
  guardian_phone: string | null;
};

type QueueItem = {
  id: string;
  student_phone: string;
  message_body: string;
  tenant_id: string | null;
  attempts: number | null;
  notification_kind: string | null;
  source_id: string | null;
  student_id: string | null;
  source_type: string | null;
  class_date: string | null;
  idempotency_key: string | null;
  scheduled_for: string;
  claim_token: string;
  max_attempts: number | null;
  teacher: QueueRelation<TeacherRelation>;
  student: QueueRelation<StudentRelation>;
};

type PreparedQueueMessage = {
  teacherId: string | null;
  destination: string;
  message: string;
  occurrenceIdentity?: {
    tenant_id: string;
    source_id: string;
    source_type: string;
    class_date: string;
  };
};

type TrialNotificationSnapshot = {
  ok?: unknown;
  retryable?: unknown;
  reason?: unknown;
  teacherId?: unknown;
  destination?: unknown;
};

type ActiveMember = {
  id: string;
  tenant_id: string | null;
  role: string | null;
  full_name: string | null;
  phone: string | null;
  attendance_phone: string | null;
  meeting_link: string | null;
  lifecycle_status: string | null;
  is_test_account: boolean | null;
  date_automation_enabled: boolean | null;
  birth_date: string | null;
  lesson_reminder_template: string | null;
};

class QueueRevalidationError extends Error {
  constructor(
    readonly queueStatus: "pending" | "failed" | "skipped",
    readonly reason: string,
  ) {
    super(reason);
  }
}

function invalid(reason: string): never {
  throw new QueueRevalidationError("skipped", reason);
}

function unavailable(reason: string): never {
  throw new QueueRevalidationError("pending", reason);
}

function relationOne<T>(value: QueueRelation<T>): T | null {
  return Array.isArray(value) ? value[0] ?? null : value;
}

async function loadActiveMember(
  supabase: SupabaseClient,
  tenantId: string,
  userId: string,
  role: "STUDENT" | "TEACHER",
): Promise<ActiveMember> {
  const [profileResult, membershipResult] = await Promise.all([
    supabase.from("profiles").select(
      "id,tenant_id,role,full_name,phone,attendance_phone,meeting_link,lifecycle_status,is_test_account,date_automation_enabled,birth_date,lesson_reminder_template",
    ).eq("id", userId).maybeSingle(),
    supabase.from("tenant_memberships").select("user_id")
      .eq("tenant_id", tenantId).eq("user_id", userId)
      .eq("role", role).eq("status", "ACTIVE").maybeSingle(),
  ]);
  if (profileResult.error || membershipResult.error) {
    unavailable(`${role.toLowerCase()}_revalidation_unavailable`);
  }
  const profile = profileResult.data as ActiveMember | null;
  if (
    !profile || String(profile.tenant_id || "") !== tenantId ||
    String(profile.role || "").toUpperCase() !== role ||
    String(profile.lifecycle_status || "").trim().toLowerCase() !== "active" ||
    String(membershipResult.data?.user_id || "") !== userId
  ) invalid(`${role.toLowerCase()}_not_active_in_tenant`);
  return profile;
}

async function prepareTeacherDailyAutomation(
  supabase: SupabaseClient,
  item: QueueItem,
  notificationKind: string,
  now: Date,
): Promise<PreparedQueueMessage> {
  const tenantId = String(item.tenant_id || "");
  const teacherId = String(relationOne(item.teacher)?.id || "");
  if (!tenantId || !teacherId) invalid("daily_teacher_binding_missing");
  const today = dateInSaoPaulo(now);
  if (!today || item.class_date !== today) {
    invalid("daily_teacher_automation_stale");
  }

  const teacher = await loadActiveMember(
    supabase,
    tenantId,
    teacherId,
    "TEACHER",
  );
  if (
    teacher.is_test_account === true ||
    teacher.date_automation_enabled === false
  ) {
    invalid("daily_teacher_automation_disabled");
  }
  if (
    notificationKind === "TEACHER_BIRTHDAY" &&
    String(teacher.birth_date || "").slice(5, 10) !== today.slice(5, 10)
  ) {
    invalid("daily_teacher_birthday_changed");
  }
  const destination = normalizeQueueDestination(teacher.phone || "");
  if (!destination) invalid("daily_teacher_phone_invalid");
  return {
    teacherId,
    destination,
    message: item.message_body,
  };
}

async function prepareStudentBirthday(
  supabase: SupabaseClient,
  item: QueueItem,
  now: Date,
): Promise<PreparedQueueMessage> {
  const tenantId = String(item.tenant_id || "");
  const studentId = String(relationOne(item.student)?.id || "");
  if (!tenantId || !studentId) invalid("daily_student_binding_missing");
  const today = dateInSaoPaulo(now);
  if (!today || item.class_date !== today) {
    invalid("daily_student_birthday_stale");
  }

  const student = await loadActiveMember(
    supabase,
    tenantId,
    studentId,
    "STUDENT",
  );
  if (
    student.is_test_account === true ||
    student.date_automation_enabled === false
  ) {
    invalid("daily_student_automation_disabled");
  }
  if (String(student.birth_date || "").slice(5, 10) !== today.slice(5, 10)) {
    invalid("daily_student_birthday_changed");
  }
  const destination = normalizeQueueDestination(student.phone || "");
  if (!destination) invalid("daily_student_phone_invalid");
  return { teacherId: null, destination, message: item.message_body };
}

async function prepareInterviewNotification(
  supabase: SupabaseClient,
  item: QueueItem,
  notificationKind: string,
  now: Date,
): Promise<PreparedQueueMessage> {
  const tenantId = String(item.tenant_id || "");
  const applicationId = String(item.source_id || "");
  const expectedEpoch = String(item.idempotency_key || "").match(/:(\d+)$/)
    ?.[1];
  if (!tenantId || !applicationId || !expectedEpoch) {
    invalid("interview_notification_binding_missing");
  }

  const { data: application, error } = await supabase.from("job_applications")
    .select("id,tenant_id,whatsapp,interview_slot")
    .eq("id", applicationId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) unavailable("interview_revalidation_unavailable");
  const slotEpoch = application?.interview_slot
    ? String(Math.floor(new Date(application.interview_slot).getTime() / 1000))
    : "";
  if (!application || slotEpoch !== expectedEpoch) {
    invalid("interview_slot_changed");
  }
  if (new Date(application.interview_slot).getTime() <= now.getTime()) {
    invalid("interview_notification_stale");
  }

  let destination = normalizeQueueDestination(item.student_phone);
  if (notificationKind.endsWith("_CANDIDATE")) {
    destination = normalizeQueueDestination(application.whatsapp || "");
  } else if (notificationKind.endsWith("_MANAGEMENT")) {
    const route = await loadTenantWhatsAppRoute(supabase, tenantId, "teacher")
      .catch(() => null);
    if (!route) unavailable("interview_management_route_unavailable");
    destination = normalizeQueueDestination(route.ownerPhone || "");
  }
  if (!destination) invalid("interview_destination_invalid");
  return { teacherId: null, destination, message: item.message_body };
}

async function prepareLessonReminder(
  supabase: SupabaseClient,
  item: QueueItem,
  now: Date,
): Promise<PreparedQueueMessage> {
  const tenantId = String(item.tenant_id || "");
  const sourceId = String(item.source_id || "");
  const sourceType = String(item.source_type || "").trim().toLowerCase();
  const classDate = String(item.class_date || "").slice(0, 10);
  if (
    !tenantId || !sourceId || !classDate ||
    !["booking", "reschedule", "appointment"].includes(sourceType)
  ) invalid("invalid_occurrence_identity");

  let occurrenceQuery = supabase
    .from("upcoming_classes")
    .select(
      "source_id,source_type,tenant_id,teacher_id,student_id,student_name_override,student_phone_override,class_date,time_text,start_at",
    )
    .eq("source_id", sourceId)
    .eq("source_type", sourceType)
    .eq("tenant_id", tenantId);
  // A view legada calcula a data civil de appointments na timezone da sessão
  // (UTC em produção). Para esse tipo, a identidade BRT vem diretamente de
  // appointments.start_time e não pode ser filtrada pelo class_date da view.
  if (sourceType !== "appointment") {
    occurrenceQuery = occurrenceQuery.eq("class_date", classDate);
  }
  const { data: occurrence, error: occurrenceError } = await occurrenceQuery
    .maybeSingle();
  if (occurrenceError) {
    unavailable("lesson_occurrence_revalidation_unavailable");
  }
  if (!occurrence) invalid("lesson_occurrence_no_longer_valid");

  let teacherId = String(occurrence.teacher_id || "");
  let studentId = String(occurrence.student_id || "");
  let appointmentName = "";
  let appointmentPhone = "";
  let canonicalClassDate = classDate;
  let canonicalClassTime = safeCommunicationText(occurrence.time_text, 20)
    .slice(0, 5);
  let canonicalStartAt = String(occurrence.start_at || "");

  if (sourceType === "booking") {
    const { data, error } = await supabase.from("bookings")
      .select(
        "id,tenant_id,teacher_id,student_id,day_of_week,time_slot,date,start_date,status",
      )
      .eq("id", sourceId).eq("tenant_id", tenantId).maybeSingle();
    if (error) unavailable("booking_revalidation_unavailable");
    const fixedDate = String(data?.date || "").slice(0, 10);
    const startsOn = String(data?.start_date || "").slice(0, 10);
    const dateMatches = fixedDate
      ? fixedDate === classDate
      : (!startsOn || startsOn <= classDate) &&
        recurringBookingMatchesDate(data?.day_of_week, classDate);
    if (
      !data || String(data.status || "").toUpperCase() !== "SCHEDULED" ||
      !dateMatches || !/^\d{2}:\d{2}/.test(String(data.time_slot || ""))
    ) {
      invalid("booking_no_longer_scheduled");
    }
    if (
      String(data.teacher_id || "") !== teacherId ||
      String(data.student_id || "") !== studentId
    ) invalid("booking_relationship_changed");
  } else if (sourceType === "reschedule") {
    const { data, error } = await supabase.from("reschedules")
      .select("id,tenant_id,teacher_id,student_id,date,time,used_at")
      .eq("id", sourceId).eq("tenant_id", tenantId).maybeSingle();
    if (error) unavailable("reschedule_revalidation_unavailable");
    if (
      !data || data.used_at ||
      String(data.date || "").slice(0, 10) !== classDate ||
      !/^\d{2}:\d{2}/.test(String(data.time || ""))
    ) invalid("reschedule_no_longer_scheduled");
    if (
      String(data.teacher_id || "") !== teacherId ||
      String(data.student_id || "") !== studentId
    ) invalid("reschedule_relationship_changed");
  } else {
    const { data, error } = await supabase.from("appointments")
      .select(
        "id,tenant_id,teacher_id,professor_id,student_name,student_phone,start_time,status",
      )
      .eq("id", sourceId).eq("tenant_id", tenantId).maybeSingle();
    if (error) unavailable("appointment_revalidation_unavailable");
    if (
      !data || String(data.status || "").trim().toLowerCase() !== "scheduled"
    ) {
      invalid("appointment_no_longer_scheduled");
    }
    if (
      data.teacher_id && data.professor_id &&
      String(data.teacher_id) !== String(data.professor_id)
    ) invalid("appointment_relationship_changed");
    const currentTeacherId = String(data.teacher_id || data.professor_id || "");
    if (!currentTeacherId || currentTeacherId !== teacherId) {
      invalid("appointment_relationship_changed");
    }
    teacherId = currentTeacherId;
    studentId = "";
    canonicalClassDate = dateInSaoPaulo(String(data.start_time || "")) || "";
    canonicalClassTime = timeInSaoPaulo(String(data.start_time || "")) || "";
    canonicalStartAt = String(data.start_time || "");
    const legacyUtcDate = String(data.start_time || "").slice(0, 10);
    if (
      !canonicalClassDate ||
      (classDate !== canonicalClassDate && classDate !== legacyUtcDate)
    ) invalid("appointment_class_date_mismatch");
    appointmentName = safeCommunicationText(data.student_name, 180);
    appointmentPhone = normalizeStudentPhone(data.student_phone) || "";
    if (!appointmentName || !appointmentPhone) {
      invalid("appointment_canonical_recipient_unavailable");
    }
  }

  const freshness = lessonReminderFreshness({
    startAt: canonicalStartAt,
    scheduledFor: item.scheduled_for,
    now,
  });
  if (freshness.ok === false) invalid(freshness.reason);

  if (!teacherId) invalid("lesson_teacher_unavailable");
  const teacher = await loadActiveMember(
    supabase,
    tenantId,
    teacherId,
    "TEACHER",
  );
  if (teacher.is_test_account !== false) invalid("test_fixture_suppressed");
  if (teacher.date_automation_enabled !== true) {
    invalid("teacher_lesson_automation_not_enabled");
  }

  let studentName = appointmentName;
  let destination = appointmentPhone;
  let classLink = safeCommunicationText(teacher.meeting_link, 300);
  if (studentId) {
    const student = await loadActiveMember(
      supabase,
      tenantId,
      studentId,
      "STUDENT",
    );
    if (student.is_test_account !== false) invalid("test_fixture_suppressed");
    studentName = safeCommunicationText(student.full_name, 180);
    destination = normalizeStudentPhone(student.attendance_phone) ||
      normalizeStudentPhone(student.phone) || "";
    classLink = safeCommunicationText(student.meeting_link, 300) || classLink;
  }
  if (!studentName || !destination) {
    invalid("lesson_canonical_recipient_unavailable");
  }

  const { data: tenant, error: tenantError } = await supabase.from("tenants")
    .select("name").eq("id", tenantId).maybeSingle();
  if (tenantError) unavailable("tenant_revalidation_unavailable");
  if (!tenant) invalid("tenant_no_longer_available");

  const message = renderReminderTemplate(
    safeCommunicationText(teacher.lesson_reminder_template, 4096) ||
      DEFAULT_CLASS_REMINDER_TEMPLATE,
    {
      student_name: studentName.split(/\s+/)[0] || studentName,
      class_time: canonicalClassTime,
      teacher_name: safeCommunicationText(teacher.full_name, 180),
      tenant_name: safeCommunicationText(tenant.name, 180),
      class_link: classLink,
    },
  );
  if (!message) invalid("lesson_canonical_message_empty");
  return {
    teacherId,
    destination,
    message,
    occurrenceIdentity: {
      tenant_id: tenantId,
      source_id: sourceId,
      source_type: sourceType,
      class_date: canonicalClassDate,
    },
  };
}

async function prepareConflictTeacherAlert(
  supabase: SupabaseClient,
  item: QueueItem,
  now: Date,
): Promise<PreparedQueueMessage> {
  const tenantId = String(item.tenant_id || "");
  const requestedId = String(item.source_id || "");
  if (!tenantId || !requestedId) invalid("invalid_conflict_identity");

  const confirmationFields =
    "id,canonical_confirmation_id,tenant_id,teacher_id,student_id,teacher_name,student_name,class_date,class_time,status,student_response,response_editable_until,resolved_at,resolution_verdict";
  const { data: requested, error: requestedError } = await supabase
    .from("attendance_confirmations").select(confirmationFields)
    .eq("id", requestedId).maybeSingle();
  if (requestedError) {
    unavailable("attendance_conflict_revalidation_unavailable");
  }
  if (!requested) invalid("attendance_conflict_no_longer_available");

  const canonicalId = String(
    requested.canonical_confirmation_id || requested.id,
  );
  const { data: canonical, error: canonicalError } =
    canonicalId === requested.id
      ? { data: requested, error: null }
      : await supabase.from("attendance_confirmations")
        .select(confirmationFields).eq("id", canonicalId).maybeSingle();
  if (canonicalError) {
    unavailable("attendance_conflict_revalidation_unavailable");
  }
  if (!canonical || String(canonical.tenant_id || "") !== tenantId) {
    invalid("attendance_conflict_tenant_mismatch");
  }
  if (String(canonical.class_date || "").slice(0, 10) !== item.class_date) {
    invalid("attendance_conflict_date_mismatch");
  }
  if (
    String(canonical.status || "").toUpperCase() !== "CONFLICT" ||
    String(canonical.student_response || "").toUpperCase() !==
      "TEACHER_NO_SHOW" ||
    canonical.resolved_at || canonical.resolution_verdict
  ) invalid("attendance_conflict_withdrawn_before_send");

  const editableUntil = new Date(
    String(canonical.response_editable_until || ""),
  );
  if (
    Number.isNaN(editableUntil.getTime()) ||
    editableUntil.getTime() > now.getTime()
  ) invalid("attendance_conflict_window_not_mature");

  const teacherId = String(canonical.teacher_id || "");
  if (!teacherId) invalid("attendance_conflict_teacher_unavailable");
  const teacher = await loadActiveMember(
    supabase,
    tenantId,
    teacherId,
    "TEACHER",
  );
  if (teacher.is_test_account !== false) invalid("test_fixture_suppressed");
  const destination = normalizeStudentPhone(teacher.phone) ||
    normalizeStudentPhone(teacher.attendance_phone) || "";
  if (!destination) invalid("attendance_conflict_teacher_phone_unavailable");

  return {
    teacherId,
    destination,
    message: renderConflictTeacherAlert({
      teacherName: teacher.full_name,
      studentName: canonical.student_name,
      classDate: canonical.class_date,
      classTime: canonical.class_time,
    }),
  };
}

async function prepareTrialLifecycleNotification(
  supabase: SupabaseClient,
  item: QueueItem,
): Promise<PreparedQueueMessage> {
  const tenantId = String(item.tenant_id || "");
  const opportunityId = String(item.source_id || "");
  const notificationKind = normalizeNotificationKind(item.notification_kind);
  if (
    !tenantId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(opportunityId) ||
    String(item.source_type || "").trim().toUpperCase() !==
      "TRIAL_OPPORTUNITY" ||
    !isTrialLifecycleNotificationKind(notificationKind)
  ) invalid("invalid_trial_notification_identity");

  const { data, error } = await supabase.rpc(
    "get_trial_notification_delivery_snapshot",
    {
      p_tenant_id: tenantId,
      p_opportunity_id: opportunityId,
      p_notification_kind: notificationKind,
    },
  );
  if (error || !data || typeof data !== "object" || Array.isArray(data)) {
    unavailable("trial_notification_revalidation_unavailable");
  }
  const snapshot = data as TrialNotificationSnapshot;
  if (snapshot.ok !== true) {
    const reason = safeCommunicationText(snapshot.reason, 160) ||
      "trial_notification_no_longer_valid";
    if (snapshot.retryable === true) unavailable(reason);
    invalid(reason);
  }

  const destination = normalizeQueueDestination(snapshot.destination);
  const message = String(item.message_body || "").trim();
  const teacherId = typeof snapshot.teacherId === "string"
    ? snapshot.teacherId
    : null;
  if (!destination || !message || message.length > 4096) {
    unavailable("trial_notification_canonical_payload_unavailable");
  }
  if (
    notificationKind === "TRIAL_TEACHER_REQUESTED" &&
    (!teacherId || teacherId !== relationOne(item.teacher)?.id)
  ) invalid("trial_notification_teacher_binding_changed");
  if (notificationKind === "TRIAL_MANAGEMENT_ACCEPTED" && teacherId) {
    invalid("trial_management_route_binding_changed");
  }

  return { teacherId, destination, message };
}

// Resolve a instância central da escola (admin do tenant com WhatsApp conectado).
async function resolveCentralInstance(
  supabase: SupabaseClient,
  tenantId: string | null,
  audience: "student" | "teacher",
  cache: Record<string, string | null>,
): Promise<string | null> {
  const key = `${tenantId || "_"}:${audience}`;
  if (key in cache) return cache[key];
  if (!tenantId) {
    cache[key] = null;
    return null;
  }
  cache[key] = await loadTenantCentralWhatsAppInstance(
    supabase,
    tenantId,
    audience,
  );
  return cache[key];
}

async function resolvePersonalInstance(
  supabase: SupabaseClient,
  tenantId: string,
  userId: string,
  audience: "student" | "teacher",
  cache: Record<string, string | null>,
): Promise<string | null> {
  const key = `${tenantId}:${userId}:${audience}`;
  if (key in cache) return cache[key];
  cache[key] = await loadTenantWhatsAppInstance(
    supabase,
    tenantId,
    userId,
    audience,
  );
  return cache[key];
}

async function resolveDeliveryIntegration(
  supabase: SupabaseClient,
  tenantId: string,
  cache: Map<string, Promise<DeliveryIntegration>>,
): Promise<DeliveryIntegration> {
  let pending = cache.get(tenantId);
  if (!pending) {
    pending = resolveEvolutionIntegration(
      supabase,
      tenantId,
      "message.send_text",
    ).then((integration) => ({
      integrationId: integration.integrationId,
      version: integration.version,
      baseUrl: integration.baseUrl,
      apiKey: integration.apiKey,
    }));
    cache.set(tenantId, pending);
  }
  try {
    return await pending;
  } catch (error) {
    // Uma indisponibilidade não deve ficar memorizada entre futuras execuções.
    cache.delete(tenantId);
    throw error;
  }
}

async function markClaim(
  supabase: SupabaseClient,
  item: Pick<QueueItem, "id" | "claim_token" | "attempts">,
  status: "pending" | "sent" | "failed" | "uncertain" | "skipped",
  lastError: string | null,
  provider?: {
    messageId?: string | null;
    httpStatus?: number | null;
  },
): Promise<boolean> {
  const outcome = status === "sent"
    ? "ACCEPTED"
    : status === "uncertain"
    ? "UNCERTAIN"
    : status === "skipped"
    ? "SKIPPED"
    : "FAILED";
  const retryDelay = status === "pending"
    ? notificationRetryDelaySeconds(Number(item.attempts || 1), item.id)
    : null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { data, error } = await supabase.rpc(
      "finalize_notification_delivery",
      {
        p_notification_id: item.id,
        p_claim_token: item.claim_token,
        p_outcome: outcome,
        p_provider_message_id: provider?.messageId || null,
        p_provider_http_status: provider?.httpStatus ?? null,
        p_error: lastError,
        p_retry_delay_seconds: retryDelay,
      },
    );
    if (!error) {
      const result = Array.isArray(data) ? data[0] : data;
      return Boolean(
        result && typeof result === "object" && result.ok === true,
      );
    }
  }
  return false;
}

type SubmissionDecision = {
  ok: boolean;
  action: string;
  reason?: string;
  providerDestination?: string;
  messageBody?: string;
};

function submissionDecision(value: unknown): SubmissionDecision | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!candidate || typeof candidate !== "object") return null;
  const record = candidate as Record<string, unknown>;
  return typeof record.ok === "boolean" && typeof record.action === "string"
    ? {
      ok: record.ok,
      action: record.action,
      ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
      ...(typeof record.providerDestination === "string"
        ? { providerDestination: record.providerDestination }
        : {}),
      ...(typeof record.messageBody === "string"
        ? { messageBody: record.messageBody }
        : {}),
    }
    : null;
}

async function beginNotificationSubmission(
  supabase: SupabaseClient,
  item: Pick<QueueItem, "id" | "claim_token">,
  instanceName: string,
  expectedDestination: string,
  providerDestination: string,
  expectedMessage: string,
  integration: Pick<DeliveryIntegration, "integrationId" | "version">,
): Promise<SubmissionDecision | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { data, error } = await supabase.rpc(
      "begin_notification_delivery_submission",
      {
        p_notification_id: item.id,
        p_claim_token: item.claim_token,
        p_provider_instance_name: instanceName,
        p_expected_destination: expectedDestination,
        p_provider_destination: providerDestination,
        p_expected_message_body: expectedMessage,
        p_integration_id: integration.integrationId,
        p_integration_version: integration.version,
      },
    );
    if (!error) {
      const decision = submissionDecision(data);
      if (decision) return decision;
    }
  }
  return null;
}

async function beginPaymentConfirmationSubmission(
  supabase: SupabaseClient,
  item: Pick<QueueItem, "id" | "claim_token">,
  outbound: Awaited<ReturnType<typeof claimOutboundMessage>>,
  instanceName: string,
  destination: string,
  providerDestination: string,
  integration: Pick<DeliveryIntegration, "integrationId" | "version">,
): Promise<SubmissionDecision | null> {
  if (!outbound.attempt_id || !outbound.claim_token) return null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { data, error } = await supabase.rpc(
      "begin_payment_confirmation_delivery_submission",
      {
        p_notification_id: item.id,
        p_notification_claim_token: item.claim_token,
        p_outbound_attempt_id: outbound.attempt_id,
        p_outbound_claim_token: outbound.claim_token,
        p_provider_instance_name: instanceName,
        p_expected_destination: destination,
        p_provider_destination: providerDestination,
        p_integration_id: integration.integrationId,
        p_integration_version: integration.version,
      },
    );
    if (!error) {
      const decision = submissionDecision(data);
      if (decision) return decision;
    }
  }
  return null;
}

async function recoverNotificationSubmission(
  supabase: SupabaseClient,
  item: Pick<QueueItem, "id" | "claim_token">,
  outbound: Awaited<ReturnType<typeof claimOutboundMessage>> | null,
  instanceName: string,
  integration: Pick<DeliveryIntegration, "integrationId" | "version">,
): Promise<SubmissionDecision | null> {
  const { data, error } = await supabase.rpc(
    "recover_notification_delivery_submission",
    {
      p_notification_id: item.id,
      p_notification_claim_token: item.claim_token,
      p_outbound_attempt_id: outbound?.attempt_id || null,
      p_outbound_claim_token: outbound?.claim_token || null,
      p_provider_instance_name: instanceName,
      p_integration_id: integration.integrationId,
      p_integration_version: integration.version,
    },
  );
  return error ? null : submissionDecision(data);
}

async function finalizePaymentConfirmationSubmission(
  supabase: SupabaseClient,
  item: Pick<QueueItem, "id" | "claim_token">,
  outbound: Awaited<ReturnType<typeof claimOutboundMessage>>,
  outcome: "accepted" | "failed" | "uncertain",
  provider: {
    messageId: string | null;
    httpStatus: number | null;
    error: string | null;
  },
): Promise<boolean> {
  if (!outbound.attempt_id || !outbound.claim_token) return false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { data, error } = await supabase.rpc(
      "finalize_payment_confirmation_delivery",
      {
        p_notification_id: item.id,
        p_notification_claim_token: item.claim_token,
        p_outbound_attempt_id: outbound.attempt_id,
        p_outbound_claim_token: outbound.claim_token,
        p_outcome: outcome,
        p_provider_message_id: provider.messageId,
        p_provider_http_status: provider.httpStatus,
        p_error: provider.error,
      },
    );
    if (!error) {
      const result = submissionDecision(data);
      return result?.ok === true;
    }
  }
  return false;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  const authError = await authorizeAutomation(req, corsHeaders);
  if (authError) return authError;

  try {
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );

    // Claim, lease e recuperação de execução interrompida ficam na mesma
    // transação. PREPARING expirado volta para a fila; SUBMITTING expirado fica
    // UNCERTAIN e nunca cruza o provedor uma segunda vez no escuro.
    const { data: claimed, error: claimError } = await supabaseClient.rpc(
      "claim_notification_delivery_batch",
      // Um item pode consumir até 10 s para resolver o JID e 15 s no POST.
      // Cinco itens mantêm a cauda confortavelmente dentro do lease de 5 min.
      { p_limit: 5, p_lease_seconds: 300 },
    );
    if (claimError) throw claimError;

    const claimRows = (Array.isArray(claimed) ? claimed : []).filter((row) =>
      row && typeof row === "object" && typeof row.id === "string" &&
      typeof row.claim_token === "string"
    ) as Array<{ id: string; claim_token: string }>;
    if (claimRows.length === 0) {
      return new Response(
        JSON.stringify({ message: "No pending notifications due." }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { data: hydrated, error: hydrateError } = await supabaseClient
      .from("notification_queue")
      .select(`
        id,
        student_phone,
        message_body,
        tenant_id,
        attempts,
        notification_kind,
        source_id,
        student_id,
        source_type,
        class_date,
        idempotency_key,
        scheduled_for,
        claim_token,
        max_attempts,
        teacher:teacher_id ( id, tenant_id ),
        student:student_id (
          id,
          is_test_account,
          tenant_id,
          phone,
          guardian_id,
          guardian_cpf,
          guardian_phone
        )
      `)
      .in("id", claimRows.map((row) => row.id))
      .eq("status", "processing")
      .eq("delivery_status", "preparing");
    if (hydrateError) throw hydrateError;

    const hydratedById = new Map(
      ((hydrated || []) as unknown as QueueItem[]).map((
        item,
      ) => [item.id, item]),
    );
    const queueItems = claimRows.flatMap((claim) => {
      const item = hydratedById.get(claim.id);
      return item?.claim_token === claim.claim_token ? [item] : [];
    });

    const results: Array<Record<string, unknown>> = [];
    const centralCache: Record<string, string | null> = {};
    const personalCache: Record<string, string | null> = {};
    const integrationCache = new Map<string, Promise<DeliveryIntegration>>();
    let persistenceFailed = queueItems.length !== claimRows.length;

    for (const item of queueItems) {
      const { id, student_phone, message_body, tenant_id } = item;
      const teacher = relationOne(item.teacher);
      const student = relationOne(item.student);
      const notificationKind = normalizeNotificationKind(
        item.notification_kind,
      );

      if (student?.is_test_account === true) {
        const marked = await markClaim(
          supabaseClient,
          item,
          "skipped",
          "test_fixture_suppressed",
        );
        persistenceFailed ||= !marked;
        results.push({ id, status: marked ? "skipped" : "marker_failed" });
        continue;
      }
      if (student?.tenant_id && student.tenant_id !== tenant_id) {
        const marked = await markClaim(
          supabaseClient,
          item,
          "failed",
          "student_tenant_mismatch",
        );
        persistenceFailed ||= !marked;
        results.push({
          id,
          status: marked ? "failed" : "marker_failed",
          error: "tenant_mismatch",
        });
        continue;
      }

      const isPaymentConfirmation = [
        "PAYMENT_CONFIRMED",
        "PAYMENT_CONFIRMED_WHATSAPP",
      ].includes(notificationKind);
      if (
        isPaymentConfirmation &&
        (!tenant_id || !item.student_id || !item.source_id || !student ||
          student.id !== item.student_id || student.tenant_id !== tenant_id)
      ) {
        const marked = await markClaim(
          supabaseClient,
          item,
          "failed",
          "payment_confirmation_binding_missing",
        );
        persistenceFailed ||= !marked;
        results.push({ id, status: marked ? "failed" : "marker_failed" });
        continue;
      }

      let prepared: PreparedQueueMessage = {
        teacherId: teacher?.tenant_id === tenant_id ? teacher.id : null,
        destination: student_phone,
        message: message_body,
      };
      try {
        if (
          notificationKind === "LESSON_REMINDER"
        ) {
          prepared = await prepareLessonReminder(
            supabaseClient,
            item,
            new Date(),
          );
        } else if (
          notificationKind === "CONFLICT_TEACHER_ALERT"
        ) {
          prepared = await prepareConflictTeacherAlert(
            supabaseClient,
            item,
            new Date(),
          );
        } else if (
          notificationKind === "TEACHER_AGENDA" ||
          notificationKind === "TEACHER_BIRTHDAY"
        ) {
          prepared = await prepareTeacherDailyAutomation(
            supabaseClient,
            item,
            notificationKind,
            new Date(),
          );
        } else if (notificationKind === "BIRTHDAY") {
          prepared = await prepareStudentBirthday(
            supabaseClient,
            item,
            new Date(),
          );
        } else if (notificationKind.startsWith("INTERVIEW_")) {
          prepared = await prepareInterviewNotification(
            supabaseClient,
            item,
            notificationKind,
            new Date(),
          );
        } else if (isTrialLifecycleNotificationKind(notificationKind)) {
          prepared = await prepareTrialLifecycleNotification(
            supabaseClient,
            item,
          );
        }
      } catch (error) {
        if (!(error instanceof QueueRevalidationError)) throw error;
        const marked = await markClaim(
          supabaseClient,
          item,
          error.queueStatus,
          error.reason,
        );
        persistenceFailed ||= !marked;
        results.push({
          id,
          status: marked ? error.queueStatus : "marker_failed",
          error: error.reason,
        });
        continue;
      }

      const route = queueAudience(notificationKind);
      let instanceId: string | null =
        !route.centralOnly && tenant_id && prepared.teacherId
          ? await resolvePersonalInstance(
            supabaseClient,
            tenant_id,
            prepared.teacherId,
            route.audience,
            personalCache,
          )
          : null;
      if (!instanceId) {
        instanceId = await resolveCentralInstance(
          supabaseClient,
          tenant_id,
          route.audience,
          centralCache,
        );
      }
      if (!instanceId) {
        const marked = await markClaim(
          supabaseClient,
          item,
          "pending",
          "no_whatsapp_instance",
        );
        persistenceFailed ||= !marked;
        results.push({
          id,
          status: marked ? "pending" : "marker_failed",
          error: "no_instance",
        });
        continue;
      }

      const destination = normalizeQueueDestination(prepared.destination);
      if (!destination) {
        const marked = await markClaim(
          supabaseClient,
          item,
          "failed",
          "invalid_phone",
        );
        persistenceFailed ||= !marked;
        results.push({
          id,
          status: marked ? "failed" : "marker_failed",
          error: "invalid_phone",
        });
        continue;
      }

      let integration: DeliveryIntegration;
      try {
        if (!tenant_id) throw new Error("notification_tenant_missing");
        integration = await resolveDeliveryIntegration(
          supabaseClient,
          tenant_id,
          integrationCache,
        );
      } catch {
        const marked = await markClaim(
          supabaseClient,
          item,
          "pending",
          "notification_provider_integration_unavailable",
        );
        persistenceFailed ||= !marked;
        results.push({ id, status: marked ? "pending" : "marker_failed" });
        continue;
      }

      // A resolução do JID é uma consulta sem efeito de envio e precisa ocorrer
      // antes do fence SUBMITTING. Depois do begin, a primeira chamada externa
      // será exclusivamente o POST de mensagem, reduzindo a janela ambígua.
      const providerDestination = await resolveWhatsAppDestination({
        base: integration.baseUrl,
        keys: [integration.apiKey],
        instance: instanceId,
        to: destination,
      });

      let paymentOutboundClaim:
        | Awaited<ReturnType<typeof claimOutboundMessage>>
        | null = null;
      if (isPaymentConfirmation) {
        const [currentProfileResult, sourcePaymentResult] = await Promise.all([
          supabaseClient.from("profiles")
            .select(
              "id,tenant_id,role,phone,guardian_id,guardian_cpf,guardian_phone,is_test_account",
            )
            .eq("id", item.student_id!)
            .eq("tenant_id", tenant_id!)
            .eq("role", "STUDENT")
            .maybeSingle(),
          supabaseClient.from("student_payments")
            .select("id,tenant_id,student_id,status,provider_status")
            .eq("id", item.source_id!)
            .eq("tenant_id", tenant_id!)
            .eq("student_id", item.student_id!)
            .limit(2),
        ]);
        if (currentProfileResult.error || sourcePaymentResult.error) {
          const marked = await markClaim(
            supabaseClient,
            item,
            "pending",
            "payment_confirmation_revalidation_unavailable",
          );
          persistenceFailed ||= !marked;
          results.push({ id, status: marked ? "pending" : "marker_failed" });
          continue;
        }

        const currentProfile = currentProfileResult.data;
        const hasFinancialGuardian = Boolean(
          currentProfile?.guardian_id || currentProfile?.guardian_cpf,
        );
        const currentDestination = normalizeQueueDestination(
          String(
            hasFinancialGuardian
              ? currentProfile?.guardian_phone || ""
              : currentProfile?.phone || "",
          ),
        );
        const sourcePayments = sourcePaymentResult.data || [];
        const sourceStatus = String(sourcePayments[0]?.status || "")
          .toUpperCase();
        if (
          !currentProfile || currentProfile.is_test_account === true ||
          currentDestination !== destination || sourcePayments.length !== 1 ||
          !["RECEIVED", "RECEIVED_IN_CASH", "PAGO"].includes(sourceStatus)
        ) {
          const reason = currentDestination !== destination
            ? "payment_confirmation_destination_changed"
            : "payment_confirmation_source_unsettled";
          const marked = await markClaim(
            supabaseClient,
            item,
            "failed",
            reason,
          );
          persistenceFailed ||= !marked;
          results.push({ id, status: marked ? "failed" : "marker_failed" });
          continue;
        }

        try {
          paymentOutboundClaim = await claimOutboundMessage(supabaseClient, {
            tenantId: tenant_id!,
            studentId: item.student_id!,
            providerEntityId: item.source_id!,
            notificationKind: "PAYMENT_CONFIRMED_WHATSAPP",
          });
        } catch {
          const marked = await markClaim(
            supabaseClient,
            item,
            "pending",
            "payment_confirmation_claim_unavailable",
          );
          persistenceFailed ||= !marked;
          results.push({ id, status: marked ? "pending" : "marker_failed" });
          continue;
        }

        if (paymentOutboundClaim.action === "REVIEW_REQUIRED") {
          const marked = await markClaim(
            supabaseClient,
            item,
            "skipped",
            paymentOutboundClaim.reason || "payment_confirmation_suppressed",
          );
          persistenceFailed ||= !marked;
          results.push({ id, status: marked ? "skipped" : "marker_failed" });
          continue;
        }
        if (paymentOutboundClaim.action === "IN_PROGRESS") {
          const marked = await markClaim(
            supabaseClient,
            item,
            "pending",
            "payment_confirmation_claim_in_progress",
          );
          persistenceFailed ||= !marked;
          results.push({ id, status: marked ? "pending" : "marker_failed" });
          continue;
        }
        if (paymentOutboundClaim.action === "ALREADY_FINAL") {
          const outboundStatus = String(paymentOutboundClaim.status || "")
            .toUpperCase();
          const queueStatus: "failed" | "uncertain" | "skipped" =
            outboundStatus === "SENT" || outboundStatus === "SUPPRESSED"
              ? "skipped"
              : ["UNKNOWN", "SUBMITTING"].includes(outboundStatus)
              ? "uncertain"
              : "failed";
          const marked = await markClaim(
            supabaseClient,
            item,
            queueStatus,
            `payment_confirmation_${
              outboundStatus.toLowerCase() || "terminal"
            }`,
          );
          persistenceFailed ||= !marked;
          results.push({ id, status: marked ? queueStatus : "marker_failed" });
          continue;
        }
      }

      // The receipt fence, queue marker, provider binding and (for payment
      // confirmations) financial ledger transition happen in one DB
      // transaction. A failed marker means no provider POST is allowed.
      const submission = paymentOutboundClaim
        ? await beginPaymentConfirmationSubmission(
          supabaseClient,
          item,
          paymentOutboundClaim,
          instanceId,
          destination,
          providerDestination,
          integration,
        )
        : await beginNotificationSubmission(
          supabaseClient,
          item,
          instanceId,
          destination,
          providerDestination,
          prepared.message,
          integration,
        );

      // Uma resposta perdida do begin não significa rollback. Consulte o estado
      // selado pelo mesmo claim; nunca finalize genericamente um SUBMITTING que
      // pode já ter sido commitado.
      const recoveredSubmission = submission ||
        await recoverNotificationSubmission(
          supabaseClient,
          item,
          paymentOutboundClaim,
          instanceId,
          integration,
        );

      if (!recoveredSubmission) {
        persistenceFailed = true;
        results.push({ id, status: "submission_state_unavailable" });
        continue;
      }

      const effectiveSubmission = recoveredSubmission;

      if (
        effectiveSubmission.action === "ALREADY_NOTIFIED" ||
        effectiveSubmission.action === "SUPPRESSED"
      ) {
        // These actions finalize the queue inside the same RPC transaction.
        results.push({
          id,
          status: "skipped",
          error: effectiveSubmission.reason ||
            "notification_suppressed_before_send",
        });
        continue;
      }

      const submissionAuthorized = paymentOutboundClaim
        ? effectiveSubmission.ok === true &&
          effectiveSubmission.action === "SUBMITTING"
        : effectiveSubmission.ok === true &&
          effectiveSubmission.action === "SUBMIT_AUTHORIZED";
      if (!submissionAuthorized) {
        if (effectiveSubmission.action === "RETRY_BEGIN") {
          // O begin não foi comprovado. Deixe o lease expirar e ser recuperado
          // como PREPARING; uma finalização aqui poderia correr contra o commit.
          persistenceFailed = true;
          results.push({
            id,
            status: "submission_begin_unconfirmed",
            error: effectiveSubmission.reason,
          });
          continue;
        }
        const retryable = effectiveSubmission.action === "RETRY" ||
          effectiveSubmission.action === "USE_PAYMENT_BRIDGE";
        const marked = await markClaim(
          supabaseClient,
          item,
          retryable ? "pending" : "skipped",
          effectiveSubmission.reason ||
            "notification_submission_not_authorized",
        );
        persistenceFailed ||= !marked;
        results.push({
          id,
          status: marked
            ? (retryable ? "pending" : "skipped")
            : "marker_failed",
          error: effectiveSubmission.reason,
        });
        continue;
      }

      const authorizedProviderDestination =
        effectiveSubmission.providerDestination;
      const authorizedMessage = effectiveSubmission.messageBody ||
        prepared.message;
      if (!authorizedProviderDestination || !authorizedMessage) {
        // O fence existe, mas sem snapshot completo não há autorização segura
        // para cruzar o provedor. O lease será reconciliado como incerto.
        persistenceFailed = true;
        results.push({ id, status: "authorized_snapshot_missing" });
        continue;
      }

      // JID resolution and the transactional SUBMITTING fence can take long
      // enough for a trial to be canceled, converted or marked as a fixture.
      // Revalidate once more before the only provider POST in this worker.
      if (isTrialLifecycleNotificationKind(notificationKind)) {
        try {
          const current = await prepareTrialLifecycleNotification(
            supabaseClient,
            item,
          );
          if (
            normalizeQueueDestination(current.destination) !== destination ||
            current.message !== authorizedMessage
          ) invalid("trial_notification_changed_before_send");
        } catch (error) {
          if (!(error instanceof QueueRevalidationError)) throw error;
          const marked = await markClaim(
            supabaseClient,
            item,
            error.queueStatus,
            error.reason,
          );
          persistenceFailed ||= !marked;
          results.push({
            id,
            status: marked ? error.queueStatus : "marker_failed",
            error: error.reason,
          });
          continue;
        }
      }

      const providerResult = await sendWhatsTextToResolvedDestinationDetailed({
        base: integration.baseUrl,
        keys: [integration.apiKey],
        instance: instanceId,
        to: authorizedProviderDestination,
        text: authorizedMessage,
        delayMs: 1000,
      });
      const decision = queueDeliveryDecision(providerResult);

      const marked = paymentOutboundClaim
        ? await finalizePaymentConfirmationSubmission(
          supabaseClient,
          item,
          paymentOutboundClaim,
          decision.status === "sent"
            ? "accepted"
            : decision.status === "uncertain"
            ? "uncertain"
            : "failed",
          {
            messageId: providerResult.messageId,
            httpStatus: providerResult.httpStatus,
            error: decision.reason,
          },
        )
        : await markClaim(
          supabaseClient,
          item,
          decision.status,
          decision.reason,
          {
            messageId: providerResult.messageId,
            httpStatus: providerResult.httpStatus,
          },
        );
      persistenceFailed ||= !marked;
      results.push({
        id,
        status: marked ? decision.status : "marker_failed",
        error: decision.reason,
        provider_message_id: providerResult.messageId,
        provider_http_status: providerResult.httpStatus,
      });
    }

    return new Response(
      JSON.stringify({ processed: results.length, details: results }),
      {
        status: persistenceFailed ? 500 : 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (error: unknown) {
    console.error("Notification queue worker failed", {
      type: error instanceof Error ? error.name : "UnknownError",
    });
    return new Response(
      JSON.stringify({ error: "notification_queue_processing_failed" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
