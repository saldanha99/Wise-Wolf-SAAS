export const LIFECYCLE_STATUSES = [
  "active",
  "suspended",
  "offboarded",
] as const;

export type LifecycleStatus = typeof LIFECYCLE_STATUSES[number];

export const STUDENT_OFFBOARDING_BILLING_POLICIES = [
  "CHARGE_CURRENT_MONTH",
  "WAIVE_CURRENT_MONTH",
] as const;

export type StudentOffboardingBillingPolicy =
  typeof STUDENT_OFFBOARDING_BILLING_POLICIES[number];

export type TargetMembershipSnapshot = {
  tenant_id?: unknown;
  role?: unknown;
  status?: unknown;
};

export function enrollmentLeadMatchesTrial(
  leadStudentIdValue: unknown,
  opportunityStudentIdValue: unknown,
  leadPhoneValue: unknown,
  opportunityPhoneValue: unknown,
): boolean {
  const leadStudentId = String(leadStudentIdValue || "").trim();
  const opportunityStudentId = String(opportunityStudentIdValue || "").trim();
  if (leadStudentId && opportunityStudentId) {
    return leadStudentId === opportunityStudentId;
  }

  const leadPhone = String(leadPhoneValue || "").trim();
  const opportunityPhone = String(opportunityPhoneValue || "").trim();
  return Boolean(
    leadPhone && opportunityPhone && leadPhone === opportunityPhone,
  );
}

export function hasExclusiveActiveTargetMembership(
  memberships: TargetMembershipSnapshot[],
  tenantId: string,
  expectedRole: "STUDENT" | "TEACHER",
): boolean {
  if (memberships.length !== 1) return false;
  const membership = memberships[0];
  return String(membership.tenant_id || "").trim() === tenantId &&
    String(membership.role || "").trim().toUpperCase() === expectedRole &&
    String(membership.status || "").trim().toUpperCase() === "ACTIVE";
}

export type SchoolAdminAction =
  | {
    action: "setStudentLifecycle";
    targetId: string;
    status: LifecycleStatus;
    reason: string | null;
    billingPolicy: StudentOffboardingBillingPolicy | null;
    effectiveEndDate: string | null;
  }
  | {
    action: "setTeacherLifecycle";
    targetId: string;
    status: LifecycleStatus;
    reason: string | null;
  }
  | {
    action: "serasaNegativar";
    paymentId: string;
  }
  | {
    action: "createEnrollmentOffer";
    leadId: string;
    opportunityId: string;
    requestId: string;
    planId: string;
    teacherId: string;
    schedule: Array<{ day: string; time: string }>;
    startDate: string;
    billingStartMonth: string;
    dueDay: number;
    enableProRata: boolean;
  }
  | {
    action: "requestTrialReschedule";
    opportunityId: string;
    requestedStartTime: string;
  };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ASAAS_PAYMENT_PATTERN = /^pay_[A-Za-z0-9_-]{3,120}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function requiredUuid(value: unknown, field: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!UUID_PATTERN.test(normalized)) throw new Error(`INVALID_${field}`);
  return normalized;
}

function futureInstant(value: unknown, field: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (
    normalized.length > 40 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/
      .test(
        normalized,
      )
  ) {
    throw new Error(`INVALID_${field}`);
  }
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp) || timestamp <= Date.now()) {
    throw new Error(`INVALID_${field}`);
  }
  const maximum = Date.now() + 366 * 24 * 60 * 60 * 1000;
  if (timestamp > maximum) throw new Error(`INVALID_${field}`);
  return new Date(timestamp).toISOString();
}

function lifecycleStatus(value: unknown): LifecycleStatus {
  if (
    typeof value !== "string" ||
    !LIFECYCLE_STATUSES.includes(value as LifecycleStatus)
  ) {
    throw new Error("INVALID_STATUS");
  }
  return value as LifecycleStatus;
}

function lifecycleReason(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error("INVALID_REASON");
  const normalized = value.trim();
  if (!normalized || normalized.length > 500) throw new Error("INVALID_REASON");
  return normalized;
}

