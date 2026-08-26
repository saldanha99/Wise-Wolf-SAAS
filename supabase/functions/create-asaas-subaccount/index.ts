/// <reference lib="deno.ns" />

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { authorizeRequest, methodNotAllowed } from "../_shared/request-auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return methodNotAllowed(corsHeaders);

  const auth = await authorizeRequest(req, {
    corsHeaders,
    allowedRoles: ["SUPER_ADMIN"],
  });
  if (auth.ok === false) return auth.response;

  // Fail closed. The former implementation could create a real provider
  // account and then lose the only returned apiKey when the database write
  // failed. It also marked the tenant approved without registering a vaulted
  // credential, webhook or explicit tenant integration connection. Asaas now
  // requires a regulated BaaS/subaccount onboarding and complete commercial
  // data. Re-enable only after a sandbox-homologated, durable provisioning
  // workflow can recover an ambiguous POST and vault the one-time key before
  // activating the tenant connection.
  return json(
    {
      error: "ASAAS_SUBACCOUNT_PROVISIONING_DISABLED",
      detail:
        "Provisionamento de subconta aguarda homologacao regulatoria e fluxo duravel.",
    },
    503,
  );
});
