// Resumo por IA de uma aula: a mesma esteira para o automático (fila
// GENERATE_SUMMARY, uma aula por rodada) e para o botão manual.
//
//   fontes → prompt (orçamento por fonte) → estimativa → reserva no banco (hash
//   das fontes, lease, teto mensal na automática) → OpenRouter → citações
//   conferidas → rascunho PROPOSED + custo real no livro das gerações.
//
// A memória do aluno NÃO muda aqui: o rascunho só vira memória quando o
// professor aprova (summary_save VERIFIED na google_meet_backend).
import {
  estimateSummaryCost,
  isRecord,
  normalizeSummary,
  pickSummarySources,
  type SourceArtifact,
  SUMMARY_MAX_ESTIMATE_USD,
  SUMMARY_PROMPT_VERSION,
  summaryMessages,
  type SummaryPricing,
  type SummaryUsage,
  summaryUsageCost,
  text,
} from "./core.ts";
import { type Fetcher, openRouterSummary } from "./provider.ts";

// O worker morre em 150 s; a rodada dá a cada trabalho um prazo (deadline) de
// ~125 s. A chamada ao modelo tem no máximo 55 s e só começa com 40 s de folga:
// a reserva, o registro de custo e o rascunho precisam caber depois dela.
export const SUMMARY_CALL_TIMEOUT_MS = 55_000;
export const SUMMARY_MIN_REMAINING_MS = 40_000;
export const SUMMARY_FINISH_MARGIN_MS = 8_000;

// Recusas do provedor que são de CONFIGURAÇÃO (chave, créditos): a geração
// automática da escola pausa em vez de tentar a cada 15 minutos.
const CONFIGURATION_FAILURES = new Set([
  "google_summary_provider_rejected",
  "google_summary_provider_credits",
]);

export type SummaryBackendAction =
  | "budget"
  | "auto_sources"
  | "claim"
  | "finish"
  | "auto_pause";
