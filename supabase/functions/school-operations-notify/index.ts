/// <reference lib="deno.ns" />
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { authorizeScopedAutomation } from "../_shared/automation-auth.ts";
import { resolveEvolutionIntegration } from "../_shared/tenant-integration-broker.ts";
import { loadTenantWhatsAppRoute } from "../_shared/tenant-communication.ts";
import {
  requestOutboundPermit,
  sendWhatsTextToResolvedDestinationDetailed,
  settleOutboundPermit,
  THROTTLE_MAX_INLINE_WAIT_MS,
} from "../_shared/evolution-send.ts";
import { operationMessage, type Row } from "./core.ts";
const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization,apikey,content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};
const object = (x: unknown): Row =>
  x && typeof x === "object" && !Array.isArray(x) ? x as Row : {};
const digest = async (x: unknown) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(x)),
      ),
    ),
  ].map((b) => b.toString(16).padStart(2, "0")).join("");
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") {
    return new Response("{}", { status: 405, headers });
  }
  const auth = await authorizeScopedAutomation(req, headers);
  if (auth.ok === false) return auth.response;
  const input = object(await req.json().catch(() => null));
  if (input.sweep !== true) {
    return new Response('{"error":"sweep_required"}', { status: 400, headers });
  }
  const db = auth.context.admin;
  const rpc = async (
    action: string,
    id: string | null = null,
    token: string | null = null,
    payload: Row = {},
  ) => {
    const r = await db.rpc("school_operation_notifications", {
      p_action: action,
      p_id: id,
      p_token: token,
      p_payload: payload,
    });
    if (r.error) throw new Error("notification_state_unavailable");
    return r.data;
  };
  let accepted = 0, suppressed = 0, uncertain = 0, errors = 0;
  try {
    const pending: unknown = await rpc("pending");
    if (!Array.isArray(pending)) throw new Error("pending_invalid");
    for (const raw of pending) {
      const p = object(raw), id = String(p.id), token = crypto.randomUUID();
      let submitted = false;
      let permitLedger: string | null = null, providerAccepted = false;
      try {
        if (input.testMode === true) continue; // Never claim or send real data in test mode.
        const route = await loadTenantWhatsAppRoute(
          db,
          String(p.tenant_id),
          "general",
          { requireDeliveryReceipts: true },
        );
        if (!route?.identity.portalUrl) {
          errors++;
          continue;
        }
        const first = await resolveEvolutionIntegration(
          db,
          String(p.tenant_id),
          "message.send_text",
        );
        const claimed = object(await rpc("claim", id, token));
        if (claimed.ok !== true) {
          suppressed++;
          continue;
        }
        const destination = String(claimed.destination || "");
        if (!/^[0-9]{10,25}@g\.us$/.test(destination)) {
          throw new Error("destination_invalid");
        }
        const message = operationMessage(
          object(claimed.source),
          route.identity.portalUrl,
        );
        // O teto é consultado antes da cerca durável. Sem POST, o claim
        // pode expirar e ser retomado; resultado incerto nunca é repetido.
        const permit = await requestOutboundPermit(
          route.instanceName,
          destination,
        );
        if (!permit) throw new Error("outbound_permit_unavailable");
        permitLedger = permit.ledger_id || null;
        if (!permit.allowed) continue;
        const wait = Math.min(
          Math.max(0, Number(permit.wait_ms || 0)),
          THROTTLE_MAX_INLINE_WAIT_MS,
        );
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        const current = await resolveEvolutionIntegration(
          db,
          String(p.tenant_id),
          "message.send_text",
        );
        const identity = (
          x: typeof first,
        ) => [x.tenantId, x.integrationId, x.version, x.baseUrl, x.apiKey];
        const routeNow = await loadTenantWhatsAppRoute(
          db,
          String(p.tenant_id),
          "general",
          { requireDeliveryReceipts: true },
        );
        if (
          JSON.stringify(identity(first)) !==
            JSON.stringify(identity(current)) ||
          routeNow?.instanceName !== route.instanceName
        ) throw new Error("route_changed");
        const authorized = object(
          await rpc("submit", id, token, {
            route_hash: await digest([
              ...identity(current),
              route.instanceName,
              destination,
              message,
            ]),
          }),
        );
        if (authorized.ok !== true) {
          suppressed++;
          continue;
        }
        submitted = true;
        const result = await sendWhatsTextToResolvedDestinationDetailed({
          base: current.baseUrl,
          keys: [current.apiKey],
          instance: route.instanceName,
          to: destination,
          text: message,
          throttle: "skip",
        });
        providerAccepted = result.outcome === "accepted";
        await rpc("finish", id, token, {
          outcome: result.outcome,
          messageId: result.messageId,
        });
        if (result.outcome === "accepted") accepted++;
        else uncertain++;
      } catch {
        errors++;
        if (submitted) {
          try {
            await rpc("finish", id, token, { outcome: "ambiguous" });
          } catch { /* SUBMITTING is never retried automatically. */ }
        }
      } finally {
        if (permitLedger) {
          await settleOutboundPermit(permitLedger, providerAccepted);
        }
      }
    }
    return new Response(
      JSON.stringify({ accepted, suppressed, uncertain, errors }),
      { headers, status: errors ? 503 : 200 },
    );
  } catch {
    return new Response('{"error":"operations_notifications_unavailable"}', {
      status: 503,
      headers,
    });
  }
});
