/// <reference lib="deno.ns" />

import {
  APPROVED_LESSON_COLUMNS,
  APPROVED_LESSONS_SYSTEM_PROMPT,
  type ApprovedLesson,
  approvedLessonBasis,
  approvedLessonsPromptBlock,
  approvedLessonsTaskFocus,
  dayMonth,
  joinPtBr,
  legacyContentWithBasis,
  LESSON_PLANNER_PROMPT_VERSION,
  MEET_APPROVED_LESSON_LIMIT,
  normalizeApprovedMeetLessons,
  recurringErrorsToTarget,
} from "./approved-lessons.ts";
import { WISE_WOLF_PROMPT_VERSION } from "./wise-wolf-training-engine.ts";

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

/** Linha como o banco devolve (com colunas que NÃO podem chegar ao modelo). */
const meetRow = (
  occurredAt: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  source_type: "MEET_SESSION",
  verification_status: "VERIFIED",
  occurred_at: occurredAt,
  lesson_objective: "Falar da rotina de trabalho",
  content_practiced: ["present simple", "daily routine chunks"],
  new_vocabulary: ["commute"],
  recurring_errors: ["he work → he works"],
  corrections_mastered: [],
  strengths_observed: ["boa fluência"],
  homework_assigned: "Gravar 1 minuto sobre a rotina",
  recommended_next_step: "Praticar terceira pessoa em perguntas",
  ...overrides,
});

Deno.test("só resumo do Meet APROVADO entra, com a data da aula no fuso da escola", () => {
  const lessons = normalizeApprovedMeetLessons([
    meetRow("2026-09-23T13:00:00Z"),
    meetRow("2026-09-22T13:00:00Z", { verification_status: "PROPOSED" }),
    meetRow("2026-09-21T13:00:00Z", { verification_status: "REJECTED" }),
    meetRow("2026-09-20T13:00:00Z", { source_type: "PLANNER_AI" }),
    meetRow("data inválida"),
    null,
    "lixo",
    // 01:30 UTC de 20/09 ainda é 19/09 em São Paulo.
    meetRow("2026-09-20T01:30:00Z"),
  ]);
  assertEquals(lessons.map((lesson) => lesson.lessonDate), [
    "2026-09-23",
    "2026-09-19",
  ]);
  assertEquals(normalizeApprovedMeetLessons(undefined), []);
  assertEquals(normalizeApprovedMeetLessons({ not: "array" }), []);
});

Deno.test("no máximo as 6 aulas aprovadas mais recentes, da mais nova para a mais velha", () => {
  const rows = Array.from(
    { length: 9 },
    (_, index) =>
      meetRow(`2026-09-${String(10 + index).padStart(2, "0")}T15:00:00Z`),
  ).reverse();
  // Ordem embaralhada não muda o resultado.
  const shuffled = [rows[4], rows[0], rows[8], rows[2], rows[6], rows[1]]
    .concat(rows[3], rows[5], rows[7]);
  const lessons = normalizeApprovedMeetLessons(shuffled);
  assertEquals(MEET_APPROVED_LESSON_LIMIT, 6);
  assertEquals(lessons.map((lesson) => lesson.lessonDate), [
    "2026-09-18",
    "2026-09-17",
    "2026-09-16",
    "2026-09-15",
    "2026-09-14",
    "2026-09-13",
  ]);
});

