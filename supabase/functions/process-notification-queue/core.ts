import type { EvolutionSendResult } from "../_shared/evolution-send.ts";

export type QueueDeliveryDecision = {
  status: "sent" | "failed" | "uncertain";
  reason: string | null;
  releaseOccurrenceReceipt: boolean;
};

export type LessonReminderFreshness =
  | { ok: true }
  | {
    ok: false;
    reason:
      | "lesson_reminder_invalid_time"
      | "lesson_reminder_too_late"
      | "lesson_reminder_stale_queue"
      | "lesson_reminder_outside_send_window";
  };

const MAX_QUEUE_AGE_MS = 15 * 60 * 1000;
const MIN_TIME_BEFORE_CLASS_MS = 15 * 60 * 1000;
const MAX_TIME_BEFORE_CLASS_MS = 45 * 60 * 1000;

export function lessonReminderFreshness(input: {
  startAt: unknown;
  scheduledFor: unknown;
  now?: Date;
}): LessonReminderFreshness {
  const now = input.now ?? new Date();
  const startAt = new Date(String(input.startAt || ""));
  const scheduledFor = new Date(String(input.scheduledFor || ""));
  if (
    Number.isNaN(now.getTime()) || Number.isNaN(startAt.getTime()) ||
    Number.isNaN(scheduledFor.getTime())
  ) return { ok: false, reason: "lesson_reminder_invalid_time" };

  if (startAt.getTime() - now.getTime() < MIN_TIME_BEFORE_CLASS_MS) {
    return { ok: false, reason: "lesson_reminder_too_late" };
  }
  if (now.getTime() - scheduledFor.getTime() > MAX_QUEUE_AGE_MS) {
    return { ok: false, reason: "lesson_reminder_stale_queue" };
  }
  if (startAt.getTime() - now.getTime() > MAX_TIME_BEFORE_CLASS_MS) {
    return { ok: false, reason: "lesson_reminder_outside_send_window" };
  }
  return { ok: true };
}

export function renderConflictTeacherAlert(input: {
  teacherName: unknown;
  studentName: unknown;
  classDate: unknown;
  classTime: unknown;
}): string {
  const teacherFirstName =
    String(input.teacherName || "").trim().split(/\s+/)[0] ||
    "professor";
  const studentName = String(input.studentName || "").trim() || "o(a) aluno(a)";
  const rawDate = String(input.classDate || "").slice(0, 10);
  const [year, month, day] = rawDate.split("-");
  const classDate = year && month && day ? `${day}/${month}` : "data informada";
  const classTime = String(input.classTime || "").trim().slice(0, 5);
  return `Oi, ${teacherFirstName}! Aqui é da coordenação da escola.\n\n` +
    `Recebemos uma divergência sobre a aula de ${classDate}` +
    (classTime ? ` às ${classTime}` : "") + ` com ${studentName}.\n` +
    "Pode nos contar como foi essa aula? Enquanto analisamos, somente esta aula fica em revisão.";
}

export function normalizeQueueDestination(raw: unknown): string | null {
  const destination = typeof raw === "string" ? raw.trim() : "";
  if (/^\d{10,25}@g\.us$/.test(destination)) return destination;
  let phone = destination.replace(/\D/g, "");
  if (phone.length === 10 || phone.length === 11) phone = `55${phone}`;
  return phone.length >= 12 && phone.length <= 15 ? phone : null;
}

export function providerMessageId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const root = payload as Record<string, unknown>;
  const key = root.key && typeof root.key === "object" &&
      !Array.isArray(root.key)
    ? root.key as Record<string, unknown>
    : null;
  const value = key?.id || root.id;
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, 320)
    : null;
}

export function queueDeliveryDecision(
  result: EvolutionSendResult,
): QueueDeliveryDecision {
  if (
    result.outcome === "accepted" && typeof result.messageId === "string" &&
    result.messageId.trim()
  ) {
    return { status: "sent", reason: null, releaseOccurrenceReceipt: false };
  }
  if (result.outcome === "accepted") {
    return {
      status: "uncertain",
      reason: "provider_accepted_without_message_id",
      releaseOccurrenceReceipt: false,
    };
  }
  if (result.outcome === "rejected") {
    return {
      status: "failed",
      reason: `provider_http_${result.httpStatus ?? "rejected"}`,
      releaseOccurrenceReceipt: true,
    };
  }
  return {
    status: "uncertain",
    reason: result.httpStatus == null
      ? "provider_network_or_timeout_ambiguous"
      : `provider_http_${result.httpStatus}_ambiguous`,
    releaseOccurrenceReceipt: false,
  };
}

/**
 * Backoff determinístico com jitter estável. Só é usado antes do POST ao
 * provedor; resultados ambíguos nunca entram nesta função.
 */
export function notificationRetryDelaySeconds(
  attempt: number,
  queueId: string,
): number {
  const safeAttempt = Math.max(1, Math.min(Math.trunc(attempt || 1), 10));
  const base = Math.min(30 * 2 ** (safeAttempt - 1), 15 * 60);
  let hash = 0;
  for (const character of queueId) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  // 0–20% de dispersão evita que a volta da integração solte o lote inteiro
  // no mesmo segundo, sem tornar o teste ou o agendamento não determinístico.
  return Math.round(base * (1 + (hash % 21) / 100));
}

export function normalizeNotificationKind(kind: unknown): string {
  return String(kind || "").trim().toUpperCase();
}

