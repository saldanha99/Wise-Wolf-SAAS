/// <reference lib="deno.ns" />
// A edge e o banco conferem as sugestões com a MESMA régua: lista de exclusão,
// limites e dobra do texto. Duas cópias divergiriam no primeiro ajuste — este
// teste lê a migration e compara. Precisa de --allow-read.
import { BLOCKED_TERMS, foldForMatch, SUGGESTION_LIMITS } from "./core.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}

const MIGRATION = new URL(
  "../../migrations/20260928130000_sugestoes_do_cartao_pela_ia.sql",
  import.meta.url,
);
const INDEX = new URL("./index.ts", import.meta.url);

Deno.test("lista de exclusão da edge = lista do banco, na mesma ordem", async () => {
  const sql = await Deno.readTextFile(MIGRATION);
  const start = sql.indexOf("-- termos-bloqueados:inicio");
  const end = sql.indexOf("-- termos-bloqueados:fim");
  assert(start > 0 && end > start, "marcadores da lista sumiram da migration");
  const terms = [...sql.slice(start, end).matchAll(/'([^']+)'/g)].map((
    match,
  ) => match[1]);
  assert(terms.length > 100, "lista do banco não foi lida");
  const edge = [...BLOCKED_TERMS];
  const onlySql = terms.filter((term) => !edge.includes(term));
  const onlyEdge = edge.filter((term) => !terms.includes(term));
  assert(
    !onlySql.length && !onlyEdge.length,
    `listas divergem — só no banco: ${onlySql.join(", ")}; só na edge: ${
      onlyEdge.join(", ")
    }`,
  );
  assert(terms.join("|") === edge.join("|"), "listas em ordem diferente");
  // Todo termo já vem dobrado (sem acento, minúsculas), senão nunca casa.
  for (const term of edge) {
    assert(
      foldForMatch(term.replace(/\*$/, "")) === term.replace(/\*$/, ""),
      `termo não dobrado: ${term}`,
    );
  }
});

Deno.test("limites da edge = política do banco", async () => {
  const sql = await Deno.readTextFile(MIGRATION);
  for (
    const [key, value] of [
      ["max_saved_per_run", SUGGESTION_LIMITS.maxKept],
      ["quote_min", SUGGESTION_LIMITS.quoteMin],
      ["quote_max", SUGGESTION_LIMITS.quoteMax],
    ] as const
  ) {
    assert(
      new RegExp(`'${key}', ${value}\\b`).test(sql),
      `limite ${key} diverge do banco (edge: ${value})`,
    );
  }
  // Objetivo e tema vêm dos limites do cartão (300 e 60).
  assert(
    SUGGESTION_LIMITS.goal === 300 && SUGGESTION_LIMITS.topic === 60,
    "limites do cartão mudaram na edge",
  );
});

Deno.test("a porta da edge não devolve texto da aula nem das sugestões", async () => {
  const source = await Deno.readTextFile(INDEX);
  assert(
    source.includes('feature: "student_card_suggestions"'),
    "consumo de IA sem a feature própria em ai_usage_events",
  );
  assert(
    !/json\(\{[^}]*(suggestions|quote|source_text)/.test(source),
    "resposta HTTP devolve sugestão, citação ou texto da aula",
  );
  assert(
    source.includes(
      'if (!auth.isService) return json({ error: "forbidden" }, 403)',
    ),
    "a rodada da fila aceita chamada que não é da chave de serviço",
  );
});