Deno.test("só campos pedagógicos: metadata, notas, origem e revisor nunca chegam ao modelo", () => {
  const lessons = normalizeApprovedMeetLessons([
    meetRow("2026-09-23T13:00:00Z", {
      source_ref: "11111111-1111-4111-8111-111111111111",
      metadata: {
        reviewed_by: "22222222-2222-4222-8222-222222222222",
        telefone: "11 98888-7777",
      },
      notes_to_verify: ["mãe comentou problema de saúde"],
      created_by: "33333333-3333-4333-8333-333333333333",
      confidence_level: "HIGH",
      // Identificador direto dentro de campo pedagógico também sai.
      homework_assigned:
        "Mandar o áudio para maria@example.com ou 11 98888-7777",
    }),
  ]);
  const block = approvedLessonsPromptBlock(lessons, "lesson_plan");
  const serialized = JSON.stringify(block);
  for (
    const forbidden of [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
      "reviewed_by",
      "saúde",
      "notes_to_verify",
      "metadata",
      "source_ref",
      "maria@example.com",
      "98888-7777",
    ]
  ) {
    assert(
      !serialized.includes(forbidden),
      `approved_lessons levou ${forbidden} ao modelo`,
    );
  }
  assertEquals(Object.keys(block.lessons[0]).sort(), [
    "content_practiced",
    "corrections_mastered",
    "homework_assigned",
    "lesson_date",
    "lesson_objective",
    "new_vocabulary",
    "recommended_next_step",
    "recurring_errors",
    "strengths_observed",
  ]);
  // A consulta lê só colunas pedagógicas + filtro e data.
  for (const column of APPROVED_LESSON_COLUMNS) {
    assert(
      !["metadata", "notes_to_verify", "source_ref", "created_by"].includes(
        column,
      ),
      `a consulta das aulas aprovadas lê ${column}`,
    );
  }
});

Deno.test("a base diz as datas das aulas: dd/mm, sem repetir o dia, em ordem", () => {
  assertEquals(dayMonth("2026-09-05"), "05/09");
  assertEquals(joinPtBr(["a"]), "a");
  assertEquals(joinPtBr(["a", "b"]), "a e b");
  assertEquals(joinPtBr(["a", "b", "c"]), "a, b e c");

  const one = normalizeApprovedMeetLessons([meetRow("2026-09-23T13:00:00Z")]);
  assertEquals(
    approvedLessonBasis(one, "lesson_plan")?.label,
    "Baseado na aula de 23/09",
  );

  const two = normalizeApprovedMeetLessons([
    meetRow("2026-09-20T13:00:00Z"),
    meetRow("2026-09-23T13:00:00Z"),
  ]);
  assertEquals(
    approvedLessonBasis(two, "lesson_plan")?.label,
    "Baseado nas aulas de 20/09 e 23/09",
  );

  // Aula de 1 h partida em dois horários do mesmo dia conta uma data.
  const three = normalizeApprovedMeetLessons([
    meetRow("2026-09-16T13:00:00Z"),
    meetRow("2026-09-23T13:00:00Z"),
    meetRow("2026-09-23T13:30:00Z"),
    meetRow("2026-09-20T13:00:00Z"),
  ]);
  const basis = approvedLessonBasis(three, "lesson_plan");
  assertEquals(basis?.lesson_dates, ["2026-09-16", "2026-09-20", "2026-09-23"]);
  assertEquals(basis?.label, "Baseado nas aulas de 16/09, 20/09 e 23/09");
  assertEquals(basis?.source, "MEET_APPROVED_SUMMARIES");

  // Sem aula aprovada não há base — e a entrada do modelo diz isso.
  assertEquals(approvedLessonBasis([], "lesson_plan"), null);
  const empty = approvedLessonsPromptBlock([], "lesson_plan");
  assertEquals(empty.basis_label, "");
  assertEquals(empty.task_focus, "none");
  assertEquals(empty.lessons, []);
  assertEquals(empty.continue_from, null);
});

Deno.test("o plano continua do próximo passo aprovado MAIS RECENTE", () => {
  const lessons = normalizeApprovedMeetLessons([
    meetRow("2026-09-20T13:00:00Z", {
      recommended_next_step: "Passo antigo",
    }),
    meetRow("2026-09-23T13:00:00Z", {
      recommended_next_step: "Perguntas com does/doesn't",
    }),
  ]);
  const expected = {
    lesson_date: "2026-09-23",
    recommended_next_step: "Perguntas com does/doesn't",
  };
  assertEquals(
    approvedLessonBasis(lessons, "lesson_plan")?.continued_from,
    expected,
  );
  const block = approvedLessonsPromptBlock(lessons, "lesson_plan");
  assertEquals(block.continue_from, expected);
  assertEquals(block.task_focus, "continue_from_recommended_next_step");
  // Plano de aula não mostra alvo de lição.
  assertEquals(
    approvedLessonBasis(lessons, "lesson_plan")?.homework_targets,
    [],
  );
});

