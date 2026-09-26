/// <reference lib="deno.ns" />
import {
  assertEquals,
  assertNotEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  canonicalLessonReminder,
  canonicalScheduleVersion,
  classReminderReceiptFromQueue,
  dateInSaoPaulo,
  type LessonReminderRpc,
  loadOfficialLessonLink,
  manualReminderReceipt,
  manualReminderWindow,
  OFFICIAL_ROOM_NOTICE,
  officialMeetLink,
  parseManualReminderIdentity,
  phonesBelongToSameRecipient,
  providerReceiptDecision,
  recurringBookingMatchesDate,
  renderLessonReminderMessage,
  renderReminderTemplate,
  rescheduleNotificationReceipt,
  rescheduleScheduledMessage,
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

Deno.test("marcador escrito com espaço ou maiúscula também é substituído", () => {
  const mensagem = renderReminderTemplate(
    "Oi {student name}, às *{Class-Time}*.\n\n{class link}\n\nTe espero!",
    { student_name: "Ana", class_time: "19:00", class_link: "" },
  );
  assertEquals(mensagem, "Oi Ana, às *19:00*.\n\nTe espero!");
});

Deno.test("marcador desconhecido nunca chega ao aluno", () => {
  const mensagem = renderReminderTemplate(
    "Oi {aluno}, sua aula é às {class_time}. {assinatura}",
    { student_name: "Ana", class_time: "19:00" },
  );
  assertEquals(mensagem, "Oi , sua aula é às 19:00.");
});

Deno.test("quebra de linha e negrito do professor são preservados", () => {
  const mensagem = renderReminderTemplate(
    "Oi {student_name}!\n\nAula às *{class_time}*.\n\nTe espero! 🐺",
    { student_name: "Penha", class_time: "20:30" },
  );
  assertEquals(mensagem, "Oi Penha!\n\nAula às *20:30*.\n\nTe espero! 🐺");
});

// ─── Sala oficial da escola no lembrete (migration 20260926190000) ───────────

type RpcCall = { fn: string; args: Record<string, unknown> };

/** Dublê do supabase.rpc: responde por nome da função e guarda as chamadas. */
function fakeRpc(
  responses: Record<string, { data: unknown; error: unknown } | Error>,
): { rpc: LessonReminderRpc; calls: RpcCall[] } {
  const calls: RpcCall[] = [];
  const rpc: LessonReminderRpc = (fn, args) => {
    calls.push({ fn, args });
    const response = responses[fn];
    if (response instanceof Error) return Promise.reject(response);
    return Promise.resolve(
      response ?? { data: null, error: { message: "sem dublê" } },
    );
  };
  return { rpc, calls };
}

const SALA = "https://meet.google.com/abc-defg-hij";
const aulaDoTheo = {
  tenantId: "school-wise-wolf",
  sourceType: "BOOKING",
  sourceId: "123e4567-e89b-42d3-a456-426614174000",
  classDate: "2026-09-28",
  classTime: "19:00",
  studentId: "223e4567-e89b-42d3-a456-426614174000",
};

Deno.test("só sala do Google Meet da escola passa como sala oficial", () => {
  assertEquals(officialMeetLink(SALA), SALA);
  assertEquals(officialMeetLink(`  ${SALA}  `), SALA);
  assertEquals(officialMeetLink("http://meet.google.com/abc-defg-hij"), null);
  assertEquals(officialMeetLink("https://meet.google.com/abc?x=1"), null);
  assertEquals(officialMeetLink("https://zoom.us/j/123"), null);
  assertEquals(officialMeetLink("https://evil.example/meet.google.com"), null);
  assertEquals(officialMeetLink(null), null);
  assertEquals(officialMeetLink(42), null);
});

Deno.test("consulta da sala manda a identidade da aula como o banco espera", async () => {
  const { rpc, calls } = fakeRpc({
    official_lesson_link: { data: SALA, error: null },
  });
  assertEquals(await loadOfficialLessonLink(rpc, aulaDoTheo), {
    ok: true,
    link: SALA,
  });
  assertEquals(calls, [{
    fn: "official_lesson_link",
    args: {
      p_tenant: "school-wise-wolf",
      p_source_type: "booking",
      p_source_id: aulaDoTheo.sourceId,
      p_class_date: "2026-09-28",
      p_start_time: "19:00",
      p_student_id: aulaDoTheo.studentId,
    },
  }]);
});

Deno.test("sem sala, horário inválido ou valor estranho do banco: sem link oficial", async () => {
  const semSala = fakeRpc({
    official_lesson_link: { data: null, error: null },
  });
  assertEquals(await loadOfficialLessonLink(semSala.rpc, aulaDoTheo), {
    ok: true,
    link: null,
  });

  const estranho = fakeRpc({
    official_lesson_link: { data: "https://evil.example/x", error: null },
  });
  assertEquals(
    await loadOfficialLessonLink(estranho.rpc, {
      ...aulaDoTheo,
      classTime: "",
      studentId: null,
    }),
    { ok: true, link: null },
  );
  // Horário que não é HH:MM não vira filtro; aluno ausente vai como null.
  assertEquals(estranho.calls[0].args.p_start_time, null);
  assertEquals(estranho.calls[0].args.p_student_id, null);
});

Deno.test("falha ao consultar a sala NÃO vira 'sem sala'", async () => {
  const comErro = fakeRpc({
    official_lesson_link: { data: null, error: { message: "timeout" } },
  });
  assertEquals(await loadOfficialLessonLink(comErro.rpc, aulaDoTheo), {
    ok: false,
    reason: "official_lesson_link_unavailable",
  });
  const lancou = fakeRpc({ official_lesson_link: new Error("rede") });
  assertEquals(await loadOfficialLessonLink(lancou.rpc, aulaDoTheo), {
    ok: false,
    reason: "official_lesson_link_unavailable",
  });
});

Deno.test("texto do lembrete vem do renderizador do banco, com modelo cru", async () => {
  const modeloDaDebora =
    "Oi {student_name}!\n\nAula às *{class_time}*.\n\n{class_link}\n\nTe espero!";
  const { rpc, calls } = fakeRpc({
    render_lesson_reminder_message: {
      data: `Oi Ana!\n\nAula às *19:00*.\n\n${SALA}\n\nTe espero!`,
      error: null,
    },
  });
  const rendered = await renderLessonReminderMessage(rpc, {
    template: modeloDaDebora,
    studentName: "Ana",
    classTime: "19:00",
    teacherName: "Débora",
    tenantName: "Wise Wolf",
    officialLink: SALA,
    personalLink: null,
  });
  assertEquals(rendered, {
    ok: true,
    message: `Oi Ana!\n\nAula às *19:00*.\n\n${SALA}\n\nTe espero!`,
  });
  // O modelo vai cru: negrito, underline e quebra de linha chegam ao banco.
  assertEquals(calls[0].args.p_template, modeloDaDebora);
  assertEquals(calls[0].args.p_official_link, SALA);
  assertEquals(calls[0].args.p_personal_link, null);
});

Deno.test("link oficial inválido nunca chega ao renderizador", async () => {
  const { rpc, calls } = fakeRpc({
    render_lesson_reminder_message: { data: "Oi Ana!", error: null },
  });
  await renderLessonReminderMessage(rpc, {
    template: null,
    studentName: "Ana",
    classTime: "19:00",
    teacherName: "Débora",
    tenantName: "Wise Wolf",
    officialLink: "https://evil.example/x",
    personalLink: "",
  });
  assertEquals(calls[0].args.p_official_link, null);
  assertEquals(calls[0].args.p_personal_link, null);
});

Deno.test("renderizador fora do ar ou vazio: não inventa mensagem", async () => {
  const input = {
    template: null,
    studentName: "Ana",
    classTime: "19:00",
    teacherName: "Débora",
    tenantName: "Wise Wolf",
    officialLink: null,
    personalLink: null,
  };
  const vazio = fakeRpc({
    render_lesson_reminder_message: { data: "   ", error: null },
  });
  assertEquals(await renderLessonReminderMessage(vazio.rpc, input), {
    ok: false,
    reason: "lesson_reminder_render_unavailable",
  });
  const lancou = fakeRpc({ render_lesson_reminder_message: new Error("x") });
  assertEquals(await renderLessonReminderMessage(lancou.rpc, input), {
    ok: false,
    reason: "lesson_reminder_render_unavailable",
  });
});

Deno.test("lembrete canônico: sala oficial encontrada vai para o texto", async () => {
  const { rpc, calls } = fakeRpc({
    official_lesson_link: { data: SALA, error: null },
    render_lesson_reminder_message: { data: "mensagem", error: null },
  });
  const result = await canonicalLessonReminder(rpc, {
    ...aulaDoTheo,
    template: null,
    studentName: "Theo",
    teacherName: "Flávio",
    tenantName: "Wise Wolf",
    personalLink: null,
  });
  assertEquals(result, { ok: true, message: "mensagem", officialLink: SALA });
  assertEquals(calls.map((call) => call.fn), [
    "official_lesson_link",
    "render_lesson_reminder_message",
  ]);
  assertEquals(calls[1].args.p_official_link, SALA);
  assertEquals(calls[1].args.p_class_time, "19:00");
});

Deno.test("lembrete canônico: sem saber da sala, não renderiza nem envia", async () => {
  const { rpc, calls } = fakeRpc({
    official_lesson_link: { data: null, error: { message: "down" } },
    render_lesson_reminder_message: { data: "mensagem", error: null },
  });
  const result = await canonicalLessonReminder(rpc, {
    ...aulaDoTheo,
    template: null,
    studentName: "Theo",
    teacherName: "Flávio",
    tenantName: "Wise Wolf",
    personalLink: "https://meet.google.com/pes-soal-abc",
  });
  assertEquals(result, {
    ok: false,
    reason: "official_lesson_link_unavailable",
  });
  assertEquals(calls.length, 1);
});

Deno.test("aviso de reposição: sala oficial com a frase da sala; sem sala, o link de sempre", () => {
  const base = {
    firstName: "Ana",
    teacherName: "Flávio",
    classDate: "2026-09-29",
    classTime: "15:00",
  };
  assertEquals(
    rescheduleScheduledMessage({
      ...base,
      officialLink: SALA,
      personalLink: "https://meet.google.com/pes-soal-abc",
    }),
    "Oi Ana, aqui é o Flávio! Reposição agendada para 29/09/2026 às 15:00." +
      `\n\n${OFFICIAL_ROOM_NOTICE}\n${SALA}`,
  );
  assertEquals(
    rescheduleScheduledMessage({
      ...base,
      officialLink: null,
      personalLink: "https://meet.google.com/pes-soal-abc",
    }),
    "Oi Ana, aqui é o Flávio! Reposição agendada para 29/09/2026 às 15:00." +
      "\n\nhttps://meet.google.com/pes-soal-abc",
  );
  assertEquals(
    rescheduleScheduledMessage({
      ...base,
      officialLink: null,
      personalLink: null,
    }),
    "Oi Ana, aqui é o Flávio! Reposição agendada para 29/09/2026 às 15:00.",
  );
});
