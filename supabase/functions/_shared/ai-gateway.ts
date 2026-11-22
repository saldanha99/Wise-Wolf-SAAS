/**
 * Ponte de IA da Wise Wolf: tudo de texto vai para a API oficial da Anthropic.
 *
 * 19/11/2026: Claude Haiku 5.5 em todas as funções (Sonnet onde o código pede
 * Sonnet), com o OpenRouter como reserva.
 * 22/11/2026 (decisão do Vinícius): o OpenRouter saiu como provedor e como
 * reserva de falha. 22/11/2026, noite: ele volta SÓ acima do teto mensal da
 * Anthropic (ANTHROPIC_MONTHLY_BUDGET_USD, padrão US$ 50) ou com
 * ANTHROPIC_ROUTING=off — ver "Teto mensal" abaixo. As funções continuam montando o
 * pedido no formato do chat do OpenRouter (é o formato OpenAI) e importam este
 * módulo como `fetch`:
 *   * chat (openrouter.ai/.../chat/completions) → Anthropic; falhou, volta erro
 *     503 no formato que as funções já tratam (falha não cai no OpenRouter);
 *   * embeddings (openrouter.ai/.../embeddings) → OpenAI direto, mesmo modelo
 *     (text-embedding-3-small), com a OPENAI_API_KEY que o realtime já usa;
 *   * qualquer outro endereço do openrouter.ai → bloqueado (410), sem rede.
 * O resto (Evolution, Asaas, Google…) passa direto para o fetch global.
 */

const OPENROUTER_CHAT = "https://openrouter.ai/api/v1/chat/completions";
const ANTHROPIC_CHAT = "https://api.anthropic.com/v1/chat/completions";
const DEFAULT_MODEL = "claude-haiku-5-5";
// 19/11/2026: o Vinícius manteve o Sonnet onde o código pede Sonnet
// (comercial, fechamento pós-experimental e acompanhamento de alunos).
const DEFAULT_SMART_MODEL = "claude-sonnet-5-5";

/** Sonnet onde a função pediu Sonnet; Haiku no resto. */
export function pickModel(asked: unknown): string {
  const wantsSonnet = /sonnet/i.test(String(asked ?? ""));
  return wantsSonnet
    ? (Deno.env.get("ANTHROPIC_SMART_MODEL") ?? "").trim() ||
      DEFAULT_SMART_MODEL
    : (Deno.env.get("ANTHROPIC_MODEL") ?? "").trim() || DEFAULT_MODEL;
}

const nativeFetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis);

function targetUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

const EFFORTS = new Set(["low", "medium", "high"]);

/** Converte o corpo no formato OpenRouter para o que a Anthropic aceita. */
export function toAnthropicBody(
  body: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    model,
    messages: body.messages,
    max_tokens: Number(body.max_tokens ?? body.max_completion_tokens) || 2000,
  };
  if (body.stop) out.stop = body.stop;
  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools;
    if (body.tool_choice) out.tool_choice = body.tool_choice;
  }
  // json_object não é aceito; json_schema é. O prompt já pede JSON.
  const rf = body.response_format as { type?: string } | undefined;
  if (rf?.type === "json_schema") out.response_format = rf;
  // temperature é recusada pelo Haiku 5.5. Raciocínio: só se a função pediu.
  const effort = String(
    (body.reasoning as { effort?: string } | undefined)?.effort ?? "",
  ).toLowerCase();
  // Desligar o raciocínio: o Haiku aceita "disabled"; o Sonnet 5.5 exige "between_tools".
  if (EFFORTS.has(effort)) out.reasoning_effort = effort;
  else {out.thinking = {
      type: /haiku/i.test(model) ? "disabled" : "between_tools",
    };}
  return out;
}

const OPENROUTER_HOST = "https://openrouter.ai/";
const OPENROUTER_EMBEDDINGS = "https://openrouter.ai/api/v1/embeddings";
const OPENAI_EMBEDDINGS = "https://api.openai.com/v1/embeddings";

