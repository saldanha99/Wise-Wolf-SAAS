/// <reference lib="deno.ns" />
// Esteira das sugestões com fetch e banco falsos: nenhuma chamada real ao
// OpenRouter nem ao banco.
import type { SummaryUsage } from "../google-meet/core.ts";
import type { Fetcher } from "../google-meet/provider.ts";
import {
  runCardSuggestions,
  runManualSuggestions,
  runSuggestionsTick,
  type SuggestionBackendAction,
  type SuggestionScope,
} from "./runner.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const PRICING = {
  input_usd_per_1m: 0.3,
  output_usd_per_1m: 2.5,
  cached_usd_per_1m: 0.03,
};
const SESSION = "33333333-3333-4333-8333-333333333333";
const SOURCES = [{
  id: "11111111-1111-4111-8111-111111111111",
  kind: "TRANSCRIPT",
  provider_name: "conferenceRecords/a/transcripts/t",
  source_text: [
    "[10:00:01] Aluno Adulto: I want to present my results in meetings.",
    "[10:00:20] Aluno Adulto: I love talking about football.",
    "[10:00:40] Aluno Adulto: Please correct me only at the end.",
    "[10:01:00] Aluno Adulto: My mother is sick and I am worried.",
  ].join("\n"),
}];
const MODEL_OUTPUT = {
  suggestions: [
    {
      field: "real_goal",
      value: "Apresentar resultados em reuniões",
      artifact_id: SOURCES[0].id,
      quote: "I want to present my results in meetings.",
    },
    {
      field: "correction_style",
      value: "end",
      artifact_id: SOURCES[0].id,
      quote: "Please correct me only at the end.",
    },
    {
      field: "avoid_topics",
      value: "doença na família",
      artifact_id: SOURCES[0].id,
      quote: "My mother is sick and I am worried.",
    },
  ],
};
const okCompletion = (output: unknown = MODEL_OUTPUT) =>
  response({
    choices: [{
      finish_reason: "stop",
      message: { content: JSON.stringify(output) },
    }],
    usage: {
      prompt_tokens: 900,
      completion_tokens: 300,
      completion_tokens_details: { reasoning_tokens: 120 },
      prompt_tokens_details: { cached_tokens: 0 },
      cost: 0.0011,
    },
  });

type Call = {
  action: SuggestionBackendAction;
  scope: SuggestionScope;
  payload: Record<string, unknown>;
};
function harness(options: {
  eligible?: boolean;
  reason?: string;
  fields?: string[];
  minor?: boolean;
  claim?: Record<string, unknown>;
  target?: Record<string, unknown>;
  due?: Record<string, unknown>[];
  fetcher?: Fetcher;
  now?: number;
}) {
  const calls: Call[] = [];
  const usages: { usage: SummaryUsage; tenantId: string }[] = [];
  const bodies: Record<string, unknown>[] = [];
  const headers: Headers[] = [];
  const urls: string[] = [];
  const fetcher: Fetcher = (input, init) => {
    urls.push(String(input));
    bodies.push(JSON.parse(String(init?.body || "{}")));
    headers.push(new Headers(init?.headers));
    return options.fetcher
      ? options.fetcher(input, init)
      : Promise.resolve(okCompletion());
  };
  const deps = {
    backend: (
      action: SuggestionBackendAction,
      scope: SuggestionScope,
      payload: Record<string, unknown> = {},
    ) => {
      calls.push({ action, scope, payload });
      if (action === "due") {
        return Promise.resolve({
          items: options.due ??
            [{ tenant_id: "escola-a", session_id: SESSION }],
        });
      }
      if (action === "target") {
        return Promise.resolve(
          options.target ?? { session_id: SESSION, budget_ok: true },
        );
      }
      if (action === "sources") {
        return Promise.resolve(
          options.eligible === false
            ? { eligible: false, reason: options.reason ?? "sem_aceite_da_ia" }
            : {
              eligible: true,
              minor: options.minor ?? false,
              fields: options.fields ??
                [
                  "real_goal",
                  "engaging_topics",
                  "correction_style",
                  "avoid_topics",
                ],
              people_names: ["Aluno Adulto", "Joana Prado"],
              sources: SOURCES,
            },
        );
      }
      if (action === "claim") {
        return Promise.resolve(
          options.claim ?? { claimed: true, run_id: "run-1" },
        );
      }
      if (action === "finish") {
        return Promise.resolve(
          payload.status === "SUCCEEDED"
            ? {
              status: "SUCCEEDED",
              saved: (payload.suggestions as unknown[]).length,
              dropped: payload.dropped,
            }
            : { status: "FAILED", error_code: payload.error_code },
        );
      }
      return Promise.resolve({ ok: true });
    },
    recordUsage: (
      usage: SummaryUsage,
      scope: { tenantId: string; actorId: string | null },
    ) => {
      usages.push({ usage, tenantId: scope.tenantId });
      return Promise.resolve();
    },
    fetcher,
    now: () => options.now ?? 0,
  };
  return { calls, usages, bodies, headers, urls, deps };
}
const actions = (calls: Call[]) => calls.map((call) => call.action);
const automatic = {
  trigger: "AUTOMATIC" as const,
  tenantId: "escola-a",
  sessionId: SESSION,
  actorId: null,
  key: "chave-falsa",
  model: "google/gemini-3.6-flash",
  pricing: PRICING,
  deadline: 120_000,
};

