/// <reference lib="deno.ns" />
/**
 * Direção, 21/11/2026: a IA nunca oferece, sugere, lista nem marca horário de reposição para o
 * ALUNO. Estes testes leem o código dos caminhos do aluno (acompanhamento e varredura) e reprovam
 * qualquer volta da oferta/marcação. A mensagem ao PROFESSOR (teacherAbsenceNudgeMessage) pode
 * sugerir horários: ali quem decide é o professor.
 */
import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

const inbound = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const sweeper = await Deno.readTextFile(new URL("../care-sweeper/index.ts", import.meta.url));

function handler(source: string, name: string): string {
  const start = source.indexOf(`async function ${name}(`);
  assert(start >= 0, name);
  const next = source.indexOf("\nasync function ", start + 10);
  return source.slice(start, next < 0 ? undefined : next);
}

Deno.test("acompanhamento do aluno não marca, não lista e não oferece horário de reposição", () => {
  const care = handler(inbound, "handleCareStudent");
  for (const proibido of [
    "care_set_reschedule_slot",
    "pickOfferedSlot",
    "parseRequestedSlot",
    "free_slots",
    "offeredSlots",
    "wants_slot",
    "Ela tem livre",
    "Fechado:",
  ]) assert(!care.includes(proibido), `handleCareStudent ainda contém ${proibido}`);
  assert(care.includes("isMakeupOrSlotMessage(text)"), "falta a resposta fixa para pedido de reposição");
  assert(care.includes("replyOffersSlot(reply)"), "falta a trava final na resposta da IA");
});

Deno.test("varredura: o lembrete de falta do aluno não leva free_slots no contexto nem na mensagem", () => {
  const start = sweeper.indexOf('kind: "ABSENCE_FOLLOWUP"');
  const end = sweeper.indexOf("// ── 2) Sexta", start);
  const bloco = sweeper.slice(start, end);
  assert(start >= 0 && end > start);
  assert(!bloco.includes("free_slots"), bloco);
  assert(!bloco.includes("freeSlots"), bloco);
});
