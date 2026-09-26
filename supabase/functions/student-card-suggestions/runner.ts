// Esteira das sugestões do cartão: a mesma para a fila automática (depois que
// o professor aprova o resumo da aula) e para o botão do professor no dossiê.
//
//   fontes (banco: aceite da IA e regra de menor conferidos AGORA) → prompt →
//   estimativa → reserva (hash das fontes, lease, teto mensal do resumo) →
//   OpenRouter → conferência (citação na fonte, lista de exclusão) → gravação
//   (o banco confere de novo) + custo real no livro e em ai_usage_events.
//
// Nada daqui escreve no cartão: as sugestões nascem PENDING e só o professor
// as aceita (decide_student_card_suggestion).
import {
  isRecord,
  type SourceArtifact,
  type SummaryPricing,
  type SummaryUsage,
  summaryUsageCost,
  text,
} from "../google-meet/core.ts";
import type { Fetcher } from "../google-meet/provider.ts";
import {
  ALL_CARD_FIELDS,
  type CardField,
  estimateSuggestionCost,
  normalizeSuggestions,
  openRouterSuggestions,
  pickSuggestionSources,
  speakerNames,
  suggestionMessages,
  SUGGESTIONS_MAX_ESTIMATE_USD,
} from "./core.ts";

// O worker morre em 150 s; cada rodada tem um prazo (deadline). A chamada ao
// modelo tem no máximo 45 s e só começa com 35 s de folga: a reserva, o custo e
// a gravação precisam caber depois dela.
export const SUGGESTIONS_CALL_TIMEOUT_MS = 45_000;
export const SUGGESTIONS_MIN_REMAINING_MS = 35_000;
export const SUGGESTIONS_FINISH_MARGIN_MS = 8_000;

// Recusas do provedor que são de CONFIGURAÇÃO (chave, créditos): a fila pausa.
const CONFIGURATION_FAILURES = new Set([
  "card_suggestions_provider_rejected",
  "card_suggestions_provider_credits",
]);

export type SuggestionBackendAction =
  | "due"
  | "auto_pause"
  | "target"
  | "sources"
  | "claim"
  | "finish";
