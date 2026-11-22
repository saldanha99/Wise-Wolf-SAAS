/// <reference lib="deno.ns" />
// Ponte de IA sem OpenRouter (22/11/2026): nada sai para openrouter.ai.
import { aiFetch, pickModel, textAiKey } from "./ai-gateway.ts";

function assertEquals(actual: unknown, expected: unknown) {
  if (actual !== expected) {
    throw new Error(`expected ${expected}, got ${actual}`);
  }
}

Deno.test("endereço do OpenRouter que não é chat nem embeddings é bloqueado sem rede", async () => {
  const response = await aiFetch("https://openrouter.ai/api/v1/key", {
    method: "GET",
  });
  assertEquals(response.status, 410);
});

Deno.test("chat sem chave da Anthropic volta 503, sem reserva no OpenRouter", async () => {
  const previous = Deno.env.get("ANTHROPIC_API_KEY");
  Deno.env.delete("ANTHROPIC_API_KEY");
  try {
    assertEquals(textAiKey(), "");
    const response = await aiFetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        body: JSON.stringify({
          model: "anthropic/claude-haiku-4.5",
          messages: [],
        }),
      },
    );
    assertEquals(response.status, 503);
  } finally {
    if (previous) Deno.env.set("ANTHROPIC_API_KEY", previous);
  }
});

Deno.test("embeddings sem chave da OpenAI voltam 503 em vez de ir ao OpenRouter", async () => {
  const previous = Deno.env.get("OPENAI_API_KEY");
  Deno.env.delete("OPENAI_API_KEY");
  try {
    const response = await aiFetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      body: JSON.stringify({
        model: "openai/text-embedding-3-small",
        input: "x",
      }),
    });
    assertEquals(response.status, 503);
  } finally {
    if (previous) Deno.env.set("OPENAI_API_KEY", previous);
  }
});

Deno.test("Sonnet só onde a função pede Sonnet", () => {
  assertEquals(/sonnet/.test(pickModel("anthropic/claude-sonnet-4")), true);
  assertEquals(/haiku/.test(pickModel("google/gemini-3.6-flash")), true);
});
