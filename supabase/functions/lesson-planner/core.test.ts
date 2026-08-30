/// <reference lib="deno.ns" />

import {
  chatCompletionFailure,
  extractChatCompletionText,
  extractEmbeddingVector,
  filterRecommendedMaterials,
  knowledgeMatchesToSources,
  memoryHasContent,
  normalizeKnowledgeMatches,
  normalizePlannerResult,
  parsePlannerRequest,
  plannerLevelRequiresHighAccuracy,
  plannerModelProfile,
  type PlannerResult,
  plannerResultQualityGaps,
  redactDirectIdentifiers,
  safetyIdentifier,
  selectPlannerModel,
} from "./core.ts";

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

function modelResult(sectionMinutes = [40, 20]): PlannerResult {
  return {
    task_mode: "lesson_plan",
    title: "Speaking with confidence",
    objective: "Sustentar uma conversa curta.",
    level: "B1",
    duration_minutes: 60,
    bilingual: true,
    overview: "Aula comunicativa.",
    sections: sectionMinutes.map((minutes, index) => ({
      title: `Bloco ${index + 1}`,
      minutes,
      teacher_guidance: "Oriente a atividade.",
      student_task: "Fale em inglês.",
      examples: [{
        english: "I can explain it.",
        portuguese: "Eu consigo explicar.",
      }],
    })),
    vocabulary: [],
    teacher_questions: [],
    expected_corrections: [],
    homework: "Grave um áudio.",
    materials: [
      { title: "Business Speaking.pdf", usage: "Use no roleplay." },
      { title: "Material inventado", usage: "Não deve passar." },
    ],
    assessment_criteria: [],
    strengths: [],
    priorities: [],
    next_steps: [],
    student_memory_update: {
      lesson_objective: "",
      content_practiced: [],
      new_vocabulary: [],
      recurring_errors: [],
      corrections_mastered: [],
      strengths_observed: [],
      homework_assigned: "",
      recommended_next_step: "",
      confidence_level: "LOW",
      notes_to_verify: [],
    },
    ai_memory_reflection: "",
    warnings: [],
  };
}

Deno.test("parsePlannerRequest accepts the legacy generation field names", () => {
  const parsed = parsePlannerRequest({
    student_id: "9cc8acc8-b68a-4b43-a471-934e31c6c7d1",
    custom_prompt: "Pratique uma apresentação.",
    duration_minutes: 30,
    bilingual: false,
  });
  assert(parsed.action === "generate");
  assertEquals(parsed.teacherRequest, "Pratique uma apresentação.");
  assertEquals(parsed.durationMinutes, 30);
  assertEquals(parsed.bilingual, false);
});

Deno.test("direct identifiers are removed before model input or persistence", () => {
  const redacted = redactDirectIdentifiers(
    "Contato aluno@example.com, CPF 000.000.000-00 e +55 11 99999-9999.",
  );
  assert(!redacted.includes("aluno@example.com"));
  assert(!redacted.includes("000.000.000-00"));
  assert(!redacted.includes("99999-9999"));
  assert(redacted.includes("[EMAIL_REMOVIDO]"));
  assert(redacted.includes("[CPF_REMOVIDO]"));
});

Deno.test("parsePlannerRequest rejects unknown actions", () => {
  let thrown = false;
  try {
    parsePlannerRequest({
      action: "delete",
      student_id: "9cc8acc8-b68a-4b43-a471-934e31c6c7d1",
    });
  } catch {
    thrown = true;
  }
  assert(thrown);
});

Deno.test("parsePlannerRequest rejects a supplied unknown task mode", () => {
  let thrown = false;
  try {
    parsePlannerRequest({
      student_id: "9cc8acc8-b68a-4b43-a471-934e31c6c7d1",
      task_mode: "ignore_all_rules",
    });
  } catch {
    thrown = true;
  }
  assert(thrown);
});

Deno.test("parsePlannerRequest normalizes non-finite durations", () => {
  const parsed = parsePlannerRequest({
    student_id: "9cc8acc8-b68a-4b43-a471-934e31c6c7d1",
    duration_minutes: Number.NaN,
  });
  assert(parsed.action === "generate");
  assertEquals(parsed.durationMinutes, 30);
});

Deno.test("normalizePlannerResult makes lesson sections total the requested time", () => {
  const request = parsePlannerRequest({
    action: "generate",
    student_id: "9cc8acc8-b68a-4b43-a471-934e31c6c7d1",
    duration_minutes: 30,
  });
  assert(request.action === "generate");
  const result = normalizePlannerResult(modelResult(), request);
  const total = result.sections.reduce(
    (sum, section) => sum + section.minutes,
    0,
  );
  assertEquals(total, 30);
  assertEquals(result.sections.map((section) => section.minutes), [30, 0]);
});

