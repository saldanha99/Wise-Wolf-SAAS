export type EnrollmentOfferAccessRow = {
  processing_state?: unknown;
  processing_by?: unknown;
  consumed_by?: unknown;
  consumed_at?: unknown;
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
