/// <reference lib="deno.ns" />
// Esteira do resumo por IA com fetch e banco falsos: nenhuma chamada real ao
// OpenRouter nem ao banco.
import type { Fetcher } from "./provider.ts";
import type { SummaryUsage } from "./core.ts";
import {
  runAutoSummaryJob,
  runSummaryGeneration,
  type SummaryBackendAction,
} from "./summary.ts";

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
const SOURCES = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    kind: "TRANSCRIPT",
    provider_name: "conferenceRecords/a/transcripts/t",
    source_text:
      "[10:00:01] Prof: turn left at the bank\n[10:00:09] Aluna: I turn left.",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    kind: "SMART_NOTES",
    provider_name: "conferenceRecords/a/smartNotes/n",
    source_text: "Resumo\nDireções na cidade.",
  },
];
const MODEL_OUTPUT = {
  narrative: "A aluna praticou direções.",
  lesson_objective: "Pedir e dar direções",
  content_practiced: ["turn left"],
  recurring_errors: ["I turn left (passado)"],
  strengths_observed: [],
  homework_assigned: "",
  recommended_next_step: "Praticar o passado simples com direções.",
  uncertainties: [],
  evidence: [
    { artifact_id: SOURCES[0].id, quote: "Aluna: I turn left." },
    { artifact_id: SOURCES[0].id, quote: "o professor atrasou" },
  ],
};
const okCompletion = (output: unknown = MODEL_OUTPUT) =>
  response({
    choices: [{
      finish_reason: "stop",
      message: { content: JSON.stringify(output) },
    }],
    usage: {
      prompt_tokens: 1200,
      completion_tokens: 600,
      completion_tokens_details: { reasoning_tokens: 250 },
      prompt_tokens_details: { cached_tokens: 0 },
      cost: 0.0019,
    },
  });

type Call = {
  action: SummaryBackendAction;
  sessionId: string | null;
  payload: Record<string, unknown>;
};
function harness(options: {
  claim?: Record<string, unknown>;
  eligible?: boolean;
  fetcher?: Fetcher;
  now?: number;
}) {
  const calls: Call[] = [];
  const usages: SummaryUsage[] = [];
  let fetches = 0;
  const fetcher: Fetcher = (input, init) => {
    fetches++;
    return options.fetcher
      ? options.fetcher(input, init)
      : Promise.resolve(okCompletion());
  };
  const deps = {
    backend: (
      action: SummaryBackendAction,
      sessionId: string | null,
      payload: Record<string, unknown> = {},
    ) => {
      calls.push({ action, sessionId, payload });
      if (action === "auto_sources") {
        return Promise.resolve({
          eligible: options.eligible ?? true,
          sources: options.eligible === false ? [] : SOURCES,
        });
      }
      if (action === "claim") {
        return Promise.resolve(
          options.claim ?? { claimed: true, generation_id: "gen-1" },
        );
      }
      if (action === "finish") {
        return Promise.resolve(
          payload.status === "SUCCEEDED"
            ? {
              status: "SUCCEEDED",
              summary: { id: "v1", status: "PROPOSED", origin: "GEMINI_API" },
            }
            : { status: "FAILED", error_code: payload.error_code },
        );
      }
      return Promise.resolve({ ok: true });
    },
    recordUsage: (usage: SummaryUsage) => {
      usages.push(usage);
      return Promise.resolve();
    },
    fetcher,
    now: () => options.now ?? 1_000,
  };
  return { deps, calls, usages, fetches: () => fetches };
}
const autoInput = (overrides: Record<string, unknown> = {}) => ({
  sessionId: "33333333-3333-4333-8333-333333333333",
  aiEnabled: true,
  key: "synthetic-key",
  model: "google/gemini-3.6-flash",
  loadPricing: () => Promise.resolve(PRICING),
  deadline: 1_000 + 125_000,
  ...overrides,
});

Deno.test("automático: reserva, chama, descarta a citação falsa e grava o rascunho com o custo real", async () => {
  const h = harness({});
  const outcome = await runAutoSummaryJob(autoInput(), h.deps);
  assert(outcome.status === "SUCCEEDED", JSON.stringify(outcome));
  const claim = h.calls.find((call) => call.action === "claim")!;
  assert(claim.payload.trigger === "AUTOMATIC");
  assert(claim.payload.model_id === "google/gemini-3.6-flash");
  assert(
    JSON.stringify(claim.payload.source_artifact_ids) ===
      JSON.stringify([SOURCES[0].id, SOURCES[1].id]),
    "a transcrição não veio primeiro",
  );
  assert(
    typeof claim.payload.estimated_usd === "number" &&
      claim.payload.estimated_usd > 0 && claim.payload.estimated_usd < 0.05,
    `estimativa: ${claim.payload.estimated_usd}`,
  );
  const finish = h.calls.find((call) => call.action === "finish")!;
  const content = finish.payload.content as {
    evidence: { quote: string }[];
    lesson_objective: string;
  };
  assert(finish.payload.status === "SUCCEEDED");
  assert(finish.payload.generation_id === "gen-1");
  assert(
    content.evidence.length === 1 &&
      content.evidence[0].quote === "Aluna: I turn left.",
    "a citação que não confere não foi descartada",
  );
  assert(finish.payload.cost_usd === 0.0019);
  assert(finish.payload.cost_source === "PROVIDER");
  assert(finish.payload.reasoning_tokens === 250);
  assert(finish.payload.prompt_version === "meet-pedagogical-v2");
  assert(
    h.usages.length === 1 && h.usages[0].reasoningTokens === 250 &&
      h.usages[0].inputTokens === 1200,
    "consumo não foi para ai_usage_events",
  );
});

