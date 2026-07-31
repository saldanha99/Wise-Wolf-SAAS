/// <reference lib="deno.ns" />

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { authorizeRequest, methodNotAllowed } from "../_shared/request-auth.ts";

let asaasUrl = Deno.env.get("ASAAS_API_URL") || "https://api-sandbox.asaas.com";
asaasUrl = asaasUrl.replace(/\/+$/, "").replace(/\/v3$/, "").replace(/\/api\/v3$/, "").replace(/\/api$/, "");
const asaasApiKey = (Deno.env.get("ASAAS_API_KEY") || Deno.env.get("ASAAS_ACCESS_TOKEN") || "").trim();

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return methodNotAllowed(corsHeaders);

  const auth = await authorizeRequest(req, {
    corsHeaders,
    allowedRoles: ["SUPER_ADMIN"],
  });
  if (auth.ok === false) return auth.response;
  if (!asaasApiKey) return json({ error: "Asaas is unavailable" }, 503);

  try {
    const body = await req.json();
    const action = body.action === "get" || body.action === "update" ? body.action : null;
    const subscriptionId = typeof body.subscriptionId === "string" ? body.subscriptionId.trim() : "";
    const maxPayments = Number(body.maxPayments);
    if (!action || !/^[A-Za-z0-9_-]{3,120}$/.test(subscriptionId)) {
      return json({ error: "Invalid request" }, 400);
    }
    if (action === "update" && (!Number.isInteger(maxPayments) || maxPayments < 1 || maxPayments > 120)) {
      return json({ error: "Invalid payment limit" }, 400);
    }

    const pathPrefix = asaasUrl.includes("api-sandbox") || asaasUrl.includes("api.asaas.com")
      ? "/v3"
      : "/api/v3";
    const response = await fetch(`${asaasUrl}${pathPrefix}/subscriptions/${encodeURIComponent(subscriptionId)}`, {
      method: action === "update" ? "POST" : "GET",
      headers: {
        "Content-Type": "application/json",
        access_token: asaasApiKey,
      },
      ...(action === "update" ? { body: JSON.stringify({ maxPayments }) } : {}),
    });
    const payload = await response.json().catch(() => ({ error: "Invalid Asaas response" }));
    return json(payload, response.status);
  } catch (error) {
    console.error("Admin subscription operation failed", {
      message: error instanceof Error ? error.message : "unknown error",
    });
    return json({ error: "Invalid request" }, 400);
  }
});
