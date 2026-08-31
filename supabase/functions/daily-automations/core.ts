export type DailyAutomationQueueInput = {
  tenantId: string;
  subjectId: string;
  kind: string;
  destination: string;
  message: string;
  refDate: string;
  scheduledAt: string;
  teacherId?: string | null;
  studentId?: string | null;
  studentName?: string | null;
};

export function dateInSaoPaulo(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${value.year}-${value.month}-${value.day}`;
}

export function dailyAutomationIdempotencyKey(
  kind: string,
  subjectId: string,
  refDate: string,
): string {
  return `daily:${kind.trim().toUpperCase()}:${refDate}:${subjectId.trim()}`;
}

export function buildDailyAutomationQueueRow(
  input: DailyAutomationQueueInput,
) {
  const kind = input.kind.trim().toUpperCase();
  return {
    tenant_id: input.tenantId,
    teacher_id: input.teacherId || null,
    student_id: input.studentId || null,
    student_name: input.studentName || null,
    student_phone: input.destination,
    message_body: input.message,
    scheduled_for: input.scheduledAt,
    next_attempt_at: input.scheduledAt,
    status: "pending",
    attempts: 0,
    max_attempts: 5,
    delivery_status: "queued",
    notification_kind: kind,
    source_id: input.subjectId,
    source_type: "DAILY_AUTOMATION",
    class_date: input.refDate,
    idempotency_key: dailyAutomationIdempotencyKey(
      kind,
      input.subjectId,
      input.refDate,
    ),
  };
}

export function isQueueDuplicateError(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" &&
      "code" in error && String((error as { code?: unknown }).code) === "23505",
  );
}
