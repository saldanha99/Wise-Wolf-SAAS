/// <reference lib="deno.ns" />

import {
  type InferredStudentSignals,
  isMinorStudent,
  normalizeTeacherCard,
  plannerSignalsFor,
  type PlannerStudentFacts,
  readPlannerCardPayload,
  resolveStudentSignals,
  saoPauloTodayIso,
  studentProfileSignalFields,
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

const minor = (
  isKids: unknown,
  birthDate: unknown,
  today: string,
  extra: { guardianId?: unknown; guardianName?: unknown } = {},
) =>
  isMinorStudent({ studentId: "aluno-1", isKids, birthDate, ...extra }, today);

Deno.test("régua local: data de nascimento como o banco faz", () => {
  const today = "2026-09-26";
  assert(minor(true, null, today), "is_kids é menor");
  assert(!minor(false, null, today), "sem data, localmente, fica para o banco");
  assert(!minor(null, "1990-05-01", today));
  assert(minor(false, "2011-03-10", today), "15 anos");
  // Faz 18 hoje: adulto. Faz 18 amanhã: ainda menor.
  assert(!minor(false, "2008-09-26", today));
  assert(minor(false, "2008-09-27", today));
  // Nascido em 29/02: vira adulto em 01/03 de ano não bissexto.
  assert(minor(false, "2008-02-29", "2026-02-28"));
  assert(!minor(false, "2008-02-29", "2026-03-01"));
  assert(!minor(false, "data-invalida", today));
});

Deno.test("régua local: responsável cadastrado é menor, com ou sem data", () => {
  const today = "2026-09-26";
  // O caso real de 26/09/2026: guardian_id preenchido, sem data, sem is_kids.
  assert(minor(false, null, today, { guardianId: "responsavel-1" }));
  assert(minor(false, "1990-05-01", today, { guardianName: "Mãe do aluno" }));
  assert(!minor(false, null, today, { guardianName: "   " }), "nome vazio");
  assert(!minor(false, null, today, { guardianId: "aluno-1" }), "ele mesmo");
  assert(!minor(false, null, today, { guardianId: null, guardianName: null }));
});

Deno.test("hoje é a data de São Paulo, não a de UTC", () => {
  // 02:00 UTC de 27/09 ainda é 26/09 em Brasília.
  assertEquals(
    saoPauloTodayIso(new Date("2026-09-27T02:00:00Z")),
    "2026-09-26",
  );
});

// ---------------------------------------------------------------------------
// O que o index.ts do Planner usa (plannerSignalsFor): ficha + Wolfie + a
// resposta de student_learning_card_for_planner.
// ---------------------------------------------------------------------------
const adultStudent: PlannerStudentFacts = {
  id: "aluno-1",
  is_kids: false,
  birth_date: "1990-05-01",
  guardian_id: null,
  guardian_name: null,
  english_for: "Trabalho",
  learning_objective: "Fluência",
  short_term_goal: "Entrevista em inglês",
  interests: ["culinária"],
  preferred_topics: ["cinema"],
  avoided_topics: ["assunto do cadastro"],
};

const wolfieRow = {
  primary_goal: "Inferido pelo Wolfie: viagem",
  interests: ["games"],
  preferred_correction_mode: "immediate",
};

const adultPayload = {
  is_minor: false,
  minor_reason: null,
  card: fullCardRow,
};

Deno.test("Planner: o cartão vence o Wolfie e a ficha no student_profile", () => {
  const signals = plannerSignalsFor(
    adultStudent,
    wolfieRow,
    adultPayload,
    "2026-09-26",
  );
  const fields = studentProfileSignalFields(signals);
  assertEquals(fields.primary_goal, "Apresentar resultados em reuniões");
  assertEquals(fields.preferred_topics, ["futebol", "séries"]);
  assertEquals(fields.topics_to_avoid, ["spoilers"]);
  assertEquals(fields.preferred_correction_mode, "selective");
  assertEquals(fields.teacher_card_notes, "Rende mais com roleplay.");
  assertEquals(fields.teacher_reviewed_fields, [
    "primary_goal",
    "preferred_topics",
    "topics_to_avoid",
    "preferred_correction_mode",
    "teacher_notes",
  ]);
});

Deno.test("Planner: sem cartão, Wolfie antes da ficha, como sempre foi", () => {
  const fields = studentProfileSignalFields(
    plannerSignalsFor(
      adultStudent,
      wolfieRow,
      { is_minor: false, card: null },
      "2026-09-26",
    ),
  );
  assertEquals(fields.primary_goal, "Inferido pelo Wolfie: viagem");
  assertEquals(fields.preferred_topics, ["games"]);
  assertEquals(fields.topics_to_avoid, ["assunto do cadastro"]);
  assertEquals(fields.preferred_correction_mode, "immediate");
  assertEquals(fields.teacher_card_notes, "");
  assertEquals(fields.teacher_reviewed_fields, []);
  // Sem Wolfie: a ficha.
  const fromProfile = studentProfileSignalFields(
    plannerSignalsFor(adultStudent, null, null, "2026-09-26"),
  );
  assertEquals(fromProfile.primary_goal, "Entrevista em inglês");
  assertEquals(fromProfile.preferred_topics, ["cinema"]);
});

Deno.test("Planner: o banco diz menor, os campos pessoais caem", () => {
  const fields = studentProfileSignalFields(
    plannerSignalsFor(
      adultStudent,
      wolfieRow,
      { is_minor: true, minor_reason: "AGE_UNKNOWN", card: fullCardRow },
      "2026-09-26",
    ),
  );
  assertEquals(fields.primary_goal, "Apresentar resultados em reuniões");
  assertEquals(fields.teacher_card_notes, "");
  assertEquals(fields.topics_to_avoid, ["assunto do cadastro"]);
  assertEquals(fields.preferred_correction_mode, "immediate");
  assertEquals(fields.teacher_reviewed_fields, [
    "primary_goal",
    "preferred_topics",
  ]);
});

Deno.test("Planner: responsável na ficha derruba os campos pessoais mesmo se o banco disser adulto", () => {
  const fields = studentProfileSignalFields(
    plannerSignalsFor(
      { ...adultStudent, birth_date: null, guardian_id: "responsavel-1" },
      wolfieRow,
      adultPayload,
      "2026-09-26",
    ),
  );
  assertEquals(fields.teacher_card_notes, "");
  assertEquals(fields.preferred_correction_mode, "immediate");
});

Deno.test("Planner: resposta sem is_minor explícito não libera nota pessoal", () => {
  const card = readPlannerCardPayload({ card: fullCardRow }, false);
  assert(card);
  assertEquals(card.notes, "");
  assertEquals(card.avoidTopics, []);
  assertEquals(card.correctionStyle, null);
  assertEquals(readPlannerCardPayload(null, false), null);
  assertEquals(readPlannerCardPayload("erro", false), null);
});