Deno.test("a lição (homework) ataca os erros recorrentes aprovados, os que mais voltam primeiro", () => {
  const lessons = normalizeApprovedMeetLessons([
    meetRow("2026-09-16T13:00:00Z", {
      recurring_errors: [
        "He work → he works",
        "in the weekend → on the weekend",
      ],
    }),
    meetRow("2026-09-20T13:00:00Z", {
      recurring_errors: ["he  work → he works", "I have 30 years → I'm 30"],
    }),
    meetRow("2026-09-23T13:00:00Z", {
      recurring_errors: ["I have 30 years → I'm 30", "he work → he works"],
    }),
  ]);
  const targets = recurringErrorsToTarget(lessons);
  // Voltou em 3 aulas, depois em 2, depois em 1 — texto da aula mais recente.
  assertEquals(targets, [
    "he work → he works",
    "I have 30 years → I'm 30",
    "in the weekend → on the weekend",
  ]);
  const basis = approvedLessonBasis(lessons, "homework");
  assertEquals(basis?.homework_targets, targets);
  const block = approvedLessonsPromptBlock(lessons, "homework");
  assertEquals(block.task_focus, "homework_attacks_recurring_errors");
  assertEquals(block.recurring_errors_to_target, targets);
  assertEquals(recurringErrorsToTarget(lessons, 1), ["he work → he works"]);
});

Deno.test("feedback e relatório usam as aulas como evidência", () => {
  const lessons = normalizeApprovedMeetLessons([
    meetRow("2026-09-23T13:00:00Z"),
  ]);
  assertEquals(
    approvedLessonsTaskFocus(lessons, "student_feedback"),
    "use_as_evidence",
  );
  assertEquals(
    approvedLessonsTaskFocus(lessons, "progress_report"),
    "use_as_evidence",
  );
  assertEquals(
    approvedLessonsTaskFocus(lessons, "class_script"),
    "continue_from_recommended_next_step",
  );
  assertEquals(approvedLessonsTaskFocus([], "homework"), "none");
});

Deno.test("o texto salvo do plano começa pela base, e sem base fica igual", () => {
  const lessons: ApprovedLesson[] = normalizeApprovedMeetLessons([
    meetRow("2026-09-20T13:00:00Z"),
    meetRow("2026-09-23T13:00:00Z"),
  ]);
  const basis = approvedLessonBasis(lessons, "lesson_plan");
  assertEquals(
    legacyContentWithBasis(basis, "Warm-up (5 min)"),
    "Baseado nas aulas de 20/09 e 23/09.\n\nWarm-up (5 min)",
  );
  assertEquals(
    legacyContentWithBasis(null, "Warm-up (5 min)"),
    "Warm-up (5 min)",
  );
});

Deno.test("regra do modelo e versão do prompt do lesson-planner", () => {
  for (
    const rule of [
      "approved_lessons",
      "continue_from.recommended_next_step",
      "recurring_errors_to_target",
      "basis_label",
      "Não deduza nem registre fato pessoal",
    ]
  ) {
    assert(
      APPROVED_LESSONS_SYSTEM_PROMPT.includes(rule),
      `a regra do modelo perdeu ${rule}`,
    );
  }
  assert(
    LESSON_PLANNER_PROMPT_VERSION.startsWith(`${WISE_WOLF_PROMPT_VERSION}+`) &&
      LESSON_PLANNER_PROMPT_VERSION.length >
        WISE_WOLF_PROMPT_VERSION.length + 1,
    "a versão do prompt do lesson-planner não distingue as aulas aprovadas",
  );
});
