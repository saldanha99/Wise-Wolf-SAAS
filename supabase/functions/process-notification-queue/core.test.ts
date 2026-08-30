/// <reference lib="deno.ns" />
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  lessonReminderFreshness,
  normalizeQueueDestination,
  providerMessageId,
  queueAudience,
  queueDeliveryDecision,
  renderConflictTeacherAlert,
} from "./core.ts";

Deno.test("CONFLICT_TEACHER_ALERT usa audiência professor e somente central", () => {
  assertEquals(queueAudience("CONFLICT_TEACHER_ALERT"), {
    audience: "teacher",
    centralOnly: true,
  });
  assertEquals(queueAudience("LESSON_REMINDER"), {
    audience: "student",
    centralOnly: false,
  });
});

Deno.test("somente 2xx com messageId comprova envio", () => {
  assertEquals(
    queueDeliveryDecision({
      outcome: "accepted",
      messageId: "msg-1",
      httpStatus: 200,
    }).status,
    "sent",
  );
  assertEquals(
    queueDeliveryDecision({
      outcome: "accepted",
      messageId: null,
      httpStatus: 200,
    }),
    {
      status: "failed",
      reason: "provider_accepted_without_message_id",
      releaseOccurrenceReceipt: false,
    },
  );
});

Deno.test("timeout, rede, 429 e 5xx são terminais e preservam receipt", () => {
  for (
    const result of [
      { outcome: "ambiguous" as const, messageId: null, httpStatus: null },
      { outcome: "ambiguous" as const, messageId: null, httpStatus: 429 },
      { outcome: "ambiguous" as const, messageId: null, httpStatus: 503 },
    ]
  ) {
    const decision = queueDeliveryDecision(result);
    assertEquals(decision.status, "failed");
    assertEquals(decision.releaseOccurrenceReceipt, false);
  }
});

Deno.test("destino aceita telefone BR e JID de grupo estrito", () => {
  assertEquals(normalizeQueueDestination("(11) 98888-7777"), "5511988887777");
  assertEquals(
    normalizeQueueDestination("120363123456789@g.us"),
    "120363123456789@g.us",
  );
  assertEquals(normalizeQueueDestination("123"), null);
});

Deno.test("confirmação financeira exige o id aceito pela Evolution", () => {
  assertEquals(providerMessageId({ key: { id: "msg-key" } }), "msg-key");
  assertEquals(providerMessageId({ id: "msg-root" }), "msg-root");
  assertEquals(providerMessageId({ key: {} }), null);
  assertEquals(providerMessageId([]), null);
});

Deno.test("lembrete só sai fresco e antes da aula", () => {
  const now = new Date("2026-08-28T15:00:00.000Z");
  assertEquals(
    lessonReminderFreshness({
      now,
      scheduledFor: "2026-08-28T14:59:30.000Z",
      startAt: "2026-08-28T15:30:00.000Z",
    }),
    { ok: true },
  );
  assertEquals(
    lessonReminderFreshness({
      now,
      scheduledFor: "2026-08-28T14:40:00.000Z",
      startAt: "2026-08-28T15:20:00.000Z",
    }),
    { ok: false, reason: "lesson_reminder_stale_queue" },
  );
  assertEquals(
    lessonReminderFreshness({
      now,
      scheduledFor: "2026-08-28T14:59:30.000Z",
      startAt: "2026-08-28T14:59:59.000Z",
    }),
    { ok: false, reason: "lesson_reminder_too_late" },
  );
  assertEquals(
    lessonReminderFreshness({
      now,
      scheduledFor: "2026-08-28T14:59:30.000Z",
      startAt: "2026-08-28T16:00:00.000Z",
    }),
    { ok: false, reason: "lesson_reminder_outside_send_window" },
  );
});

Deno.test("alerta de conflito é reconstruído com dados atuais", () => {
  assertEquals(
    renderConflictTeacherAlert({
      teacherName: "Ana Silva",
      studentName: "Bruno Souza",
      classDate: "2026-08-28",
      classTime: "19:30:00",
    }),
    "Oi, Ana! Aqui é da coordenação da escola.\n\n" +
      "Recebemos uma divergência sobre a aula de 28/08 às 19:30 com Bruno Souza.\n" +
      "Pode nos contar como foi essa aula? Enquanto analisamos, somente esta aula fica em revisão.",
  );
});
