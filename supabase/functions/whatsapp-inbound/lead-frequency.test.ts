/// <reference lib="deno.ns" />
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  LEAD_FREQUENCY_RULE,
  parseWeeklyFrequency,
  slotsFittingFrequency,
  teacherWeeklyDays,
  weeklyFrequencyFacts,
} from "./lead-frequency.ts";

// 16/11/2026 é segunda.
const laura = (date: string, time: string) => ({
  date,
  time,
  teacher_id: "L",
  teacher_name: "Lais Sampaio",
});
const bruna = (date: string, time: string) => ({
  date,
  time,
  teacher_id: "B",
  teacher_name: "Bruna Lima",
});
const all = [
  laura("2026-11-16", "19:00"),
  laura("2026-11-18", "19:00"),
  laura("2026-11-20", "19:30"),
  bruna("2026-11-17", "19:00"), // Bruna só tem terça
  bruna("2026-11-16", "10:00"),
];

Deno.test("lê a frequência só quando o texto fala de frequência", () => {
  assertEquals(parseWeeklyFrequency("acho que umas 3x por semana"), 3);
  assertEquals(parseWeeklyFrequency("Duas vezes na semana"), 2);
  assertEquals(parseWeeklyFrequency("queria todo dia"), 5);
  assertEquals(parseWeeklyFrequency("tenho 2 filhos e trabalho à noite"), null);
  assertEquals(parseWeeklyFrequency("às 19h"), null);
});

Deno.test("dias da semana do professor no horário, com tolerância de 30 min", () => {
  assertEquals(teacherWeeklyDays(all, "L", "19:00"), [1, 3, 5]);
  assertEquals(teacherWeeklyDays(all, "B", "19:00"), [2]);
});

Deno.test("horário que não comporta a frequência sai da lista; nada comporta = lista intacta", () => {
  const menu = [laura("2026-11-16", "19:00"), bruna("2026-11-17", "19:00")];
  const three = slotsFittingFrequency(menu, all, 3);
  assert(three.fits);
  assertEquals(three.slots.map((s) => s.teacher_id), ["L"]);
  const five = slotsFittingFrequency(menu, all, 5);
  assertEquals(five.fits, false);
  assertEquals(five.slots.length, 2);
  assertEquals(slotsFittingFrequency(menu, all, null).slots.length, 2);
});

Deno.test("prévia em fatos curtos, sem prometer vaga", () => {
  const facts = weeklyFrequencyFacts(
    [laura("2026-11-16", "19:00")],
    all,
    3,
    true,
  );
  assert(
    facts.includes("19:00: Teacher Lais tem seg, qua, sex livres (3x/semana)"),
    facts,
  );
  assert(LEAD_FREQUENCY_RULE.includes('NUNCA diga "reservado"'));
  assert(LEAD_FREQUENCY_RULE.includes("não é compromisso"));
});
