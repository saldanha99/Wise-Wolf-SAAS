export type EnrollmentOfferAccessRow = {
  processing_state?: unknown;
  processing_by?: unknown;
  consumed_by?: unknown;
  consumed_at?: unknown;
};

export type BillingStatus = "OK" | "OVERDUE" | "SUSPENDED";

export type OpenStudentPaymentRow = {
  due_date?: unknown;
  status?: unknown;
};

export type StudentBillingDecision = {
  status: BillingStatus;
  oldestDue: string | null;
  businessDaysLate: number;
};

export type StudentAccess =
  | {
    status: "ACTIVE";
    enrollmentState: "COMPLETED" | null;
  }
  | {
    status: "PENDING_ACTIVATION";
    enrollmentState: string;
  };

const text = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const DAY_MS = 86_400_000;

const calendarDayUtc = (value: unknown): number => {
  const normalized = text(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);
  if (!match) throw new RangeError("invalid_calendar_date");

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new RangeError("invalid_calendar_date");
  }
  return timestamp;
};

/**
 * Counts Monday-Friday dates in the interval (dueDate, asOfDate]. The due date
 * itself is never part of the contractual tolerance. Calendar dates are parsed
 * as UTC only to avoid DST/time-zone shifts; no instant conversion is involved.
 */
export function businessDaysAfter(
  dueDate: string,
  asOfDate: string,
): number {
  const dueTimestamp = calendarDayUtc(dueDate);
  const asOfTimestamp = calendarDayUtc(asOfDate);
  if (asOfTimestamp <= dueTimestamp) return 0;

  let businessDays = 0;
  for (
    let cursor = dueTimestamp + DAY_MS;
    cursor <= asOfTimestamp;
    cursor += DAY_MS
  ) {
    const weekday = new Date(cursor).getUTCDay();
    if (weekday !== 0 && weekday !== 6) businessDays += 1;
  }
  return businessDays;
}

/**
 * Resolves the financial access status from open, past-due payments. Access is
 * suspended only after the seventh weekday following the oldest due date.
 */
export function resolveStudentBilling(
  payments: OpenStudentPaymentRow[],
  asOfDate: string,
  toleranceBusinessDays = 7,
): StudentBillingDecision {
  if (
    !Number.isInteger(toleranceBusinessDays) ||
    toleranceBusinessDays < 0
  ) {
    throw new RangeError("invalid_business_day_tolerance");
  }
  const asOfTimestamp = calendarDayUtc(asOfDate);
  const openPastDueDates = payments
    .filter((payment) =>
      ["PENDING", "OVERDUE"].includes(text(payment.status).toUpperCase())
    )
    .map((payment) => text(payment.due_date))
    .filter((dueDate) => calendarDayUtc(dueDate) < asOfTimestamp)
    .sort();

  const oldestDue = openPastDueDates[0] ?? null;
  if (!oldestDue) {
    return { status: "OK", oldestDue: null, businessDaysLate: 0 };
  }

  const businessDaysLate = businessDaysAfter(oldestDue, asOfDate);
  return {
    status: businessDaysLate > toleranceBusinessDays ? "SUSPENDED" : "OVERDUE",
    oldestDue,
    businessDaysLate,
  };
}

/**
 * Enrollment completion is authoritative only when the offer was consumed by
 * this student. No matching offer is deliberately treated as a legacy/manual
 * account so this gate does not invent an activation rule for those flows.
 */
export function resolveStudentAccess(
  offers: EnrollmentOfferAccessRow[],
  studentId: string,
): StudentAccess {
  const normalizedStudentId = text(studentId);
  const completed = offers.some((offer) =>
    text(offer.consumed_by) === normalizedStudentId &&
    Boolean(text(offer.consumed_at)) &&
    text(offer.processing_state).toUpperCase() === "COMPLETED"
  );
  if (completed) {
    return { status: "ACTIVE", enrollmentState: "COMPLETED" };
  }

  const unfinished = offers.find((offer) =>
    text(offer.processing_by) === normalizedStudentId ||
    text(offer.consumed_by) === normalizedStudentId
  );
  if (unfinished) {
    return {
      status: "PENDING_ACTIVATION",
      enrollmentState: text(unfinished.processing_state).toUpperCase() ||
        "UNKNOWN",
    };
  }

  return { status: "ACTIVE", enrollmentState: null };
}
