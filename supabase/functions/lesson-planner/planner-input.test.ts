/// <reference lib="deno.ns" />

/**
 * A entrada do modelo montada de verdade (sem banco, sem rede): o que chega ao
 * provedor de IA quando QUALQUER professor autorizado pede um plano — titular,
 * segundo professor, substituto da cobertura ou professor da reposição. O
 * motivo do acesso não é parâmetro da montagem; por isso um teste só vale para
 * todos, e é isso que se afirma aqui.
 */

import {
  approvedLessonsContext,
  normalizeApprovedMeetLessons,
} from "./approved-lessons.ts";
import {
  buildPlannerModelInput,
  buildPlannerRetrievalQuery,
  PLANNER_CLASS_LOG_COLUMNS,
  PLANNER_GIVEN_LESSON_COLUMNS,
  PLANNER_INTELLIGENCE_COLUMNS,
  PLANNER_MEMORY_COLUMNS,
  PLANNER_STUDENT_COLUMNS,
  type PlannerContextData,
  type PlannerGenerateRequest,
  type PlannerStudentRow,
} from "./planner-input.ts";

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

const TODAY = "2026-11-21";

const request = (
  taskMode: PlannerGenerateRequest["taskMode"] = "lesson_plan",
): PlannerGenerateRequest => ({
  action: "generate",
  studentId: "11111111-1111-4111-8111-111111111111",
  teacherRequest: "",
  taskMode,
  bilingual: true,
  durationMinutes: 30,
});

/**
 * Ficha do aluno como o banco devolveria se alguém voltasse a ler as colunas
 * pessoais: a montagem não pode usá-las nem que cheguem.
 */
const adultStudent = (
  overrides: Record<string, unknown> = {},
): PlannerStudentRow =>
  ({
    id: "11111111-1111-4111-8111-111111111111",
    tenant_id: "school-fixture",
    role: "STUDENT",
    module: "B1",
    english_for: "Trabalho",
    learning_objective: "Conversação",
    is_kids: false,
    birth_date: "1990-01-01",
    guardian_id: null,
    guardian_name: null,
    student_category: "adult",
    interests: ["futebol"],
    preferred_topics: null,
    avoided_topics: null,
    short_term_goal: "Reuniões em inglês",
    wolfie_settings: { level: "B1" },
    // Colunas pessoais — fora do cartão revisado.
    personality: "SENTINELA-PERSONALIDADE ansiosa com a separação dos pais",
    occupation: "SENTINELA-OCUPACAO gerente do banco X",
    long_term_goal: "SENTINELA-LONGO-PRAZO mudar com a família para o Canadá",
    ...overrides,
  }) as unknown as PlannerStudentRow;

const personalContext = (
  overrides: Partial<PlannerContextData> = {},
): PlannerContextData => ({
  intelligence: {
    estimated_level: "B1",
    primary_goal: "Reuniões em inglês",
    interests: ["futebol", "séries"],
    recurring_grammar_errors: ["he work → he works"],
    recommended_next_step: "Passo inferido pelo Wolfie",
    // Inferência do Wolfie sobre a vida do aluno — fora do cartão.
    profession: "SENTINELA-PROFISSAO médica",
    job_role: "SENTINELA-CARGO chefe de UTI",
    industry: "SENTINELA-SETOR hospital psiquiátrico",
    secondary_goals: ["SENTINELA-META-SECUNDARIA pagar a dívida da família"],
  },
  teacherCard: null,
  memoryItems: [],
  reports: [],
  learningMemories: [
    {
      source_type: "PLANNER_AI",
      verification_status: "PROPOSED",
      occurred_at: "2026-11-10T13:00:00Z",
      lesson_objective: "Perguntas no passado",
      content_practiced: ["did you…?"],
      new_vocabulary: [],
      recurring_errors: ["did you went → did you go"],
      strengths_observed: [],
      // Nota que ninguém revisou (inclusive a que o próprio Planner propôs).
      notes_to_verify: [
        "SENTINELA-NOTA aluna comentou que está em tratamento de depressão",
      ],
      metadata: { reviewed_by: "SENTINELA-METADATA" },
      source_ref: "SENTINELA-SOURCE-REF",
    },
    {
      source_type: "CLASS_LOG",
      verification_status: "VERIFIED",
      occurred_at: "2026-11-12T13:00:00Z",
      lesson_objective: "Rotina no trabalho",
      content_practiced: ["present simple"],
      notes_to_verify: [
        "SENTINELA-NOTA-VERIFICADA problema de saúde na família",
      ],
      metadata: { telefone: "SENTINELA-METADATA-2" },
    },
  ],
  approvedLessons: approvedLessonsContext([], null),
  classLogs: [
    {
      class_date: "2026-11-20",
      created_at: "2026-11-20T15:00:00Z",
      presence: "COMPLETED",
      lesson_objective: "Pedir informação no aeroporto",
      content_covered: "Perguntas indiretas",
      student_difficulties: "Ordem das palavras na pergunta indireta",
      homework_assigned: "Gravar 5 perguntas",
      recommended_next_step: "Pedir e confirmar informação por telefone",
      // Anotação livre de outro professor — o substituto nem lê isso pela RLS.
      observations:
        "SENTINELA-OBSERVACAO aluna passando por separação dos pais",
      psychological_profile: "SENTINELA-PERFIL-PSICOLOGICO",
      notes: "SENTINELA-NOTES",
    },
  ],
  previousPlans: [],
  materials: [],
  ...overrides,
});