Deno.test("OpenRouter: data_collection deny, schema estrito com enum, chave no cabeçalho", async () => {
  const h = harness({});
  const outcome = await runCardSuggestions(automatic, h.deps);
  assert(outcome.status === "SUCCEEDED", JSON.stringify(outcome));
  assert(
    h.urls.length === 1 &&
      h.urls[0] === "https://openrouter.ai/api/v1/chat/completions",
    "não chamou o OpenRouter uma vez",
  );
  const body = h.bodies[0] as {
    model: string;
    provider: { data_collection: string; require_parameters: boolean };
    response_format: {
      type: string;
      json_schema: {
        strict: boolean;
        schema: {
          properties: {
            suggestions: {
              items: { properties: { field: { enum: string[] } } };
            };
          };
        };
      };
    };
    max_tokens: number;
  };
  assert(body.model === "google/gemini-3.6-flash", "modelo errado");
  assert(body.provider.data_collection === "deny", "sem data_collection deny");
  assert(body.provider.require_parameters === true, "sem require_parameters");
  assert(
    body.response_format.type === "json_schema" &&
      body.response_format.json_schema.strict === true,
    "resposta sem schema estrito",
  );
  assert(
    body.response_format.json_schema.schema.properties.suggestions.items
      .properties.field.enum.length === 4,
    "enum dos campos do adulto errado",
  );
  assert(body.max_tokens === 3000, "teto de saída");
  assert(
    h.headers[0].get("Authorization") === "Bearer chave-falsa",
    "chave fora do cabeçalho",
  );
  // A ordem: fontes → reserva → chamada → gravação.
  assert(
    actions(h.calls).join(",") === "sources,claim,finish",
    actions(h.calls).join(","),
  );
});

Deno.test("gravação: só o que passou na conferência; custo e tokens no livro", async () => {
  const h = harness({});
  const outcome = await runCardSuggestions(automatic, h.deps);
  const finish = h.calls.find((call) => call.action === "finish")!;
  const suggestions = finish.payload.suggestions as {
    field: string;
    quote: string;
  }[];
  assert(
    suggestions.map((item) => item.field).join(",") ===
      "real_goal,correction_style",
    "sugestão sensível (família/saúde) foi para o banco",
  );
  assert(finish.payload.dropped === 1, "descarte não contado");
  assert(
    finish.payload.status === "SUCCEEDED" &&
      finish.payload.cost_usd === 0.0011 &&
      finish.payload.cost_source === "PROVIDER" &&
      finish.payload.reasoning_tokens === 120,
    "custo do provedor fora do livro",
  );
  assert(
    h.usages.length === 1 && h.usages[0].tenantId === "escola-a" &&
      h.usages[0].usage.inputTokens === 900,
    "consumo não foi para ai_usage_events",
  );
  const claim = h.calls.find((call) => call.action === "claim")!;
  assert(
    claim.payload.trigger === "AUTOMATIC" &&
      (claim.payload.source_artifact_ids as string[])[0] === SOURCES[0].id &&
      typeof claim.payload.estimated_usd === "number",
    "reserva sem fontes ou estimativa",
  );
  assert(
    outcome.status === "SUCCEEDED" && outcome.saved === 2,
    JSON.stringify(outcome),
  );
});

Deno.test("menor: o modelo recebe só objetivo e temas e nada pessoal é gravado", async () => {
  const h = harness({ minor: true, fields: ["real_goal", "engaging_topics"] });
  await runCardSuggestions(automatic, h.deps);
  const body = h.bodies[0] as {
    messages: { role: string; content: string }[];
    response_format: {
      json_schema: {
        schema: {
          properties: {
            suggestions: {
              items: { properties: { field: { enum: string[] } } };
            };
          };
        };
      };
    };
  };
  assert(
    body.response_format.json_schema.schema.properties.suggestions.items
      .properties.field.enum.join(",") === "real_goal,engaging_topics",
    "menor com enum de campos pessoais",
  );
  assert(
    body.messages[0].content.includes("menor de idade"),
    "instrução não avisou que é menor",
  );
  const finish = h.calls.find((call) => call.action === "finish")!;
  assert(
    (finish.payload.suggestions as { field: string }[]).every((item) =>
      item.field === "real_goal" || item.field === "engaging_topics"
    ),
    "menor ganhou estilo de correção ou 'o que evitar'",
  );
});

