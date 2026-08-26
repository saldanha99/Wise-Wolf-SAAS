import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  authorizeScopedAutomation,
  scopeAutomationRows,
} from "../_shared/automation-auth.ts";
import { sendWhatsTextDetailed } from "../_shared/evolution-send.ts";
import {
  claimFinancialReportMessage,
  financialReportMessageFinish,
  finishFinancialReportMessage,
  markFinancialReportMessageSubmitting,
} from "../_shared/financial-report-message-fence.ts";
import { loadTenantWhatsAppRoute } from "../_shared/tenant-communication.ts";
import {
  type ResolvedEvolutionIntegration,
  resolveEvolutionIntegration,
} from "../_shared/tenant-integration-broker.ts";

// Cron semanal (segunda de manhã): resumo de métricas da semana para o diretor de cada escola.
// Enviado pela instância central da escola para o telefone do SCHOOL_ADMIN.
// Idempotente via automation_sent (kind=WEEKLY_DIGEST, subject_id=tenant_id, ref_date=hoje).

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};
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
      const { data: dup, error: dupError } = await supabase.from(
        "automation_sent",
      ).select("id")
        .eq("kind", "WEEKLY_DIGEST").eq("subject_id", r.tenant_id).eq(
          "ref_date",
          today,
        ).maybeSingle();
      if (dupError) {
        result.failures.push(`${r.tenant_id}: marcador legado indisponível`);
        continue;
      }
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

      let integration: ResolvedEvolutionIntegration;
      try {
        integration = await resolveEvolutionIntegration(
          supabase,
          r.tenant_id,
          "message.send_text",
        );
      } catch {
        result.failures.push(`${r.tenant_id}: integração indisponível`);
        continue;
      }

      const claim = await claimFinancialReportMessage(supabase, {
        tenantId: r.tenant_id,
        notificationKind: "WEEKLY_DIGEST",
        subjectId: r.tenant_id,
        refDate: today,
      });
      if (claim.action === "ALREADY_FINAL") {
        if (String(claim.status || "").toUpperCase() === "SENT") {
          try {
            await recordWeeklyDigestSent(supabase, r.tenant_id, today);
          } catch {
            result.failures.push(
              `${r.tenant_id}: marcador legado indisponível`,
            );
          }
        } else {
          result.failures.push(
            `${r.tenant_id}: resultado durável ${claim.status} requer revisão`,
          );
        }
        result.skipped++;
        continue;
      }
      if (claim.action !== "SUBMIT_ONCE") {
        if (claim.action === "REVIEW_REQUIRED") {
          result.failures.push(
            `${r.tenant_id}: ${claim.reason || "escopo inativo"}`,
          );
        } else {
          result.skipped++;
        }
        continue;
      }

      const mark = await markFinancialReportMessageSubmitting(
        supabase,
        claim,
      );
      if (mark.ok !== true || mark.status !== "SUBMITTING") {
        if (mark.status === "SUPPRESSED") {
          result.skipped++;
        } else {
          result.failures.push(
            `${r.tenant_id}: ${mark.reason || "claim perdido antes do envio"}`,
          );
        }
        continue;
      }

      const providerResult = await sendWhatsTextDetailed({
        base: integration.baseUrl,
        keys: [integration.apiKey],
        instance: route.instanceName,
        to: route.ownerPhone,
        text,
        delayMs: 800,
      });
      const finish = financialReportMessageFinish(providerResult);
      try {
        await finishFinancialReportMessage(supabase, claim, finish);
      } catch {
        result.failures.push(
          `${r.tenant_id}: resultado do envio não pôde ser persistido`,
        );
        continue;
      }
      if (finish.status !== "SENT") {
        result.failures.push(
          `${r.tenant_id}: ${finish.error || finish.status.toLowerCase()}`,
        );
        continue;
      }

      try {
        await recordWeeklyDigestSent(supabase, r.tenant_id, today);
        result.sent++;
      } catch {
        result.failures.push(`${r.tenant_id}: marcador legado indisponível`);
      }
    }

    return new Response(JSON.stringify(result), {
      status: result.failures.length === 0 ? 200 : 503,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

async function recordWeeklyDigestSent(
  supabase: any,
  tenantId: string,
  refDate: string,
) {
  const { error } = await supabase.from("automation_sent").upsert({
    kind: "WEEKLY_DIGEST",
    subject_id: tenantId,
    ref_date: refDate,
  }, {
    onConflict: "kind,subject_id,ref_date",
    ignoreDuplicates: true,
  });
  if (error) throw new Error("weekly_digest_legacy_marker_failed");
}
