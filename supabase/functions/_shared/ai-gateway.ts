/**
 * Ponte de IA da Wise Wolf: tudo de texto vai para a API oficial da Anthropic.
 *
 * 19/11/2026: Claude Haiku 5.5 em todas as funções (Sonnet onde o código pede
 * Sonnet), com o OpenRouter como reserva.
 * 22/11/2026 (decisão do Vinícius): o OpenRouter SAIU da Wise Wolf — nem
 * provedor, nem reserva, nem chave no fluxo. As funções continuam montando o
 * pedido no formato do chat do OpenRouter (é o formato OpenAI) e importam este
 * módulo como `fetch`:
 *   * chat (openrouter.ai/.../chat/completions) → Anthropic; falhou, volta erro
 *     503 no formato que as funções já tratam (não há mais reserva);
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
  return (Deno.env.get("ANTHROPIC_API_KEY") ?? "").trim();
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
  return nativeFetch(OPENAI_EMBEDDINGS, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${key}`,
    },
    body: JSON.stringify({ ...parsed, model }),
    signal: init.signal,
  });
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
