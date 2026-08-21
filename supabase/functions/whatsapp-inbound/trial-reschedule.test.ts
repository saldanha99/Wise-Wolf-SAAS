// A diretiva existe porque o `tsconfig.json` da raiz (lib DOM, para o Vite) é
// lido pelo Deno e apaga `deno.ns` quando este arquivo roda sozinho. Sem ela,
// `deno test` deste arquivo isolado falha no type-check.
/// <reference lib="deno.ns" />
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type ActiveTrial,
  brtSlotFromIso,
  brtStartIso,
  classifyTeacherRescheduleReply,
  decideTrialAction,
  isTrialAppointmentActive,
  isTrialOutcomeOpen,
  minutesApart,
  trialRescheduleReplyCode,
} from "./trial-reschedule.ts";

// Caso real que originou a regra: experimental de quinta 13/08/2026 às 12:00
// aceita pela Teacher Lais (12:00 BRT = 15:00 UTC no banco).
const AULA_DA_LAIS: ActiveTrial = {
  opportunityId: "4f4b5036-58f1-46f6-bc1d-a7fabdc79081",
  appointmentId: "ed8e22c9-cc4e-4eaa-ad4d-8d168f54c35e",
  teacherId: "a7158b7d-6e9f-4ba4-a981-f5b03c5c5301",
  teacherName: "Lais Sampaio Conde",
  teacherPhone: "5511999999999",
  startIso: "2026-08-13T15:00:00+00:00",
};

Deno.test("BRT vira o instante UTC que o banco guarda", () => {
  assertEquals(brtStartIso("2026-08-13", "12:00"), "2026-08-13T15:00:00.000Z");
  assertEquals(brtStartIso("2026-08-13", "16:00"), "2026-08-13T19:00:00.000Z");
});

Deno.test("e o caminho de volta devolve o horário que a escola enxerga", () => {
  assertEquals(brtSlotFromIso("2026-08-13T15:00:00+00:00"), { date: "2026-08-13", time: "12:00" });
  // Meia-noite BRT cai no dia seguinte em UTC — o dia tem de voltar certo.
  assertEquals(brtSlotFromIso("2026-08-14T02:30:00+00:00"), { date: "2026-08-13", time: "23:30" });
});

Deno.test("REGRESSÃO: horário novo aguarda o aceite do professor antes de mudar", () => {
  const d = decideTrialAction({
    existing: AULA_DA_LAIS,
    requested: { date: "2026-08-13", time: "16:00" },
    busy: [],
  });
  assertEquals(d.action, "confirm");
  if (d.action !== "confirm") return;
  assertEquals(d.from, { date: "2026-08-13", time: "12:00" });
  assertEquals(d.to, { date: "2026-08-13", time: "16:00" });
  assertEquals(d.newStartIso, "2026-08-13T19:00:00.000Z");
  assertEquals(d.trial.teacherId, AULA_DA_LAIS.teacherId);
});

Deno.test("sem experimental com dono, o leilão continua igual", () => {
  const d = decideTrialAction({ existing: null, requested: { date: "2026-08-14", time: "10:00" } });
  assertEquals(d.action, "broadcast");
});

Deno.test("aluno repetindo o MESMO horário não vira disparo nenhum", () => {
  const d = decideTrialAction({
    existing: AULA_DA_LAIS,
    requested: { date: "2026-08-13", time: "12:00" },
  });
  assertEquals(d.action, "keep");
});

Deno.test("conflito real na agenda do dono NÃO é resolvido pelo robô", () => {
  const d = decideTrialAction({
    existing: AULA_DA_LAIS,
    requested: { date: "2026-08-13", time: "16:00" },
    busy: [{ startIso: "2026-08-13T19:15:00+00:00", label: "aula das 16:15" }],
  });
  assertEquals(d.action, "escalate");
  if (d.action !== "escalate") return;
  assertEquals(d.conflict, "aula das 16:15");
});

