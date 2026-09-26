/// <reference lib="deno.ns" />

import {
  type InferredStudentSignals,
  isMinorStudent,
  normalizeTeacherCard,
  resolveStudentSignals,
  saoPauloTodayIso,
} from "./teacher-card.ts";

function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message?: string) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  assert(
    actualJson === expectedJson,
    message ?? `expected ${expectedJson}, received ${actualJson}`,
  );
}

const inferred: InferredStudentSignals = {
  primaryGoal: "Inferido pelo Wolfie: viagem",
  preferredTopics: ["games"],
  topicsToAvoid: ["assunto antigo do cadastro"],
  preferredCorrectionMode: "immediate",
};

const fullCardRow = {
  real_goal: "Apresentar resultados em reuniões",
  engaging_topics: ["futebol", "séries"],
  correction_style: "selective",
  avoid_topics: ["spoilers"],
  notes: "Rende mais com roleplay.",
  updated_at: "2026-09-26T12:00:00Z",
};

Deno.test("o cartão do professor vence o que o Wolfie inferiu", () => {
  const card = normalizeTeacherCard(fullCardRow, false);
  const signals = resolveStudentSignals(inferred, card);
  assertEquals(signals.primaryGoal, "Apresentar resultados em reuniões");
  assertEquals(signals.preferredTopics, ["futebol", "séries"]);
  assertEquals(signals.topicsToAvoid, ["spoilers"]);
  assertEquals(signals.preferredCorrectionMode, "selective");
  assertEquals(signals.teacherNotes, "Rende mais com roleplay.");
  assertEquals(signals.teacherReviewedFields, [
    "primary_goal",
    "preferred_topics",
    "topics_to_avoid",
    "preferred_correction_mode",
    "teacher_notes",
  ]);
  assertEquals(signals.teacherCardUpdatedAt, "2026-09-26T12:00:00Z");
});

Deno.test("campo vazio no cartão cai no que já existia", () => {
  const card = normalizeTeacherCard({
    real_goal: "",
    engaging_topics: ["culinária"],
    correction_style: null,
    avoid_topics: [],
    notes: "",
  }, false);
  const signals = resolveStudentSignals(inferred, card);
  assertEquals(signals.primaryGoal, inferred.primaryGoal);
  assertEquals(signals.preferredTopics, ["culinária"]);
  assertEquals(signals.topicsToAvoid, inferred.topicsToAvoid);
  assertEquals(signals.preferredCorrectionMode, "immediate");
  assertEquals(signals.teacherNotes, "");
  assertEquals(signals.teacherReviewedFields, ["preferred_topics"]);
});

Deno.test("sem cartão (ou cartão vazio) o Planner segue como antes", () => {
  assertEquals(normalizeTeacherCard(null, false), null);
  assertEquals(normalizeTeacherCard("texto solto", false), null);
  assertEquals(
    normalizeTeacherCard({
      real_goal: "  ",
      engaging_topics: [],
      avoid_topics: [],
      notes: "",
    }, false),
    null,
  );
  const signals = resolveStudentSignals(inferred, null);
  assertEquals(signals.primaryGoal, inferred.primaryGoal);
  assertEquals(signals.preferredTopics, inferred.preferredTopics);
  assertEquals(signals.topicsToAvoid, inferred.topicsToAvoid);
  assertEquals(signals.teacherReviewedFields, []);
  assertEquals(signals.teacherCardUpdatedAt, null);
});

Deno.test("menor de idade: só objetivo e temas chegam ao Planner", () => {
  const card = normalizeTeacherCard(fullCardRow, true);
  assert(card);
  assertEquals(card.correctionStyle, null);
  assertEquals(card.avoidTopics, []);
  assertEquals(card.notes, "");
  const signals = resolveStudentSignals(inferred, card);
  assertEquals(signals.primaryGoal, "Apresentar resultados em reuniões");
  assertEquals(signals.teacherNotes, "");
  assertEquals(signals.preferredCorrectionMode, "immediate");
  assertEquals(signals.teacherReviewedFields, [
    "primary_goal",
    "preferred_topics",
  ]);
  // Cartão de menor só com os campos pessoais (escrito antes de a data de
  // nascimento chegar) não vale nada.
  assertEquals(
    normalizeTeacherCard({
      real_goal: "",
      engaging_topics: [],
      correction_style: "end",
      avoid_topics: ["x"],
      notes: "nota",
    }, true),
    null,
  );
});

Deno.test("estilo de correção inventado é ignorado", () => {
  const card = normalizeTeacherCard({
    ...fullCardRow,
    correction_style: "gentle",
  }, false);
  assert(card);
  assertEquals(card.correctionStyle, null);
  assertEquals(
    resolveStudentSignals(inferred, card).preferredCorrectionMode,
    "immediate",
  );
});

Deno.test("o Planner respeita os limites do banco mesmo com linha fora deles", () => {
  const card = normalizeTeacherCard({
    real_goal: "a".repeat(500),
    engaging_topics: Array.from({ length: 12 }, (_, i) => `t${i}`.repeat(40)),
    correction_style: "end",
    avoid_topics: Array.from({ length: 10 }, (_, i) => `e${i}`),
    notes: "n".repeat(900),
  }, false);
  assert(card);
  assertEquals(card.realGoal.length, 300);
  assertEquals(card.engagingTopics.length, 8);
  assert(card.engagingTopics.every((topic) => topic.length <= 60));
  assertEquals(card.avoidTopics.length, 6);
  assertEquals(card.notes.length, 400);
});

Deno.test("menor pela data de nascimento, na mesma régua do banco", () => {
  const today = "2026-09-26";
  assert(isMinorStudent(true, null, today), "is_kids é menor");
  assert(!isMinorStudent(false, null, today), "sem data é adulto");
  assert(!isMinorStudent(null, "1990-05-01", today));
  assert(isMinorStudent(false, "2011-03-10", today), "15 anos");
  // Faz 18 hoje: adulto. Faz 18 amanhã: ainda menor.
  assert(!isMinorStudent(false, "2008-09-26", today));
  assert(isMinorStudent(false, "2008-09-27", today));
  // Nascido em 29/02: vira adulto em 01/03 de ano não bissexto.
  assert(isMinorStudent(false, "2008-02-29", "2026-02-28"));
  assert(!isMinorStudent(false, "2008-02-29", "2026-03-01"));
  assert(!isMinorStudent(false, "data-invalida", today));
});

Deno.test("hoje é a data de São Paulo, não a de UTC", () => {
  // 02:00 UTC de 27/09 ainda é 26/09 em Brasília.
  assertEquals(
    saoPauloTodayIso(new Date("2026-09-27T02:00:00Z")),
    "2026-09-26",
  );
});
