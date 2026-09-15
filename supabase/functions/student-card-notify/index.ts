/// <reference lib="deno.ns" />
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { authorizeScopedAutomation } from "../_shared/automation-auth.ts";
import { loadTenantCentralWhatsAppContext } from "../_shared/tenant-communication.ts";
import {
  resolveAsaasIntegration,
  resolveEvolutionIntegration,
} from "../_shared/tenant-integration-broker.ts";
import { sameSnapshot, sendCardNotice } from "./core.ts";
import {
  type CardAsaasIntegration,
  type CardRoute,
  runStudentCardSweep,
} from "./worker.ts";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization,x-client-info,apikey,content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Content-Type": "application/json",
};

async function readAsaas(
  integration: CardAsaasIntegration,
  kind: "payments" | "subscriptions",
  id: string,
) {
  const response = await fetch(
    `${integration.baseUrl}/${kind}/${encodeURIComponent(id)}`,
    {
      method: "GET",
      headers: {
        access_token: integration.apiKey,
        "User-Agent": "WiseWolf-CardNotice",
      },
      redirect: "error",
      signal: AbortSignal.timeout(8000),
    },
  );
  if (!response.ok) throw new Error("card_provider_unavailable");
  return await response.json();
}

serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers });
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers,
    });
  }
  // True service authentication only; no user/admin can request arbitrary sends.
  const auth = await authorizeScopedAutomation(request, headers);
  if (auth.ok === false) return auth.response;
  const body = await request.json().catch(() => null);
  const modeKeys = ["testMode", "test_mode", "dryRun", "dry_run"];
  if (
    !body || typeof body !== "object" || Array.isArray(body) ||
    body.sweep !== true ||
    Object.keys(body).some((key) => !["sweep", ...modeKeys].includes(key)) ||
    modeKeys.some((key) =>
      body[key] !== undefined && typeof body[key] !== "boolean"
    )
  ) {
    return new Response(JSON.stringify({ error: "invalid_sweep_request" }), {
      status: 400,
      headers,
    });
  }
  const client = auth.context.admin;
  try {
    const result = await runStudentCardSweep({
      client,
      async resolveRoute(tenantId): Promise<CardRoute | null> {
        const route = await loadTenantCentralWhatsAppContext(
          client,
          tenantId,
          "student",
          { requireDeliveryReceipts: true },
        );
        if (!route) return null;
        const instance = await client.from("whatsapp_instances")
          .select("integration_id,integration_version")
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
          tenantId,
          instanceName: route.instanceName,
          integrationId: integration.integrationId,
          integrationVersion: integration.version,
          mode: integration.mode,
          baseUrl: integration.baseUrl,
          apiKey: integration.apiKey,
          brandName: route.identity.brandName,
          portalUrl: route.identity.portalUrl,
        };
      },
      async resolveAsaas(tenantId) {
        const [payment, subscription] = await Promise.all([
          resolveAsaasIntegration(client, tenantId, "payment.read"),
          resolveAsaasIntegration(client, tenantId, "subscription.read"),
        ]);
        return sameSnapshot(payment, subscription) ? payment : null;
      },
      readPayment: (integration, id) => readAsaas(integration, "payments", id),
      readSubscription: (integration, id) =>
        readAsaas(integration, "subscriptions", id),
      async hash(value) {
        const digest = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(value),
        );
        return [...new Uint8Array(digest)].map((byte) =>
          byte.toString(16).padStart(2, "0")
        ).join("");
      },
      send: sendCardNotice,
    }, {
      testMode: body.testMode === true || body.test_mode === true,
      dryRun: body.dryRun === true || body.dry_run === true,
    });
    return new Response(JSON.stringify(result), {
      status: result.errors.length ? 503 : 200,
      headers,
    });
  } catch {
    return new Response(
      JSON.stringify({ error: "student_card_notification_unavailable" }),
      { status: 503, headers },
    );
  }
});
