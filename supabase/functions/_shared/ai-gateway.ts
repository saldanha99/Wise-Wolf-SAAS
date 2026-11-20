/**
 * Ponte de IA: chat do OpenRouter -> API oficial da Anthropic (19/11/2026).
 *
 * Decisão do Vinícius: Claude Haiku 5.5 em todas as funções, pela API oficial
 * da Anthropic, com o OpenRouter como reserva. Cada função importa este módulo
 * como `fetch`; só pedidos para o chat do OpenRouter são desviados. Embeddings,
 * Evolution, Asaas etc. passam direto para o fetch global, sem mudança.
 *
 * Desligar sem deploy: ANTHROPIC_ROUTING=off no .env.functions (ou tirar a
 * ANTHROPIC_API_KEY) e recriar o container de funções.
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
    ? (Deno.env.get("ANTHROPIC_SMART_MODEL") ?? "").trim() || DEFAULT_SMART_MODEL
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
  else out.thinking = { type: /haiku/i.test(model) ? "disabled" : "between_tools" };
  return out;
}

export async function aiFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const url = targetUrl(input);
  const key = (Deno.env.get("ANTHROPIC_API_KEY") ?? "").trim();
  const routing = (Deno.env.get("ANTHROPIC_ROUTING") ?? "on").trim().toLowerCase();
  if (
    url !== OPENROUTER_CHAT || !key || routing === "off" ||
    typeof init?.body !== "string"
  ) {
    return nativeFetch(input, init);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(init.body);
  } catch {
    return nativeFetch(input, init);
  }
  if (parsed.stream) return nativeFetch(input, init);

  const model = pickModel(parsed.model);
  const started = Date.now();
  try {
    const resp = await nativeFetch(ANTHROPIC_CHAT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key}`,
      },
      body: JSON.stringify(toAnthropicBody(parsed, model)),
      signal: init.signal,
    });
    if (resp.ok) {
      console.log(
        `[ai-gateway] anthropic ok model=${model} asked=${parsed.model} ms=${Date.now() - started}`,
      );
      return resp;
    }
    const detail = (await resp.text().catch(() => "")).slice(0, 200);
    console.warn(
      `[ai-gateway] anthropic HTTP ${resp.status} asked=${parsed.model}; reserva OpenRouter. ${detail}`,
    );
  } catch (error) {
    if (init.signal?.aborted) throw error;
    console.warn(
      `[ai-gateway] anthropic falhou (${(error as Error)?.name}); reserva OpenRouter.`,
    );
  }
  return nativeFetch(input, init);
}
