/// <reference lib="deno.ns" />
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isStudentLifecycleNotificationKind,
  isTrialLifecycleNotificationKind,
  LESSON_RECORDING_CONSENT_KIND,
  lessonRecordingConsentDelivery,
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

Deno.test("aceite familiar usa exclusivamente a central e audiência aluno", () => {
  assertEquals(queueAudience("SCHEDULE_CHANGE_FAMILY_ACCEPTANCE"), {
    audience: "student",
    centralOnly: true,
  });
  assertEquals(queueAudience("TEACHER_CHANGE_GROUP"), {
    audience: "teacher",
    centralOnly: true,
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

Deno.test("avisos de matrícula fechada saem exclusivamente pela central", () => {
  assertEquals(queueAudience("ENROLLMENT_STUDENT_CONFIRMED"), {
    audience: "student",
    centralOnly: false,
  });
  for (
    const kind of [
      "ENROLLMENT_MANAGEMENT_CLOSED",
      "ENROLLMENT_TEACHER_CLOSED",
    ]
  ) {
    assertEquals(queueAudience(kind), {
      audience: "teacher",
      centralOnly: true,
    });
  }
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

Deno.test("fila: vetado pelo teto volta para pending, nunca failed", () => {
  const d = queueDeliveryDecision({
    outcome: "rejected",
    messageId: null,
    httpStatus: 429,
    throttled: true,
    retryAfterMs: 60_000,
    throttleKind: "outreach",
  });
  assertEquals(d.status, "pending");
  assertEquals(d.reason, "throttled_outreach");
  assertEquals(d.releaseOccurrenceReceipt, true);
});

Deno.test("pedido do termo de registro sai só pela central, com audiência aluno", () => {
  assertEquals(queueAudience(LESSON_RECORDING_CONSENT_KIND), {
    audience: "student",
    centralOnly: true,
  });
  assertEquals(queueAudience(" lesson_recording_consent_request "), {
    audience: "student",
    centralOnly: true,
  });
});

Deno.test("revalidação do termo autoriza só destino de pessoa com o link do termo no portal da escola", () => {
  const token = "a".repeat(64);
  const portal = "https://system.wisewolflanguage.com.br";
  const message =
    `Olá, Ana! Aqui é da Escola.\n\nTermo completo e resposta (leva 1 minuto): ${portal}/registro-das-aulas?token=${token}`;
  assertEquals(
    lessonRecordingConsentDelivery({
      ok: true,
      destination: "11 98888-0001",
      message,
      portal,
    }),
    { ok: true, destination: "5511988880001", message },
  );
  // Escola com domínio próprio verificado: o link é o do portal dela.
  const customPortal = "https://escola.exemplo.com.br";
  const customMessage = message.replace(portal, customPortal);
  assertEquals(
    lessonRecordingConsentDelivery({
      ok: true,
      destination: "5511988880001",
      message: customMessage,
      portal: customPortal,
    }).ok,
    true,
  );
  // Grupo nunca recebe o termo de um aluno.
  assertEquals(
    lessonRecordingConsentDelivery({
      ok: true,
      destination: "120363000000000000@g.us",
      message,
      portal,
    }).ok,
    false,
  );
  // Link de outro domínio que o portal da escola não sai.
  assertEquals(
    lessonRecordingConsentDelivery({
      ok: true,
      destination: "5511988880001",
      message: message.replace(portal, "https://exemplo.invalid"),
      portal,
    }),
    {
      ok: false,
      retryable: false,
      reason: "lesson_recording_consent_payload_invalid",
    },
  );
  // Sem portal (ou portal que não é https://host) não sai.
  for (
    const badPortal of [
      undefined,
      "",
      "http://system.wisewolflanguage.com.br",
      "https://x.com/caminho",
    ]
  ) {
    assertEquals(
      lessonRecordingConsentDelivery({
        ok: true,
        destination: "5511988880001",
        message,
        portal: badPortal,
      }).ok,
      false,
    );
  }
  // Token com um caractere a mais não é o link do termo.
  assertEquals(
    lessonRecordingConsentDelivery({
      ok: true,
      destination: "5511988880001",
      message: `${message}0`,
      portal,
    }).ok,
    false,
  );
});

Deno.test("revalidação do termo recusada cancela sem nova tentativa", () => {
  assertEquals(
    lessonRecordingConsentDelivery({ ok: false, reason: "aluno_ja_decidiu" }),
    { ok: false, retryable: false, reason: "aluno_ja_decidiu" },
  );
  assertEquals(
    lessonRecordingConsentDelivery({ ok: false }),
    {
      ok: false,
      retryable: false,
      reason: "lesson_recording_consent_no_longer_valid",
    },
  );
  // Pedido parado dias na fila é cancelado, não adiado.
  assertEquals(
    lessonRecordingConsentDelivery({ ok: false, reason: "pedido_vencido" }),
    { ok: false, retryable: false, reason: "pedido_vencido" },
  );
  // Resposta ilegível do banco é indisponibilidade: tenta de novo depois.
  assertEquals(lessonRecordingConsentDelivery(null), {
    ok: false,
    retryable: true,
    reason: "lesson_recording_consent_snapshot_unavailable",
  });
});

Deno.test("fora da janela ou do ritmo o termo é adiado, sem gastar tentativa", () => {
  // Sábado 21h -> segunda 9h: o adiamento de uma vez vai até 1 h (teto do
  // defer_notification_delivery); o banco manda adiar de novo na próxima.
  assertEquals(
    lessonRecordingConsentDelivery({
      ok: false,
      retryable: true,
      reason: "fora_da_janela_de_envio",
      defer_seconds: 36 * 3600,
    }),
    {
      ok: false,
      retryable: true,
      reason: "fora_da_janela_de_envio",
      deferSeconds: 3600,
    },
  );
  assertEquals(
    lessonRecordingConsentDelivery({
      ok: false,
      retryable: true,
      reason: "ritmo_do_termo",
      defer_seconds: 89.2,
    }),
    { ok: false, retryable: true, reason: "ritmo_do_termo", deferSeconds: 90 },
  );
  // Adiamento sem número válido vira nova tentativa comum, não envio.
  for (const bad of [0, -5, "x", null]) {
    assertEquals(
      lessonRecordingConsentDelivery({
        ok: false,
        retryable: true,
        reason: "ritmo_do_termo",
        defer_seconds: bad,
      }),
      { ok: false, retryable: true, reason: "ritmo_do_termo" },
    );
  }
  // Recusa definitiva nunca vira adiamento, mesmo com número.
  assertEquals(
    lessonRecordingConsentDelivery({
      ok: false,
      reason: "contato_mudou",
      defer_seconds: 60,
    }),
    { ok: false, retryable: false, reason: "contato_mudou" },
  );
});
