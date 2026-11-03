export const MAX_FULFILLMENT_ATTEMPTS = 8;
export const DEFAULT_HUB_PUBLIC_URL =
  "https://system.wisewolflanguage.com.br/hub";
export const DEFAULT_WOLFIE_PUBLIC_URL =
  "https://wolfie.wisewolflanguage.com.br";

type UnknownRecord = Record<string, unknown>;

export type HubFulfillmentDestinations = {
  hubUrl: string;
  wolfieUrl: string;
};

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (character) =>
    ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    })[character] ?? character);

export function normalizeHubFulfillmentPhone(value: unknown): string | null {
  let phone = typeof value === "string" ? value.replace(/\D/g, "") : "";
  if (phone.length === 10 || phone.length === 11) phone = `55${phone}`;
  return phone.startsWith("55") && (phone.length === 12 || phone.length === 13)
    ? phone
    : null;
}

export function isHubFulfillmentTestFixture(metadata: unknown): boolean {
  return Boolean(
    metadata && typeof metadata === "object" && !Array.isArray(metadata) &&
      (metadata as UnknownRecord).test_fixture === true,
  );
}

export function normalizeHubFulfillmentPublicUrl(
  value: unknown,
  fallback: string,
): string {
  const normalize = (candidate: string): string | null => {
    try {
      const parsed = new URL(candidate.trim());
      if (
        parsed.protocol !== "https:" || parsed.username || parsed.password ||
        parsed.search || parsed.hash
      ) {
        return null;
      }
      return parsed.toString().replace(/\/$/, "");
    } catch {
      return null;
    }
  };
  return normalize(typeof value === "string" ? value : "") ||
    normalize(fallback) || DEFAULT_HUB_PUBLIC_URL;
}

export function hubFulfillmentProviderIdempotencyKey(input: {
  checkoutId: string;
  channel: "EMAIL" | "WHATSAPP";
}): string {
  return `hub-fulfillment/${input.channel.toLowerCase()}/${input.checkoutId}`;
}

export function hubFulfillmentAccessUrl(
  productFamily: string,
  destinations: Partial<HubFulfillmentDestinations> = {},
): string {
  return productFamily === "WOLFIE_STANDALONE"
    ? normalizeHubFulfillmentPublicUrl(
      destinations.wolfieUrl,
      DEFAULT_WOLFIE_PUBLIC_URL,
    )
    : normalizeHubFulfillmentPublicUrl(
      destinations.hubUrl,
      DEFAULT_HUB_PUBLIC_URL,
    );
}

export function hubFulfillmentProductLabel(productFamily: string): string {
  return productFamily === "WOLFIE_STANDALONE"
    ? "Wolfie AI Tutor"
    : "Wise Wolf Hub";
}

export function hubFulfillmentFirstName(value: unknown): string {
  const name = typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f<>*_`~]/g, " ").replace(/\s+/g, " ")
      .trim().slice(0, 160)
    : "";
  return name.split(" ")[0] || "Olá";
}

export function buildHubFulfillmentWhatsApp(input: {
  recipientName: string;
  productFamily: string;
  planName: string;
  destinations?: Partial<HubFulfillmentDestinations>;
}): string {
  const firstName = hubFulfillmentFirstName(input.recipientName);
  const product = hubFulfillmentProductLabel(input.productFamily);
  const url = hubFulfillmentAccessUrl(
    input.productFamily,
    input.destinations,
  );
  const plan = input.planName.replace(/[\u0000-\u001f\u007f<>*_`~]/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, 160);
  return [
    `✅ Pagamento confirmado, ${firstName}!`,
    `Seu acesso ao ${product} está liberado no plano ${plan}.`,
    `Acesse com o mesmo e-mail usado na compra: ${url}`,
    "Se precisar de ajuda, responda a esta mensagem.",
  ].join("\n\n");
}

export function buildHubFulfillmentEmail(input: {
  recipientName: string;
  productFamily: string;
  planName: string;
  destinations?: Partial<HubFulfillmentDestinations>;
}): { subject: string; html: string } {
  const product = hubFulfillmentProductLabel(input.productFamily);
  const url = hubFulfillmentAccessUrl(
    input.productFamily,
    input.destinations,
  );
  const name = escapeHtml(hubFulfillmentFirstName(input.recipientName));
  const plan = escapeHtml(input.planName.trim().slice(0, 160));
  return {
    subject: `Seu acesso ao ${product} está liberado`,
    html: `
      <div style="background:#07111f;padding:40px 16px;font-family:Inter,Arial,sans-serif;color:#eef4ff">
        <div style="max-width:600px;margin:0 auto;background:#0d1b2d;border:1px solid #263c5a;border-radius:24px;padding:38px">
          <p style="margin:0 0 12px;color:#8eb8ff;font-size:12px;font-weight:800;letter-spacing:.12em">WISE WOLF</p>
          <h1 style="margin:0 0 18px;font-size:30px;line-height:1.18">Seu acesso está pronto</h1>
          <p style="margin:0;color:#bac8db;line-height:1.7">Olá, ${name}. Confirmamos seu pagamento e liberamos o plano <strong style="color:#fff">${plan}</strong> no ${product}.</p>
          <p style="margin:30px 0"><a href="${url}" style="display:inline-block;background:#7c9cff;color:#07111f;padding:15px 23px;border-radius:13px;text-decoration:none;font-weight:900">Acessar agora</a></p>
          <p style="margin:0;color:#8293aa;font-size:13px;line-height:1.65">Entre com o mesmo e-mail usado na compra. Se precisar de ajuda, responda a este e-mail.</p>
        </div>
      </div>`,
  };
}