export function isTrialLifecycleNotificationKind(kind: unknown): boolean {
  const normalized = normalizeNotificationKind(kind);
  return normalized === "TRIAL_TEACHER_REQUESTED" ||
    normalized === "TRIAL_MANAGEMENT_ACCEPTED";
}

export type StudentLifecycleNotificationDescriptor = {
  audience: "student" | "teacher";
  targetStatus: "suspended" | "offboarded";
};

export function studentLifecycleNotificationDescriptor(
  kind: unknown,
): StudentLifecycleNotificationDescriptor | null {
  switch (normalizeNotificationKind(kind)) {
    case "STUDENT_SUSPENDED":
      return { audience: "student", targetStatus: "suspended" };
    case "STUDENT_OFFBOARDED":
      return { audience: "student", targetStatus: "offboarded" };
    case "TEACHER_STUDENT_SUSPENDED":
      return { audience: "teacher", targetStatus: "suspended" };
    case "TEACHER_STUDENT_OFFBOARDED":
      return { audience: "teacher", targetStatus: "offboarded" };
    default:
      return null;
  }
}

export function isStudentLifecycleNotificationKind(kind: unknown): boolean {
  return studentLifecycleNotificationDescriptor(kind) !== null;
}

function firstName(value: unknown, fallback: string): string {
  const normalized = String(value || "").trim().replace(/\s+/g, " ");
  return normalized.split(" ")[0]?.slice(0, 80) || fallback;
}

function displayName(value: unknown, fallback: string): string {
  const normalized = String(value || "").trim().replace(/\s+/g, " ");
  return normalized.slice(0, 180) || fallback;
}

function displayDate(value: unknown): string {
  const raw = String(value || "").slice(0, 10);
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : "a data combinada";
}

export function renderStudentLifecycleNotification(input: {
  kind: unknown;
  studentName: unknown;
  teacherName?: unknown;
  tenantName: unknown;
  effectiveEndDate: unknown;
}): string | null {
  const descriptor = studentLifecycleNotificationDescriptor(input.kind);
  if (!descriptor) return null;

  const studentFirstName = firstName(input.studentName, "tudo bem");
  const studentName = displayName(input.studentName, "seu aluno");
  const teacherFirstName = firstName(input.teacherName, "professor(a)");
  const tenantName = displayName(input.tenantName, "nossa escola");
  const effectiveDate = displayDate(input.effectiveEndDate);

  if (descriptor.audience === "teacher") {
    if (descriptor.targetStatus === "suspended") {
      return `Oi, ${teacherFirstName}! Atualiza\u00e7\u00e3o da coordena\u00e7\u00e3o: as aulas de ${studentName} ficar\u00e3o em pausa a partir de ${effectiveDate}, e os hor\u00e1rios fixos j\u00e1 foram liberados na sua agenda. N\u00e3o \u00e9 necess\u00e1rio manter esses slots reservados. Se precisar de algum ajuste, fale com a coordena\u00e7\u00e3o.`;
    }
    return `Oi, ${teacherFirstName}! Atualiza\u00e7\u00e3o da coordena\u00e7\u00e3o: a matr\u00edcula de ${studentName} foi encerrada a partir de ${effectiveDate}, e os hor\u00e1rios fixos j\u00e1 foram liberados na sua agenda. Obrigado por todo o acompanhamento. Se precisar de algum ajuste, fale com a coordena\u00e7\u00e3o.`;
  }

  if (descriptor.targetStatus === "suspended") {
    return `Oi, ${studentFirstName}! Passando para confirmar que sua jornada com a ${tenantName} ficar\u00e1 em pausa a partir de ${effectiveDate}. Seus hor\u00e1rios fixos foram liberados por enquanto. Quando for o momento de retomar, nossa equipe estar\u00e1 pronta para organizar uma nova agenda com carinho. Se precisar, conte com a gente.`;
  }
  return `Oi, ${studentFirstName}! Registramos o encerramento da sua matr\u00edcula na ${tenantName}, conforme alinhado com a equipe, a partir de ${effectiveDate}. Agradecemos por ter feito parte da nossa escola. Seus hor\u00e1rios fixos foram liberados e, se quiser voltar no futuro, ser\u00e1 um prazer receber voc\u00ea novamente. Conte com a gente.`;
}

export function queueAudience(kind: unknown): {
  audience: "student" | "teacher";
  centralOnly: boolean;
} {
  const normalized = normalizeNotificationKind(kind);
  if (
    normalized === "SCHEDULE_CHANGE_GROUP" ||
    normalized === "CONFLICT_TEACHER_ALERT" ||
    normalized === "TEACHER_AGENDA" ||
    normalized === "TEACHER_BIRTHDAY" ||
    normalized === "SCHOOL_AI_BRIEFING" ||
    normalized === "CRON_ALERT" ||
    normalized === "ASAAS_HEALTH" ||
    normalized === "INTERVIEW_BOOKED_CANDIDATE" ||
    normalized === "INTERVIEW_BOOKED_MANAGEMENT" ||
    normalized === "INTERVIEW_REMINDER_CANDIDATE" ||
    normalized === "INTERVIEW_REMINDER_MANAGEMENT" ||
    normalized === "TRIAL_TEACHER_REQUESTED" ||
    normalized === "TRIAL_MANAGEMENT_ACCEPTED" ||
    normalized === "TEACHER_STUDENT_SUSPENDED" ||
    normalized === "TEACHER_STUDENT_OFFBOARDED"
  ) return { audience: "teacher", centralOnly: true };
  return { audience: "student", centralOnly: false };
}
