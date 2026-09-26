/// <reference lib="deno.ns" />

/**
 * Amarra o index.ts do Planner ao cartão do aluno. A regra "o cartão vence o
 * Wolfie e a ficha" é provada em teacher-card.test.ts (plannerSignalsFor); aqui
 * se prova que o index.ts USA essa conta — sem isso, voltar buildModelInput a
 * ler intelligence.interests direto, trocar a RPC ou perder o filtro por aluno
 * deixaria todos os testes verdes. Precisa de --allow-read.
 */

const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Corpo de uma função de topo do index.ts (até a próxima função de topo). */
function functionBody(name: string): string {
  const start = source.search(
    new RegExp(`\\n(?:async )?function ${name}\\(`),
  );
  assert(start >= 0, `index.ts perdeu a função ${name}`);
  const rest = source.slice(start + 1);
  const next = rest.slice(1).search(/\n(?:async )?function \w+\(/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

Deno.test("o Planner lê o cartão pela RPC do banco, do aluno e da escola certos", () => {
  const body = functionBody("loadPlannerContext");
  const call =
    /\.rpc\(\s*"student_learning_card_for_planner"\s*,\s*\{\s*p_tenant:\s*tenantId,\s*p_student:\s*studentId,?\s*\}\s*\)/;
  assert(
    call.test(body),
    "loadPlannerContext não chama student_learning_card_for_planner com tenantId e studentId",
  );
  assert(
    !source.includes('from("student_learning_cards")'),
    "o Planner voltou a ler a tabela do cartão direto (sem a regra de menor do banco)",
  );
  assert(
    /teacherCard:\s*teacherCardResult\.error\s*\?\s*null\s*:\s*teacherCardResult\.data/
      .test(body),
    "falha ao ler o cartão tem de virar 'sem cartão', não derrubar o plano",
  );
});

Deno.test("a ficha traz os sinais de menor que a régua local usa", () => {
  const body = functionBody("requireStudentAccess");
  for (
    const column of ["is_kids", "birth_date", "guardian_id", "guardian_name"]
  ) {
    assert(
      body.includes(`"${column}"`),
      `requireStudentAccess não lê ${column}`,
    );
  }
});

Deno.test("objetivo, temas, evitar e estilo saem de plannerSignalsFor (o cartão vence)", () => {
  const signals = functionBody("plannerStudentSignals");
  assert(
    /plannerSignalsFor\(\s*student,\s*context\.intelligence,\s*context\.teacherCard,/
      .test(signals),
    "plannerStudentSignals não passa ficha, Wolfie e cartão para plannerSignalsFor",
  );

  const retrieval = functionBody("buildRetrievalQuery");
  assert(
    retrieval.includes("plannerStudentSignals(student, context)") &&
      /primary_goal:\s*signals\.primaryGoal/.test(retrieval),
    "a busca da base de conhecimento não usa o objetivo resolvido pelo cartão",
  );

  const model = functionBody("buildModelInput");
  assert(
    model.includes("plannerStudentSignals(student, context)") &&
      model.includes("...studentProfileSignalFields(signals)"),
    "buildModelInput não monta o student_profile com os campos do cartão",
  );
  // Nenhuma chave do cartão pode ser reescrita depois do spread, e o index.ts
  // não pode voltar a ler direto o que o cartão substitui.
  for (
    const key of [
      "primary_goal:",
      "preferred_topics:",
      "topics_to_avoid:",
      "preferred_correction_mode:",
      "teacher_card_notes:",
      "teacher_reviewed_fields:",
    ]
  ) {
    assert(
      !model.includes(key),
      `buildModelInput reescreve ${key} fora do cartão`,
    );
  }
  for (
    const direct of [
      "intelligence.interests",
      "intelligence.preferred_correction_mode",
      "student.avoided_topics",
      "student.preferred_topics",
    ]
  ) {
    assert(!source.includes(direct), `index.ts voltou a ler ${direct} direto`);
  }
});

Deno.test("o acesso do professor é a regra do banco, não a agenda consultada na edge", () => {
  const body = functionBody("requireStudentAccess");
  assert(
    /teacherPlannerAccess\(\s*\(fn, args\) => context\.admin\.rpc\(fn, args\),/
      .test(body),
    "requireStudentAccess não pergunta ao banco (planner_teacher_can_access_student)",
  );
  assert(
    /teacherId:\s*context\.userId/.test(body) &&
      /studentId:\s*student\.id/.test(body) &&
      /tenantId:\s*student\.tenant_id/.test(body),
    "requireStudentAccess não passa professor, aluno e escola da requisição",
  );
  assert(
    !body.includes('.from("bookings")'),
    "requireStudentAccess voltou a decidir pela agenda do professor na edge (recusa substituto e segundo professor)",
  );
  assert(
    /access\.kind === "error"[\s\S]*503[\s\S]*access\.kind === "denied"[\s\S]*403/
      .test(body),
    "erro do banco tem de dar 503 e recusa 403",
  );
});

Deno.test("as aulas do Meet entram só aprovadas, pedagógicas e com a data", () => {
  const body = functionBody("loadPlannerContext");
  const meet =
    /\.select\(\s*APPROVED_LESSON_COLUMNS\.join\(","\),?\s*\)\.eq\("tenant_id", tenantId\)\.eq\("student_id", studentId\)\s*\.eq\("source_type", "MEET_SESSION"\)\s*\.eq\("verification_status", "VERIFIED"\)\s*\.order\("occurred_at", \{ ascending: false \}\)\s*\.limit\(MEET_APPROVED_LESSON_LIMIT\)/;
  assert(
    meet.test(body),
    "a consulta das aulas aprovadas perdeu escola, aluno, origem MEET_SESSION, VERIFIED, ordem ou limite",
  );
  assert(
    /\.neq\("source_type", "MEET_SESSION"\)\s*\.neq\("verification_status", "REJECTED"\)/
      .test(body),
    "a consulta geral de memórias voltou a trazer resumo do Meet (entraria sem aprovação)",
  );
  assert(
    /approvedLessons:\s*normalizeApprovedMeetLessons\(approvedLessonsResult\.data\)/
      .test(body) &&
      body.includes(
        '["student_learning_memories:meet_verified", approvedLessonsResult]',
      ),
    "as aulas aprovadas não passam por normalizeApprovedMeetLessons ou falha na leitura não é tratada",
  );
});

Deno.test("o modelo recebe as aulas aprovadas e a regra delas", () => {
  const model = functionBody("buildModelInput");
  assert(
    /approved_lessons:\s*approvedLessonsPromptBlock\(\s*context\.approvedLessons,\s*request\.taskMode,?\s*\)/
      .test(model),
    "buildModelInput não manda approved_lessons ao modelo",
  );
  const retrieval = functionBody("buildRetrievalQuery");
  assert(
    retrieval.includes("continueFrom(context.approvedLessons)") &&
      retrieval.includes("recurringErrorsToTarget(context.approvedLessons, 5)"),
    "a busca da base de conhecimento não parte do próximo passo e dos erros aprovados",
  );
  const call = functionBody("callOpenRouter");
  assert(
    /\{ role: "system", content: APPROVED_LESSONS_SYSTEM_PROMPT \}/.test(call),
    "a regra das aulas aprovadas não vai ao modelo",
  );
});

Deno.test("o plano devolvido e salvo diz em quais aulas se baseou", () => {
  const body = functionBody("generatePlan");
  assert(
    /const lessonBasis = approvedLessonBasis\(\s*plannerContext\.approvedLessons,\s*request\.taskMode,?\s*\)/
      .test(body),
    "a base do plano não é calculada das aulas aprovadas",
  );
  assert(
    body.includes(
      "const planWithBasis = { ...plan, lesson_basis: lessonBasis }",
    ) &&
      /\.\.\.planWithBasis,\s*legacy_content: legacyContent/.test(body) &&
      body.includes("plan: planWithBasis,") &&
      body.includes("lesson_basis: lessonBasis,"),
    "a base não vai no plano salvo e na resposta",
  );
  assert(
    body.includes("prompt_version: LESSON_PLANNER_PROMPT_VERSION"),
    "planner_ai_runs não registra a versão do prompt com as aulas aprovadas",
  );
});