export interface SuggestionScope {
  tenantId: string | null;
  actorId: string | null;
  sessionId: string | null;
}
/** student_card_suggestions_backend (só service_role). */
export type SuggestionBackend = (
  action: SuggestionBackendAction,
  scope: SuggestionScope,
  payload?: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export interface SuggestionDeps {
  backend: SuggestionBackend;
  // ai_usage_events (feature student_card_suggestions).
  recordUsage: (
    usage: SummaryUsage,
    scope: { tenantId: string; actorId: string | null },
  ) => Promise<void>;
  fetcher?: Fetcher;
  now?: () => number;
}

export type SuggestionOutcome =
  | {
    status: "SUCCEEDED";
    saved: number;
    dropped: number;
    cost_usd: number | null;
  }
  | { status: "FAILED"; error: string; cost_usd: number | null }
  | { status: "SKIPPED" | "DEFERRED"; reason: string };

const code = (value: unknown, fallback: string): string => {
  const valueText = text(value, 80);
  return /^[a-z_]{1,80}$/.test(valueText) ? valueText : fallback;
};
const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : 0;

/**
 * Uma leitura de UMA aula. Recusa do banco (aceite, teto, já lida, em
 * andamento) volta como SKIPPED com o motivo — nada foi pago.
 */
export async function runCardSuggestions(
  input: {
    trigger: "AUTOMATIC" | "MANUAL";
    tenantId: string;
    sessionId: string;
    actorId: string | null;
    key: string;
    model: string;
    pricing: SummaryPricing;
    deadline: number;
  },
  deps: SuggestionDeps,
): Promise<SuggestionOutcome> {
  const now = deps.now || Date.now;
  if (input.deadline - now() < SUGGESTIONS_MIN_REMAINING_MS) {
    return { status: "DEFERRED", reason: "card_suggestions_no_time_left" };
  }
  const scope: SuggestionScope = {
    tenantId: input.tenantId,
    actorId: input.actorId,
    sessionId: input.sessionId,
  };
  const found = await deps.backend("sources", scope, {
    trigger: input.trigger,
  });
  if (found.eligible !== true) {
    return {
      status: "SKIPPED",
      reason: code(found.reason, "card_suggestions_not_eligible"),
    };
  }
  // Campos que o BANCO diz que valem para este aluno agora (menor: só objetivo
  // e temas). Campo desconhecido fica de fora.
  const fields = (Array.isArray(found.fields) ? found.fields : []).filter((
    field,
  ): field is CardField => ALL_CARD_FIELDS.includes(field as CardField));
  if (!fields.length) {
    return { status: "SKIPPED", reason: "card_suggestions_no_fields" };
  }
  const sources = pickSuggestionSources(
    (Array.isArray(found.sources) ? found.sources : []).filter(isRecord).map((
      source,
    ): SourceArtifact => ({
      id: text(source.id, 40),
      kind: text(source.kind, 20),
      provider_name: text(source.provider_name, 200),
      imported_at: text(source.imported_at, 40),
      source_text: typeof source.source_text === "string"
        ? source.source_text
        : "",
    })).filter((source) => source.id && source.source_text),
  );
  if (!sources.length) return { status: "SKIPPED", reason: "sem_fonte" };
  const names = [
    ...(Array.isArray(found.people_names) ? found.people_names : [])
      .map((name) => text(name, 200)).filter(Boolean),
    ...speakerNames(sources),
  ];
  const messages = suggestionMessages(sources, fields, found.minor === true);
  const estimate = estimateSuggestionCost(
    messages.reduce((sum, message) => sum + message.content.length, 0),
    input.pricing,
  );
  if (estimate.usd > SUGGESTIONS_MAX_ESTIMATE_USD) {
    return { status: "SKIPPED", reason: "card_suggestions_estimate_too_high" };
  }
  const claim = await deps.backend("claim", scope, {
    trigger: input.trigger,
    model_id: input.model,
    estimated_usd: estimate.usd,
    source_artifact_ids: sources.map((source) => source.id),
  });
  if (claim.claimed !== true) {
    return {
      status: "SKIPPED",
      reason: code(claim.reason, "card_suggestions_not_claimed"),
    };
  }
  const runId = text(claim.run_id, 40);
  const call = await openRouterSuggestions({
    messages,
    key: input.key,
    model: input.model,
    fields,
    timeoutMs: Math.min(
      SUGGESTIONS_CALL_TIMEOUT_MS,
      input.deadline - now() - SUGGESTIONS_FINISH_MARGIN_MS,
    ),
  }, deps.fetcher);
  if (call.usage) {
    await deps.recordUsage(call.usage, {
      tenantId: input.tenantId,
      actorId: input.actorId,
    });
  }

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

  let error: string | null = call.ok ? null : call.code;
  let kept: ReturnType<typeof normalizeSuggestions>["kept"] = [];
  let dropped = 0;
  if (call.ok) {
    try {
      const normalized = normalizeSuggestions(
        call.value,
        sources,
        fields,
        names,
      );
      kept = normalized.kept;
      dropped = normalized.dropped;
    } catch (caught) {
      error = code(
        caught instanceof Error ? caught.message : "",
        "card_suggestions_response_invalid",
      );
    }
  }
  const finished = await deps.backend("finish", scope, {
    run_id: runId,
    status: error ? "FAILED" : "SUCCEEDED",
    error_code: error,
    suggestions: kept,
    dropped,
    cost_usd: cost.usd,
    cost_source: cost.source,
    input_tokens: call.usage?.inputTokens ?? 0,
    output_tokens: call.usage?.outputTokens ?? 0,
    reasoning_tokens: call.usage?.reasoningTokens ?? 0,
    cached_tokens: call.usage?.cachedTokens ?? 0,
  });
  if (finished.status === "SUCCEEDED") {
    return {
      status: "SUCCEEDED",
      saved: count(finished.saved),
      dropped: count(finished.dropped),
      cost_usd: cost.usd,
    };
  }
  return {
    status: "FAILED",
    error: code(finished.error_code, error || "card_suggestions_failed"),
    cost_usd: cost.usd,
  };
}

/** O botão do professor no dossiê: a aula aprovada mais recente ainda não lida. */
export async function runManualSuggestions(
  input: {
    tenantId: string;
    actorId: string;
    studentId: string;
    aiEnabled: boolean;
    key: string;
    model: string;
    loadPricing: () => Promise<SummaryPricing | null>;
    deadline: number;
  },
  deps: SuggestionDeps,
): Promise<SuggestionOutcome> {
  if (!input.aiEnabled) {
    return { status: "SKIPPED", reason: "card_suggestions_not_configured" };
  }
  // Permissão conferida no banco como a própria pessoa (a régua do cartão).
  const target = await deps.backend("target", {
    tenantId: input.tenantId,
    actorId: input.actorId,
    sessionId: null,
  }, { student_id: input.studentId });
  const sessionId = text(target.session_id, 40);
  if (!sessionId) {
    return {
      status: "SKIPPED",
      reason: code(target.reason, "sem_aula_aprovada"),
    };
  }
  if (target.budget_ok === false) {
    return { status: "SKIPPED", reason: "teto_atingido" };
  }
  const pricing = await input.loadPricing();
  if (!pricing) {
    return { status: "SKIPPED", reason: "card_suggestions_pricing_required" };
  }
  return runCardSuggestions({
    trigger: "MANUAL",
    tenantId: input.tenantId,
    sessionId,
    actorId: input.actorId,
    key: input.key,
    model: input.model,
    pricing,
    deadline: input.deadline,
  }, deps);
}

export interface TickItem {
  session_id: string;
  status: SuggestionOutcome["status"];
  saved?: number;
  reason?: string;
  error?: string;
}

/**
 * Rodada da fila (cron a cada 15 min, só quando o banco tem aula pronta). Sem
 * IA configurada ou sem preço, as escolas da fila pausam em vez de chamar a
 * edge à toa. A resposta vai para o pg_net: SÓ estados, nunca texto da aula.
 */
export async function runSuggestionsTick(
  input: {
    aiEnabled: boolean;
    key: string;
    model: string;
    loadPricing: () => Promise<SummaryPricing | null>;
    deadline: number;
  },
  deps: SuggestionDeps,
): Promise<{ processed: TickItem[]; paused?: string }> {
  const now = deps.now || Date.now;
  const due = await deps.backend("due", {
    tenantId: null,
    actorId: null,
    sessionId: null,
  }, { limit: 3 });
  const items = (Array.isArray(due.items) ? due.items : []).filter(isRecord)
    .map((item) => ({
      tenantId: text(item.tenant_id, 100),
      sessionId: text(item.session_id, 40),
    })).filter((item) => item.tenantId && item.sessionId);
  const pauseAll = async (reason: string, minutes: number) => {
    for (const tenantId of new Set(items.map((item) => item.tenantId))) {
      await deps.backend("auto_pause", {
        tenantId,
        actorId: null,
        sessionId: null,
      }, { reason, minutes });
    }
  };
  if (!items.length) return { processed: [] };
  if (!input.aiEnabled) {
    await pauseAll("card_suggestions_not_configured", 360);
    return { processed: [], paused: "card_suggestions_not_configured" };
  }
  const pricing = await input.loadPricing();
  if (!pricing) {
    await pauseAll("card_suggestions_pricing_required", 60);
    return { processed: [], paused: "card_suggestions_pricing_required" };
  }
  const processed: TickItem[] = [];
  for (const item of items) {
    if (input.deadline - now() < SUGGESTIONS_MIN_REMAINING_MS) break;
    let outcome: SuggestionOutcome;
    try {
      outcome = await runCardSuggestions({
        trigger: "AUTOMATIC",
        tenantId: item.tenantId,
        sessionId: item.sessionId,
        actorId: null,
        key: input.key,
        model: input.model,
        pricing,
        deadline: input.deadline,
      }, deps);
    } catch (caught) {
      outcome = {
        status: "FAILED",
        error: code(
          caught instanceof Error ? caught.message : "",
          "card_suggestions_failed",
        ),
        cost_usd: null,
      };
    }
    processed.push(
      outcome.status === "SUCCEEDED"
        ? {
          session_id: item.sessionId,
          status: outcome.status,
          saved: outcome.saved,
        }
        : outcome.status === "FAILED"
        ? {
          session_id: item.sessionId,
          status: outcome.status,
          error: outcome.error,
        }
        : {
          session_id: item.sessionId,
          status: outcome.status,
          reason: outcome.reason,
        },
    );
    if (
      outcome.status === "FAILED" && CONFIGURATION_FAILURES.has(outcome.error)
    ) {
      // Chave recusada ou sem créditos vale para todas: pausa e para.
      await pauseAll(outcome.error, 60);
      break;
    }
  }
  return { processed };
}
