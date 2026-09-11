export interface OpportunityClaimRecord {
  id: string;
  student_name: string;
  student_phone?: string | null;
  slots_proposed: unknown;
  status: string | null;
  kind: string | null;
  interests: string | null;
  winner_teacher_id: string | null;
  trial_appointment_id: string | null;
  claim_generation: number;
  is_staff_preview?: boolean;
  actor_role?: string;
}

export interface OpportunityClaimSlot {
  date: string;
  time: string;
  label: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isOpportunityId(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value.trim());
}

export function isClaimGeneration(value: unknown): boolean {
  if (typeof value === "string" && !/^\d+$/.test(value.trim())) return false;
  if (typeof value !== "string" && typeof value !== "number") return false;
  const generation = Number(value);
  return Number.isInteger(generation) && generation >= 1 && generation <= 2147483647;
}

export function canonicalClaimPath(
  opportunityId: string,
  generation: number,
): string {
  return `/claim-opportunity?id=${encodeURIComponent(opportunityId)}&g=${generation}`;
}

export function deriveOpportunityClaimSlot(
  slotsProposed: unknown,
): OpportunityClaimSlot | null {
  if (!Array.isArray(slotsProposed) || slotsProposed.length !== 1) return null;
  const slot = slotsProposed[0];
  if (!slot || typeof slot !== "object" || Array.isArray(slot)) return null;
  const date = typeof slot.date === "string" ? slot.date.trim() : "";
  const time = typeof slot.time === "string" ? slot.time.trim() : "";
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)
  ) return null;

  const [year, month, day] = date.split("-").map(Number);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) return null;

  return {
    date,
    time,
    label: `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}/${year} às ${time}`,
  };
}

export function normalizeWhatsAppPhone(value: unknown): string | null {
  const digits = typeof value === "string" ? value.replace(/\D/g, "") : "";
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  if (digits.startsWith("55") && (digits.length === 12 || digits.length === 13)) {
    return digits;
  }
  return null;
}

export function deriveAlternateWhatsAppPhone(value: unknown): string | null {
  const normalized = normalizeWhatsAppPhone(value);
  if (!normalized || !normalized.startsWith("55")) return null;
  // Brazilian numbers:
  // 12 digits: 55 + 2 DDD + 8 digits -> alternate adds 9
  // 13 digits: 55 + 2 DDD + 9 digits starting with 9 -> alternate removes 9
  if (normalized.length === 12) {
    const ddd = normalized.slice(2, 4);
    const rest = normalized.slice(4);
    return `55${ddd}9${rest}`;
  }
  if (normalized.length === 13 && normalized[4] === "9") {
    const ddd = normalized.slice(2, 4);
    const rest = normalized.slice(5);
    return `55${ddd}${rest}`;
  }
  return null;
}

export function formatPhoneDisplay(value: unknown): string {
  const digits = typeof value === "string" ? value.replace(/\D/g, "") : "";
  if (!digits) return "";
  const d = digits.startsWith("55") && digits.length >= 12 ? digits.slice(2) : digits;
  if (d.length === 11) {
    return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  }
  if (d.length === 10) {
    return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  }
  return value ? String(value).trim() : "";
}