function studentOffboardingBillingPolicy(
  value: unknown,
): StudentOffboardingBillingPolicy {
  if (
    typeof value !== "string" ||
    !STUDENT_OFFBOARDING_BILLING_POLICIES.includes(
      value as StudentOffboardingBillingPolicy,
    )
  ) {
    throw new Error("INVALID_BILLING_POLICY");
  }
  return value as StudentOffboardingBillingPolicy;
}

function calendarDate(value: unknown, field: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new Error(`INVALID_${field}`);
  }
  const [year, month, day] = normalized.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error(`INVALID_${field}`);
  }
  return normalized;
}

const WEEKDAY_MAP: Record<string, string> = {
  sunday: "Sunday",
  domingo: "Sunday",
  monday: "Monday",
  segunda: "Monday",
  segundafeira: "Monday",
  tuesday: "Tuesday",
  terca: "Tuesday",
  tercafeira: "Tuesday",
  wednesday: "Wednesday",
  quarta: "Wednesday",
  quartafeira: "Wednesday",
  thursday: "Thursday",
  quinta: "Thursday",
  quintafeira: "Thursday",
  friday: "Friday",
  sexta: "Friday",
  sextafeira: "Friday",
  saturday: "Saturday",
  sabado: "Saturday",
};

function folded(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z]/gi, "").toLowerCase();
}

function isoDate(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new Error("INVALID_START_DATE");
  }
  const [year, month, day] = normalized.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error("INVALID_START_DATE");
  }
  return normalized;
}

function billingMonth(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(normalized)) {
    throw new Error("INVALID_BILLING_START_MONTH");
  }
  return normalized;
}

function enrollmentDueDay(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 31) {
    throw new Error("INVALID_DUE_DAY");
  }
  return parsed;
}

function enrollmentSchedule(
  value: unknown,
): Array<{ day: string; time: string }> {
  if (!Array.isArray(value) || value.length < 1 || value.length > 7) {
    throw new Error("INVALID_SCHEDULE");
  }
  const seen = new Set<string>();
  return value.map((raw) => {
    if (!isRecord(raw) || !hasOnlyKeys(raw, ["day", "time"])) {
      throw new Error("INVALID_SCHEDULE");
    }
    const rawDay = typeof raw.day === "string" ? raw.day.trim() : "";
    const day = WEEKDAY_MAP[folded(rawDay)];
    const match = typeof raw.time === "string"
      ? raw.time.trim().match(/^(\d{1,2}):([0-5]\d)$/)
      : null;
    if (!day || !match || Number(match[1]) > 23) {
      throw new Error("INVALID_SCHEDULE");
    }
    const time = `${match[1].padStart(2, "0")}:${match[2]}`;
    const key = `${day}|${time}`;
    if (seen.has(key)) throw new Error("DUPLICATE_SCHEDULE_SLOT");
    seen.add(key);
    return { day, time };
  });
}

