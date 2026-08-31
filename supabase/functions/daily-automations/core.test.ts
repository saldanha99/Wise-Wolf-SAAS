import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  buildDailyAutomationQueueRow,
  dailyAutomationIdempotencyKey,
  dateInSaoPaulo,
  isQueueDuplicateError,
} from "./core.ts";

Deno.test("daily automation uses the civil date in Sao Paulo", () => {
  assertEquals(
    dateInSaoPaulo(new Date("2026-09-01T01:30:00.000Z")),
    "2026-08-31",
  );
});

Deno.test("daily queue identity is stable per kind, date and subject", () => {
  assertEquals(
    dailyAutomationIdempotencyKey(
      " teacher_agenda ",
      "00000000-0000-4000-8000-000000000001",
      "2026-08-31",
    ),
    "daily:TEACHER_AGENDA:2026-08-31:00000000-0000-4000-8000-000000000001",
  );
});

Deno.test("daily automation is persisted as a durable queue item", () => {
  const row = buildDailyAutomationQueueRow({
    tenantId: "school-wise-wolf",
    subjectId: "00000000-0000-4000-8000-000000000001",
    kind: "teacher_agenda",
    destination: "5511999999999",
    message: "Agenda do dia",
    refDate: "2026-08-31",
    scheduledAt: "2026-08-31T11:00:00.000Z",
    teacherId: "00000000-0000-4000-8000-000000000001",
  });

  assertEquals(row.status, "pending");
  assertEquals(row.delivery_status, "queued");
  assertEquals(row.notification_kind, "TEACHER_AGENDA");
  assertEquals(row.teacher_id, row.source_id);
  assertEquals(row.student_id, null);
  assertEquals(row.max_attempts, 5);
  assertEquals(
    row.idempotency_key,
    "daily:TEACHER_AGENDA:2026-08-31:00000000-0000-4000-8000-000000000001",
  );
});

Deno.test("only a unique violation is classified as an existing queue item", () => {
  assertEquals(isQueueDuplicateError({ code: "23505" }), true);
  assertEquals(isQueueDuplicateError({ code: "42501" }), false);
  assertEquals(isQueueDuplicateError(null), false);
});
