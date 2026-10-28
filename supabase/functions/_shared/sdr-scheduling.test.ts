import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  alternativeQuestion,
  availabilityFacts,
  availableMenu,
  type AvailableTrialSlot,
  describeWindow,
  filterSlotsByWindows,
  humanizeIsoDates,
  offeredSlotsInReply,
  parseAvailabilityWindows,
  rankTrialAlternatives,
  replyDeniesAvailability,
  replyOffersUnknownSlot,
  replyPromisesTrialCheck,
  requestedTrialSlot,
  unavailablePreferenceNote,
} from "./sdr-scheduling.ts";
const slot = (
  date: string,
  time: string,
  teacher = "teacher-a",
): AvailableTrialSlot => ({
  date,
  time,
  teacher_id: teacher,
  teacher_name: "Professor Teste",
  phone: "5511999999999",
});
const now = Date.parse("2026-09-05T15:00:00-03:00");
Deno.test("alternatives omit past dates, holidays, Sundays and failed exact slot", () => {
  const rows = [
    slot("2026-09-04", "18:00"),
    slot("2026-09-07", "18:00"),
    slot("2026-09-06", "18:00"),
    slot("2026-09-08", "18:00"),
    slot("2026-09-09", "18:00"),
  ];
  assertEquals(
    rankTrialAlternatives(rows, { date: "2026-09-08", time: "18:00" }, "", now)
      .map((s) => s.date),
    ["2026-09-09"],
  );
});
Deno.test("preference ranks the student's evening before earlier morning openings", () => {
  const rows = [
    slot("2026-09-08", "08:00"),
    slot("2026-09-08", "19:00"),
    slot("2026-09-09", "18:00"),
  ];
  assertEquals(
    rankTrialAlternatives(rows, null, "à noite", now).map((s) => s.time),
    ["19:00", "18:00"],
  );
});
Deno.test("explicit exclusions are respected and duplicate teacher slots collapse", () => {
  const rows = [
    slot("2026-09-08", "08:00"),
    slot("2026-09-08", "08:00", "teacher-b"),
    slot("2026-09-08", "19:00"),
  ];
  assertEquals(
    rankTrialAlternatives(rows, null, "não posso à noite", now).map((s) =>
      s.time
    ),
    ["08:00"],
  );
});
Deno.test("same requested hour wins among equally compatible future alternatives", () => {
  const rows = [
    slot("2026-09-08", "16:30"),
    slot("2026-09-09", "18:00"),
    slot("2026-09-10", "19:00"),
  ];
  assertEquals(
    rankTrialAlternatives(
      rows,
      { date: "2026-09-08", time: "18:00" },
      "",
      now,
    )[0].time,
    "18:00",
  );
});
Deno.test("menu uses exact dates, avoids duplicate teachers and never confirms the agenda", () => {
  assertEquals(
    availableMenu([
      slot("2026-09-08", "19:00"),
      slot("2026-09-08", "19:00", "b"),
    ]),
    "2026-09-08 (ter 08/09): 19:00",
  );
  assertEquals(
    alternativeQuestion([slot("2026-09-08", "19:00")]).includes(
      "ter 08/09 às 19:00",
    ),
    true,
  );
  assertEquals(
    alternativeQuestion([slot("2026-09-08", "19:00")]).includes(
      "sujeito ao aceite",
    ),
    true,
  );
  assertEquals(alternativeQuestion([]).includes("Qual outro dia"), true);
});

Deno.test("only evenings never offers mornings when no preferred slot remains", () => {
  assertEquals(
    rankTrialAlternatives(
      [slot("2026-09-08", "08:00")],
      null,
      "somente à noite",
      now,
    ),
    [],
  );
});

