export const PLATFORM_ATTENDANCE_PORTAL =
  "https://system.wisewolflanguage.com.br";
export const ATTENDANCE_CLAIM_LIMIT = 5;

const BRAZIL_TIME_ZONE = "America/Sao_Paulo";

export interface AttendanceDeliveryClaim {
  id: string;
  claim_token?: string | null;
  delivery_key?: string | null;
  session_key?: string | null;
  session_end_at?: string | null;
  tenant_id?: string | null;
  token?: string | null;
  student_id?: string | null;
  student_name?: string | null;
  student_phone?: string | null;
  attendance_phone?: string | null;
  teacher_id?: string | null;
  teacher_name?: string | null;
  class_date?: string | null;
  class_time?: string | null;
  source_id?: string | null;
  source_type?: string | null;
  send_attempts?: number | null;
}

export interface AttendanceParticipantProfile {
  id?: string | null;
  tenant_id?: string | null;
  role?: string | null;
  lifecycle_status?: string | null;
  is_test_account?: boolean | null;
  attendance_phone?: string | null;
  phone?: string | null;
}

export interface EvolutionDeliveryResult {
  outcome: "accepted" | "rejected" | "ambiguous";
  messageId: string | null;
  httpStatus: number | null;
}

export type DeliveryFinalization =
  | {
    action: "complete";
    providerMessageId: string;
  }
  | {
    action: "fail";
    errorCode: "provider_rejected" | "provider_ambiguous";
    ambiguous: boolean;
  };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      .test(value);
}

/**
 * Valida o contrato inteiro antes do primeiro dispatch. Um rollout desalinhado
 * não pode enviar parte do lote e só então descobrir que os claims restantes
 * não podem ser finalizados.
 */
export function parseAttendanceDeliveryClaims(
  value: unknown,
  maximumRows = ATTENDANCE_CLAIM_LIMIT,
): AttendanceDeliveryClaim[] {
  const rows = Array.isArray(value) ? value : value == null ? [] : [value];
  if (rows.length > maximumRows) {
    throw new Error("attendance_claim_limit_exceeded");
  }
  for (const row of rows) {
    if (
      !isRecord(row) || !isUuid(row.id) || !isUuid(row.claim_token) ||
      typeof row.tenant_id !== "string" || !row.tenant_id.trim() ||
      typeof row.delivery_key !== "string" || !row.delivery_key.trim() ||
      typeof row.session_key !== "string" || !row.session_key.trim() ||
      !isUuid(row.student_id) || !isUuid(row.teacher_id) ||
      typeof row.token !== "string" ||
      !/^[A-Za-z0-9_-]{16,256}$/.test(row.token) ||
      typeof row.class_date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(row.class_date) ||
      typeof row.class_time !== "string" || !row.class_time.trim() ||
      typeof row.session_end_at !== "string" ||
      !Number.isFinite(Date.parse(row.session_end_at))
    ) {
      throw new Error("invalid_attendance_claim_contract");
    }
  }
  return rows as AttendanceDeliveryClaim[];
}

/**
 * Ultima barreira antes do provedor externo. O banco ja filtra fixtures no
 * enqueue e no claim; a Edge rele a identidade atual para cobrir uma conta
 * marcada como teste depois que o claim foi criado ou um rollout desalinhado.
 */
export function attendanceParticipantsAllowExternalDelivery(
  claim: AttendanceDeliveryClaim,
  profiles: readonly AttendanceParticipantProfile[],
): boolean {
  return resolveAttendanceDeliveryRecipient(claim, profiles).allowed;
}

/**
 * Resolve o destinatario usando apenas o cadastro atual. O telefone gravado no
 * snapshot da confirmacao nunca deve ressuscitar um numero que ja foi trocado.
 */