Deno.test("normalizePlannerResult also fills missing lesson minutes", () => {
  const request = parsePlannerRequest({
    action: "generate",
    student_id: "9cc8acc8-b68a-4b43-a471-934e31c6c7d1",
    duration_minutes: 30,
  });
  assert(request.action === "generate");
  const result = normalizePlannerResult(modelResult([3, 7]), request);
  assertEquals(result.sections.map((section) => section.minutes), [3, 27]);
});

Deno.test("planner quality gate rejects a structurally incomplete lesson", () => {
  const request = parsePlannerRequest({
    action: "generate",
    student_id: "9cc8acc8-b68a-4b43-a471-934e31c6c7d1",
    duration_minutes: 30,
    bilingual: true,
  });
  assert(request.action === "generate");
  const gaps = plannerResultQualityGaps(modelResult([4]), request);
  assert(gaps.includes("lesson_section_count"));
  assert(gaps.includes("lesson_minutes_total"));
  assert(gaps.includes("lesson_vocabulary"));
  assert(gaps.includes("lesson_teacher_questions"));
});

Deno.test("planner quality gate accepts a complete 30-minute lesson", () => {
  const request = parsePlannerRequest({
    action: "generate",
    student_id: "9cc8acc8-b68a-4b43-a471-934e31c6c7d1",
    duration_minutes: 30,
    bilingual: true,
  });
  assert(request.action === "generate");
  const result = modelResult([6, 6, 6, 6, 6]);
  result.vocabulary = Array.from({ length: 4 }, (_, index) => ({
    item: `chunk ${index + 1}`,
    meaning_pt: "significado",
    example_en: "I can explain it.",
    use_question_en: "Can you explain it?",
  }));
  result.teacher_questions = Array.from({ length: 4 }, () => ({
    question_en: "Can you explain it?",
    model_answer_en: "Yes, I can.",
    translation_pt: "Você consegue explicar?",
  }));
  assertEquals(plannerResultQualityGaps(result, request), []);
  result.sections = modelResult([6, 6, 6, 6, 8]).sections;
  assertEquals(plannerResultQualityGaps(result, request), []);
  const normalized = normalizePlannerResult(result, request);
  assertEquals(
    normalized.sections.reduce((sum, section) => sum + section.minutes, 0),
    30,
  );
});

Deno.test("future-generation modes cannot create factual student memory", () => {
  const request = parsePlannerRequest({
    action: "generate",
    student_id: "9cc8acc8-b68a-4b43-a471-934e31c6c7d1",
    task_mode: "lesson_plan",
  });
  assert(request.action === "generate");
  const raw = modelResult([15, 15]);
  raw.student_memory_update.lesson_objective = "Objetivo ainda não praticado";
  raw.student_memory_update.content_practiced = ["Conteúdo futuro"];
  raw.student_memory_update.new_vocabulary = ["future chunk"];
  raw.student_memory_update.recurring_errors = ["Erro inventado"];
  raw.student_memory_update.corrections_mastered = ["Correção inventada"];
  raw.student_memory_update.strengths_observed = ["Força inventada"];
  raw.student_memory_update.homework_assigned = "Tarefa ainda não atribuída";
  raw.student_memory_update.recommended_next_step = "Passo inventado";
  raw.student_memory_update.notes_to_verify = ["Hipótese explícita"];
  const normalized = normalizePlannerResult(raw, request);
  assertEquals(normalized.student_memory_update, {
    lesson_objective: "",
    content_practiced: [],
    new_vocabulary: [],
    recurring_errors: [],
    corrections_mastered: [],
    strengths_observed: [],
    homework_assigned: "",
    recommended_next_step: "",
    confidence_level: "LOW",
    notes_to_verify: ["Hipótese explícita"],
  });
});

Deno.test("planner routes evaluation modes to the high-accuracy model", () => {
  assertEquals(
    selectPlannerModel(
      "lesson_plan",
      "openai/gpt-4o-mini",
      "openai/gpt-5-mini",
    ),
    "openai/gpt-4o-mini",
  );
  for (
    const mode of [
      "student_feedback",
      "oral_test",
      "presentation_coaching",
      "progress_report",
    ] as const
  ) {
    assertEquals(
      selectPlannerModel(
        mode,
        "openai/gpt-4o-mini",
        "openai/gpt-5-mini",
      ),
      "openai/gpt-5-mini",
    );
  }
});

Deno.test("planner routes B2 and C-level students to the high-accuracy model", () => {
  assertEquals(plannerLevelRequiresHighAccuracy("A2"), false);
  assertEquals(plannerLevelRequiresHighAccuracy("B1-B2"), true);
  assertEquals(plannerLevelRequiresHighAccuracy("C1 Advanced"), true);
  assertEquals(
    selectPlannerModel(
      "lesson_plan",
      "openai/gpt-4o-mini",
      "openai/gpt-5-mini",
      "B2",
    ),
    "openai/gpt-5-mini",
  );
  assertEquals(
    selectPlannerModel(
      "homework",
      "openai/gpt-4o-mini",
      "openai/gpt-5-mini",
      "B1",
    ),
    "openai/gpt-4o-mini",
  );
});

