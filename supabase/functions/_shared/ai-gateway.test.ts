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

Deno.test("embeddings vão para a OpenAI só com os campos que ela aceita", async () => {
  const previous = Deno.env.get("OPENAI_API_KEY");
  Deno.env.set("OPENAI_API_KEY", "test-key");
  const realFetch = globalThis.fetch;
  let sent: Record<string, unknown> = {};
  let url = "";
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    url = String(input);
    sent = JSON.parse(String(init?.body ?? "{}"));
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as typeof fetch;
  try {
    const mod = await import(`./ai-gateway.ts?case=${Date.now()}`);
    await mod.aiFetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      body: JSON.stringify({
        model: "openai/text-embedding-3-small",
        input: "x",
        dimensions: 1536,
        provider: { zdr: true },
      }),
    });
    assertEquals(url, "https://api.openai.com/v1/embeddings");
    assertEquals(sent.model, "text-embedding-3-small");
    assertEquals("provider" in sent, false);
    assertEquals(sent.dimensions, 1536);
  } finally {
    globalThis.fetch = realFetch;
    if (previous) Deno.env.set("OPENAI_API_KEY", previous);
    else Deno.env.delete("OPENAI_API_KEY");
  }
});

// ── Teto mensal da Anthropic (22/11/2026) ──
import {
  anthropicCostUsd,
  anthropicRoutingOff,
  monthlyBudgetUsd,
  overBudget,
} from "./ai-gateway.ts";

function assertClose(actual: number | null, expected: number) {
  if (actual === null || Math.abs(actual - expected) > 1e-9) {
    throw new Error(`expected ${expected}, got ${actual}`);
  }
}

Deno.test("custo do Haiku 5.5: entrada, saída e cache pelo preço oficial", () => {
  // 17.000 entrada (2.000 em cache) + 1.600 saída
  assertClose(
    anthropicCostUsd("claude-haiku-5-5", {
      prompt_tokens: 17_000,
      completion_tokens: 1_600,
      prompt_tokens_details: { cached_tokens: 2_000 },
    }),
    (15_000 * 0.10 + 2_000 * 0.01 + 1_600 * 0.50) / 1e6,
  );
});

Deno.test("Haiku acima de 100K tokens de prompt usa o preço longo", () => {
  assertClose(
    anthropicCostUsd("claude-haiku-5-5", {
      prompt_tokens: 120_000,
      completion_tokens: 1_000,
    }),
    (120_000 * 0.50 + 1_000 * 2.50) / 1e6,
  );
});

Deno.test("Sonnet 5.5 e modelo desconhecido custam como Sonnet", () => {
  const expected = (10_000 * 2 + 1_000 * 10) / 1e6;
  assertClose(
    anthropicCostUsd("claude-sonnet-5-5", {
      prompt_tokens: 10_000,
      completion_tokens: 1_000,
    }),
    expected,
  );
  assertClose(
    anthropicCostUsd("claude-novo", {
      prompt_tokens: 10_000,
      completion_tokens: 1_000,
    }),
    expected,
  );
});

Deno.test("resposta sem usage não é medida", () => {
  assertEquals(anthropicCostUsd("claude-haiku-5-5", undefined), null);
  assertEquals(
    anthropicCostUsd("claude-haiku-5-5", { prompt_tokens: "x" }),
    null,
  );
});

Deno.test("teto: padrão 50, valor configurado, off = sem teto, inválido = 50", () => {
  const previous = Deno.env.get("ANTHROPIC_MONTHLY_BUDGET_USD");
  try {
    Deno.env.delete("ANTHROPIC_MONTHLY_BUDGET_USD");
    assertEquals(monthlyBudgetUsd(), 50);
    Deno.env.set("ANTHROPIC_MONTHLY_BUDGET_USD", "80");
    assertEquals(monthlyBudgetUsd(), 80);
    Deno.env.set("ANTHROPIC_MONTHLY_BUDGET_USD", "off");
    assertEquals(monthlyBudgetUsd(), Number.POSITIVE_INFINITY);
    Deno.env.set("ANTHROPIC_MONTHLY_BUDGET_USD", "-3");
    assertEquals(monthlyBudgetUsd(), 50);
  } finally {
    if (previous === undefined) Deno.env.delete("ANTHROPIC_MONTHLY_BUDGET_USD");
    else Deno.env.set("ANTHROPIC_MONTHLY_BUDGET_USD", previous);
  }
});

Deno.test("acima do teto só com gasto conhecido; leitura falha não bloqueia", () => {
  assertEquals(overBudget(49.99, 50), false);
  assertEquals(overBudget(50, 50), true);
  assertEquals(overBudget(null, 50), false);
  assertEquals(overBudget(1_000, Number.POSITIVE_INFINITY), false);
});

Deno.test("ANTHROPIC_ROUTING=off é a chave para voltar ao OpenRouter", () => {
  const previous = Deno.env.get("ANTHROPIC_ROUTING");
  try {
    Deno.env.set("ANTHROPIC_ROUTING", "on");
    assertEquals(anthropicRoutingOff(), false);
    Deno.env.set("ANTHROPIC_ROUTING", "off");
    assertEquals(anthropicRoutingOff(), true);
  } finally {
    if (previous === undefined) Deno.env.delete("ANTHROPIC_ROUTING");
    else Deno.env.set("ANTHROPIC_ROUTING", previous);
  }
});

Deno.test("com ANTHROPIC_ROUTING=off e sem chave da Anthropic, as funções ainda acham a chave do OpenRouter", () => {
  const saved = {
    a: Deno.env.get("ANTHROPIC_API_KEY"),
    r: Deno.env.get("ANTHROPIC_ROUTING"),
    o: Deno.env.get("OPENROUTER_API_KEY"),
  };
  try {
    Deno.env.delete("ANTHROPIC_API_KEY");
    Deno.env.set("OPENROUTER_API_KEY", "or-test");
    Deno.env.set("ANTHROPIC_ROUTING", "on");
    assertEquals(textAiKey(), "");
    Deno.env.set("ANTHROPIC_ROUTING", "off");
    assertEquals(textAiKey(), "or-test");
  } finally {
    for (
      const [name, value] of [["ANTHROPIC_API_KEY", saved.a], [
        "ANTHROPIC_ROUTING",
        saved.r,
      ], ["OPENROUTER_API_KEY", saved.o]] as const
    ) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
});