/** google_meet_summary_backend já amarrado à escola e a quem pediu. */
export type SummaryBackend = (
  action: SummaryBackendAction,
  sessionId: string | null,
  payload?: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export interface SummaryDeps {
  backend: SummaryBackend;
  // ai_usage_events (tokens de entrada, saída, cache e raciocínio).
  recordUsage: (usage: SummaryUsage) => Promise<void>;
  fetcher?: Fetcher;
  now?: () => number;
}

export type SummaryOutcome =
  | { status: "SUCCEEDED"; summary: unknown; cost_usd: number | null }
  | { status: "FAILED"; error: string; cost_usd: number | null }
  | { status: "SKIPPED" | "DEFERRED"; reason: string };

const code = (value: unknown, fallback: string): string => {
  const valueText = text(value, 80);
  return /^[a-z_]{1,80}$/.test(valueText) ? valueText : fallback;
};

/**
 * Uma geração: reserva, chamada, conferência e registro. Recusa da reserva
 * (conteúdo já resumido, outra geração em andamento, teto) volta como SKIPPED
 * com o motivo — nada foi pago.
 */
export async function runSummaryGeneration(
  input: {
    trigger: "AUTOMATIC" | "MANUAL";
    sessionId: string;
    sources: SourceArtifact[];
    key: string;
    model: string;
    pricing: SummaryPricing;
    deadline: number;
  },
  deps: SummaryDeps,
): Promise<SummaryOutcome> {
  const now = deps.now || Date.now;
  const sources = pickSummarySources(input.sources);
  if (!sources.length) throw new Error("google_artifacts_required");
  const messages = summaryMessages(sources);
  const estimate = estimateSummaryCost(
    messages.reduce((sum, message) => sum + message.content.length, 0),
    input.pricing,
  );
  if (estimate.usd > SUMMARY_MAX_ESTIMATE_USD) {
    throw new Error("google_summary_estimate_too_high");
  }
  if (input.deadline - now() < SUMMARY_MIN_REMAINING_MS) {
    return { status: "DEFERRED", reason: "google_summary_no_time_left" };
  }
  const claim = await deps.backend("claim", input.sessionId, {
    trigger: input.trigger,
    model_id: input.model,
    estimated_usd: estimate.usd,
    source_artifact_ids: sources.map((source) => source.id),
  });
  if (claim.claimed !== true) {
    return {
      status: "SKIPPED",
      reason: code(claim.reason, "google_summary_not_claimed"),
    };
  }
  const generationId = text(claim.generation_id, 40);
  const call = await openRouterSummary({
    messages,
    key: input.key,
    model: input.model,
    timeoutMs: Math.min(
      SUMMARY_CALL_TIMEOUT_MS,
      input.deadline - now() - SUMMARY_FINISH_MARGIN_MS,
    ),
  }, deps.fetcher);
  if (call.usage) await deps.recordUsage(call.usage);

  // Custo: o que o provedor cobrou; recusa antes de gerar = 0; resposta incerta
  // = nulo (o banco conta a estimativa reservada — pode ter sido cobrado).
  let cost: { usd: number | null; source: string | null } = {
    usd: null,
    source: null,
  };
  if (call.usage) cost = summaryUsageCost(call.usage, input.pricing);
  else if (!call.ok && call.charge === "NONE") {
    cost = { usd: 0, source: "NONE" };
  }

  let content: unknown = null;
  let error: string | null = call.ok ? null : call.code;
  if (call.ok) {
    try {
      content = normalizeSummary(call.value, sources, false, {
        requireEvidence: true,
      });
    } catch (caught) {
      error = code(
        caught instanceof Error ? caught.message : "",
        "google_summary_response_invalid",
      );
    }
  }
  const finished = await deps.backend("finish", input.sessionId, {
    generation_id: generationId,
    status: content ? "SUCCEEDED" : "FAILED",
    error_code: error,
    content,
    prompt_version: SUMMARY_PROMPT_VERSION,
    cost_usd: cost.usd,
    cost_source: cost.source,
    input_tokens: call.usage?.inputTokens ?? 0,
    output_tokens: call.usage?.outputTokens ?? 0,
    reasoning_tokens: call.usage?.reasoningTokens ?? 0,
    cached_tokens: call.usage?.cachedTokens ?? 0,
  });
  if (finished.status === "SUCCEEDED" && isRecord(finished.summary)) {
    return {
      status: "SUCCEEDED",
      summary: finished.summary,
      cost_usd: cost.usd,
    };
  }
  return {
    status: "FAILED",
    error: code(
      finished.error_code,
      error || "google_summary_generation_failed",
    ),
    cost_usd: cost.usd,
  };
}

/**
 * Trabalho GENERATE_SUMMARY da fila. Sem IA configurada no servidor (flag,
 * chave, modelo) ou sem preço cadastrado, a escola sai da fila por 1 h em vez de
 * chamar a edge à toa; recusa de configuração do provedor faz o mesmo.
 */
export async function runAutoSummaryJob(
  input: {
    sessionId: string;
    aiEnabled: boolean;
    key: string;
    model: string;
    loadPricing: () => Promise<SummaryPricing | null>;
    deadline: number;
  },
  deps: SummaryDeps,
): Promise<SummaryOutcome> {
  const now = deps.now || Date.now;
  if (!input.aiEnabled) {
    await deps.backend("auto_pause", null, {
      reason: "google_summary_ai_not_configured",
      minutes: 60,
    });
    return { status: "SKIPPED", reason: "google_summary_ai_not_configured" };
  }
  if (input.deadline - now() < SUMMARY_MIN_REMAINING_MS) {
    return { status: "DEFERRED", reason: "google_summary_no_time_left" };
  }
  const pricing = await input.loadPricing();
  if (!pricing) {
    await deps.backend("auto_pause", null, {
      reason: "google_summary_pricing_required",
      minutes: 60,
    });
    return { status: "SKIPPED", reason: "google_summary_pricing_required" };
  }
  const found = await deps.backend("auto_sources", input.sessionId);
  if (found.eligible !== true) {
    return { status: "SKIPPED", reason: "google_summary_not_eligible" };
  }
  const sources: SourceArtifact[] =
    (Array.isArray(found.sources) ? found.sources : []).filter(isRecord).map((
      source,
    ) => ({
      id: text(source.id, 40),
      kind: text(source.kind, 20),
      provider_name: text(source.provider_name, 200),
      source_text: typeof source.source_text === "string"
        ? source.source_text
        : "",
    })).filter((source) => source.id && source.source_text);
  const outcome = await runSummaryGeneration({
    trigger: "AUTOMATIC",
    sessionId: input.sessionId,
    sources,
    key: input.key,
    model: input.model,
    pricing,
    deadline: input.deadline,
  }, deps);
  if (
    outcome.status === "FAILED" && CONFIGURATION_FAILURES.has(outcome.error)
  ) {
    await deps.backend("auto_pause", null, {
      reason: outcome.error,
      minutes: 60,
    });
  }
  return outcome;
}
