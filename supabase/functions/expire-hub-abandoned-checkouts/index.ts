/// <reference lib="deno.ns" />

// Rotina horária (cron wisewolf-hub-abandoned-checkouts): cancela no Asaas e
// localmente os checkouts PIX/boleto do Hub e do Wolfie sem o 1º pagamento há
// mais de 5 dias. Só aceita a chave de serviço; nunca é chamada por usuário.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.93.3";
import { authorizeAutomation } from "../_shared/automation-auth.ts";
import {
  parseAbandonedCheckoutRequest,
  processAbandonedCheckouts,
} from "./core.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (status: number, payload: Record<string, unknown>) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

  const authError = await authorizeAutomation(req, corsHeaders);
  if (authError) return authError;

  const body = await req.json().catch(() => ({}));
  const request = parseAbandonedCheckoutRequest(body);
  if (request.ok === false) return json(400, { error: request.error });

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !serviceRoleKey) {
    return json(503, { error: "service_configuration_unavailable" });
  }
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const summary = await processAbandonedCheckouts(admin, {
      limit: request.limit,
      checkoutId: request.checkoutId,
    });
    if (summary.failed > 0) {
      console.error("[hub-abandoned] checkouts não concluídos", {
        failures: summary.failures,
      });
    }
    return json(200, summary);
  } catch (error) {
    console.error("[hub-abandoned] varredura indisponível", {
      type: error instanceof Error ? error.message : "unknown",
    });
    return json(500, { error: "abandoned_checkout_run_failed" });
  }
});