Deno.test("sem aceite do termo que declara a IA: nem reserva, nem chamada", async () => {
  const h = harness({ eligible: false, reason: "sem_aceite_da_ia" });
  const outcome = await runCardSuggestions(automatic, h.deps);
  assert(
    outcome.status === "SKIPPED" && outcome.reason === "sem_aceite_da_ia",
    JSON.stringify(outcome),
  );
  assert(h.urls.length === 0, "a aula foi para a IA sem o aceite");
  assert(actions(h.calls).join(",") === "sources", "reservou sem aceite");
});

Deno.test("teto do mês atingido na reserva: não chama a IA", async () => {
  const h = harness({ claim: { claimed: false, reason: "teto_atingido" } });
  const outcome = await runCardSuggestions(automatic, h.deps);
  assert(
    outcome.status === "SKIPPED" && outcome.reason === "teto_atingido",
    JSON.stringify(outcome),
  );
  assert(h.urls.length === 0, "chamou a IA com o teto atingido");
});

Deno.test("sem tempo até o prazo: adia sem reservar", async () => {
  const h = harness({ now: 100_000 });
  const outcome = await runCardSuggestions(automatic, h.deps);
  assert(outcome.status === "DEFERRED", JSON.stringify(outcome));
  assert(h.calls.length === 0 && h.urls.length === 0, "reservou sem tempo");
});

Deno.test("provedor recusa a chave: FAILED sem custo; a fila pausa as escolas", async () => {
  const h = harness({
    fetcher: () => Promise.resolve(response({ error: "no" }, 401)),
    due: [
      { tenant_id: "escola-a", session_id: SESSION },
      {
        tenant_id: "escola-b",
        session_id: "44444444-4444-4444-8444-444444444444",
      },
    ],
  });
  const result = await runSuggestionsTick({
    aiEnabled: true,
    key: "chave-falsa",
    model: "google/gemini-3.6-flash",
    loadPricing: () => Promise.resolve(PRICING),
    deadline: 120_000,
  }, h.deps);
  assert(
    result.processed.length === 1 && result.processed[0].status === "FAILED" &&
      result.processed[0].error === "card_suggestions_provider_rejected",
    JSON.stringify(result),
  );
  const finish = h.calls.find((call) => call.action === "finish")!;
  assert(
    finish.payload.status === "FAILED" && finish.payload.cost_usd === 0 &&
      finish.payload.cost_source === "NONE",
    "recusa antes de gerar não ficou com custo zero",
  );
  const paused = h.calls.filter((call) => call.action === "auto_pause").map((
    call,
  ) => call.scope.tenantId).sort();
  assert(
    paused.join(",") === "escola-a,escola-b",
    "fila não pausou as escolas: " + paused.join(","),
  );
});

Deno.test("resposta fora do formato: FAILED, nada gravado", async () => {
  const h = harness({
    fetcher: () => Promise.resolve(okCompletion({ items: [] })),
  });
  const outcome = await runCardSuggestions(automatic, h.deps);
  assert(outcome.status === "FAILED", JSON.stringify(outcome));
  const finish = h.calls.find((call) => call.action === "finish")!;
  assert(
    finish.payload.status === "FAILED" &&
      finish.payload.error_code === "card_suggestions_response_invalid" &&
      (finish.payload.suggestions as unknown[]).length === 0,
    "resposta inválida gravou sugestão",
  );
});

Deno.test("fila sem IA configurada: pausa a escola sem ler a aula", async () => {
  const h = harness({});
  const result = await runSuggestionsTick({
    aiEnabled: false,
    key: "",
    model: "",
    loadPricing: () => Promise.resolve(PRICING),
    deadline: 120_000,
  }, h.deps);
  assert(
    result.paused === "card_suggestions_not_configured",
    JSON.stringify(result),
  );
  assert(
    actions(h.calls).join(",") === "due,auto_pause" && h.urls.length === 0,
    actions(h.calls).join(","),
  );
});

Deno.test("resposta da fila não leva texto da aula nem das sugestões", async () => {
  const h = harness({});
  const result = await runSuggestionsTick({
    aiEnabled: true,
    key: "chave-falsa",
    model: "google/gemini-3.6-flash",
    loadPricing: () => Promise.resolve(PRICING),
    deadline: 120_000,
  }, h.deps);
  const serialized = JSON.stringify(result);
  assert(
    result.processed[0].status === "SUCCEEDED" &&
      result.processed[0].saved === 2,
    serialized,
  );
  assert(
    !serialized.includes("meetings") && !serialized.includes("Apresentar"),
    "texto da aula na resposta do cron: " + serialized,
  );
});

