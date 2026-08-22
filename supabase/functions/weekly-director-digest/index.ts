import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  authorizeScopedAutomation,
  scopeAutomationRows,
} from "../_shared/automation-auth.ts";
import { loadTenantWhatsAppRoute } from "../_shared/tenant-communication.ts";

// Cron semanal (segunda de manhã): resumo de métricas da semana para o diretor de cada escola.
// Enviado pela instância central da escola para o telefone do SCHOOL_ADMIN.
// Idempotente via automation_sent (kind=WEEKLY_DIGEST, subject_id=tenant_id, ref_date=hoje).

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};
const EVOLUTION_API_BASE = `${
  (Deno.env.get("EVOLUTION_API_URL") || "https://api.2b.app.br")
    .replace(/\/+$/, "")
}/message/sendText`;
const API_TOKEN = Deno.env.get("EVOLUTION_API_KEY") || "";

interface WeeklyDigestRow {
  tenant_id: string;
  active_students?: number;
  classes_week?: number;
  received_week?: number;
  overdue_count?: number;
  overdue_amount?: number;
}

const money = (v: any) => `R$ ${Number(v || 0).toFixed(2).replace(".", ",")}`;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  const auth = await authorizeScopedAutomation(req, corsHeaders, {
    allowAdmin: true,
  });
  if (auth.ok === false) return auth.response;
  try {
    if (!API_TOKEN) {
      return new Response(JSON.stringify({ error: "provider_unavailable" }), {
        status: 503,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const supabase = auth.context.admin;
    const tenantId = auth.context.tenantId;
    const today = new Date().toISOString().split("T")[0];

    const { data: rows, error: rowsError } = await supabase.rpc(
      "weekly_digest_rows",
    );
    if (rowsError) throw rowsError;
    const result = { sent: 0, skipped: 0, failures: [] as string[] };

    for (const r of scopeAutomationRows<WeeklyDigestRow>(rows, tenantId)) {
      // dedupe
      const { data: dup } = await supabase.from("automation_sent").select("id")
        .eq("kind", "WEEKLY_DIGEST").eq("subject_id", r.tenant_id).eq(
          "ref_date",
          today,
        ).maybeSingle();
      if (dup) {
        result.skipped++;
        continue;
      }

      const route = await loadTenantWhatsAppRoute(
        supabase,
        r.tenant_id,
        "general",
      );
      if (!route?.ownerPhone) {
        result.failures.push(`${r.tenant_id}: canal da direção indisponível`);
        continue;
      }

      const text = `📊 *Resumo da semana — ${route.identity.brandName}*\n\n` +
        `👥 Alunos ativos: *${r.active_students}*\n` +
        `📚 Aulas (últimos 7 dias): *${r.classes_week}*\n` +
        `💰 Recebido na semana: *${money(r.received_week)}*\n` +
        `⚠️ Inadimplência: *${r.overdue_count}* ${
          r.overdue_count === 1 ? "cobrança" : "cobranças"
        } (${money(r.overdue_amount)})\n\n` +
        `Tenha uma ótima semana!`;

      const resp = await fetch(
        `${EVOLUTION_API_BASE}/${encodeURIComponent(route.instanceName)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", apikey: API_TOKEN },
          body: JSON.stringify({
            number: route.ownerPhone,
            text,
            delay: 800,
            linkPreview: false,
          }),
        },
      );
      if (!resp.ok) {
        result.failures.push(`${r.tenant_id}: evolution ${resp.status}`);
        continue;
      }
      await supabase.from("automation_sent").insert({
        kind: "WEEKLY_DIGEST",
        subject_id: r.tenant_id,
        ref_date: today,
      });
      result.sent++;
    }

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