/**
 * Chave que as funções usam para saber se a IA de texto está configurada. Antes
 * era a OPENROUTER_API_KEY; agora é a da Anthropic (a ponte ignora o
 * Authorization que a função manda e usa a própria chave).
 */
export function textAiKey(): string {
  const anthropic = (Deno.env.get("ANTHROPIC_API_KEY") ?? "").trim();
  if (anthropic) return anthropic;
  // Com ANTHROPIC_ROUTING=off a chave da Anthropic pode nem existir: as funções
  // só checam se há chave antes de chamar, e o chat vai ao OpenRouter.
  const routingOff = (Deno.env.get("ANTHROPIC_ROUTING") ?? "").trim()
    .toLowerCase() === "off";
  return routingOff ? (Deno.env.get("OPENROUTER_API_KEY") ?? "").trim() : "";
}

function errorResponse(
  status: number,
  code: string,
  message: string,
): Response {
  return new Response(
    JSON.stringify({ error: { code, message } }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

async function embeddingsViaOpenAI(init?: RequestInit): Promise<Response> {
  const key = (Deno.env.get("OPENAI_API_KEY") ?? "").trim();
  if (!key || typeof init?.body !== "string") {
    return errorResponse(
      503,
      "embeddings_unavailable",
      "OpenAI embeddings not configured",
    );
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(init.body);
  } catch {
    return errorResponse(400, "invalid_request", "Invalid embeddings body");
  }
  const model = String(parsed.model ?? "").replace(/^openai\//, "") ||
    "text-embedding-3-small";
  // Só os campos que a OpenAI aceita: o pedido antigo traz `provider` (do
  // OpenRouter), que a OpenAI recusa com 400.
  const clean: Record<string, unknown> = { model, input: parsed.input };
  for (const field of ["dimensions", "encoding_format", "user"]) {
    if (parsed[field] !== undefined) clean[field] = parsed[field];
  }
  return nativeFetch(OPENAI_EMBEDDINGS, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${key}`,
    },
    body: JSON.stringify(clean),
    signal: init.signal,
  });
}

// ── Teto mensal da Anthropic (22/11/2026, decisão do Vinícius) ─────────────
// A chave é compartilhada com o Lei Prova (que tem o próprio contador). A Wise
// Wolf mede cada chamada (usage × preço) e soma por mês UTC em
// private.ai_provider_monthly_spend. Até o teto nada muda; acima dele o chat
// vai para o OpenRouter (o provedor de antes) até virar o mês. Falha ao ler ou
// gravar o contador nunca bloqueia: segue na Anthropic (fail-open).
// ANTHROPIC_ROUTING=off manda tudo para o OpenRouter (chave para voltar atrás).

/** US$ por 1M de tokens (preço oficial, 22/11/2026). */
const ANTHROPIC_PRICES: Record<
  string,
  {
    input: number;
    output: number;
    cacheRead: number;
    long?: { input: number; output: number; cacheRead: number };
  }
> = {
  // Haiku 5.5: prompts acima de 100K tokens custam mais.
  "claude-haiku-5-5": {
    input: 0.10,
    output: 0.50,
    cacheRead: 0.01,
    long: { input: 0.50, output: 2.50, cacheRead: 0.05 },
  },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.10 },
};
const LONG_PROMPT_TOKENS = 100_000;
const DEFAULT_MONTHLY_BUDGET_USD = 50;
const SPEND_CACHE_MS = 60_000;
const SPEND_RPC_TIMEOUT_MS = 1_000;

/** Custo em US$ de uma resposta do chat da Anthropic (formato OpenAI). */
export function anthropicCostUsd(model: string, usage: unknown): number | null {
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  const prompt = Number(u.prompt_tokens);
  const completion = Number(u.completion_tokens);
  if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return null;
  const details = u.prompt_tokens_details as
    | Record<string, unknown>
    | undefined;
  const cached = Math.min(
    Math.max(Number(details?.cached_tokens) || 0, 0),
    prompt,
  );
  // Modelo desconhecido: preço do Sonnet (o mais caro) para o teto não furar.
  const base = ANTHROPIC_PRICES[model] ?? ANTHROPIC_PRICES["claude-sonnet-5-5"];
  const price = prompt > LONG_PROMPT_TOKENS && base.long ? base.long : base;
  return ((prompt - cached) * price.input + cached * price.cacheRead +
    Math.max(completion, 0) * price.output) / 1_000_000;
}

/** Teto mensal em US$. "off" = sem teto; valor inválido = padrão (50). */
export function monthlyBudgetUsd(): number {
  const raw = (Deno.env.get("ANTHROPIC_MONTHLY_BUDGET_USD") ?? "").trim();
  if (raw.toLowerCase() === "off") return Number.POSITIVE_INFINITY;
  const value = Number(raw);
  return raw && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_MONTHLY_BUDGET_USD;
}

export function anthropicRoutingOff(): boolean {
  return (Deno.env.get("ANTHROPIC_ROUTING") ?? "").trim().toLowerCase() ===
    "off";
}

/** Gasto conhecido acima do teto? Sem leitura (null) não bloqueia. */
export function overBudget(
  spentUsd: number | null,
  budgetUsd: number,
): boolean {
  return spentUsd !== null && Number.isFinite(budgetUsd) &&
    spentUsd >= budgetUsd;
}

// EdgeRuntime é injetado pelo runtime do Supabase (sem tipagem padrão).
declare const EdgeRuntime:
  | { waitUntil: (promise: Promise<unknown>) => void }
  | undefined;

/** Gravação do gasto fora do caminho da resposta; sem EdgeRuntime, só dispara. */
function runInBackground(task: Promise<unknown>): void {
  const guarded = task.catch(() => undefined);
  try {
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
      EdgeRuntime.waitUntil(guarded);
    }
  } catch {
    // Sem waitUntil a promessa segue sozinha.
  }
}

function isStreamBody(body: unknown): boolean {
  if (typeof body !== "string") return false;
  try {
    return JSON.parse(body)?.stream === true;
  } catch {
    return false;
  }
}

const utcMonth = (d = new Date()) => d.toISOString().slice(0, 7);
let spendCache: { month: string; usd: number; at: number } | null = null;

async function spendRpc(
  fn: string,
  args: Record<string, unknown>,
): Promise<number | null> {
  const url = (Deno.env.get("SUPABASE_URL") ?? "").trim();
  const key = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "").trim();
  if (!url || !key) return null;
  try {
    const resp = await nativeFetch(`${url}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key}`,
        "apikey": key,
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(SPEND_RPC_TIMEOUT_MS),
    });
    if (!resp.ok) {
      console.warn(
        `[ai-gateway] contador de gasto HTTP ${resp.status} (${fn})`,
      );
      return null;
    }
    const value = Number(await resp.json());
    return Number.isFinite(value) ? value : null;
  } catch (error) {
    console.warn(
      `[ai-gateway] contador de gasto falhou (${fn}): ${
        (error as Error)?.name
      }`,
    );
    return null;
  }
}

async function anthropicSpentThisMonth(): Promise<number | null> {
  const month = utcMonth();
  if (
    spendCache && spendCache.month === month &&
    Date.now() - spendCache.at < SPEND_CACHE_MS
  ) {
    return spendCache.usd;
  }
  const usd = await spendRpc("ai_provider_spend_month", {
    p_provider: "anthropic",
  });
  if (usd !== null) spendCache = { month, usd, at: Date.now() };
  return usd;
}

async function recordAnthropicSpend(
  resp: Response,
  model: string,
): Promise<void> {
  try {
    const data = await resp.clone().json();
    const cost = anthropicCostUsd(model, data?.usage);
    if (cost === null) {
      console.warn(
        `[ai-gateway] resposta sem usage; gasto não medido (model=${model})`,
      );
      return;
    }
    const total = await spendRpc("ai_provider_spend_add", {
      p_provider: "anthropic",
      p_usd: Number(cost.toFixed(6)),
    });
    if (total !== null) {
      spendCache = { month: utcMonth(), usd: total, at: Date.now() };
    }
  } catch {
    // Medição nunca derruba a resposta.
  }
}

/** Chat pelo OpenRouter (provedor de antes), com o corpo original da função. */
async function chatViaOpenRouter(
  init: RequestInit,
  reason: string,
): Promise<Response> {
  const key = (Deno.env.get("OPENROUTER_API_KEY") ?? "").trim();
  if (!key) {
    console.warn(
      `[ai-gateway] ${reason}: sem OPENROUTER_API_KEY, sem reserva.`,
    );
    return errorResponse(
      reason === "budget" ? 429 : 503,
      reason === "budget" ? "ai_budget_exceeded" : "ai_not_configured",
      "Anthropic budget reached and no fallback configured",
    );
  }
  console.log(`[ai-gateway] chat pelo OpenRouter (${reason})`);
  const resp = await nativeFetch(OPENROUTER_CHAT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${key}`,
    },
    body: init.body,
    signal: init.signal,
  });
  if (resp.ok && !isStreamBody(init.body)) {
    try {
      const data = await resp.clone().json();
      const cost = Number(data?.usage?.cost);
      if (Number.isFinite(cost) && cost >= 0 && cost <= 100) {
        runInBackground(spendRpc("ai_provider_spend_add", {
          p_provider: "openrouter",
          p_usd: Number(cost.toFixed(6)),
        }));
      }
    } catch {
      // Medição nunca derruba a resposta.
    }
  }
  return resp;
}

export async function aiFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const url = targetUrl(input);
  if (!url.startsWith(OPENROUTER_HOST)) return nativeFetch(input, init);
  if (url === OPENROUTER_EMBEDDINGS) return embeddingsViaOpenAI(init);
  if (url !== OPENROUTER_CHAT) {
    console.warn("[ai-gateway] OpenRouter bloqueado na Wise Wolf", {
      path: url.slice(21, 80),
    });
    return errorResponse(
      410,
      "openrouter_removed",
      "OpenRouter is no longer used",
    );
  }

  if (typeof init?.body === "string" && anthropicRoutingOff()) {
    return chatViaOpenRouter(init, "routing_off");
  }
  const key = textAiKey();
  if (!key || typeof init?.body !== "string") {
    return errorResponse(503, "ai_not_configured", "Anthropic API key missing");
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(init.body);
  } catch {
    return errorResponse(400, "invalid_request", "Invalid chat body");
  }

  const budget = monthlyBudgetUsd();
  if (
    Number.isFinite(budget) &&
    overBudget(await anthropicSpentThisMonth(), budget)
  ) {
    return chatViaOpenRouter(init, "budget");
  }

  const model = pickModel(parsed.model);
  const started = Date.now();
  try {
    const body = toAnthropicBody(parsed, model);
    if (parsed.stream === true) body.stream = true;
    const resp = await nativeFetch(ANTHROPIC_CHAT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key}`,
      },
      body: JSON.stringify(body),
      signal: init.signal,
    });
    if (resp.ok) {
      if (body.stream !== true) {
        runInBackground(recordAnthropicSpend(resp, model));
      }
      console.log(
        `[ai-gateway] anthropic ok model=${model} asked=${parsed.model} ms=${
          Date.now() - started
        }`,
      );
      return resp;
    }
    const detail = (await resp.text().catch(() => "")).slice(0, 200);
    console.warn(
      `[ai-gateway] anthropic HTTP ${resp.status} asked=${parsed.model}; sem reserva. ${detail}`,
    );
    // Mesmo status (402/429/5xx) para as funções seguirem com o tratamento delas.
    return errorResponse(
      resp.status,
      "anthropic_error",
      detail || "Anthropic request failed",
    );
  } catch (error) {
    if (init.signal?.aborted) throw error;
    console.warn(
      `[ai-gateway] anthropic falhou (${(error as Error)?.name}); sem reserva.`,
    );
    return errorResponse(
      503,
      "anthropic_unavailable",
      "Anthropic request failed",
    );
  }
}
