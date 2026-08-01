/// <reference lib="deno.ns" />

import {
  parseAiUsage,
  recordAiUsage,
} from "../../supabase/functions/_shared/ai-usage.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("aceita o formato do OpenRouter (prompt/completion_tokens)", () => {
  const usage = parseAiUsage({
    usage: {
      prompt_tokens: 4000,
      completion_tokens: 500,
      prompt_tokens_details: { cached_tokens: 3200 },
    },
  });
  assert(usage !== null, "usage do OpenRouter precisa ser lido");
  assert(usage.inputTokens === 4000, `input errado: ${usage.inputTokens}`);
  assert(usage.outputTokens === 500, `output errado: ${usage.outputTokens}`);
  assert(usage.cachedTokens === 3200, `cache errado: ${usage.cachedTokens}`);
});

Deno.test("aceita o formato do OpenAI (input/output_tokens)", () => {
  const usage = parseAiUsage({
    usage: {
      input_tokens: 1200,
      output_tokens: 300,
      input_token_details: { cached_tokens: 800 },
    },
  });
  assert(usage !== null, "usage da OpenAI precisa ser lido");
  assert(
    usage.inputTokens === 1200 && usage.cachedTokens === 800,
    "os dois formatos de provedor precisam funcionar",
  );
});

Deno.test("aceita usageMetadata do Gemini", () => {
  const usage = parseAiUsage({
    usageMetadata: {
      promptTokenCount: 900,
      candidatesTokenCount: 120,
      cachedContentTokenCount: 640,
    },
  });
  assert(usage !== null, "usageMetadata do Gemini precisa ser lido");
  assert(
    usage.inputTokens === 900,
    `input Gemini errado: ${usage.inputTokens}`,
  );
  assert(
    usage.outputTokens === 120,
    `output Gemini errado: ${usage.outputTokens}`,
  );
  assert(
    usage.cachedTokens === 640,
    `cache Gemini errado: ${usage.cachedTokens}`,
  );
});

Deno.test("usage ausente ou zerado não vira evento", () => {
  assert(parseAiUsage(null) === null, "null não é usage");
  assert(parseAiUsage({}) === null, "objeto vazio não é usage");
  assert(
    parseAiUsage({ usage: { prompt_tokens: 0, completion_tokens: 0 } }) ===
      null,
    "tudo zero não deve gerar linha de custo",
  );
});

Deno.test("valores negativos ou inválidos viram zero, nunca NaN", () => {
  const usage = parseAiUsage({
    usage: { prompt_tokens: -50, completion_tokens: "abc", cached_tokens: 10 },
  });
  assert(usage !== null, "cache válido mantém o evento");
  assert(
    usage.inputTokens === 0 && usage.outputTokens === 0,
    "lixo precisa virar 0 para não corromper o relatório",
  );
});

Deno.test("falha ao gravar NUNCA propaga — métrica não derruba a aula", async () => {
  const quebrado = {
    from: () => ({
      insert: () => Promise.reject(new Error("banco fora do ar")),
    }),
  };
  // Se isto lançar, uma indisponibilidade de métrica derrubaria a IA inteira.
  await recordAiUsage(quebrado, {
    tenantId: "school-wise-wolf",
    userId: null,
    feature: "wolfie_brain",
    model: "anthropic/claude-haiku-4.5",
    usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 0 },
  });

  const comErro = {
    from: () => ({
      insert: () => Promise.resolve({ error: { code: "42P01" } }),
    }),
  };
  await recordAiUsage(comErro, {
    tenantId: null,
    userId: null,
    feature: "wolfie_brain",
    model: "m",
    usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
  });
});

Deno.test("usage nulo não tenta gravar nada", async () => {
  let tentou = false;
  const espiao = {
    from: () => {
      tentou = true;
      return { insert: () => Promise.resolve({ error: null }) };
    },
  };
  await recordAiUsage(espiao, {
    tenantId: "t",
    userId: null,
    feature: "f",
    model: "m",
    usage: null,
  });
  assert(!tentou, "sem usage não deve haver escrita no banco");
});
