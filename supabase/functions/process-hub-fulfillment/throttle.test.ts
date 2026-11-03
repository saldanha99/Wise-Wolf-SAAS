/// <reference lib="deno.ns" />

import {
  sendWhatsTextDetailed,
  setOutboundPermitSource,
} from "../_shared/evolution-send.ts";
import {
  HUB_FULFILLMENT_THROTTLE_DEADLINE_MS,
  HUB_FULFILLMENT_THROTTLE_MAX_DEFERRALS,
  HUB_FULFILLMENT_THROTTLE_MAX_DELAY_MS,
  HUB_FULFILLMENT_THROTTLE_METADATA_KEY,
  HUB_FULFILLMENT_THROTTLE_MIN_DELAY_MS,
  MAX_FULFILLMENT_ATTEMPTS,
  nextHubFulfillmentThrottleDeferral,
} from "./core.ts";

const assert = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};

const NOW = Date.parse("2026-11-03T15:00:00.000Z");

Deno.test("veto do teto adia no horário pedido e não gasta tentativa", () => {
  const decision = nextHubFulfillmentThrottleDeferral({
    attemptCount: 3,
    metadata: { source: "hub_checkout" },
    retryAfterMs: 90_000,
    nowMs: NOW,
  });
  assert(decision.kind === "defer", "o primeiro veto adia");
  if (decision.kind !== "defer") return;
  assert(
    decision.nextAttemptAt === "2026-11-03T15:01:30.000Z",
    `respeita o retryAfterMs: ${decision.nextAttemptAt}`,
  );
  assert(
    decision.attemptCount === 2,
    "o claim somou 1; o adiamento devolve, porque o provedor não foi tocado",
  );
  assert(
    decision.metadata.source === "hub_checkout",
    "metadata existente é preservada",
  );
  const state = decision.metadata[HUB_FULFILLMENT_THROTTLE_METADATA_KEY] as {
    deferrals: number;
    first_at: string;
    last_at: string;
  };
  assert(
    state.deferrals === 1 && state.first_at === "2026-11-03T15:00:00.000Z" &&
      state.last_at === state.first_at,
    "o primeiro veto abre a contagem",
  );
});

Deno.test("veto preserva a marca de fixture e não deixa attempt_count negativo", () => {
  const decision = nextHubFulfillmentThrottleDeferral({
    attemptCount: 0,
    metadata: { test_fixture: true },
    retryAfterMs: 120_000,
    nowMs: NOW,
  });
  assert(decision.kind === "defer", "adia");
  if (decision.kind !== "defer") return;
  assert(decision.attemptCount === 0, "nunca abaixo de zero");
  assert(decision.metadata.test_fixture === true, "fixture continua fixture");
});

Deno.test("espera pedida pelo teto é limitada entre 1 min e 6 h", () => {
  const cases: Array<[unknown, number]> = [
    [1_000, HUB_FULFILLMENT_THROTTLE_MIN_DELAY_MS],
    [undefined, HUB_FULFILLMENT_THROTTLE_MIN_DELAY_MS],
    [Number.NaN, HUB_FULFILLMENT_THROTTLE_MIN_DELAY_MS],
    ["abc", HUB_FULFILLMENT_THROTTLE_MIN_DELAY_MS],
    [-5_000, HUB_FULFILLMENT_THROTTLE_MIN_DELAY_MS],
    [3_600_000, 3_600_000],
    [30 * 60 * 60_000, HUB_FULFILLMENT_THROTTLE_MAX_DELAY_MS],
  ];
  for (const [retryAfterMs, expectedDelay] of cases) {
    const decision = nextHubFulfillmentThrottleDeferral({
      attemptCount: 1,
      metadata: {},
      retryAfterMs,
      nowMs: NOW,
    });
    assert(decision.kind === "defer", `adia (${String(retryAfterMs)})`);
    if (decision.kind !== "defer") return;
    assert(
      Date.parse(decision.nextAttemptAt) - NOW === expectedDelay,
      `espera de ${String(retryAfterMs)} vira ${expectedDelay}`,
    );
  }
});

Deno.test("vetos seguidos acumulam e respeitam o prazo final", () => {
  const firstAt = new Date(NOW).toISOString();
  let metadata: Record<string, unknown> = {};
  let nowMs = NOW;
  for (let round = 1; round <= 3; round += 1) {
    const decision = nextHubFulfillmentThrottleDeferral({
      attemptCount: 1,
      metadata,
      retryAfterMs: 60_000,
      nowMs,
    });
    assert(decision.kind === "defer", `rodada ${round} adia`);
    if (decision.kind !== "defer") return;
    const state = decision.metadata[HUB_FULFILLMENT_THROTTLE_METADATA_KEY] as {
      deferrals: number;
      first_at: string;
    };
    assert(state.deferrals === round, `conta ${round} adiamentos`);
    assert(state.first_at === firstAt, "o prazo conta do primeiro veto");
    metadata = decision.metadata;
    nowMs += 60_000;
  }

  // Perto do prazo: a espera pedida é cortada no limite (uma última chance).
  const deadline = NOW + HUB_FULFILLMENT_THROTTLE_DEADLINE_MS;
  const nearDeadline = nextHubFulfillmentThrottleDeferral({
    attemptCount: 1,
    metadata,
    retryAfterMs: HUB_FULFILLMENT_THROTTLE_MAX_DELAY_MS,
    nowMs: deadline - 10 * 60_000,
  });
  assert(nearDeadline.kind === "defer", "ainda dentro do prazo, adia");
  if (nearDeadline.kind === "defer") {
    assert(
      Date.parse(nearDeadline.nextAttemptAt) === deadline,
      "a próxima tentativa não passa do prazo final",
    );
  }

  const expired = nextHubFulfillmentThrottleDeferral({
    attemptCount: 1,
    metadata,
    retryAfterMs: 60_000,
    nowMs: deadline,
  });
  assert(
    expired.kind === "expired" &&
      expired.reason === "whatsapp_throttle_deadline_exceeded",
    "vencido o prazo, desiste",
  );
});