const SENTINELS = [
  "SENTINELA-PERSONALIDADE",
  "SENTINELA-OCUPACAO",
  "SENTINELA-LONGO-PRAZO",
  "SENTINELA-PROFISSAO",
  "SENTINELA-CARGO",
  "SENTINELA-SETOR",
  "SENTINELA-META-SECUNDARIA",
  "SENTINELA-NOTA",
  "SENTINELA-METADATA",
  "SENTINELA-SOURCE-REF",
  "SENTINELA-OBSERVACAO",
  "SENTINELA-PERFIL-PSICOLOGICO",
  "SENTINELA-NOTES",
  "depressão",
  "separação dos pais",
  "saúde na família",
];

const FORBIDDEN_KEYS = [
  "notes_to_verify",
  "observations",
  "learning_style_note",
  "long_term_goal",
  "profession_or_context",
  "industry",
  "secondary_goals",
  'metadata":{"reviewed_by',
  "source_ref",
  "psychological_profile",
];

Deno.test("nenhum dado pessoal fora do cartão chega ao modelo — vale para todo professor que planeja", () => {
  for (const mode of ["lesson_plan", "homework", "student_feedback"] as const) {
    const input = buildPlannerModelInput(
      request(mode),
      adultStudent(),
      personalContext(),
      [],
      TODAY,
    );
    for (const sentinel of SENTINELS) {
      assert(
        !input.includes(sentinel),
        `${mode}: o prompt levou "${sentinel}" ao provedor de IA`,
      );
    }
    for (const key of FORBIDDEN_KEYS) {
      assert(!input.includes(key), `${mode}: o prompt leva a chave ${key}`);
    }
  }
});

Deno.test("o que é pedagógico continua chegando (o recorte não esvazia o plano)", () => {
  const input = JSON.parse(buildPlannerModelInput(
    request(),
    adultStudent(),
    personalContext(),
    [],
    TODAY,
  ));
  const log = input.recent_lesson_memory.recent_class_logs[0];
  assertEquals(Object.keys(log).sort(), [
    "content_covered",
    "date",
    "homework_assigned",
    "lesson_objective",
    "presence",
    "recommended_next_step",
    "student_difficulties",
  ]);
  assertEquals(
    log.recommended_next_step,
    "Pedir e confirmar informação por telefone",
  );
  assertEquals(
    log.student_difficulties,
    "Ordem das palavras na pergunta indireta",
  );

  const hypothesis = input.recent_lesson_memory.hypotheses_to_verify[0];
  assertEquals(hypothesis.recurring_errors, ["did you went → did you go"]);
  assert(!("notes_to_verify" in hypothesis), "hipótese levou notes_to_verify");

  assertEquals(Object.keys(input.student_profile).sort(), [
    "age_group",
    "cefr_level",
    "preferred_correction_mode",
    "preferred_language_mode",
    "preferred_topics",
    "primary_goal",
    "student_reference",
    "teacher_card_notes",
    "teacher_reviewed_fields",
    "topics_to_avoid",
  ]);
  assertEquals(input.student_profile.primary_goal, "Reuniões em inglês");
});

Deno.test("objetivo, temas e observação saem do cartão revisado (o cartão vence)", () => {
  const input = JSON.parse(buildPlannerModelInput(
    request(),
    adultStudent(),
    personalContext({
      teacherCard: {
        is_minor: false,
        card: {
          real_goal: "Apresentar resultados na reunião de segunda",
          engaging_topics: ["F1", "podcasts"],
          correction_style: "end",
          avoid_topics: ["política"],
          notes: "Prefere começar pela conversa livre",
          updated_at: "2026-11-01T12:00:00Z",
        },
      },
    }),
    [],
    TODAY,
  ));
  assertEquals(
    input.student_profile.primary_goal,
    "Apresentar resultados na reunião de segunda",
  );
  assertEquals(input.student_profile.preferred_topics, ["F1", "podcasts"]);
  assertEquals(
    input.student_profile.teacher_card_notes,
    "Prefere começar pela conversa livre",
  );
});