Deno.test("a própria aula, no horário antigo, não conta como conflito", () => {
  const d = decideTrialAction({
    existing: AULA_DA_LAIS,
    requested: { date: "2026-08-13", time: "12:20" },
    busy: [{ startIso: AULA_DA_LAIS.startIso, label: "a própria experimental" }],
  });
  assertEquals(d.action, "confirm");
});

Deno.test("30 min de intervalo: exatamente 30 passa, 29 barra", () => {
  const trinta = decideTrialAction({
    existing: AULA_DA_LAIS,
    requested: { date: "2026-08-13", time: "16:00" },
    busy: [{ startIso: "2026-08-13T19:30:00+00:00", label: "aula das 16:30" }],
  });
  assertEquals(trinta.action, "confirm");

  const vinteNove = decideTrialAction({
    existing: AULA_DA_LAIS,
    requested: { date: "2026-08-13", time: "16:00" },
    busy: [{ startIso: "2026-08-13T19:29:00+00:00", label: "aula das 16:29" }],
  });
  assertEquals(vinteNove.action, "escalate");
});

Deno.test("só appointment 'scheduled' segura o agendamento do aluno", () => {
  const agora = "2026-08-12T13:00:00Z";
  assertEquals(isTrialAppointmentActive("scheduled", "2026-08-13T15:00:00Z", agora), true);
  assertEquals(isTrialAppointmentActive("cancelled", "2026-08-13T15:00:00Z", agora), false);
  assertEquals(isTrialAppointmentActive("completed", "2026-08-13T15:00:00Z", agora), false);
  assertEquals(isTrialAppointmentActive("no_show", "2026-08-13T15:00:00Z", agora), false);
});

Deno.test("aula recém-passada ainda remarca; aula velha esquecida não sequestra a nova", () => {
  const agora = "2026-08-12T13:00:00Z";
  assertEquals(isTrialAppointmentActive("scheduled", "2026-08-10T15:00:00Z", agora), true);
  assertEquals(isTrialAppointmentActive("scheduled", "2026-07-20T15:00:00Z", agora), false);
});

Deno.test("experimental com lançamento ou desfecho nunca é reaproveitada", () => {
  assertEquals(isTrialOutcomeOpen(null), true);
  assertEquals(isTrialOutcomeOpen("SCHEDULED"), true);
  assertEquals(isTrialOutcomeOpen("DONE"), false);
  assertEquals(isTrialOutcomeOpen("NO_SHOW_TEACHER"), false);
  assertEquals(isTrialOutcomeOpen("NO_SHOW_STUDENT"), false);
});

Deno.test("minutesApart não depende da ordem", () => {
  assertEquals(minutesApart("2026-08-13T19:00:00Z", "2026-08-13T19:45:00Z"), 45);
  assertEquals(minutesApart("2026-08-13T19:45:00Z", "2026-08-13T19:00:00Z"), 45);
});

Deno.test("REGRESSÃO: 'acredito que eu não consigo' é recusa, nunca aceite", () => {
  assertEquals(classifyTeacherRescheduleReply("Bom dia, acredito que eu não consigo"), "decline");
  assertEquals(classifyTeacherRescheduleReply("Não tenho esse horário"), "decline");
  assertEquals(classifyTeacherRescheduleReply("não posso atender #A1B2C3D4"), "decline");
});

Deno.test("só resposta afirmativa inequívoca aceita a remarcação", () => {
  assertEquals(classifyTeacherRescheduleReply("Sim, consigo atender #A1B2C3D4"), "accept");
  assertEquals(classifyTeacherRescheduleReply("Pode remarcar"), "accept");
  assertEquals(classifyTeacherRescheduleReply("Acho que talvez eu consiga"), "unknown");
});

Deno.test("extrai o código do pedido sem confundir texto comum", () => {
  assertEquals(trialRescheduleReplyCode("Sim, consigo #a1b2c3d4"), "A1B2C3D4");
  assertEquals(trialRescheduleReplyCode("Não consigo esse horário"), null);
});