export function resolveAttendanceDeliveryRecipient(
  claim: AttendanceDeliveryClaim,
  profiles: readonly AttendanceParticipantProfile[],
): { allowed: boolean; phone: string | null } {
  if (
    !isUuid(claim.student_id) || !isUuid(claim.teacher_id) ||
    typeof claim.tenant_id !== "string" || !claim.tenant_id.trim()
  ) {
    return { allowed: false, phone: null };
  }

  const byId = new Map(
    profiles
      .filter((profile) => typeof profile.id === "string")
      .map((profile) => [profile.id as string, profile]),
  );
  const student = byId.get(claim.student_id);
  const teacher = byId.get(claim.teacher_id);
  const isEligible = (
    profile: AttendanceParticipantProfile | undefined,
    role: "STUDENT" | "TEACHER",
  ) => {
    if (!profile) return false;
    return profile.tenant_id === claim.tenant_id &&
      profile.role === role &&
      profile.lifecycle_status?.trim().toLowerCase() === "active" &&
      profile.is_test_account === false;
  };

  const allowed = isEligible(student, "STUDENT") &&
    isEligible(teacher, "TEACHER");
  return {
    allowed,
    phone: allowed
      ? selectAttendancePhone(student?.attendance_phone, student?.phone)
      : null,
  };
}

function safeHttpsBase(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password) return null;
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/**
 * A identidade do tenant continua tendo precedência. Tenants legados que não
 * possuem domínio/slug válido voltam ao portal institucional da plataforma —
 * nunca a uma URL recebida do cliente ou a HTTP.
 */
export function resolveAttendancePortal(
  tenantPortal: unknown,
  configuredPlatformPortal: unknown = PLATFORM_ATTENDANCE_PORTAL,
): string {
  return safeHttpsBase(tenantPortal) ||
    safeHttpsBase(configuredPlatformPortal) ||
    PLATFORM_ATTENDANCE_PORTAL;
}

export function buildAttendanceConfirmationUrl(
  portal: string,
  token: unknown,
): string | null {
  const safePortal = safeHttpsBase(portal);
  const safeToken = typeof token === "string" &&
      /^[A-Za-z0-9_-]{16,256}$/.test(token.trim())
    ? token.trim()
    : "";
  if (!safePortal || !safeToken) return null;
  const url = new URL(`${safePortal}/confirmar-presenca`);
  url.searchParams.set("token", safeToken);
  return url.toString();
}

export function normalizeAttendancePhone(value: unknown): string | null {
  const digits = typeof value === "string" ? value.replace(/\D/g, "") : "";
  const withCountry = digits.length === 10 || digits.length === 11
    ? `55${digits}`
    : digits;
  return withCountry.length >= 12 && withCountry.length <= 15
    ? withCountry
    : null;
}

/** O telefone exclusivo de auditoria tem precedência sobre o telefone geral. */
export function selectAttendancePhone(
  attendancePhone: unknown,
  studentPhone: unknown,
): string | null {
  return normalizeAttendancePhone(attendancePhone) ||
    normalizeAttendancePhone(studentPhone);
}

function localDate(now: Date, timeZone = BRAZIL_TIME_ZONE): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: string) =>
    parts.find((entry) => entry.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function previousIsoDate(date: string): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() - 1);
  return parsed.toISOString().slice(0, 10);
}

/**
 * Defesa em profundidade contra um backlog: mesmo que um RPC antigo devolva
 * linhas demais, a Edge só considera hoje e ontem no fuso operacional.
 */
export function isFreshAttendanceClassDate(
  classDate: unknown,
  now = new Date(),
  timeZone = BRAZIL_TIME_ZONE,
): boolean {
  if (typeof classDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(classDate)) {
    return false;
  }
  const today = localDate(now, timeZone);
  return classDate === today || classDate === previousIsoDate(today);
}

function localDateTimeParts(
  now: Date,
  timeZone = BRAZIL_TIME_ZONE,
): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (type: string) =>
    parts.find((entry) => entry.type === type)?.value || "";
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    minutes: Number(part("hour")) * 60 + Number(part("minute")),
  };
}