export function nextHubFulfillmentAttempt(
  attemptCount: number,
  nowMs = Date.now(),
): { status: "PENDING" | "FAILED"; nextAttemptAt: string | null } {
  if (attemptCount >= MAX_FULFILLMENT_ATTEMPTS) {
    return { status: "FAILED", nextAttemptAt: null };
  }
  const delayMinutes = Math.min(5 * (2 ** Math.max(attemptCount - 1, 0)), 360);
  return {
    status: "PENDING",
    nextAttemptAt: new Date(nowMs + delayMinutes * 60_000).toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// WhatsApp vetado pela régua anti-bloqueio (`whatsapp_outbound_permit`).
//
// O veto acontece ANTES do POST: nada saiu para o provedor. Tratar isso como
// recusa definitiva (como era) deixava o cliente que acabou de pagar sem o
// aviso de acesso só porque o número da escola estava no teto da hora. Agora o
// veto vira nova tentativa no horário que a régua indicou, sem gastar uma das
// MAX_FULFILLMENT_ATTEMPTS (o claim soma 1; aqui devolvemos), com teto próprio
// de adiamentos e prazo final contado do primeiro veto. Passado o prazo, a
// entrega do WhatsApp termina como FAILED — o e-mail da mesma compra segue
// pela sua própria linha.
// ─────────────────────────────────────────────────────────────────────────────

export const HUB_FULFILLMENT_THROTTLE_MIN_DELAY_MS = 60_000;
export const HUB_FULFILLMENT_THROTTLE_MAX_DELAY_MS = 6 * 60 * 60_000;
export const HUB_FULFILLMENT_THROTTLE_MAX_DEFERRALS = 96;
export const HUB_FULFILLMENT_THROTTLE_DEADLINE_MS = 48 * 60 * 60_000;
export const HUB_FULFILLMENT_THROTTLE_METADATA_KEY = "whatsapp_throttle";

export type HubFulfillmentThrottleState = {
  deferrals: number;
  first_at: string;
  last_at: string;
};

export type HubFulfillmentThrottleDecision =
  | {
    kind: "defer";
    nextAttemptAt: string;
    attemptCount: number;
    metadata: UnknownRecord;
  }
  | {
    kind: "expired";
    reason:
      | "whatsapp_throttle_deadline_exceeded"
      | "whatsapp_throttle_deferrals_exhausted";
    metadata: UnknownRecord;
  };

function readThrottleState(
  metadata: unknown,
): HubFulfillmentThrottleState | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const raw = (metadata as UnknownRecord)[
    HUB_FULFILLMENT_THROTTLE_METADATA_KEY
  ];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const state = raw as UnknownRecord;
  const deferrals = Number(state.deferrals);
  const firstAt = typeof state.first_at === "string" ? state.first_at : "";
  if (
    !Number.isInteger(deferrals) || deferrals < 0 ||
    !Number.isFinite(Date.parse(firstAt))
  ) {
    return null;
  }
  return {
    deferrals,
    first_at: firstAt,
    last_at: typeof state.last_at === "string" ? state.last_at : firstAt,
  };
}

/**
 * Decide o que fazer com uma entrega de WhatsApp vetada pelo teto.
 *
 * `attemptCount` é o valor JÁ incrementado pelo claim desta rodada; no
 * adiamento ele volta ao que era, porque o provedor não foi tocado.
 */
export function nextHubFulfillmentThrottleDeferral(input: {
  attemptCount: number;
  metadata: unknown;
  retryAfterMs: unknown;
  nowMs?: number;
}): HubFulfillmentThrottleDecision {
  const nowMs = input.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const base: UnknownRecord = input.metadata &&
      typeof input.metadata === "object" && !Array.isArray(input.metadata)
    ? { ...(input.metadata as UnknownRecord) }
    : {};
  const previous = readThrottleState(input.metadata);
  const firstAt = previous?.first_at ?? nowIso;
  const deferrals = (previous?.deferrals ?? 0) + 1;
  const state: HubFulfillmentThrottleState = {
    deferrals,
    first_at: firstAt,
    last_at: nowIso,
  };
  const metadata: UnknownRecord = {
    ...base,
    [HUB_FULFILLMENT_THROTTLE_METADATA_KEY]: state,
  };

  const deadlineMs = Date.parse(firstAt) + HUB_FULFILLMENT_THROTTLE_DEADLINE_MS;
  if (deferrals > HUB_FULFILLMENT_THROTTLE_MAX_DEFERRALS) {
    return {
      kind: "expired",
      reason: "whatsapp_throttle_deferrals_exhausted",
      metadata,
    };
  }
  if (nowMs >= deadlineMs) {
    return {
      kind: "expired",
      reason: "whatsapp_throttle_deadline_exceeded",
      metadata,
    };
  }

  const requested = Number(input.retryAfterMs);
  const delayMs = Math.min(
    Math.max(
      Number.isFinite(requested) ? Math.trunc(requested) : 0,
      HUB_FULFILLMENT_THROTTLE_MIN_DELAY_MS,
    ),
    HUB_FULFILLMENT_THROTTLE_MAX_DELAY_MS,
  );
  // A próxima tentativa nunca passa do prazo final: se o teto mandou esperar
  // além dele, tenta uma última vez no limite.
  const nextMs = Math.min(nowMs + delayMs, deadlineMs);
  return {
    kind: "defer",
    nextAttemptAt: new Date(nextMs).toISOString(),
    attemptCount: Math.max(Math.trunc(input.attemptCount) - 1, 0),
    metadata,
  };
}
