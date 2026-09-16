import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  authorizeScopedAutomation,
  scopeAutomationRows,
} from "../_shared/automation-auth.ts";
import { sendWhatsText } from "../_shared/evolution-send.ts";
import {
  montarMensagemFolha,
  type PayrollSummary,
} from "../_shared/payroll-message.ts";
import {
  loadTenantWhatsAppRoute,
  resolveTenantConfiguredWhatsAppDestination,
} from "../_shared/tenant-communication.ts";
import { resolveEvolutionIntegration } from "../_shared/tenant-integration-broker.ts";

// Folha do mês por professor no grupo da Gestão.
//
// Cron do dia 1º (07:00 UTC, depois do fechamento das 06:30) — ou disparo
// manual de um admin com `{ "month": "AAAA-MM" }`. Destino: o grupo da Gestão
// configurado em dre_report_settings, validado como pertencente à escola.
// Idempotente via automation_sent (kind=MONTHLY_PAYROLL, subject=tenant:mês,
// ref_date=dia 1º do mês); a marca é gravada ANTES do envio e apagada se o
// envio falha — linha em automation_sent = mensagem entregue.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

interface TargetRow {
  tenant_id: string;
  destino?: string | null;
}

function previousMonthInSaoPaulo(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const y = Number(parts.find((p) => p.type === "year")?.value);
  const m = Number(parts.find((p) => p.type === "month")?.value);
  const zero = m - 2; // mês anterior, base zero
  const year = y + Math.floor(zero / 12);
  const month = ((zero % 12) + 12) % 12 + 1;
  return `${year}-${String(month).padStart(2, "0")}`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  const auth = await authorizeScopedAutomation(req, corsHeaders, {
    allowAdmin: true,
  });
  if (auth.ok === false) return auth.response;
  try {
    const supabase = auth.context.admin;
    const scopeTenant = auth.context.tenantId;
    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch { /* corpo vazio no cron */ }
    const requested = String(body.month || "").trim();
    const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(requested)
      ? requested
      : previousMonthInSaoPaulo();
    const manual = Boolean(requested);
    const refDate = `${month}-01`;

    const { data: targets, error: targetsError } = await supabase
      .from("dre_report_settings")
      .select("tenant_id,destino,is_active")
      .eq("is_active", true);
    if (targetsError) throw targetsError;

    const result = { month, sent: 0, skipped: 0, failures: [] as string[] };
    for (const row of scopeAutomationRows<TargetRow>(targets, scopeTenant)) {
      const tenantId = row.tenant_id;
      const subject = manual
        ? `${tenantId}:${month}:manual`
        : `${tenantId}:${month}`;
      const { data: dup, error: dupError } = await supabase
        .from("automation_sent").select("id")
        .eq("kind", "MONTHLY_PAYROLL").eq("subject_id", subject)
        .eq("ref_date", refDate).maybeSingle();
      if (dupError) {
        result.failures.push(`${tenantId}: marcador indisponível`);
        continue;
      }
      if (dup) {
        result.skipped++;
        continue;
      }

      const route = await loadTenantWhatsAppRoute(
        supabase,
        tenantId,
        "general",
      );
      if (!route) {
        result.failures.push(`${tenantId}: canal institucional indisponível`);
        continue;
      }
      const destino = resolveTenantConfiguredWhatsAppDestination(
        route,
        row.destino,
      );
      if (!destino) {
        console.error("[whatsapp] destino recusado: nao pertence a escola", {
          tenant: tenantId,
        });
        result.failures.push(`${tenantId}: destino não pertence à escola`);
        continue;
      }

      const { data: summary, error: summaryError } = await supabase.rpc(
        "gestao_payroll_summary",
        { p_tenant: tenantId, p_month: month },
      );
      const s = summary as PayrollSummary | null;
      if (summaryError || !s?.ok) {
        result.failures.push(`${tenantId}: folha indisponível`);
        continue;
      }
      const text = montarMensagemFolha(route.identity.brandName, s);

      let integration;
      try {
        integration = await resolveEvolutionIntegration(
          supabase,
          tenantId,
          "message.send_text",
        );
      } catch {
        result.failures.push(`${tenantId}: integração indisponível`);
        continue;
      }

      const { data: mark, error: markError } = await supabase.from(
        "automation_sent",
      )
        .insert({
          kind: "MONTHLY_PAYROLL",
          subject_id: subject,
          ref_date: refDate,
        })
        .select("id").maybeSingle();
      if (markError || !mark) {
        result.skipped++;
        continue;
      }
      const ok = await sendWhatsText({
        base: integration.baseUrl,
        keys: [integration.apiKey],
        instance: route.instanceName,
        to: destino,
        text,
      });
      if (!ok) {
        await supabase.from("automation_sent").delete().eq("id", mark.id);
        result.failures.push(`${tenantId}: envio recusado pela Evolution`);
        continue;
      }
      result.sent++;
    }

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("management-payroll-report failed", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return new Response(
      JSON.stringify({ ok: false, error: "payroll_report_failed" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