Deno.test("menor de idade: só objetivo e temas do cartão; nada de observação nem estilo", () => {
  const input = JSON.parse(buildPlannerModelInput(
    request(),
    adultStudent({ is_kids: true, birth_date: null }),
    personalContext({
      teacherCard: {
        // Mesmo que o banco dissesse adulto, a ficha diz turma infantil.
        is_minor: false,
        card: {
          real_goal: "Ler histórias curtas",
          engaging_topics: ["dinossauros"],
          correction_style: "immediate",
          avoid_topics: ["escola nova"],
          notes: "SENTINELA-NOTA-MENOR pais em processo de divórcio",
          updated_at: "2026-11-01T12:00:00Z",
        },
      },
    }),
    [],
    TODAY,
  ));
  assertEquals(input.student_profile.primary_goal, "Ler histórias curtas");
  assertEquals(input.student_profile.teacher_card_notes, "");
  assertEquals(input.student_profile.topics_to_avoid, []);
  assert(
    !JSON.stringify(input).includes("SENTINELA-NOTA-MENOR"),
    "nota pessoal do cartão de menor chegou ao modelo",
  );
});

Deno.test("as consultas ao banco nem leem as colunas pessoais", () => {
  const forbidden: Record<string, readonly string[]> = {
    profiles: ["personality", "occupation", "long_term_goal"],
    wolf_intelligence: [
      "profession",
      "job_role",
      "industry",
      "secondary_goals",
    ],
    student_learning_memories: ["notes_to_verify", "metadata", "source_ref"],
    class_logs: [
      "observations",
      "psychological_profile",
      "notes",
      "teacher_verdict",
      "review_notes",
    ],
  };
  const lists: Record<string, readonly string[]> = {
    profiles: PLANNER_STUDENT_COLUMNS,
    wolf_intelligence: PLANNER_INTELLIGENCE_COLUMNS,
    student_learning_memories: PLANNER_MEMORY_COLUMNS,
    class_logs: [...PLANNER_CLASS_LOG_COLUMNS, ...PLANNER_GIVEN_LESSON_COLUMNS],
  };
  for (const [table, columns] of Object.entries(forbidden)) {
    for (const column of columns) {
      assert(
        !lists[table].includes(column),
        `a consulta de ${table} lê ${column}`,
      );
    }
  }
  // O recorte do dossiê do substituto entra inteiro.
  for (
    const column of [
      "lesson_objective",
      "content_covered",
      "student_difficulties",
      "homework_assigned",
      "recommended_next_step",
    ]
  ) {
    assert(
      PLANNER_CLASS_LOG_COLUMNS.includes(
        column as typeof PLANNER_CLASS_LOG_COLUMNS[number],
      ),
      `class_logs perdeu ${column}`,
    );
  }
});

Deno.test("aula aprovada que ficou para trás não guia o plano nem a busca da base", () => {
  const lessons = normalizeApprovedMeetLessons([
    {
      source_type: "MEET_SESSION",
      verification_status: "VERIFIED",
      occurred_at: "2026-09-23T13:00:00Z",
      lesson_objective: "Rotina",
      recurring_errors: ["erro aprovado de setembro"],
      recommended_next_step: "Próximo passo aprovado de setembro",
    },
  ]);

  const stale = personalContext({
    approvedLessons: approvedLessonsContext(lessons, "2026-11-20"),
  });
  const staleInput = JSON.parse(
    buildPlannerModelInput(
      request("homework"),
      adultStudent(),
      stale,
      [],
      TODAY,
    ),
  );
  assertEquals(staleInput.approved_lessons.task_focus, "use_as_evidence");
  assertEquals(staleInput.approved_lessons.continue_from, null);
  assertEquals(staleInput.approved_lessons.recurring_errors_to_target, []);
  assertEquals(
    staleInput.approved_lessons.newer_logged_lesson_date,
    "2026-11-20",
  );
  const staleQuery = JSON.parse(
    buildPlannerRetrievalQuery(
      request("homework"),
      adultStudent(),
      stale,
      TODAY,
    ),
  );
  assertEquals(staleQuery.recommended_next_step, "Passo inferido pelo Wolfie");
  assert(
    !staleQuery.recurring_needs.includes("erro aprovado de setembro"),
    "a busca da base ainda parte do erro aprovado que ficou para trás",
  );

  const fresh = personalContext({
    approvedLessons: approvedLessonsContext(lessons, "2026-09-23"),
  });
  const freshQuery = JSON.parse(
    buildPlannerRetrievalQuery(
      request("homework"),
      adultStudent(),
      fresh,
      TODAY,
    ),
  );
  assertEquals(
    freshQuery.recommended_next_step,
    "Próximo passo aprovado de setembro",
  );
  assertEquals(freshQuery.recurring_needs[0], "erro aprovado de setembro");
  const freshInput = JSON.parse(
    buildPlannerModelInput(
      request("homework"),
      adultStudent(),
      fresh,
      [],
      TODAY,
    ),
  );
  assertEquals(
    freshInput.approved_lessons.task_focus,
    "homework_attacks_recurring_errors",
  );
});
