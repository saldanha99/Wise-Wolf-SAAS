/// <reference lib="deno.ns" />
import {
  assertEquals,
  assertNotEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  canonicalScheduleVersion,
  classReminderReceiptFromQueue,
  dateInSaoPaulo,
  manualReminderReceipt,
  manualReminderWindow,
  parseManualReminderIdentity,
  phonesBelongToSameRecipient,
  providerReceiptDecision,
  recurringBookingMatchesDate,
  rescheduleNotificationReceipt,
  scheduleVersionHash,
  timeInSaoPaulo,
} from "./core.ts";

const identity = parseManualReminderIdentity({
  source_id: "123e4567-e89b-42d3-a456-426614174000",
  source_type: "booking",
  class_date: "2026-08-28",
})!;

Deno.test("receipt canônico independe do caller e isola tenant/ocorrência", () => {
  const first = manualReminderReceipt("tenant-a", identity);
  const replay = manualReminderReceipt("tenant-a", identity);
  const otherTenant = manualReminderReceipt("tenant-b", identity);
  assertEquals(first, replay);
  assertNotEquals(first.subject_id, otherTenant.subject_id);
  assertEquals(first.kind, "CLASS_REMINDER");
  assertEquals(first.ref_date, "2026-08-28");
});

Deno.test("fila AUTO produz a mesma barreira canônica do MANUAL", () => {
  assertEquals(
    classReminderReceiptFromQueue({
      tenant_id: "tenant-a",
      source_id: identity.sourceId,
      source_type: "booking",
      class_date: identity.classDate,
    }),
    manualReminderReceipt("tenant-a", identity),
  );
  assertEquals(
    classReminderReceiptFromQueue({
      tenant_id: "tenant-a",
      source_id: "não-é-uuid",
      source_type: "booking",
      class_date: identity.classDate,
    }),
    null,
  );
});

Deno.test("reposição usa revisão monotônica inclusive ao reverter horário", () => {
  const rescheduleIdentity = {
    ...identity,
    sourceType: "RESCHEDULE" as const,
  };
  const first = rescheduleNotificationReceipt(
    "tenant-a",
    rescheduleIdentity,
    1,
  );
  const replay = rescheduleNotificationReceipt(
    "tenant-a",
    rescheduleIdentity,
    1,
  );
  const changedTime = rescheduleNotificationReceipt(
    "tenant-a",
    rescheduleIdentity,
    2,
  );
  const revertedTime = rescheduleNotificationReceipt(
    "tenant-a",
    rescheduleIdentity,
    3,
  );

  assertEquals(first, replay);
  assertNotEquals(first.subject_id, changedTime.subject_id);
  assertNotEquals(first.subject_id, revertedTime.subject_id);
  assertNotEquals(changedTime.subject_id, revertedTime.subject_id);
  assertEquals(first.ref_date, revertedTime.ref_date);
});

Deno.test("identidade manual exige UUID, tipo conhecido e data real", () => {
  assertEquals(
    parseManualReminderIdentity({
      source_id: "qualquer",
      source_type: "booking",
      class_date: "2026-02-30",
    }),
    null,
  );
  assertEquals(identity.sourceType, "BOOKING");
});

Deno.test("destino canônico aceita formatação e variante BR do nono dígito", () => {
  assertEquals(
    phonesBelongToSameRecipient("(11) 98888-7777", "5511988887777"),
    true,
  );
  assertEquals(
    phonesBelongToSameRecipient("551188887777", "5511988887777"),
    true,
  );
  assertEquals(
    phonesBelongToSameRecipient("5511988887777", "5511988880000"),
    false,
  );
});

Deno.test("somente rejeição conhecida libera receipt", () => {
  assertEquals(
    providerReceiptDecision({
      outcome: "accepted",
      messageId: null,
      httpStatus: 200,
    }),
    { releaseReceipt: false, delivery: "ambiguous" },
  );
  assertEquals(
    providerReceiptDecision({
      outcome: "accepted",
      messageId: "provider-123",
      httpStatus: 200,
    }),
    { releaseReceipt: false, delivery: "accepted" },
  );
  assertEquals(
    providerReceiptDecision({
      outcome: "rejected",
      messageId: null,
      httpStatus: 400,
    }).releaseReceipt,
    true,
  );
  assertEquals(
    providerReceiptDecision({
      outcome: "ambiguous",
      messageId: null,
      httpStatus: 429,
    }).releaseReceipt,
    false,
  );
  assertEquals(
    providerReceiptDecision({
      outcome: "ambiguous",
      messageId: null,
      httpStatus: 503,
    }).releaseReceipt,
    false,
  );
});

Deno.test("booking recorrente valida o dia civil sem conversão de fuso", () => {
  assertEquals(recurringBookingMatchesDate("Sexta", "2026-08-28"), true);
  assertEquals(recurringBookingMatchesDate("Quinta", "2026-08-28"), false);
});

Deno.test("versão da grade ignora IDs/ordem e muda só com dia ou horário", async () => {
  const original = canonicalScheduleVersion([
    { day_of_week: "Terça-feira", time_slot: "19:00:00" },
    { day_of_week: "segunda", time_slot: "08:30" },
  ]);
  const sameSchedule = canonicalScheduleVersion([
    { day_of_week: "Monday", time_slot: "08:30" },
    { day_of_week: "TERCA", time_slot: "19:00" },
    { day_of_week: "segunda-feira", time_slot: "08:30" },
  ]);
  const changedSchedule = canonicalScheduleVersion([
    { day_of_week: "segunda", time_slot: "09:00" },
    { day_of_week: "terça", time_slot: "19:00" },
  ]);

  assertEquals(original, sameSchedule);
  assertNotEquals(original, changedSchedule);
  assertEquals(
    await scheduleVersionHash(original),
    await scheduleVersionHash(sameSchedule),
  );
  assertNotEquals(
    await scheduleVersionHash(original),
    await scheduleVersionHash(changedSchedule),
  );
});

Deno.test("lembrete manual só é aceito entre 15 e 45 minutos antes", () => {
  const now = new Date("2026-08-28T15:00:00.000Z");
  assertEquals(
    manualReminderWindow({ now, startAt: "2026-08-28T15:30:00.000Z" }),
    { ok: true },
  );
  assertEquals(
    manualReminderWindow({ now, startAt: "2026-08-28T15:14:59.000Z" }),
    { ok: false, reason: "manual_reminder_too_late" },
  );
  assertEquals(
    manualReminderWindow({ now, startAt: "2026-08-28T15:45:01.000Z" }),
    { ok: false, reason: "manual_reminder_too_early" },
  );
});

Deno.test("appointment usa data e hora civis de São Paulo, não UTC", () => {
  assertEquals(dateInSaoPaulo("2026-08-29T01:00:00.000Z"), "2026-08-28");
  assertEquals(timeInSaoPaulo("2026-08-28T22:00:00.000Z"), "19:00");
});