// ── Janela de disponibilidade (Ana Carolina, 17/09/2026) ─────────────────
Deno.test("'sábados ou durante a semana após as 18h' vira duas janelas", () => {
  const w = parseAvailabilityWindows(
    "Sábados ou durante a semana após as 18h",
  );
  assertEquals(w, [
    { days: [6], fromMin: null, toMin: null },
    { days: [1, 2, 3, 4, 5], fromMin: 18 * 60, toMin: null },
  ]);
  assertEquals(describeWindow(w[1]), "de segunda a sexta depois das 18:00");
  assertEquals(describeWindow(w[0]), "aos sábados");
});
Deno.test("frases comuns: antes das, entre, período, dia da semana, negação", () => {
  assertEquals(parseAvailabilityWindows("antes das 12h"), [
    { days: null, fromMin: null, toMin: 12 * 60 },
  ]);
  assertEquals(parseAvailabilityWindows("segunda e quarta entre 19h e 21h"), [
    { days: [1, 3], fromMin: 19 * 60, toMin: 21 * 60 },
  ]);
  assertEquals(parseAvailabilityWindows("de manhã"), [
    { days: null, fromMin: 6 * 60, toMin: 12 * 60 },
  ]);
  assertEquals(parseAvailabilityWindows("não posso à noite"), []);
  assertEquals(parseAvailabilityWindows("dia 26, 10:30 por favor"), []);
  assertEquals(parseAvailabilityWindows("às 18h"), [
    { days: null, fromMin: 18 * 60, toMin: 19 * 60 },
  ]);
  assertEquals(parseAvailabilityWindows("Combinado!!"), []);
});
Deno.test("a janela filtra a lista; sábado sem professor é dito nos fatos", () => {
  const rows = [
    slot("2026-09-18", "10:30"), // sex de manhã
    slot("2026-09-18", "18:00"),
    slot("2026-09-21", "19:30"),
    slot("2026-09-22", "08:00"),
  ];
  const windows = parseAvailabilityWindows(
    "Sábados ou durante a semana após as 18h",
  );
  assertEquals(
    filterSlotsByWindows(rows, windows).map((s) => `${s.date} ${s.time}`),
    ["2026-09-18 18:00", "2026-09-21 19:30"],
  );
  const facts = availabilityFacts(windows, rows);
  assertEquals(facts.includes("aos sábados → NENHUM professor livre"), true);
  assertEquals(
    facts.includes("de segunda a sexta depois das 18:00 → 2 opções"),
    true,
  );
  assertEquals(
    unavailablePreferenceNote(windows, rows),
    "Aos sábados não temos professor no momento 😕 ",
  );
});
Deno.test("alternativas respeitam a janela: nada de 10:30 para quem só pode depois das 18h", () => {
  const rows = [
    slot("2026-09-18", "10:30"),
    slot("2026-09-21", "10:30"),
    slot("2026-09-18", "18:00"),
    slot("2026-09-21", "19:30"),
  ];
  assertEquals(
    rankTrialAlternatives(
      rows,
      { date: "2026-09-26", time: "10:30" },
      "Sábados ou durante a semana após as 18h",
      Date.parse("2026-09-17T13:40:00-03:00"),
    ).map((s) => `${s.date} ${s.time}`),
    ["2026-09-18 18:00", "2026-09-21 19:30"],
  );
});
Deno.test("veto: resposta que oferece horário fora da lista é pega; data ISO vira dd/mm", () => {
  const rows = [slot("2026-09-18", "18:00"), slot("2026-09-21", "19:30")];
  const invented =
    "Temos horários aos sábados. Que tal no dia 2026-09-19 às 09:00? Ou 2026-09-26 às 10:30?";
  assertEquals(replyOffersUnknownSlot(invented, rows), true);
  assertEquals(
    offeredSlotsInReply(invented),
    [{ monthDay: "09-19", time: "09:00" }, {
      monthDay: "09-26",
      time: "10:30",
    }],
  );
  assertEquals(
    replyOffersUnknownSlot(
      "Posso ver qui 18/09 às 18:00 ou seg 21/09 às 19:30?",
      rows,
    ),
    false,
  );
  assertEquals(
    replyOffersUnknownSlot("Qual dia fica bom para você?", rows),
    false,
  );
  assertEquals(
    humanizeIsoDates("dia 2026-09-19 às 09:00"),
    "dia 19/09 às 09:00",
  );
});

Deno.test("intervalo de dias: 'segunda a quinta-feira' inclui terça e quarta", () => {
  const [w] = parseAvailabilityWindows("Segunda a quinta-feira, 20h");
  assertEquals(w.days, [1, 2, 3, 4]);
  assertEquals(w.fromMin, 20 * 60);
  assertEquals(parseAvailabilityWindows("de terça à sexta de manhã")[0].days, [
    2,
    3,
    4,
    5,
  ]);
  assertEquals(parseAvailabilityWindows("seg a qui depois das 19h")[0].days, [
    1,
    2,
    3,
    4,
  ]);
});

Deno.test("lead Thiago: sexta 16h pedida depois continua na janela", () => {
  // 28/10/2026 (quarta). Gravado: "Segunda a quinta-feira, 20h"; depois
  // pediu "sexta as 16h" e respondeu "Ok" — a sexta não pode sumir.
  const slots = [slot("2026-10-29", "20:00"), slot("2026-10-30", "16:00")];
  const windows = parseAvailabilityWindows(
    "Segunda a quinta-feira, 20h\nDe segunda a quinta-feira, 20h\nInglês trabalho\nAula experimental pode ser na sexta as 16h\nOk",
  );
  assertEquals(filterSlotsByWindows(slots, windows).length, 2);
});

Deno.test("requestedTrialSlot: pedido explícito livre é encontrado", () => {
  const slots = [slot("2026-10-29", "20:00"), slot("2026-10-30", "16:00")];
  assertEquals(
    requestedTrialSlot(
      ["Ok", "Aula experimental pode ser na sexta as 16h", "Inglês trabalho"],
      slots,
      "2026-10-28",
    )?.date,
    "2026-10-30",
  );
  // preferência com vários dias não é escolha
  assertEquals(
    requestedTrialSlot(["De segunda a quinta-feira, 20h"], slots, "2026-10-28"),
    null,
  );
  // pedido mais novo sem professor não deixa o antigo ressuscitar
  assertEquals(
    requestedTrialSlot(
      ["e sabado as 9h?", "pode ser sexta as 16h"],
      slots,
      "2026-10-28",
    ),
    null,
  );
  // negação não é pedido
  assertEquals(
    requestedTrialSlot(["sexta as 16h não posso"], slots, "2026-10-28"),
    null,
  );
});

Deno.test("respostas que negam horário ou prometem verificar", () => {
  assertEquals(
    replyDeniesAvailability(
      "Thiago, verifiquei aqui e infelizmente não temos horários disponíveis às sextas-feiras no momento.",
    ),
    true,
  );
  assertEquals(
    replyDeniesAvailability("Temos horário na sexta às 16h!"),
    false,
  );
  assertEquals(
    replyPromisesTrialCheck(
      "Sexta-feira às 16h é um ótimo horário! Vou verificar a disponibilidade do professor para você",
    ),
    true,
  );
  assertEquals(replyPromisesTrialCheck("Qual dia fica melhor?"), false);
});
