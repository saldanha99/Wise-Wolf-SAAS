/// <reference lib="deno.ns" />
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildCareSystemPrompt,
  isMoneyOrContractTopic,
  parseCareModelReply,
  parseRequestedSlot,
  pickOfferedSlot,
} from "./care-conversation.ts";

const slots = [
  { date: "2026-09-18", day: "Sexta", time: "09:00", label: "18/09 às 09:00" },
  { date: "2026-09-18", day: "Sexta", time: "10:30", label: "18/09 às 10:30" },
  {
    date: "2026-09-21",
    day: "Segunda",
    time: "14:00",
    label: "21/09 às 14:00",
  },
];

Deno.test("escolha de horário oferecido: ordinal, hora, dia, data", () => {
  assertEquals(pickOfferedSlot("1", slots)?.time, "09:00");
  assertEquals(pickOfferedSlot("pode ser o primeiro", slots)?.time, "09:00");
  assertEquals(pickOfferedSlot("o das 10:30", slots)?.time, "10:30");
  assertEquals(pickOfferedSlot("10h30", slots)?.time, "10:30");
  assertEquals(pickOfferedSlot("segunda", slots)?.date, "2026-09-21");
  assertEquals(pickOfferedSlot("18/09 às 9h", slots)?.time, "09:00");
  assertEquals(
    pickOfferedSlot("sexta 14:00", slots),
    null,
    "sexta não tem 14:00",
  );
  assertEquals(
    pickOfferedSlot("sexta", slots),
    null,
    "duas opções na sexta: a IA pergunta qual",
  );
  assertEquals(pickOfferedSlot("tudo bem, obrigada", slots), null);
});

Deno.test("horário fora da lista vira pedido com a data mais próxima daquele dia", () => {
  const asked = parseRequestedSlot("quinta às 19h", "2026-09-17");
  assertEquals(asked, { date: "2026-09-24", day: "Quinta", time: "19:00" });
  assertEquals(
    parseRequestedSlot("quinta", "2026-09-17"),
    null,
    "sem hora não marca",
  );
  assertEquals(
    parseRequestedSlot("25/09 10:30", "2026-09-17")?.date,
    "2026-09-25",
  );
  assertEquals(
    parseRequestedSlot("segunda 8:15", "2026-09-17"),
    null,
    "só slot de 30 min",
  );
});

Deno.test("dinheiro e contrato nunca vão para a IA", () => {
  assert(isMoneyOrContractTopic("qual a chave pix?"));
  assert(isMoneyOrContractTopic("quero cancelar o contrato"));
  assert(isMoneyOrContractTopic("não paguei ainda"));
  assert(!isMoneyOrContractTopic("a aula foi ótima, a teacher é muito boa"));
});

Deno.test("resposta do modelo: sem reply é nada; wants_slot só com data e hora válidas", () => {
  assertEquals(parseCareModelReply({ sentiment: "POSITIVE" }), null);
  const parsed = parseCareModelReply({
    reply: "Fechado!",
    sentiment: "positive",
    summary: "quer repor sexta",
    wants_slot: { date: "2026-09-18", time: "09:00" },
    handoff: false,
    close: false,
  });
  assertEquals(parsed?.sentiment, "POSITIVE");
  assertEquals(parsed?.wants_slot, { date: "2026-09-18", time: "09:00" });
  assertEquals(
    parseCareModelReply({
      reply: "ok",
      wants_slot: { date: "18/09", time: "9h" },
    })?.wants_slot,
    null,
  );
});

Deno.test("prompt leva o direito, os horários e a regra dura de dinheiro", () => {
  const system = buildCareSystemPrompt({
    agentName: "Bia",
    schoolName: "Wise Wolf",
    ctx: {
      id: "t1",
      kind: "ABSENCE_FOLLOWUP",
      status: "SENT",
      subject_role: "STUDENT",
      subject_id: "s1",
      subject_name: "Mariana Pastro",
      teacher_name: "Lais Sampaio",
      quota: { limit: 4, used: 1 },
    },
    offeredSlots: slots,
    todayIso: "2026-09-17",
  });
  assert(system.includes("ainda tem 3"), system);
  assert(system.includes("Sexta 18/09 às 09:00 (2026-09-18 09:00)"), system);
  assert(system.includes("NUNCA fale de cobrança"), system);
  assert(system.includes("Teacher Lais"), system);
});
