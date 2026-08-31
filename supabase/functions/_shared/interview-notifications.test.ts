/// <reference lib="deno.ns" />
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildInterviewBookedMessages,
  buildInterviewReminderMessages,
  interviewNotificationKind,
  normalizeInterviewPhone,
  parseInterviewQueueOutcome,
} from "./interview-notifications.ts";

Deno.test("notificações de entrevista têm kinds independentes por audiência", () => {
  assertEquals(
    interviewNotificationKind("BOOKED", "CANDIDATE"),
    "INTERVIEW_BOOKED_CANDIDATE",
  );
  assertEquals(
    interviewNotificationKind("BOOKED", "MANAGEMENT"),
    "INTERVIEW_BOOKED_MANAGEMENT",
  );
  assertEquals(
    interviewNotificationKind("REMINDER", "CANDIDATE"),
    "INTERVIEW_REMINDER_CANDIDATE",
  );
  assertEquals(
    interviewNotificationKind("REMINDER", "MANAGEMENT"),
    "INTERVIEW_REMINDER_MANAGEMENT",
  );
});

Deno.test("mensagens de confirmação preservam horário, marca e score", () => {
  const messages = buildInterviewBookedMessages({
    candidateName: "Ana Maria",
    candidatePhone: "(11) 98888-7777",
    brandName: "Wise Wolf",
    date: "02/09/2026",
    dayOfWeek: "quarta-feira",
    time: "18:30",
    aiScore: 91,
  });
  assertStringIncludes(messages.candidate, "Ana");
  assertStringIncludes(messages.candidate, "Wise Wolf");
  assertStringIncludes(messages.candidate, "02/09/2026");
  assertStringIncludes(messages.management, "5511988887777");
  assertStringIncludes(messages.management, "Score da triagem: 91");
});

Deno.test("mensagens de lembrete são separadas para candidato e gestão", () => {
  const messages = buildInterviewReminderMessages({
    candidateName: "Bruno Souza",
    candidatePhone: "11977776666",
    brandName: "Wise Wolf",
    time: "19:00",
  });
  assertStringIncludes(messages.candidate, "Bruno");
  assertStringIncludes(messages.candidate, "19:00");
  assertStringIncludes(messages.management, "Bruno Souza");
  assertStringIncludes(messages.management, "5511977776666");
});

Deno.test("resultado idempotente da fila distingue novo item de duplicata", () => {
  assertEquals(parseInterviewQueueOutcome({ ok: true, queued: true }), {
    ok: true,
    queued: true,
    duplicate: false,
    reason: null,
  });
  assertEquals(
    parseInterviewQueueOutcome({
      ok: true,
      queued: false,
      duplicate: true,
      reason: "already_queued",
    }),
    {
      ok: true,
      queued: false,
      duplicate: true,
      reason: "already_queued",
    },
  );
  assertEquals(parseInterviewQueueOutcome(null), {
    ok: false,
    queued: false,
    duplicate: false,
    reason: "invalid_result",
  });
});

Deno.test("telefone de entrevista é normalizado sem aceitar texto", () => {
  assertEquals(normalizeInterviewPhone("(11) 98888-7777"), "5511988887777");
  assertEquals(normalizeInterviewPhone("+55 11 98888-7777"), "5511988887777");
  assertEquals(normalizeInterviewPhone("sem telefone"), "");
});
