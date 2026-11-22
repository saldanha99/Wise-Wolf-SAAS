// Purchase do Hub/Wolfie no CAPI do Meta (LEI 10), 22/11/2026.
//
// Mesmo event_id do Pixel do navegador ("hub_checkout:<id da sessão>"): o Meta deduplica,
// então reenvio do webhook não conta duas vezes. Disparado depois de hub_activate_paid_checkout.
// Sem FB_CAPI_TOKEN é no-op (o token não está configurado em 22/11/2026). Nunca é o Lead de aluno.

export interface HubPurchaseInput {
  checkoutId: string;
  amount: number;
  metadata: Record<string, unknown> | null | undefined;
  eventTime?: number;
}

const text = (value: unknown, max = 300) => typeof value === "string" ? value.trim().slice(0, max) : "";

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value.trim().toLowerCase()));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function hubPurchaseEventId(checkoutId: string): string {
  return `hub_checkout:${checkoutId}`;
}

/** Corpo do evento (sem token). Dados pessoais só em hash, como o Meta pede. */
export async function hubPurchasePayload(input: HubPurchaseInput): Promise<Record<string, unknown> | null> {
  const metadata = input.metadata ?? {};
  const snapshot = (metadata.fulfillment_snapshot ?? {}) as Record<string, unknown>;
  if (metadata.test_fixture === true || snapshot.test_fixture === true || metadata.testMode === true) return null;
  const marketing = (metadata.marketing ?? {}) as Record<string, unknown>;
  const email = text(snapshot.email_recipient, 320);
  const phoneDigits = text(snapshot.whatsapp_recipient, 20).replace(/\D/g, "");
  const userId = text(snapshot.user_id, 64);
  const userData: Record<string, unknown> = {};
  if (email) userData.em = [await sha256(email)];
  if (phoneDigits) userData.ph = [await sha256(phoneDigits.startsWith("55") ? phoneDigits : `55${phoneDigits}`)];
  if (userId) userData.external_id = [await sha256(userId)];
  const fbp = text(marketing.fbp, 200);
  const fbc = text(marketing.fbc, 300);
  const userAgent = text(marketing.client_user_agent, 400);
  if (/^fb\.\d\.\d+\.\d+$/.test(fbp)) userData.fbp = fbp;
  if (/^fb\.\d\.\d+\.[A-Za-z0-9_-]+$/.test(fbc)) userData.fbc = fbc;
  if (userAgent) userData.client_user_agent = userAgent;
  const pageUrl = text(marketing.page_url, 500);
  const planCode = text(snapshot.plan_code, 60);
  return {
    data: [{
      event_name: "Purchase",
      event_time: input.eventTime ?? Math.floor(Date.now() / 1000),
      event_id: hubPurchaseEventId(input.checkoutId),
      action_source: "website",
      event_source_url: /^https:\/\/wisewolflanguage\.com\.br\//.test(pageUrl) ? pageUrl : "https://wisewolflanguage.com.br/",
      user_data: userData,
      custom_data: {
        value: Number(input.amount),
        currency: "BRL",
        content_type: "product",
        ...(planCode ? { content_ids: [planCode] } : {}),
      },
    }],
  };
}

export async function sendHubPurchaseCapi(
  input: HubPurchaseInput,
  options: { pixelId: string; token: string; fetchImpl?: typeof fetch },
): Promise<"SENT" | "SKIPPED" | "FAILED"> {
  if (!options.token) return "SKIPPED";
  const payload = await hubPurchasePayload(input);
  if (!payload) return "SKIPPED";
  try {
    const response = await (options.fetchImpl ?? fetch)(
      `https://graph.facebook.com/v20.0/${options.pixelId}/events?access_token=${encodeURIComponent(options.token)}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(8000) },
    );
    return response.ok ? "SENT" : "FAILED";
  } catch {
    return "FAILED";
  }
}