export function normalizeSchoolAdminAction(body: unknown): SchoolAdminAction {
  if (!isRecord(body) || typeof body.action !== "string") {
    throw new Error("INVALID_ACTION");
  }

  if (
    body.action === "setStudentLifecycle" ||
    body.action === "setTeacherLifecycle"
  ) {
    const idKey = body.action === "setStudentLifecycle"
      ? "studentId"
      : "teacherId";
    const allowed = body.action === "setStudentLifecycle"
      ? [
        "action",
        idKey,
        "status",
        "reason",
        "billingPolicy",
        "effectiveEndDate",
      ]
      : ["action", idKey, "status", "reason"];
    if (!hasOnlyKeys(body, allowed)) {
      throw new Error("UNEXPECTED_FIELD");
    }
    const status = lifecycleStatus(body.status);
    const billingPolicy = body.action === "setStudentLifecycle" &&
        status === "offboarded"
      ? studentOffboardingBillingPolicy(body.billingPolicy)
      : null;
    const effectiveEndDate = body.action === "setStudentLifecycle" &&
        status === "offboarded"
      ? calendarDate(body.effectiveEndDate, "EFFECTIVE_END_DATE")
      : null;
    if (
      body.action === "setStudentLifecycle" && status !== "offboarded" &&
      (body.billingPolicy !== undefined || body.effectiveEndDate !== undefined)
    ) {
      throw new Error("UNEXPECTED_BILLING_POLICY");
    }
    const targetId = requiredUuid(body[idKey], idKey);
    const reason = lifecycleReason(body.reason);
    if (
      body.action === "setStudentLifecycle" && status !== "active" && !reason
    ) {
      throw new Error("INVALID_REASON");
    }
    if (body.action === "setStudentLifecycle") {
      return {
        action: "setStudentLifecycle",
        targetId,
        status,
        reason,
        billingPolicy,
        effectiveEndDate,
      };
    }
    return {
      action: "setTeacherLifecycle",
      targetId,
      status,
      reason,
    };
  }

  if (body.action === "serasaNegativar") {
    if (!hasOnlyKeys(body, ["action", "paymentId"])) {
      throw new Error("UNEXPECTED_FIELD");
    }
    const paymentId = typeof body.paymentId === "string"
      ? body.paymentId.trim()
      : "";
    if (!ASAAS_PAYMENT_PATTERN.test(paymentId)) {
      throw new Error("INVALID_PAYMENT_ID");
    }
    return { action: body.action, paymentId };
  }

  if (body.action === "createEnrollmentOffer") {
    if (
      !hasOnlyKeys(body, [
        "action",
        "leadId",
        "opportunityId",
        "requestId",
        "planId",
        "teacherId",
        "schedule",
        "startDate",
        "billingStartMonth",
        "dueDay",
        "enableProRata",
      ])
    ) {
      throw new Error("UNEXPECTED_FIELD");
    }
    if (typeof body.enableProRata !== "boolean") {
      throw new Error("INVALID_PRO_RATA");
    }
    return {
      action: body.action,
      leadId: requiredUuid(body.leadId, "LEAD_ID"),
      opportunityId: requiredUuid(body.opportunityId, "OPPORTUNITY_ID"),
      requestId: requiredUuid(body.requestId, "REQUEST_ID"),
      planId: requiredUuid(body.planId, "PLAN_ID"),
      teacherId: requiredUuid(body.teacherId, "TEACHER_ID"),
      schedule: enrollmentSchedule(body.schedule),
      startDate: isoDate(body.startDate),
      billingStartMonth: billingMonth(body.billingStartMonth),
      dueDay: enrollmentDueDay(body.dueDay),
      enableProRata: body.enableProRata,
    };
  }

  if (body.action === "requestTrialReschedule") {
    if (
      !hasOnlyKeys(body, [
        "action",
        "opportunityId",
        "requestedStartTime",
      ])
    ) {
      throw new Error("UNEXPECTED_FIELD");
    }
    return {
      action: body.action,
      opportunityId: requiredUuid(body.opportunityId, "OPPORTUNITY_ID"),
      requestedStartTime: futureInstant(
        body.requestedStartTime,
        "REQUESTED_START_TIME",
      ),
    };
  }

  throw new Error("INVALID_ACTION");
}

export function isEligibleForDunning(
  status: unknown,
  dueDate: unknown,
  today: string,
): boolean {
  return status === "OVERDUE" &&
    typeof dueDate === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(dueDate) &&
    dueDate < today;
}

export function normalizeEnrollmentPlan(plan: Record<string, unknown>): {
  value: number;
  planDuration: number;
  classesPerWeek: number;
} {
  const value = Number(plan.monthly_price);
  const planDuration = Number(plan.fidelity_months);
  const classesPerWeek = Number(plan.classes_per_week);
  if (!Number.isFinite(value) || value <= 0) throw new Error("INVALID_PLAN");
  if (![0, 1, 6, 12].includes(planDuration)) throw new Error("INVALID_PLAN");
  if (
    !Number.isInteger(classesPerWeek) || classesPerWeek < 1 ||
    classesPerWeek > 7
  ) {
    throw new Error("INVALID_PLAN");
  }
  return { value, planDuration, classesPerWeek };
}
