/// <reference lib="deno.ns" />
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  createClient,
  type SupabaseClient,
} from "https://esm.sh/@supabase/supabase-js@2.93.3";
import { authorizeAutomation } from "../_shared/automation-auth.ts";
import { sendWhatsTextDetailed } from "../_shared/evolution-send.ts";
import {
  claimOutboundMessage,
  finishOutboundMessage,
  markOutboundMessageSubmittingDecision,
} from "../_shared/student-billing-period-guard.ts";
import { resolveEvolutionIntegration } from "../_shared/tenant-integration-broker.ts";
import {
  loadTenantCentralWhatsAppInstance,
  loadTenantWhatsAppInstance,
  safeCommunicationText,
} from "../_shared/tenant-communication.ts";
import {
  classReminderReceiptFromQueue,
  dateInSaoPaulo,
  DEFAULT_CLASS_REMINDER_TEMPLATE,
  normalizeStudentPhone,
  recurringBookingMatchesDate,
  renderReminderTemplate,
  timeInSaoPaulo,
} from "../send-class-notification/core.ts";
import {
  lessonReminderFreshness,
  normalizeQueueDestination,
  providerMessageId,
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

const EVOLUTION_API_URL = (Deno.env.get("EVOLUTION_API_URL") || "")
  .trim()
  .replace(/\/+$/, "");
// Chave via env para permitir rotação sem novo deploy.
const EVOLUTION_API_KEYS = Array.from(
  new Set([
    (Deno.env.get("EVOLUTION_API_KEY") || "").trim(),
  ].filter(Boolean)),
);
const MAX_PAYMENT_CONFIRMATION_ATTEMPTS = 3;
const PROCESSING_LEASE_MS = 5 * 60 * 1000;

type QueueRelation<T> = T | T[] | null;

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
  scheduled_for: string;
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
  lesson_reminder_template: string | null;
};

class QueueRevalidationError extends Error {
  constructor(
    readonly queueStatus: "failed" | "skipped",
    readonly reason: string,
  ) {
    super(reason);
  }
}

function invalid(reason: string): never {
  throw new QueueRevalidationError("skipped", reason);
}

function unavailable(reason: string): never {
  throw new QueueRevalidationError("failed", reason);
}

function relationOne<T>(value: QueueRelation<T>): T | null {
  return Array.isArray(value) ? value[0] ?? null : value;
}

function providerHttpOutcomeIsUnknown(status: number): boolean {
  return [408, 409, 425, 429].includes(status) || status >= 500;
}