/**
 * Uma pane não pode transformar a recuperação do serviço num disparo tardio.
 * A janela de 12h é maior que a captura normal do enqueue (8h), mas encerra
 * linhas antigas do mesmo dia/da véspera sem contatar o aluno.
 */
export function isFreshAttendanceOccurrence(
  classDate: unknown,
  classTime: unknown,
  now = new Date(),
  maximumAgeHours = 12,
  timeZone = BRAZIL_TIME_ZONE,
): boolean {
  if (!isFreshAttendanceClassDate(classDate, now, timeZone)) return false;
  if (typeof classDate !== "string" || typeof classTime !== "string") {
    return false;
  }
  const match = classTime.match(/(?:^|\D)([01]?\d|2[0-3]):([0-5]\d)(?:\D|$)/);
  if (!match) return false;
  const current = localDateTimeParts(now, timeZone);
  const currentDay = Date.parse(`${current.date}T12:00:00Z`);
  const classDay = Date.parse(`${classDate}T12:00:00Z`);
  if (!Number.isFinite(currentDay) || !Number.isFinite(classDay)) return false;
  const dayDifference = Math.round((currentDay - classDay) / 86_400_000);
  const classMinutes = Number(match[1]) * 60 + Number(match[2]);
  const ageMinutes = dayDifference * 1440 + current.minutes - classMinutes;
  return ageMinutes >= 0 && ageMinutes <= maximumAgeHours * 60;
}

function normalizedKeyPart(value: unknown): string {
  return typeof value === "string"
    ? value.trim().toLowerCase().replace(/\s+/g, " ")
    : "";
}

/**
 * O banco fornece `delivery_key` como chave canônica. O fallback mantém
 * compatibilidade durante a subida conjunta da migration.
 */
export function attendanceDeliveryKey(row: AttendanceDeliveryClaim): string {
  const supplied = normalizedKeyPart(row.delivery_key);
  if (supplied) return `delivery:${supplied}`;

  const sourceId = normalizedKeyPart(row.source_id);
  const sourceType = normalizedKeyPart(row.source_type);
  const classDate = normalizedKeyPart(row.class_date);
  if (sourceId && sourceType && classDate) {
    return `occurrence:${
      normalizedKeyPart(row.tenant_id)
    }:${sourceType}:${sourceId}:${classDate}`;
  }

  return `confirmation:${normalizedKeyPart(row.id)}`;
}

export function dedupeAttendanceDeliveries<T extends AttendanceDeliveryClaim>(
  rows: readonly T[],
): { deliveries: T[]; duplicates: T[] } {
  const seen = new Set<string>();
  const deliveries: T[] = [];
  const duplicates: T[] = [];
  for (const row of rows) {
    const key = attendanceDeliveryKey(row);
    if (seen.has(key)) {
      duplicates.push(row);
      continue;
    }
    seen.add(key);
    deliveries.push(row);
  }
  return { deliveries, duplicates };
}

/**
 * Timeout, 5xx e 429 são ambíguos: a Evolution pode ter aceitado antes de a
 * resposta se perder. Esses casos não podem voltar para retry automático.
 */
export function finalizationForEvolutionResult(
  result: EvolutionDeliveryResult,
): DeliveryFinalization {
  const providerMessageId = typeof result.messageId === "string"
    ? result.messageId.trim()
    : "";
  if (result.outcome === "accepted" && providerMessageId) {
    return { action: "complete", providerMessageId };
  }
  if (result.outcome === "ambiguous" || result.outcome === "accepted") {
    return {
      action: "fail",
      errorCode: "provider_ambiguous",
      ambiguous: true,
    };
  }
  return {
    action: "fail",
    errorCode: "provider_rejected",
    ambiguous: false,
  };
}

export function attendanceDeliveryHttpStatus(summary: {
  claimed: number;
  sent: number;
  failed: number;
  suppressed: number;
}): number {
  return summary.failed > 0 ? 502 : 200;
}
