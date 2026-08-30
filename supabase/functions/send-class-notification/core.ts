import type { EvolutionSendResult } from "../_shared/evolution-send.ts";

export type ManualClassSourceType =
  | "BOOKING"
  | "RESCHEDULE"
  | "APPOINTMENT";

export interface ManualReminderIdentity {
  sourceId: string;
  sourceType: ManualClassSourceType;
  classDate: string;
}

export interface ManualReminderReceipt {
  kind: "CLASS_REMINDER";
  subject_id: string;
  ref_date: string;
}

export interface RescheduleNotificationReceipt {
  kind: "RESCHEDULE_SCHEDULED";
  subject_id: string;
  ref_date: string;
}

export interface ProviderReceiptDecision {
  releaseReceipt: boolean;
  delivery: "accepted" | "rejected" | "ambiguous";
}

export type ManualReminderWindow =
  | { ok: true }
  | {
    ok: false;
    reason:
      | "manual_reminder_invalid_start_time"
      | "manual_reminder_too_late"
      | "manual_reminder_too_early";
  };

export const DEFAULT_CLASS_REMINDER_TEMPLATE = `Oi {student_name}, tudo bem? 👋

Lembrando que nossa aula começa em 30 minutos, às *{class_time}*.

{class_link}

Te espero! 🐺`;

export const SCHEDULE_CONFIRMATION_REF_DATE = "2000-01-01";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeStudentPhone(value: unknown): string | null {
  const digits = typeof value === "string" ? value.replace(/\D/g, "") : "";
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  return digits.length >= 12 && digits.length <= 15 ? digits : null;
}

/**
 * Telefones brasileiros com e sem o nono dígito podem apontar para o mesmo JID.
 * Exigimos o mesmo DDD e os mesmos oito dígitos finais; nunca aceitamos somente
 * uma coincidência de sufixo sem o DDD.
 */
export function phonesBelongToSameRecipient(
  requested: unknown,
  canonical: unknown,
): boolean {
  const left = normalizeStudentPhone(requested);
  const right = normalizeStudentPhone(canonical);
  if (!left || !right) return false;
  if (left === right) return true;

  const localLeft = left.startsWith("55") ? left.slice(2) : left;
  const localRight = right.startsWith("55") ? right.slice(2) : right;
  if (localLeft.length < 10 || localRight.length < 10) return false;
  return localLeft.slice(0, 2) === localRight.slice(0, 2) &&
    localLeft.slice(-8) === localRight.slice(-8);
}

function normalizedName(value: unknown): string {
  return typeof value === "string"
    ? value.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ").trim().toLocaleLowerCase("pt-BR")
    : "";
}

export function namesBelongToSameRecipient(
  requested: unknown,
  canonical: unknown,
): boolean {
  const left = normalizedName(requested);
  const right = normalizedName(canonical);
  return Boolean(left && right && left === right);
}

export function normalizeManualClassSourceType(
  value: unknown,
): ManualClassSourceType | null {
  const normalized = typeof value === "string"
    ? value.trim().toUpperCase()
    : "";
  if (
    normalized === "BOOKING" || normalized === "RESCHEDULE" ||
    normalized === "APPOINTMENT"
  ) return normalized;
  return null;
}

export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

export function parseManualReminderIdentity(input: {
  source_id?: unknown;
  source_type?: unknown;
  class_date?: unknown;
}): ManualReminderIdentity | null {
  const sourceId = typeof input.source_id === "string"
    ? input.source_id.trim()
    : "";
  const sourceType = normalizeManualClassSourceType(input.source_type);
  const classDate = typeof input.class_date === "string"
    ? input.class_date.trim()
    : "";
  if (
    !UUID_PATTERN.test(sourceId) || !sourceType || !isCalendarDate(classDate)
  ) {
    return null;
  }
  return { sourceId, sourceType, classDate };
}

export function hasAnyManualReminderIdentityField(input: {
  source_id?: unknown;
  source_type?: unknown;
  class_date?: unknown;
}): boolean {
  return input.source_id !== undefined || input.source_type !== undefined ||
    input.class_date !== undefined;
}

export function manualReminderReceipt(
  tenantId: string,
  identity: ManualReminderIdentity,
): ManualReminderReceipt {
  return {
    kind: "CLASS_REMINDER",
    subject_id: `${tenantId}:${identity.sourceType}:${identity.sourceId}`,
    ref_date: identity.classDate,
  };
}

/**
 * A revisão monotônica muda em toda alteração relevante da reposição. Isso
 * bloqueia replay da mesma versão e também permite avisar uma reversão, como
 * 19h → 20h → 19h, sem colidir com a primeira mensagem.
 */
export function rescheduleNotificationReceipt(
  tenantId: string,
  identity: ManualReminderIdentity,
  notificationRevision: number,
): RescheduleNotificationReceipt {
  return {
    kind: "RESCHEDULE_SCHEDULED",
    subject_id:
      `${tenantId}:RESCHEDULE:${identity.sourceId}:v${notificationRevision}`,
    ref_date: identity.classDate,
  };
}