async function loadActiveMember(
  supabase: SupabaseClient,
  tenantId: string,
  userId: string,
  role: "STUDENT" | "TEACHER",
): Promise<ActiveMember> {
  const [profileResult, membershipResult] = await Promise.all([
    supabase.from("profiles").select(
      "id,tenant_id,role,full_name,phone,attendance_phone,meeting_link,lifecycle_status,is_test_account,date_automation_enabled,lesson_reminder_template",
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

async function markClaim(
  supabase: SupabaseClient,
  id: string,
  status: "pending" | "sent" | "failed" | "skipped",
  lastError: string | null,
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { data, error } = await supabase
      .from("notification_queue")
      .update({
        status,
        last_error: lastError,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("status", "processing")
      .select("id")
      .maybeSingle();
    if (!error) return Boolean(data);
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

    // Recupera claims abandonados por timeout/restart do worker.
    const staleBefore = new Date(Date.now() - PROCESSING_LEASE_MS)
      .toISOString();
    const { data: staleClaims, error: staleClaimsError } = await supabaseClient
      .from("notification_queue")
      .select(
        "id, attempts, notification_kind, tenant_id, student_id, source_id",
      )
      .eq("status", "processing")
      .lt("updated_at", staleBefore)
      .limit(100);
    if (staleClaimsError) throw staleClaimsError;
    for (const stale of (staleClaims || [])) {
      let recoveredStatus: "pending" | "sent" | "failed" | "skipped" = "failed";
      let recoveredError = "worker_lease_expired_ambiguous";
      if (
        stale.notification_kind === "PAYMENT_CONFIRMED" &&
        stale.tenant_id && stale.student_id && stale.source_id
      ) {
        const { data: outbound, error: outboundError } = await supabaseClient
          .from("asaas_outbound_message_attempts")
          .select("status, submit_attempt_count")
          .eq("tenant_id", stale.tenant_id)
          .eq("student_id", stale.student_id)
          .eq("provider_entity_id", stale.source_id)
          .eq("notification_kind", "PAYMENT_CONFIRMED_WHATSAPP")
          .maybeSingle();
        if (outboundError) throw outboundError;
        const outboundStatus = String(outbound?.status || "").toUpperCase();
        if (outboundStatus === "SENT") {
          recoveredStatus = "sent";
          recoveredError = "";
        } else if (outboundStatus === "SUPPRESSED") {
          recoveredStatus = "skipped";
          recoveredError = "payment_confirmation_suppressed";
        } else if (
          ["FAILED", "UNKNOWN", "SUBMITTING"].includes(outboundStatus) ||
          Number(outbound?.submit_attempt_count || 0) > 0
        ) {
          recoveredStatus = "failed";
          recoveredError = "payment_confirmation_terminal";
        } else if (outboundStatus === "CLAIMED") {
          recoveredStatus = "pending";
          recoveredError = "payment_confirmation_claim_recoverable";
        } else {
          recoveredStatus = Number(stale.attempts || 0) >=
              MAX_PAYMENT_CONFIRMATION_ATTEMPTS
            ? "failed"
            : "pending";
          recoveredError = recoveredStatus === "failed"
            ? "payment_confirmation_terminal"
            : "payment_confirmation_claim_recoverable";
        }
      } else if (stale.notification_kind === "PAYMENT_CONFIRMED") {
        recoveredStatus = "failed";
        recoveredError = "payment_confirmation_binding_missing";
      }
      const { error: staleRecoveryError } = await supabaseClient
        .from("notification_queue")
        .update({
          status: recoveredStatus,
          last_error: recoveredError || null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", stale.id)
        .eq("status", "processing");
      if (staleRecoveryError) throw staleRecoveryError;
    }

    // 1. Busca notificações pendentes e vencidas
    const { data: pending, error: fetchError } = await supabaseClient
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
                scheduled_for,
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
      .eq("status", "pending")
      .lte("scheduled_for", new Date().toISOString())
      .limit(50);

    if (fetchError) throw fetchError;
    if (!pending || pending.length === 0) {
      return new Response(
        JSON.stringify({ message: "No pending notifications due." }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const queueItems = pending as unknown as QueueItem[];
    const results: Array<Record<string, unknown>> = [];
    const centralCache: Record<string, string | null> = {};
    const personalCache: Record<string, string | null> = {};
    let persistenceFailed = false;

    // 2. Processa o lote
    for (const item of queueItems) {
      const { id, student_phone, message_body, tenant_id, attempts } = item;
      const teacher = relationOne(item.teacher);
      const student = relationOne(item.student);
      const nextAttempts = (attempts || 0) + 1;
      const { data: claim, error: claimError } = await supabaseClient
        .from("notification_queue")
        .update({
          status: "processing",
          attempts: nextAttempts,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id)
        .eq("status", "pending")
        .select("id")
        .maybeSingle();
      if (claimError || !claim) {
        results.push({ id, status: "skipped" });
        continue;
      }

      if (student?.is_test_account === true) {
        const marked = await markClaim(
          supabaseClient,
          id,
          "skipped",
          "test_fixture_suppressed",
        );
        persistenceFailed ||= !marked;
        results.push({
          id,
          status: marked ? "skipped" : "marker_failed",
        });
        continue;
      }
      if (student?.tenant_id && student.tenant_id !== tenant_id) {
        const marked = await markClaim(
          supabaseClient,
          id,
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
      const isPaymentConfirmation =
        item.notification_kind === "PAYMENT_CONFIRMED";
      if (
        isPaymentConfirmation &&
        (!tenant_id || !item.student_id || !item.source_id || !student ||
          student.id !== item.student_id || student.tenant_id !== tenant_id)
      ) {
        const marked = await markClaim(
          supabaseClient,
          id,
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
          String(item.notification_kind || "").toUpperCase() ===
            "LESSON_REMINDER"
        ) {
          prepared = await prepareLessonReminder(
            supabaseClient,
            item,
            new Date(),
          );
        } else if (
          String(item.notification_kind || "").toUpperCase() ===
            "CONFLICT_TEACHER_ALERT"
        ) {
          prepared = await prepareConflictTeacherAlert(
            supabaseClient,
            item,
            new Date(),
          );
        }
      } catch (error) {
        if (!(error instanceof QueueRevalidationError)) throw error;
        const marked = await markClaim(
          supabaseClient,
          id,
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

      // Aviso em grupo sempre sai da conexão central, que é a participante
      // configurada no grupo da escola. Mensagem individual mantém o fluxo
      // professor → fallback central.
      const route = queueAudience(item.notification_kind);
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
          id,
          "failed",
          "no_whatsapp_instance",
        );
        persistenceFailed ||= !marked;
        results.push({
          id,
          status: marked ? "failed" : "marker_failed",
          error: "no_instance",
        });
        continue;
      }

      const destination = normalizeQueueDestination(prepared.destination);
      if (!destination) {
        const marked = await markClaim(
          supabaseClient,
          id,
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

      // Confirmações financeiras usam exclusivamente a integração Evolution
      // resolvida para a escola. Elas nunca herdam a chave global de outro
      // tenant e só atravessam o provedor após um claim submit-once durável.
      let deliveryBaseUrl = EVOLUTION_API_URL;
      let deliveryApiKeys = EVOLUTION_API_KEYS;
      if (isPaymentConfirmation) {
        try {
          const integration = await resolveEvolutionIntegration(
            supabaseClient,
            tenant_id!,
            "message.send_text",
          );
          deliveryBaseUrl = integration.baseUrl;
          deliveryApiKeys = [integration.apiKey];
        } catch {
          const marked = await markClaim(
            supabaseClient,
            id,
            "pending",
            "payment_confirmation_integration_unavailable",
          );
          persistenceFailed ||= !marked;
          results.push({ id, status: marked ? "pending" : "marker_failed" });
          continue;
        }
      }
      if (!deliveryBaseUrl || deliveryApiKeys.length === 0) {
        const marked = await markClaim(
          supabaseClient,
          id,
          "failed",
          "notification_provider_unavailable",
        );
        persistenceFailed ||= !marked;
        results.push({ id, status: marked ? "failed" : "marker_failed" });
        continue;
      }

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
        if (currentProfileResult.error) throw currentProfileResult.error;
        if (sourcePaymentResult.error) throw sourcePaymentResult.error;
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
          const marked = await markClaim(
            supabaseClient,
            id,
            "failed",
            currentDestination !== destination
              ? "payment_confirmation_destination_changed"
              : "payment_confirmation_source_unsettled",
          );
          persistenceFailed ||= !marked;
          results.push({ id, status: marked ? "failed" : "marker_failed" });
          continue;
        }

        paymentOutboundClaim = await claimOutboundMessage(supabaseClient, {
          tenantId: tenant_id!,
          studentId: item.student_id!,
          providerEntityId: item.source_id!,
          notificationKind: "PAYMENT_CONFIRMED_WHATSAPP",
        });
        if (paymentOutboundClaim.action === "REVIEW_REQUIRED") {
          const marked = await markClaim(
            supabaseClient,
            id,
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
            id,
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
          const queueStatus = outboundStatus === "SENT"
            ? "sent"
            : outboundStatus === "SUPPRESSED"
            ? "skipped"
            : "failed";
          const marked = await markClaim(
            supabaseClient,
            id,
            queueStatus,
            queueStatus === "sent"
              ? null
              : `payment_confirmation_${
                outboundStatus.toLowerCase() || "terminal"
              }`,
          );
          persistenceFailed ||= !marked;
          results.push({ id, status: marked ? queueStatus : "marker_failed" });
          continue;
        }
        const submit = await markOutboundMessageSubmittingDecision(
          supabaseClient,
          paymentOutboundClaim,
        );
        if (submit.ok !== true || submit.status !== "SUBMITTING") {
          const marked = await markClaim(
            supabaseClient,
            id,
            "skipped",
            submit.reason || "payment_confirmation_suppressed_before_send",
          );
          persistenceFailed ||= !marked;
          results.push({ id, status: marked ? "skipped" : "marker_failed" });
          continue;
        }
      }

      const occurrenceReceipt = item.notification_kind === "LESSON_REMINDER"
        ? classReminderReceiptFromQueue(prepared.occurrenceIdentity || item)
        : null;
      if (item.notification_kind === "LESSON_REMINDER" && !occurrenceReceipt) {
        const marked = await markClaim(
          supabaseClient,
          id,
          "failed",
          "invalid_occurrence_identity",
        );
        persistenceFailed ||= !marked;
        results.push({ id, status: marked ? "failed" : "marker_failed" });
        continue;
      }
      if (occurrenceReceipt) {
        const { error: receiptError } = await supabaseClient
          .from("automation_sent").insert(occurrenceReceipt);
        if (receiptError?.code === "23505") {
          const marked = await markClaim(
            supabaseClient,
            id,
            "skipped",
            "occurrence_already_notified",
          );
          persistenceFailed ||= !marked;
          results.push({ id, status: marked ? "skipped" : "marker_failed" });
          continue;
        }
        if (receiptError) {
          const marked = await markClaim(
            supabaseClient,
            id,
            "failed",
            "occurrence_receipt_unavailable",
          );
          persistenceFailed ||= !marked;
          results.push({ id, status: marked ? "failed" : "marker_failed" });
          continue;
        }
      }

      if (paymentOutboundClaim) {
        const url = `${deliveryBaseUrl}/message/sendText/${
          encodeURIComponent(instanceId)
        }`;
        let response: Response | null = null;
        try {
          for (const key of deliveryApiKeys) {
            response = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json", apikey: key },
              body: JSON.stringify({
                number: destination,
                text: prepared.message,
                delay: 1000,
                linkPreview: false,
              }),
              signal: AbortSignal.timeout(15_000),
            });
            if (response.status !== 401) break;
          }
        } catch (error) {
          const safeReason = error instanceof DOMException &&
              (error.name === "TimeoutError" || error.name === "AbortError")
            ? "provider_timeout"
            : "provider_network_error";
          try {
            await finishOutboundMessage(supabaseClient, paymentOutboundClaim, {
              status: "UNKNOWN",
              error: safeReason,
            });
          } catch {
            persistenceFailed = true;
          }
          const marked = await markClaim(
            supabaseClient,
            id,
            "failed",
            safeReason,
          );
          persistenceFailed ||= !marked;
          results.push({
            id,
            status: marked ? "failed" : "marker_failed",
            error: safeReason,
          });
          continue;
        }

        if (!response || !response.ok) {
          const unknown = response
            ? providerHttpOutcomeIsUnknown(response.status)
            : true;
          const safeReason = unknown
            ? "provider_delivery_outcome_unknown"
            : `provider_http_${response?.status ?? "unavailable"}`;
          try {
            await finishOutboundMessage(supabaseClient, paymentOutboundClaim, {
              status: unknown ? "UNKNOWN" : "FAILED",
              providerHttpStatus: response?.status ?? null,
              error: safeReason,
            });
          } catch {
            persistenceFailed = true;
          }
          const marked = await markClaim(
            supabaseClient,
            id,
            "failed",
            safeReason,
          );
          persistenceFailed ||= !marked;
          results.push({
            id,
            status: marked ? "failed" : "marker_failed",
            error: safeReason,
          });
          continue;
        }

        const payload = await response.json().catch(() => null);
        const messageId = providerMessageId(payload);
        if (!messageId) {
          const safeReason = "provider_accepted_without_message_id";
          try {
            await finishOutboundMessage(supabaseClient, paymentOutboundClaim, {
              status: "UNKNOWN",
              providerHttpStatus: response.status,
              error: safeReason,
            });
          } catch {
            persistenceFailed = true;
          }
          const marked = await markClaim(
            supabaseClient,
            id,
            "failed",
            safeReason,
          );
          persistenceFailed ||= !marked;
          results.push({
            id,
            status: marked ? "failed" : "marker_failed",
            error: safeReason,
          });
          continue;
        }

        try {
          await finishOutboundMessage(supabaseClient, paymentOutboundClaim, {
            status: "SENT",
            providerHttpStatus: response.status,
          });
        } catch {
          // O provedor aceitou; sem marker durável, a recuperação do lease
          // encerra a fila usando o claim e nunca envia novamente.
          persistenceFailed = true;
          results.push({ id, status: "marker_failed" });
          continue;
        }
        const marked = await markClaim(supabaseClient, id, "sent", null);
        persistenceFailed ||= !marked;
        results.push({
          id,
          status: marked ? "sent" : "marker_failed",
          provider_message_id: messageId,
        });
        continue;
      }

      const providerResult = await sendWhatsTextDetailed({
        base: EVOLUTION_API_URL,
        keys: EVOLUTION_API_KEYS,
        instance: instanceId,
        to: destination,
        text: prepared.message,
        delayMs: 1000,
      });
      const decision = queueDeliveryDecision(providerResult);

      if (decision.releaseOccurrenceReceipt && occurrenceReceipt) {
        const { error: releaseError } = await supabaseClient
          .from("automation_sent").delete()
          .eq("kind", occurrenceReceipt.kind)
          .eq("subject_id", occurrenceReceipt.subject_id)
          .eq("ref_date", occurrenceReceipt.ref_date);
        if (releaseError) {
          console.error("Occurrence receipt release failed", { id });
        }
      }

      const marked = await markClaim(
        supabaseClient,
        id,
        decision.status,
        decision.reason,
      );
      // Depois de 2xx o receipt já está preservado e um marker failure
      // deixa PROCESSING; a recuperação do lease o torna FAILED, sem envio.
      persistenceFailed ||= !marked;
      results.push({
        id,
        status: marked ? decision.status : "marker_failed",
        error: decision.reason,
        provider_message_id: providerResult.messageId,
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