Deno.test("teto de adiamentos encerra a entrega", () => {
  const metadata = {
    [HUB_FULFILLMENT_THROTTLE_METADATA_KEY]: {
      deferrals: HUB_FULFILLMENT_THROTTLE_MAX_DEFERRALS,
      first_at: new Date(NOW - 60 * 60_000).toISOString(),
      last_at: new Date(NOW - 60_000).toISOString(),
    },
  };
  const decision = nextHubFulfillmentThrottleDeferral({
    attemptCount: 2,
    metadata,
    retryAfterMs: 60_000,
    nowMs: NOW,
  });
  assert(
    decision.kind === "expired" &&
      decision.reason === "whatsapp_throttle_deferrals_exhausted",
    "passado o teto de adiamentos, desiste",
  );
  assert(
    HUB_FULFILLMENT_THROTTLE_MAX_DEFERRALS > MAX_FULFILLMENT_ATTEMPTS,
    "o teto de adiamentos é independente (e maior) que o de tentativas",
  );
});

Deno.test("estado de veto corrompido recomeça a contagem em vez de travar", () => {
  const decision = nextHubFulfillmentThrottleDeferral({
    attemptCount: 1,
    metadata: {
      [HUB_FULFILLMENT_THROTTLE_METADATA_KEY]: {
        deferrals: "muitos",
        first_at: "ontem",
      },
    },
    retryAfterMs: 60_000,
    nowMs: NOW,
  });
  assert(decision.kind === "defer", "adia");
  if (decision.kind !== "defer") return;
  const state = decision.metadata[HUB_FULFILLMENT_THROTTLE_METADATA_KEY] as {
    deferrals: number;
  };
  assert(state.deferrals === 1, "recomeça do primeiro veto");
});

Deno.test("envio real vetado pela régua não chama o sendText e vira adiamento", async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    calls.push(url);
    if (url.includes("/chat/whatsappNumbers/")) {
      return Promise.resolve(
        new Response(
          JSON.stringify([{
            exists: true,
            jid: "5511999990000@s.whatsapp.net",
          }]),
          { status: 200 },
        ),
      );
    }
    return Promise.resolve(new Response("{}", { status: 500 }));
  }) as typeof fetch;
  setOutboundPermitSource(() =>
    Promise.resolve({ allowed: false, kind: "transactional", wait_ms: 95_000 })
  );
  try {
    const result = await sendWhatsTextDetailed({
      base: "https://evolution.example.invalid",
      keys: ["chave-de-teste"],
      instance: "instancia-teste",
      to: "5511999990000",
      text: "mensagem de teste",
    });
    assert(
      result.outcome === "rejected" && result.throttled === true,
      "a régua veta antes do POST",
    );
    assert(
      !calls.some((url) => url.includes("/message/sendText/")),
      "nenhum POST de envio sai quando a régua veta",
    );
    const decision = nextHubFulfillmentThrottleDeferral({
      attemptCount: 1,
      metadata: {},
      retryAfterMs: result.retryAfterMs,
      nowMs: NOW,
    });
    assert(
      decision.kind === "defer" &&
        Date.parse(decision.nextAttemptAt) - NOW === 95_000,
      "o worker reagenda pelo retryAfterMs devolvido",
    );
  } finally {
    globalThis.fetch = originalFetch;
    setOutboundPermitSource(null);
  }
});

Deno.test({
  name: "worker trata o veto antes da recusa definitiva e limpa o marcador",
  permissions: { read: true },
  async fn() {
    const source = await Deno.readTextFile(
      new URL("./index.ts", import.meta.url),
    );
    const throttledCheck = source.indexOf(
      'result.outcome === "rejected" && result.throttled === true',
    );
    const definitiveRejection = source.indexOf(
      '"whatsapp_provider_rejected"',
    );
    assert(
      throttledCheck >= 0 && throttledCheck < definitiveRejection,
      "o veto do teto é separado ANTES da recusa definitiva",
    );
    const catchThrottle = source.indexOf(
      "error instanceof ProviderThrottledError",
    );
    const genericRetry = source.indexOf(
      "nextHubFulfillmentAttempt(row.attempt_count)",
    );
    assert(
      catchThrottle >= 0 && catchThrottle < genericRetry,
      "o veto não passa pela régua de falhas do provedor",
    );
    const deferBody = source.slice(
      source.indexOf("async function deferThrottledDelivery("),
      source.indexOf("async function processDelivery("),
    );
    assert(
      deferBody.includes('status: "PENDING"') &&
        deferBody.includes("attempt_count: decision.attemptCount") &&
        deferBody.includes("next_attempt_at: decision.nextAttemptAt") &&
        (deferBody.match(/provider_dispatch_started_at: null/g) || [])
            .length === 2,
      "o adiamento volta para PENDING sem o marcador de despacho",
    );
  },
});
