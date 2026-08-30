/// <reference lib="deno.ns" />

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  createClient,
  type SupabaseClient,
} from "https://esm.sh/@supabase/supabase-js@2.93.3";
import { authorizeAutomation } from "../_shared/automation-auth.ts";
import type { TenantIntegrationRpcClient } from "../_shared/tenant-integration-broker.ts";
import {
  parseReconcileWhatsAppWebhookOptions,
  type ReconcileWhatsAppWebhookInstance,
  type ReconcileWhatsAppWebhookOptions,
  reconcileWhatsAppWebhooks,
  ReconcileWhatsAppWebhooksError,
} from "./core.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const MAX_REQUEST_BYTES = 4_096;

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function requestOptions(
  req: Request,
): Promise<
  | { ok: true; value: ReconcileWhatsAppWebhookOptions }
  | { ok: false; response: Response }
> {
  const contentLength = Number(req.headers.get("content-length") || "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    return {
      ok: false,
      response: json({ error: "PAYLOAD_TOO_LARGE" }, 413),
    };
  }

  const rawBody = await req.text();
  if (new TextEncoder().encode(rawBody).byteLength > MAX_REQUEST_BYTES) {
    return {
      ok: false,
      response: json({ error: "PAYLOAD_TOO_LARGE" }, 413),
    };
  }
  let body: unknown = {};
  if (rawBody.trim()) {
    try {
      body = JSON.parse(rawBody);
    } catch {
      return { ok: false, response: json({ error: "INVALID_REQUEST" }, 400) };
    }
  }
  const parsed = parseReconcileWhatsAppWebhookOptions(body);
  return parsed.ok
    ? parsed
    : { ok: false, response: json({ error: parsed.code }, 400) };
}

async function loadEligibleInstances(
  client: SupabaseClient,
  options: ReconcileWhatsAppWebhookOptions,
): Promise<ReconcileWhatsAppWebhookInstance[]> {
  let query = client
    .from("whatsapp_instances")
    .select(
      "tenant_id,instance_name,webhook_auth_version,integration_id,integration_version",
    )
    .eq("inbox_enabled", true)
    .in("status", ["connected", "open"])
    .order("webhook_auth_version", { ascending: true })
    .order("updated_at", { ascending: true })
    .order("instance_name", { ascending: true })
    .limit(options.limit);
  if (!options.includeAll) query = query.lt("webhook_auth_version", 3);

  const { data, error } = await query;
  if (error) throw new Error("INSTANCE_LIST_UNAVAILABLE");
  return (data || []).flatMap((row) => {
    const tenantId = String(row.tenant_id || "").trim();
    const instanceName = String(row.instance_name || "").trim();
    const integrationId = String(row.integration_id || "").trim();
    const integrationVersion = Number(row.integration_version);
    if (
      !tenantId || !instanceName || !integrationId ||
      !Number.isSafeInteger(integrationVersion) || integrationVersion < 1
    ) return [];
    return [{
      tenantId,
      instanceName,
      webhookAuthVersion: Number(row.webhook_auth_version) === 3
        ? 3
        : Number(row.webhook_auth_version) === 2
        ? 2
        : 1,
      integrationId,
      integrationVersion,
    }];
  });
}

export async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "METHOD_NOT_ALLOWED" }, 405);
  }

  const authError = await authorizeAutomation(req, corsHeaders);
  if (authError) return authError;

  const options = await requestOptions(req);
  if (!options.ok) return options.response;

  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim() || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim() ||
    "";
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ error: "SERVICE_CONFIGURATION_UNAVAILABLE" }, 503);
  }
  const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    const result = await reconcileWhatsAppWebhooks(options.value, {
      admin: serviceClient as unknown as TenantIntegrationRpcClient,
      getEnv: (name) => Deno.env.get(name),
      loadInstances: (requested) =>
        loadEligibleInstances(serviceClient, requested),
    });
    const errors = result.results.flatMap((item) =>
      item.status === "failed"
        ? [{
          tenantId: item.tenantId,
          instanceName: item.instanceName,
          code: item.error || "RECONCILE_FAILED",
          ...(item.upstreamStatus === undefined
            ? {}
            : { upstreamStatus: item.upstreamStatus }),
        }]
        : []
    );
    return json({
      ok: result.failed === 0,
      mode: options.value.includeAll ? "all" : "legacy",
      selected: result.selected,
      configured: result.configured,
      failed: result.failed,
      errors,
    });
  } catch (error) {
    const code = error instanceof ReconcileWhatsAppWebhooksError
      ? error.code
      : error instanceof Error && error.message === "INSTANCE_LIST_UNAVAILABLE"
      ? "INSTANCE_LIST_UNAVAILABLE"
      : "RECONCILE_FAILED";
    console.error("[WA Webhook Reconcile] Falha geral", { code });
    return json(
      { error: code },
      code === "INBOUND_WEBHOOK_UNAVAILABLE" ? 503 : 500,
    );
  }
}

serve(handleRequest);
