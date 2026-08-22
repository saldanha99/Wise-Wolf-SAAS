export const LIFECYCLE_STATUSES = [
  "active",
  "suspended",
  "offboarded",
] as const;

export type LifecycleStatus = typeof LIFECYCLE_STATUSES[number];

export type SchoolAdminAction =
  | {
    action: "setStudentLifecycle";
    targetId: string;
    status: LifecycleStatus;
    reason: string | null;
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
    planId: string;
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
    if (!hasOnlyKeys(body, ["action", idKey, "status", "reason"])) {
      throw new Error("UNEXPECTED_FIELD");
    }
    return {
      action: body.action,
      targetId: requiredUuid(body[idKey], idKey),
      status: lifecycleStatus(body.status),
      reason: lifecycleReason(body.reason),
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
    if (!hasOnlyKeys(body, ["action", "leadId", "planId"])) {
      throw new Error("UNEXPECTED_FIELD");
    }
    return {
      action: body.action,
      leadId: requiredUuid(body.leadId, "LEAD_ID"),
      planId: requiredUuid(body.planId, "PLAN_ID"),
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
