/// <reference lib="deno.ns" />
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { authorizeScopedAutomation } from "../_shared/automation-auth.ts";
import { sendWhatsTextToResolvedDestinationDetailed } from "../_shared/evolution-send.ts";
import {
  loadTenantWhatsAppRoute,
  resolveTenantConfiguredWhatsAppDestination,
} from "../_shared/tenant-communication.ts";
import { resolveEvolutionIntegration } from "../_shared/tenant-integration-broker.ts";
import { type ReserveRoute, runReserveSweep } from "./worker.ts";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization,x-client-info,apikey,content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Content-Type": "application/json",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers,
    });
  }
  // Service-only. Directors change opt-in settings, not arbitrary send payloads.
  const auth = await authorizeScopedAutomation(req, headers);
  if (auth.ok === false) return auth.response;
  const client = auth.context.admin;
  const body = await req.json().catch(() => null) as
    | Record<string, unknown>
    | null;
  if (!body || body.sweep !== true) {
    return new Response(JSON.stringify({ error: "sweep_required" }), {
      status: 400,
      headers,
    });
  }
  try {
    const result = await runReserveSweep({
      client,
      async resolveRoute(tenantId): Promise<ReserveRoute | null> {
        const settings = await client.from("dre_report_settings").select(
          "destino,is_active",
        ).eq("tenant_id", tenantId).maybeSingle();
        if (settings.error || settings.data?.is_active !== true) return null;
        const route = await loadTenantWhatsAppRoute(
          client,
          tenantId,
          "general",
          { requireDeliveryReceipts: true },
        );
        if (!route) return null;
        const destination = resolveTenantConfiguredWhatsAppDestination(
          route,
          settings.data.destino,
        );
        if (!destination || !/^[0-9]{10,25}@g\.us$/.test(destination)) {
          return null;
        }
        const instance = await client.from("whatsapp_instances").select(
          "integration_id,integration_version",
        )
          .eq("tenant_id", tenantId).eq("instance_name", route.instanceName)
          .maybeSingle();
        if (instance.error) return null;
        const integration = await resolveEvolutionIntegration(
          client,
          tenantId,
          "message.send_text",
        );
        if (
          integration.integrationId !== instance.data?.integration_id ||
          integration.version !== Number(instance.data?.integration_version)
        ) return null;
        return {
          instanceName: route.instanceName,
          destination,
          integrationId: integration.integrationId,
          integrationVersion: integration.version,
          baseUrl: integration.baseUrl,
          apiKey: integration.apiKey,
        };
      },
      async hash(value) {
        const hash = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(value),
        );
        return [...new Uint8Array(hash)].map((byte) =>
          byte.toString(16).padStart(2, "0")
        ).join("");
      },
      send: (route, message) =>
        sendWhatsTextToResolvedDestinationDetailed({
          base: route.baseUrl,
          keys: [route.apiKey],
          instance: route.instanceName,
          to: route.destination,
          text: message,
        }),
    }, { testMode: body.testMode === true || body.test_mode === true });
    return new Response(JSON.stringify(result), {
      status: result.errors.length ? 503 : 200,
      headers,
    });
  } catch {
    return new Response(
      JSON.stringify({ error: "monthly_reserve_notification_unavailable" }),
      { status: 503, headers },
    );
  }
});