Deno.test("botão: permissão e aula pelo banco; leitura MANUAL com autor", async () => {
  const h = harness({});
  const outcome = await runManualSuggestions({
    tenantId: "escola-a",
    actorId: "55555555-5555-4555-8555-555555555555",
    studentId: "66666666-6666-4666-8666-666666666666",
    aiEnabled: true,
    key: "chave-falsa",
    model: "google/gemini-3.6-flash",
    loadPricing: () => Promise.resolve(PRICING),
    deadline: 120_000,
  }, h.deps);
  assert(outcome.status === "SUCCEEDED", JSON.stringify(outcome));
  const target = h.calls[0];
  assert(
    target.action === "target" &&
      target.scope.actorId === "55555555-5555-4555-8555-555555555555" &&
      target.payload.student_id === "66666666-6666-4666-8666-666666666666",
    "botão não pediu a aula ao banco como a pessoa",
  );
  const claim = h.calls.find((call) => call.action === "claim")!;
  assert(
    claim.payload.trigger === "MANUAL" &&
      claim.scope.actorId === "55555555-5555-4555-8555-555555555555",
    "leitura do botão sem autor",
  );
});

Deno.test("botão: sem aula aprovada, teto ou IA desligada não chamam a IA", async () => {
  for (
    const [target, aiEnabled, expected] of [
      [{ session_id: null, reason: "ja_sugerido" }, true, "ja_sugerido"],
      [{ session_id: SESSION, budget_ok: false }, true, "teto_atingido"],
      [
        { session_id: SESSION, budget_ok: true },
        false,
        "card_suggestions_not_configured",
      ],
    ] as const
  ) {
    const h = harness({ target: { ...target } });
    const outcome = await runManualSuggestions({
      tenantId: "escola-a",
      actorId: "55555555-5555-4555-8555-555555555555",
      studentId: "66666666-6666-4666-8666-666666666666",
      aiEnabled,
      key: "chave-falsa",
      model: "google/gemini-3.6-flash",
      loadPricing: () => Promise.resolve(PRICING),
      deadline: 120_000,
    }, h.deps);
    assert(
      outcome.status === "SKIPPED" && outcome.reason === expected,
      JSON.stringify(outcome),
    );
    assert(h.urls.length === 0, `chamou a IA (${expected})`);
  }
});

Deno.test("botão com a IA desligada ou sem preço pausa a escola: o botão some em vez de falhar a cada clique", async () => {
  for (
    const [aiEnabled, pricing, reason, minutes] of [
      [false, PRICING, "card_suggestions_not_configured", 360],
      [true, null, "card_suggestions_pricing_required", 60],
    ] as const
  ) {
    const h = harness({});
    const outcome = await runManualSuggestions({
      tenantId: "escola-a",
      actorId: "55555555-5555-4555-8555-555555555555",
      studentId: "66666666-6666-4666-8666-666666666666",
      aiEnabled,
      key: "chave-falsa",
      model: "google/gemini-3.6-flash",
      loadPricing: () => Promise.resolve(pricing),
      deadline: 120_000,
    }, h.deps);
    assert(
      outcome.status === "SKIPPED" && outcome.reason === reason,
      JSON.stringify(outcome),
    );
    const paused = h.calls.find((call) => call.action === "auto_pause");
    assert(
      paused?.scope.tenantId === "escola-a" &&
        paused.payload.reason === reason &&
        paused.payload.minutes === minutes,
      `botão não pausou a escola (${reason}): ${JSON.stringify(h.calls)}`,
    );
    assert(h.urls.length === 0, `chamou a IA (${reason})`);
  }
  // A pausa que falha não muda a resposta ao professor.
  const h = harness({});
  const outcome = await runManualSuggestions({
    tenantId: "escola-a",
    actorId: "55555555-5555-4555-8555-555555555555",
    studentId: "66666666-6666-4666-8666-666666666666",
    aiEnabled: false,
    key: "",
    model: "",
    loadPricing: () => Promise.resolve(null),
    deadline: 120_000,
  }, {
    ...h.deps,
    backend: (action) =>
      action === "auto_pause"
        ? Promise.reject(new Error("card_suggestions_storage_unavailable"))
        : Promise.resolve({}),
  });
  assert(
    outcome.status === "SKIPPED" &&
      outcome.reason === "card_suggestions_not_configured",
    JSON.stringify(outcome),
  );
});
