/// <reference lib="deno.ns" />
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handoffAtivo, HANDOFF_TTL_MS, pickAlternatives } from "./lead-contact.ts";

const agoraMenos = (ms: number) => new Date(Date.now() - ms).toISOString();

Deno.test("sem handoff, o robô fala", () => {
  assertEquals(handoffAtivo(null), false);
  assertEquals(handoffAtivo({}), false);
  assertEquals(handoffAtivo({ ai_handoff: false, ai_handoff_at: agoraMenos(1000) }), false);
});

Deno.test("handoff recente cala o robô; vencido libera", () => {
  assertEquals(handoffAtivo({ ai_handoff: true, ai_handoff_at: agoraMenos(3600_000) }), true);
  assertEquals(handoffAtivo({ ai_handoff: true, ai_handoff_at: agoraMenos(HANDOFF_TTL_MS + 60_000) }), false);
});

Deno.test("REGRESSÃO: handoff sem carimbo conta como vencido, não como eterno", () => {
  assertEquals(handoffAtivo({ ai_handoff: true, ai_handoff_at: null }), false);
  assertEquals(handoffAtivo({ ai_handoff: true }), false);
  assertEquals(handoffAtivo({ ai_handoff: true, ai_handoff_at: "data inválida" }), false);
});

const GRADE = [
  { day_of_week: 2, start_time: "16:00:00" },
  { day_of_week: 3, start_time: "16:00:00" },
  { day_of_week: 4, start_time: "09:00:00" },
  { day_of_week: 4, start_time: "16:00:00" },
  { day_of_week: 4, start_time: "19:30:00" },
  { day_of_week: 0, start_time: "16:00:00" }, // domingo: a escola não opera
];

Deno.test("oferece o mesmo horário em outros dias e outros horários no mesmo dia", () => {
  const alt = pickAlternatives(GRADE, 4, "16:00");
  assertEquals(alt.days, [2, 3]);
  assertEquals(alt.times, ["09:00", "16:00", "19:30"]);
});

Deno.test("domingo nunca é oferecido", () => {
  assertEquals(pickAlternatives(GRADE, 2, "16:00").days.includes(0), false);
});

Deno.test("madrugada e linha suja ficam fora", () => {
  const sujo = [
    { day_of_week: 4, start_time: "03:00:00" },
    { day_of_week: 4, start_time: "23:00:00" },
    { day_of_week: 4, start_time: "manhã" },
    { day_of_week: 4, start_time: "10:00:00" },
  ];
  assertEquals(pickAlternatives(sujo, 4, "16:00").times, ["10:00"]);
});

Deno.test("grade vazia devolve listas vazias, não quebra", () => {
  assertEquals(pickAlternatives([], 4, "16:00"), { days: [], times: [] });
  assertEquals(pickAlternatives(null, 4, "16:00"), { days: [], times: [] });
});
