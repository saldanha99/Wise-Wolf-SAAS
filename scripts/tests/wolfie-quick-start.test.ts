/// <reference lib="deno.ns" />

import {
  buildQuickStartPlan,
  lastMeaningfulSession,
  parseCefrLevel,
  resolveKnownLevel,
  resumableSession,
} from "../../src/components/wolfie/quickStart.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("nível é extraído de texto livre digitado por humano", () => {
  // `module` é campo aberto: em produção aparece "B1", "Inglês B1", "b1 - ...".
  for (const entrada of ["B1", "Inglês B1", "b1 - intermediário", "nível A2"]) {
    assert(
      parseCefrLevel(entrada) !== null,
      `não reconheceu o nível em ${JSON.stringify(entrada)}`,
    );
  }
  assert(parseCefrLevel("General") === null, "'General' não é nível");
  assert(parseCefrLevel(null) === null, "null não é nível");
  assert(parseCefrLevel("D9") === null, "nível inexistente deve ser rejeitado");
});

Deno.test("o nível estimado pela IA vence o cadastro manual", () => {
  const r = resolveKnownLevel("B2", "A1");
  assert(r.level === "B2", `esperava B2 observado, veio ${r.level}`);
  assert(r.known, "com estimativa, o nível é conhecido");
});

Deno.test("sem nenhum nível, assume intermediário e admite que chutou", () => {
  const r = resolveKnownLevel(null, "General");
  assert(r.level === "B1", `fallback deveria ser B1, veio ${r.level}`);
  assert(
    !r.known,
    "precisa sinalizar que chutou, para a UI oferecer ajuste",
  );
});

Deno.test("retomar a última prática vence começar do zero", () => {
  const plano = buildQuickStartPlan(
    { module: "A2" },
    {
      recentSessions: [
        { subject: "conversation", cefr_level: "A2" },
        { subject: "vocabulary", cefr_level: "B1", sector: "saúde" },
      ],
    } as never,
    null,
  );
  // "conversation" não é gerável pelo fluxo de atividades: precisa ser pulada.
  assert(
    plano.selection.subject === "vocabulary",
    `deveria retomar vocabulary, veio ${plano.selection.subject}`,
  );
  assert(plano.selection.level === "B1", "mantém o nível daquela sessão");
  assert(plano.selection.sector === "saúde", "mantém o setor daquela sessão");
});

Deno.test("aluno novo recebe um ponto de partida praticável, nunca um vazio", () => {
  const plano = buildQuickStartPlan(null, null, null);
  assert(Boolean(plano.selection.subject), "precisa ter subject");
  assert(Boolean(plano.selection.level), "precisa ter nível");
  assert(plano.label.length > 0, "precisa ter rótulo de botão");
  assert(plano.reason.length > 0, "precisa explicar a escolha ao aluno");
});

Deno.test("ocupação do aluno vira setor do primeiro contato", () => {
  const plano = buildQuickStartPlan(
    { module: "B2", occupation: "enfermagem" },
    null,
    null,
  );
  assert(
    plano.selection.sector === "enfermagem",
    "usa a ocupação já cadastrada em vez de perguntar de novo",
  );
  assert(plano.levelKnown, "B2 declarado é nível conhecido");
});

Deno.test("sessão inacabada é detectada para o atalho de retomada", () => {
  assert(resumableSession(null) === null, "sem overview, nada a retomar");
  assert(
    resumableSession({ resumableSessions: [] } as never) === null,
    "lista vazia não retoma",
  );
  assert(
    resumableSession({ resumableSessions: [{ id: "s1" }] } as never)?.id === "s1",
    "a primeira sessão retomável deve ser oferecida",
  );
});

Deno.test("histórico só com conversas não quebra a escolha", () => {
  const previa = lastMeaningfulSession(
    { recentSessions: [{ subject: "conversation" }] } as never,
  );
  assert(previa === null, "conversa pura não serve de base para atividade");
  const plano = buildQuickStartPlan({ module: "A1" }, {
    recentSessions: [{ subject: "conversation" }],
  } as never, null);
  assert(plano.selection.level === "A1", "cai para o nível conhecido do aluno");
});

Deno.test("tarefa do professor vira o ponto de partida, acima do histórico", async () => {
  const { buildQuickStartPlan } = await import(
    "../../src/components/wolfie/quickStart.ts"
  );
  const plano = buildQuickStartPlan(
    { module: "B1" },
    { recentSessions: [{ subject: "vocabulary", cefr_level: "B1" }] } as never,
    null,
    { id: "a1", topic: "Falar sobre o fim de semana", teacher_name: "Mateus Silva" },
  );
  assert(plano.assignmentId === "a1", "precisa carregar o id para fechar o laço");
  assert(
    plano.selection.sector === "Falar sobre o fim de semana",
    "o tema pedido pelo professor precisa chegar à prática",
  );
  assert(
    plano.reason.includes("Mateus"),
    "o aluno precisa saber QUEM pediu — é o que dá peso à tarefa",
  );
  assert(plano.label === "Fazer a tarefa", `rótulo inesperado: ${plano.label}`);
});

Deno.test("sem tarefa, o comportamento anterior é preservado", async () => {
  const { buildQuickStartPlan } = await import(
    "../../src/components/wolfie/quickStart.ts"
  );
  const plano = buildQuickStartPlan({ module: "B1" }, null, null, null);
  assert(!plano.assignmentId, "sem tarefa não deve haver assignmentId");
  assert(plano.selection.level === "B1", "mantém o nível conhecido");
});
