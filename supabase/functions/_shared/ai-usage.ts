/**
 * Registro de consumo de IA, compartilhado por todas as edge functions.
 *
 * Regra de ouro: métrica NUNCA derruba a funcionalidade. Toda falha aqui é
 * engolida e logada. Se a gravação quebrar, o aluno continua tendo aula — só
 * o número deixa de ser contabilizado.
 */

export interface AiUsageTokens {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /**
   * Tokens de raciocínio (OpenAI/OpenRouter). Já estão DENTRO de outputTokens —
   * são cobrados como saída; é só a quebra. Opcional: quem não informa grava 0.
   */
  reasoningTokens?: number;
}

/**
 * Cliente mínimo — evita acoplar a assinatura ao tipo do supabase-js.
 * `PromiseLike` porque o builder do PostgREST é thenable, não uma Promise.
 */
interface UsageWriter {
  from: (table: string) => {
    insert: (rows: Record<string, unknown>) => PromiseLike<{ error: unknown }>;
  };
}

const wholeNumber = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : 0;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * Normaliza o bloco `usage` do OpenRouter/OpenAI. Os provedores variam entre
 * `prompt_tokens`/`input_tokens` e aninham o cache de formas diferentes, então
 * aceitamos os dois formatos em vez de assumir um.
 */
export function parseAiUsage(payload: unknown): AiUsageTokens | null {
  const usage = isRecord(payload)
    ? payload.usage ?? payload.usageMetadata ?? payload
    : null;
  if (!isRecord(usage)) return null;

  const inputTokens = wholeNumber(usage.input_tokens) ||
    wholeNumber(usage.prompt_tokens) ||
    wholeNumber(usage.promptTokenCount);
  const outputTokens = wholeNumber(usage.output_tokens) ||
    wholeNumber(usage.completion_tokens) ||
    wholeNumber(usage.candidatesTokenCount);

  const promptDetails = isRecord(usage.prompt_tokens_details)
    ? usage.prompt_tokens_details
    : isRecord(usage.input_token_details)
    ? usage.input_token_details
    : null;
  const cachedTokens = wholeNumber(usage.cached_tokens) ||
    wholeNumber(promptDetails?.cached_tokens) ||
    wholeNumber(usage.cachedContentTokenCount);

  // Só os formatos em que o raciocínio já está dentro da saída
  // (completion_tokens_details / output_tokens_details). O thoughtsTokenCount
  // do Gemini direto fica de fora: lá ele NÃO está em candidatesTokenCount.
  const completionDetails = isRecord(usage.completion_tokens_details)
    ? usage.completion_tokens_details
    : isRecord(usage.output_tokens_details)
    ? usage.output_tokens_details
    : null;
  const reasoningTokens = wholeNumber(completionDetails?.reasoning_tokens);

  if (!inputTokens && !outputTokens && !cachedTokens) return null;
  return reasoningTokens
    ? { inputTokens, outputTokens, cachedTokens, reasoningTokens }
    : { inputTokens, outputTokens, cachedTokens };
}

/**
 * Grava um evento de consumo. O retorno nunca rejeita, mas deve ser aguardado
 * pela Edge Function para o isolate não encerrar antes da escrita.
 */
export async function recordAiUsage(
  db: UsageWriter,
  event: {
    tenantId: string | null;
    userId: string | null;
    feature: string;
    provider?: string;
    model: string;
    usage: AiUsageTokens | null;
  },
): Promise<void> {
  if (!event.usage) return;
  try {
    const { error } = await db.from("ai_usage_events").insert({
      tenant_id: event.tenantId,
      user_id: event.userId,
      feature: event.feature.slice(0, 60),
      provider: (event.provider ?? "openrouter").slice(0, 30),
      model: event.model.slice(0, 120),
      input_tokens: event.usage.inputTokens,
      output_tokens: event.usage.outputTokens,
      cached_tokens: event.usage.cachedTokens,
      // Só quando existe: a coluna nasceu em 20260927110000, e uma function
      // publicada antes da migration continua gravando.
      ...(event.usage.reasoningTokens
        ? { reasoning_tokens: event.usage.reasoningTokens }
        : {}),
    });
    if (error) {
      console.error("AI usage record failed", { feature: event.feature });
    }
  } catch {
    console.error("AI usage record threw", { feature: event.feature });
  }
}
