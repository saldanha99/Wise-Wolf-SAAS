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