export function classReminderReceiptFromQueue(item: {
  tenant_id?: unknown;
  source_type?: unknown;
  source_id?: unknown;
  class_date?: unknown;
}): ManualReminderReceipt | null {
  const tenantId = typeof item.tenant_id === "string"
    ? item.tenant_id.trim()
    : "";
  const identity = parseManualReminderIdentity({
    source_id: item.source_id,
    source_type: item.source_type,
    class_date: item.class_date,
  });
  return tenantId && identity
    ? manualReminderReceipt(tenantId, identity)
    : null;
}

export function renderReminderTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? "")
    .replace(/\u0000/g, "").trim().slice(0, 4096);
}

export function providerReceiptDecision(
  result: EvolutionSendResult,
): ProviderReceiptDecision {
  if (
    result.outcome === "accepted" &&
    typeof result.messageId === "string" &&
    result.messageId.trim()
  ) {
    return { releaseReceipt: false, delivery: "accepted" };
  }
  // HTTP 2xx sem identificador não comprova uma entrega rastreável. O provedor
  // pode ter aceitado, portanto o receipt permanece e o cliente não repete.
  if (result.outcome === "accepted") {
    return { releaseReceipt: false, delivery: "ambiguous" };
  }
  if (result.outcome === "rejected") {
    return { releaseReceipt: true, delivery: "rejected" };
  }
  return { releaseReceipt: false, delivery: "ambiguous" };
}

export function dateInSaoPaulo(value: string | Date): string | null {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const byType = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${byType.year}-${byType.month}-${byType.day}`;
}

export function timeInSaoPaulo(value: string | Date): string | null {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const byType = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${byType.hour}:${byType.minute}`;
}

export function manualReminderWindow(input: {
  startAt: unknown;
  now?: Date;
}): ManualReminderWindow {
  const startAt = new Date(String(input.startAt || ""));
  const now = input.now ?? new Date();
  if (Number.isNaN(startAt.getTime()) || Number.isNaN(now.getTime())) {
    return { ok: false, reason: "manual_reminder_invalid_start_time" };
  }
  const minutesUntilClass = (startAt.getTime() - now.getTime()) / 60_000;
  if (minutesUntilClass < 15) {
    return { ok: false, reason: "manual_reminder_too_late" };
  }
  if (minutesUntilClass > 45) {
    return { ok: false, reason: "manual_reminder_too_early" };
  }
  return { ok: true };
}

function normalizedWeekday(value: unknown): string {
  return typeof value === "string"
    ? value.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .trim().toLowerCase()
    : "";
}

export function recurringBookingMatchesDate(
  dayOfWeek: unknown,
  classDate: string,
): boolean {
  if (!isCalendarDate(classDate)) return false;
  const weekdays = [
    ["domingo", "sunday", "0", "7"],
    ["segunda", "segunda-feira", "monday", "1"],
    ["terca", "terca-feira", "tuesday", "2"],
    ["quarta", "quarta-feira", "wednesday", "3"],
    ["quinta", "quinta-feira", "thursday", "4"],
    ["sexta", "sexta-feira", "friday", "5"],
    ["sabado", "saturday", "6"],
  ];
  const [year, month, day] = classDate.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekdays[weekday].includes(normalizedWeekday(dayOfWeek));
}

function normalizedScheduleDay(value: unknown): string {
  const normalized = normalizedWeekday(value).replace(/-feira$/, "");
  const aliases: Record<string, string> = {
    domingo: "0",
    sunday: "0",
    segunda: "1",
    monday: "1",
    terca: "2",
    tuesday: "2",
    quarta: "3",
    wednesday: "3",
    quinta: "4",
    thursday: "4",
    sexta: "5",
    friday: "5",
    sabado: "6",
    saturday: "6",
  };
  return aliases[normalized] ?? normalized;
}

/**
 * A versão da grade depende do conteúdo pedagógico do horário, não dos IDs
 * das linhas. Assim, recriar uma linha idêntica não dispara outra confirmação,
 * enquanto qualquer mudança real de dia/horário produz uma nova versão.
 */
export function canonicalScheduleVersion(
  rows: Array<{ day_of_week?: unknown; time_slot?: unknown }>,
): string {
  return Array.from(
    new Set(
      rows.flatMap((row) => {
        const day = normalizedScheduleDay(row.day_of_week);
        const time = typeof row.time_slot === "string"
          ? row.time_slot.trim().slice(0, 5)
          : "";
        return day && /^\d{2}:\d{2}$/.test(time) ? [`${day}@${time}`] : [];
      }),
    ),
  ).sort().join("|");
}

export async function scheduleVersionHash(version: string): Promise<string> {
  if (!version) return "";
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`wise-wolf-schedule-v1:${version}`),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