Deno.test("GPT-4o mini profile omits reasoning and stays deterministic", () => {
  assertEquals(plannerModelProfile("openai/gpt-4o-mini"), {
    supportsReasoning: false,
    temperature: 0.2,
    timeoutMs: 25_000,
  });
  assertEquals(plannerModelProfile("openai/gpt-5-mini"), {
    supportsReasoning: true,
    temperature: null,
    timeoutMs: 25_000,
  });
});

Deno.test("recommended materials are restricted to approved or retrieved titles", () => {
  const filtered = filterRecommendedMaterials(modelResult().materials, [
    "Business Speaking",
  ]);
  assertEquals(filtered, [{
    title: "Business Speaking",
    usage: "Use no roleplay.",
  }]);
});

Deno.test("ambiguous normalized material titles are not recommended", () => {
  const filtered = filterRecommendedMaterials(
    [{ title: "Lesson One", usage: "Use." }],
    ["Lesson One.pdf", "Lesson-One.docx"],
  );
  assertEquals(filtered, []);
});

Deno.test("OpenRouter chat helpers extract structured text", () => {
  const payload = {
    id: "gen_123",
    choices: [{
      finish_reason: "stop",
      message: { content: '{"title":"Plano"}' },
    }],
  };
  assertEquals(extractChatCompletionText(payload), '{"title":"Plano"}');
  assertEquals(chatCompletionFailure(payload), null);
});

Deno.test("pgvector matches are bounded and converted to audit-only sources", () => {
  const matches = normalizeKnowledgeMatches([
    {
      chunk_id: "chunk_123",
      document_id: "doc_123",
      title: "Wise Wolf Method.md",
      content: "Use guided production before free production.",
      similarity: 1.4,
      chunk_index: 2,
      metadata: { level: "B1", nested: { ignore: true } },
    },
    {
      chunk_id: "chunk_123",
      document_id: "doc_123",
      title: "duplicado",
      content: "duplicado",
    },
  ]);
  assertEquals(matches.length, 1);
  assertEquals(matches[0].similarity, 1);
  assertEquals(knowledgeMatchesToSources(matches), [{
    source_id: "chunk_123",
    document_id: "doc_123",
    title: "Wise Wolf Method.md",
    score: 1,
    attributes: { level: "B1", chunk_index: 2 },
  }]);
});

Deno.test("OpenRouter response helper distinguishes refusal and incomplete output", () => {
  assertEquals(
    chatCompletionFailure({ choices: [] }),
    "incomplete",
  );
  assertEquals(
    chatCompletionFailure({
      choices: [{
        finish_reason: "content_filter",
        message: { content: "" },
      }],
    }),
    "refusal",
  );
  assertEquals(
    chatCompletionFailure({ error: { code: 503, message: "overloaded" } }),
    "provider_error",
  );
  assertEquals(
    chatCompletionFailure({
      choices: [{
        finish_reason: "error",
        error: {
          metadata: { error_type: "content_policy_violation" },
        },
        message: { content: "" },
      }],
    }),
    "refusal",
  );
});

Deno.test("OpenRouter embeddings require the configured dimensions and finite values", () => {
  assertEquals(
    extractEmbeddingVector({
      data: [{ embedding: [0.1, -0.2, 0.3] }],
    }, 3),
    [0.1, -0.2, 0.3],
  );
  assertEquals(
    extractEmbeddingVector({
      data: [{ embedding: [0.1, Number.NaN, 0.3] }],
    }, 3),
    null,
  );
  assertEquals(
    extractEmbeddingVector({ data: [{ embedding: [0.1] }] }, 3),
    null,
  );
});

Deno.test("empty memory proposals remain empty", () => {
  const request = parsePlannerRequest({
    student_id: "9cc8acc8-b68a-4b43-a471-934e31c6c7d1",
  });
  assert(request.action === "generate");
  const result = normalizePlannerResult(modelResult([15, 15]), request);
  assertEquals(memoryHasContent(result.student_memory_update), false);
});

Deno.test("safety identifier is stable and separates tenants", async () => {
  const first = await safetyIdentifier("tenant-a", "teacher-a");
  const repeated = await safetyIdentifier("tenant-a", "teacher-a");
  const other = await safetyIdentifier("tenant-b", "teacher-a");
  assertEquals(first, repeated);
  assert(first !== other);
  assert(/^wwp_[0-9a-f]{32}$/.test(first));
});
