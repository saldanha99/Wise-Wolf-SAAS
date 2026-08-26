import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { authorizeRequest, methodNotAllowed } from "../_shared/request-auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

function currentPeriodInSaoPaulo(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  if (!year || !month) throw new Error("period_resolution_failed");
  return `${year}-${month}-01`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return methodNotAllowed(corsHeaders);

  const auth = await authorizeRequest(req, {
    corsHeaders,
    allowService: true,
    allowedRoles: ["SUPER_ADMIN"],
  });
  if (auth.ok === false) return auth.response;

  try {
    const body = (await req.json().catch(() => ({}))) as {
      tenant_id?: unknown;
      period?: unknown;
    };
    const tenantId = typeof body.tenant_id === "string"
      ? body.tenant_id.trim()
      : "";
    if (!tenantId) {
      return new Response(JSON.stringify({ error: "tenant_id_obrigatorio" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    const periodInput = typeof body.period === "string"
      ? body.period.trim()
      : "";
    const periodStart = /^\d{4}-\d{2}$/.test(periodInput)
      ? `${periodInput}-01`
      : /^\d{4}-\d{2}-01$/.test(periodInput)
      ? periodInput
      : periodInput
      ? null
      : currentPeriodInSaoPaulo();
    if (!periodStart) {
      return new Response(JSON.stringify({ error: "periodo_invalido" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    // One database transaction holds the tenant/competence advisory lock and
    // inserts deterministic automation keys with ON CONFLICT. Concurrent
    // invocations therefore converge on exactly one monthly row per student.
    const { data, error } = await auth.context.admin.rpc(
      "generate_monthly_student_payments",
      { p_tenant_id: tenantId, p_period_start: periodStart },
    );
    if (error) throw error;

    return new Response(JSON.stringify({ success: true, ...data }), {
      status: 200,
      headers: corsHeaders,
    });
  } catch (error) {
    console.error("[sync-payments] generation failed", {
      type: error instanceof Error ? error.name : "unknown",
    });
    return new Response(JSON.stringify({ error: "PAYMENT_SYNC_FAILED" }), {
      status: 500,
      headers: corsHeaders,
    });
  }
});
