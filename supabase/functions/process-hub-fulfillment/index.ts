/// <reference lib="deno.ns" />

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  createClient,
  type SupabaseClient,
} from "https://esm.sh/@supabase/supabase-js@2.93.3";
import { authorizeAutomation } from "../_shared/automation-auth.ts";
import { sendWhatsTextDetailed } from "../_shared/evolution-send.ts";
import { loadTenantCentralWhatsAppContext } from "../_shared/tenant-communication.ts";
import {
  buildHubFulfillmentEmail,
  buildHubFulfillmentWhatsApp,
  DEFAULT_HUB_PUBLIC_URL,
  DEFAULT_WOLFIE_PUBLIC_URL,
  type HubFulfillmentDestinations,
  hubFulfillmentProviderIdempotencyKey,
  isHubFulfillmentTestFixture,
  nextHubFulfillmentAttempt,
  normalizeHubFulfillmentPhone,
  normalizeHubFulfillmentPublicUrl,
} from "./core.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVOLUTION_API_URL = (Deno.env.get("EVOLUTION_API_URL") || "").trim()
  .replace(/\/+$/, "");
const EVOLUTION_API_KEYS = Array.from(
  new Set([(Deno.env.get("EVOLUTION_API_KEY") || "").trim()].filter(Boolean)),
);
const RESEND_API_KEY = (Deno.env.get("RESEND_API_KEY") || "").trim();
const RESEND_FROM_EMAIL = (Deno.env.get("RESEND_FROM_EMAIL") || "").trim() ||
  "Wise Wolf <nao-responda@wisewolflanguage.com.br>";
const RESEND_REPLY_TO = (Deno.env.get("RESEND_REPLY_TO") || "").trim();
const HUB_FULFILLMENT_TENANT_ID =
  (Deno.env.get("HUB_FULFILLMENT_TENANT_ID") || "school-wise-wolf").trim();
const HUB_FULFILLMENT_CONCURRENCY = 2;
const HUB_FULFILLMENT_DESTINATIONS: HubFulfillmentDestinations = {
  hubUrl: normalizeHubFulfillmentPublicUrl(
    Deno.env.get("HUB_FULFILLMENT_PUBLIC_URL") ||
      Deno.env.get("HUB_PUBLIC_URL"),
    DEFAULT_HUB_PUBLIC_URL,
  ),
  wolfieUrl: normalizeHubFulfillmentPublicUrl(
    Deno.env.get("WOLFIE_PUBLIC_URL"),
    DEFAULT_WOLFIE_PUBLIC_URL,
  ),
};

type FulfillmentRow = {
  id: number;
  checkout_id: string;
  channel: "EMAIL" | "WHATSAPP";
  recipient: string;
  recipient_name: string;
  product_family: string;
  plan_code: string;
  plan_name: string;
  attempt_count: number;
  lease_token: string;
  provider_dispatch_started_at: string | null;
  metadata: Record<string, unknown> | null;
};

type FulfillmentOutcome =
  | "sent"
  | "skipped"
  | "retry"
  | "failed"
  | "uncertain";

class ProviderDeliveryError extends Error {
  constructor(
    message: string,
    readonly ambiguous: boolean,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ProviderDeliveryError";
  }
}

const json = (status: number, payload: Record<string, unknown>) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