Deno.test("sem nenhuma citação que confira o rascunho reprova, e o custo fica registrado", async () => {
  const h = harness({
    fetcher: () =>
      Promise.resolve(okCompletion({
        ...MODEL_OUTPUT,
        evidence: [{ artifact_id: SOURCES[0].id, quote: "inventado" }],
      })),
  });
  const outcome = await runAutoSummaryJob(autoInput(), h.deps);
  assert(
    outcome.status === "FAILED" && outcome.error === "invalid_summary_evidence",
    JSON.stringify(outcome),
  );
  const finish = h.calls.find((call) => call.action === "finish")!;
  assert(finish.payload.status === "FAILED" && finish.payload.content === null);
  assert(finish.payload.cost_usd === 0.0019, "custo pago sumiu do livro");
});

Deno.test("reserva recusada (teto, já gerado) não chama a IA", async () => {
  const h = harness({
    claim: { claimed: false, reason: "google_summary_budget_exhausted" },
  });
  const outcome = await runAutoSummaryJob(autoInput(), h.deps);
  assert(
    outcome.status === "SKIPPED" &&
      outcome.reason === "google_summary_budget_exhausted",
  );
  assert(h.fetches() === 0, "chamou a IA sem reserva");
  assert(!h.calls.some((call) => call.action === "finish"));
});

Deno.test("sem IA configurada ou sem preço a escola pausa, sem chamada paga", async () => {
  let h = harness({});
  let outcome = await runAutoSummaryJob(
    autoInput({ aiEnabled: false }),
    h.deps,
  );
  assert(
    outcome.status === "SKIPPED" &&
      h.calls[0].action === "auto_pause" &&
      h.calls[0].payload.reason === "google_summary_ai_not_configured" &&
      h.fetches() === 0,
  );
  h = harness({});
  outcome = await runAutoSummaryJob(
    autoInput({ loadPricing: () => Promise.resolve(null) }),
    h.deps,
  );
  assert(
    outcome.status === "SKIPPED" &&
      h.calls.some((call) =>
        call.action === "auto_pause" &&
        call.payload.reason === "google_summary_pricing_required"
      ) && h.fetches() === 0 &&
      !h.calls.some((call) => call.action === "claim"),
  );
});

Deno.test("sem tempo na rodada a geração fica para a próxima, sem reservar", async () => {
  const h = harness({ now: 100_000 });
  const outcome = await runAutoSummaryJob(
    autoInput({ deadline: 100_000 + 30_000 }),
    h.deps,
  );
  assert(outcome.status === "DEFERRED", JSON.stringify(outcome));
  assert(h.calls.length === 0 && h.fetches() === 0);
});

Deno.test("aula que deixou de ser elegível não é gerada", async () => {
  const h = harness({ eligible: false });
  const outcome = await runAutoSummaryJob(autoInput(), h.deps);
  assert(
    outcome.status === "SKIPPED" &&
      outcome.reason === "google_summary_not_eligible" &&
      !h.calls.some((call) => call.action === "claim"),
  );
});

Deno.test("sem créditos no provedor: custo zero e a escola pausa", async () => {
  const h = harness({
    fetcher: () => Promise.resolve(response({ error: {} }, 402)),
  });
  const outcome = await runAutoSummaryJob(autoInput(), h.deps);
  assert(
    outcome.status === "FAILED" &&
      outcome.error === "google_summary_provider_credits",
  );
  const finish = h.calls.find((call) => call.action === "finish")!;
  assert(
    finish.payload.cost_usd === 0 && finish.payload.cost_source === "NONE",
  );
  assert(
    h.calls.some((call) =>
      call.action === "auto_pause" &&
      call.payload.reason === "google_summary_provider_credits"
    ),
    "falha de configuração não pausou a escola",
  );
});

Deno.test("rede caiu no meio: custo incerto (o banco conta a estimativa)", async () => {
  const h = harness({
    fetcher: () => Promise.reject(new TypeError("network")),
  });
  const outcome = await runAutoSummaryJob(autoInput(), h.deps);
  assert(
    outcome.status === "FAILED" &&
      outcome.error === "google_summary_provider_unavailable",
  );
  const finish = h.calls.find((call) => call.action === "finish")!;
  assert(
    finish.payload.cost_usd === null && finish.payload.cost_source === null,
  );
  assert(!h.calls.some((call) => call.action === "auto_pause"));
});

Deno.test("manual usa a mesma esteira, com as fontes da tela", async () => {
  const h = harness({});
  const outcome = await runSummaryGeneration({
    trigger: "MANUAL",
    sessionId: "33333333-3333-4333-8333-333333333333",
    sources: [
      { ...SOURCES[1], imported_at: "2026-09-26T10:00:00Z" },
      { ...SOURCES[0], imported_at: "2026-09-26T09:00:00Z" },
    ],
    key: "k",
    model: "google/gemini-3.6-flash",
    pricing: PRICING,
    deadline: 1_000 + 125_000,
  }, h.deps);
  assert(outcome.status === "SUCCEEDED");
  const claim = h.calls.find((call) => call.action === "claim")!;
  assert(claim.payload.trigger === "MANUAL");
  assert(
    (claim.payload.source_artifact_ids as string[])[0] === SOURCES[0].id,
    "transcrição não veio primeiro no manual",
  );
});
