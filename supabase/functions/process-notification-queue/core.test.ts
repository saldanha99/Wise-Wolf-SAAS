/// <reference lib="deno.ns" />
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isStudentLifecycleNotificationKind,
  isTrialLifecycleNotificationKind,
  lessonReminderFreshness,
  normalizeNotificationKind,
  normalizeQueueDestination,
  notificationRetryDelaySeconds,
  providerMessageId,
  queueAudience,
  queueDeliveryDecision,
  renderConflictTeacherAlert,
  renderStudentLifecycleNotification,
  studentLifecycleNotificationDescriptor,
} from "./core.ts";

Deno.test("tipo da notificacao e canonico independentemente de casing", () => {
  assertEquals(
    normalizeNotificationKind(" payment_confirmed "),
    "PAYMENT_CONFIRMED",
  );
  assertEquals(normalizeNotificationKind("lesson_reminder"), "LESSON_REMINDER");
  assertEquals(queueAudience(" conflict_teacher_alert "), {
    audience: "teacher",
    centralOnly: true,
  });
});

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

Deno.test("notificações do funil experimental usam a rota e classificação corretas", () => {
  assertEquals(
    isTrialLifecycleNotificationKind("trial_teacher_requested"),
    true,
  );
  assertEquals(
    isTrialLifecycleNotificationKind("TRIAL_MANAGEMENT_ACCEPTED"),
    true,
  );
  assertEquals(isTrialLifecycleNotificationKind("LESSON_REMINDER"), false);
  assertEquals(queueAudience("TRIAL_TEACHER_REQUESTED"), {
    audience: "teacher",
    centralOnly: true,
  });
  assertEquals(queueAudience("TRIAL_MANAGEMENT_ACCEPTED"), {
    audience: "teacher",
    centralOnly: true,
  });
});

Deno.test("avisos de ciclo de vida distinguem aluno, professor e destino", () => {
  assertEquals(studentLifecycleNotificationDescriptor("student_suspended"), {
    audience: "student",
    targetStatus: "suspended",
  });
  assertEquals(
    studentLifecycleNotificationDescriptor("TEACHER_STUDENT_OFFBOARDED"),
    { audience: "teacher", targetStatus: "offboarded" },
  );
  assertEquals(isStudentLifecycleNotificationKind("STUDENT_OFFBOARDED"), true);
  assertEquals(isStudentLifecycleNotificationKind("LESSON_REMINDER"), false);
  assertEquals(queueAudience("TEACHER_STUDENT_SUSPENDED"), {
    audience: "teacher",
    centralOnly: true,
  });
  assertEquals(queueAudience("STUDENT_SUSPENDED"), {
    audience: "student",
    centralOnly: false,
  });
});

Deno.test("avisos de ciclo de vida são acolhedores e não expõem motivo interno", () => {
  assertEquals(
    renderStudentLifecycleNotification({
      kind: "STUDENT_SUSPENDED",
      studentName: "Rafael Marquini",
      tenantName: "Wise Wolf Languages",
      effectiveEndDate: "2026-08-31",
    }),
    "Oi, Rafael! Passando para confirmar que sua jornada com a Wise Wolf Languages ficará em pausa a partir de 31/08/2026. Seus horários fixos foram liberados por enquanto. Quando for o momento de retomar, nossa equipe estará pronta para organizar uma nova agenda com carinho. Se precisar, conte com a gente.",
  );
  assertEquals(
    renderStudentLifecycleNotification({
      kind: "TEACHER_STUDENT_OFFBOARDED",
      studentName: "Rafael Marquini",
      teacherName: "Débora Alves",
      tenantName: "Wise Wolf Languages",
      effectiveEndDate: "2026-08-31",
    }),
    "Oi, Débora! Atualização da coordenação: a matrícula de Rafael Marquini foi encerrada a partir de 31/08/2026, e os horários fixos já foram liberados na sua agenda. Obrigado por todo o acompanhamento. Se precisar de algum ajuste, fale com a coordenação.",
  );
});

Deno.test("automações internas e de professor nunca usam WhatsApp pessoal", () => {
  for (
    const kind of [
      "TEACHER_AGENDA",
      "TEACHER_BIRTHDAY",
      "SCHOOL_AI_BRIEFING",
      "CRON_ALERT",
      "ASAAS_HEALTH",
      "INTERVIEW_BOOKED_CANDIDATE",
      "INTERVIEW_BOOKED_MANAGEMENT",
      "INTERVIEW_REMINDER_CANDIDATE",
      "INTERVIEW_REMINDER_MANAGEMENT",
    ]
  ) {
    assertEquals(queueAudience(kind), {
      audience: "teacher",
      centralOnly: true,
    });
  }
  assertEquals(queueAudience("BIRTHDAY"), {
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
      status: "uncertain",
      reason: "provider_accepted_without_message_id",
      releaseOccurrenceReceipt: false,
    },
  );
});

Deno.test("timeout, rede, 429 e 5xx ficam incertos e preservam receipt", () => {
  for (
    const result of [
      { outcome: "ambiguous" as const, messageId: null, httpStatus: null },
      { outcome: "ambiguous" as const, messageId: null, httpStatus: 429 },
      { outcome: "ambiguous" as const, messageId: null, httpStatus: 503 },
    ]
  ) {
    const decision = queueDeliveryDecision(result);
    assertEquals(decision.status, "uncertain");
    assertEquals(decision.releaseOccurrenceReceipt, false);
  }
});

Deno.test("retry pré-envio usa backoff crescente e determinístico", () => {
  const first = notificationRetryDelaySeconds(1, "queue-a");
  const second = notificationRetryDelaySeconds(2, "queue-a");
  const capped = notificationRetryDelaySeconds(20, "queue-a");
  assertEquals(first >= 30 && first <= 36, true);
  assertEquals(second >= 60 && second <= 72, true);
  assertEquals(second > first, true);
  assertEquals(capped >= 900 && capped <= 1080, true);
  assertEquals(
    notificationRetryDelaySeconds(2, "queue-a"),
    second,
  );
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