async function markDelivery(
  admin: SupabaseClient,
  row: FulfillmentRow,
  update: Record<string, unknown>,
): Promise<void> {
  const { data, error } = await admin.from("hub_fulfillment_outbox")
    .update({
      ...update,
      lease_token: null,
      lease_expires_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id)
    .eq("status", "PROCESSING")
    .eq("lease_token", row.lease_token)
    .select("id")
    .maybeSingle();
  if (error || !data) throw new Error("fulfillment_marker_failed");
}

async function markProviderDispatchStarted(
  admin: SupabaseClient,
  row: FulfillmentRow,
): Promise<void> {
  const now = new Date().toISOString();
  const startedAt = row.provider_dispatch_started_at || now;
  let marker = admin.from("hub_fulfillment_outbox")
    .update({
      provider_dispatch_started_at: startedAt,
      updated_at: now,
    })
    .eq("id", row.id)
    .eq("status", "PROCESSING")
    .eq("lease_token", row.lease_token);
  marker = row.provider_dispatch_started_at
    ? marker.eq(
      "provider_dispatch_started_at",
      row.provider_dispatch_started_at,
    )
    : marker.is("provider_dispatch_started_at", null);
  const { data, error } = await marker
    .select("id")
    .maybeSingle();
  if (error || !data) throw new Error("fulfillment_dispatch_fence_failed");
  row.provider_dispatch_started_at = startedAt;
}

async function sendEmail(
  admin: SupabaseClient,
  row: FulfillmentRow,
): Promise<string | null> {
  if (!RESEND_API_KEY) throw new Error("email_provider_unavailable");
  const content = buildHubFulfillmentEmail({
    recipientName: row.recipient_name,
    productFamily: row.product_family,
    planName: row.plan_name,
    destinations: HUB_FULFILLMENT_DESTINATIONS,
  });
  await markProviderDispatchStarted(admin, row);
  let response: Response;
  try {
    response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "User-Agent": "WiseWolf-Hub-Fulfillment/1.0",
        "Idempotency-Key": hubFulfillmentProviderIdempotencyKey({
          checkoutId: row.checkout_id,
          channel: row.channel,
        }),
      },
      body: JSON.stringify({
        from: RESEND_FROM_EMAIL,
        to: [row.recipient],
        subject: content.subject,
        html: content.html,
        ...(RESEND_REPLY_TO ? { reply_to: RESEND_REPLY_TO } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ProviderDeliveryError(
      "email_provider_outcome_unknown",
      true,
      true,
    );
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const providerErrorName = payload && typeof payload === "object" &&
        !Array.isArray(payload) &&
        typeof (payload as { name?: unknown }).name === "string"
      ? (payload as { name: string }).name
      : "";
    const concurrentIdempotentRequest = response.status === 409 &&
      providerErrorName === "concurrent_idempotent_requests";
    const ambiguous = response.status === 408 || response.status === 425 ||
      response.status >= 500 || concurrentIdempotentRequest;
    const retryable = ambiguous || response.status === 429;
    throw new ProviderDeliveryError(
      `email_provider_http_${response.status}`,
      ambiguous,
      retryable,
    );
  }
  return payload && typeof payload === "object" && !Array.isArray(payload) &&
      typeof (payload as { id?: unknown }).id === "string"
    ? (payload as { id: string }).id.slice(0, 320)
    : null;
}

async function sendWhatsApp(
  admin: SupabaseClient,
  row: FulfillmentRow,
): Promise<string | null> {
  const phone = normalizeHubFulfillmentPhone(row.recipient);
  if (!phone) throw new Error("invalid_whatsapp_recipient");
  if (!EVOLUTION_API_URL || EVOLUTION_API_KEYS.length === 0) {
    throw new Error("whatsapp_provider_unavailable");
  }
  const route = await loadTenantCentralWhatsAppContext(
    admin,
    HUB_FULFILLMENT_TENANT_ID,
    "general",
  );
  if (!route) throw new Error("whatsapp_route_unavailable");
  await markProviderDispatchStarted(admin, row);
  const result = await sendWhatsTextDetailed({
    base: EVOLUTION_API_URL,
    keys: EVOLUTION_API_KEYS,
    instance: route.instanceName,
    to: phone,
    text: buildHubFulfillmentWhatsApp({
      recipientName: row.recipient_name,
      productFamily: row.product_family,
      planName: row.plan_name,
      destinations: HUB_FULFILLMENT_DESTINATIONS,
    }),
    delayMs: 1200,
  });
  if (result.outcome === "ambiguous") {
    throw new ProviderDeliveryError(
      "whatsapp_provider_outcome_unknown",
      true,
      false,
    );
  }
  if (result.outcome === "rejected") {
    throw new ProviderDeliveryError(
      "whatsapp_provider_rejected",
      false,
      false,
    );
  }
  return result.messageId;
}

async function processDelivery(
  admin: SupabaseClient,
  row: FulfillmentRow,
): Promise<FulfillmentOutcome> {
  if (isHubFulfillmentTestFixture(row.metadata)) {
    await markDelivery(admin, row, {
      status: "SKIPPED",
      last_error: "test_fixture_suppressed",
      completed_at: new Date().toISOString(),
    });
    return "skipped";
  }

  let providerMessageId: string | null;
  try {
    providerMessageId = row.channel === "EMAIL"
      ? await sendEmail(admin, row)
      : await sendWhatsApp(admin, row);
  } catch (error) {
    const reason = error instanceof Error &&
        /^[a-z0-9_]+(?:_[0-9]{3})?$/i.test(error.message)
      ? error.message.slice(0, 160)
      : "fulfillment_provider_error";
    const ambiguous = error instanceof ProviderDeliveryError &&
      error.ambiguous;
    const retryable = !(error instanceof ProviderDeliveryError) ||
      error.retryable;
    const retry = nextHubFulfillmentAttempt(row.attempt_count);
    const uncertain = ambiguous &&
      (row.channel === "WHATSAPP" || retry.status === "FAILED");
    const terminal = !retryable || retry.status === "FAILED";
    await markDelivery(admin, row, {
      status: uncertain ? "UNCERTAIN" : terminal ? "FAILED" : retry.status,
      next_attempt_at: retry.nextAttemptAt || new Date().toISOString(),
      last_error: reason,
      completed_at: !uncertain && terminal ? new Date().toISOString() : null,
      ...(!ambiguous ? { provider_dispatch_started_at: null } : {}),
    });
    console.warn("Hub fulfillment delivery deferred", {
      id: row.id,
      channel: row.channel,
      reason,
      final: uncertain || terminal,
      uncertain,
    });
    if (uncertain) return "uncertain";
    return terminal ? "failed" : "retry";
  }

  await markDelivery(admin, row, {
    status: "SENT",
    provider_message_id: providerMessageId,
    last_error: null,
    completed_at: new Date().toISOString(),
  });
  return "sent";
}

async function processDeliveryPool(
  admin: SupabaseClient,
  rows: FulfillmentRow[],
): Promise<FulfillmentOutcome[]> {
  const outcomes = new Array<FulfillmentOutcome>(rows.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < rows.length) {
      const deliveryIndex = nextIndex;
      nextIndex += 1;
      outcomes[deliveryIndex] = await processDelivery(
        admin,
        rows[deliveryIndex],
      );
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(HUB_FULFILLMENT_CONCURRENCY, rows.length) },
      worker,
    ),
  );
  return outcomes;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

  const authError = await authorizeAutomation(req, corsHeaders);
  if (authError) return authError;

  let checkoutId: string | null = null;
  let limit = 10;
  try {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    if (typeof body.checkoutId === "string" && body.checkoutId.trim()) {
      checkoutId = body.checkoutId.trim();
      if (!UUID_PATTERN.test(checkoutId)) {
        return json(400, { error: "invalid_checkout_id" });
      }
    }
    if (typeof body.limit === "number" && Number.isFinite(body.limit)) {
      limit = Math.max(1, Math.min(Math.trunc(body.limit), 10));
    }
  } catch {
    return json(400, { error: "invalid_json" });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !serviceRoleKey) {
    return json(503, { error: "service_configuration_unavailable" });
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await admin.rpc("claim_hub_fulfillment_outbox", {
    p_checkout_id: checkoutId,
    p_limit: limit,
  });
  if (error) {
    console.error("Hub fulfillment claim failed", { code: error.code });
    return json(500, { error: "fulfillment_claim_failed" });
  }

  const rows = Array.isArray(data) ? data as FulfillmentRow[] : [];
  const outcomes = await processDeliveryPool(admin, rows);
  return json(200, {
    claimed: rows.length,
    sent: outcomes.filter((outcome) => outcome === "sent").length,
    skipped: outcomes.filter((outcome) => outcome === "skipped").length,
    retrying: outcomes.filter((outcome) => outcome === "retry").length,
    failed: outcomes.filter((outcome) => outcome === "failed").length,
    uncertain: outcomes.filter((outcome) => outcome === "uncertain").length,
  });
});
