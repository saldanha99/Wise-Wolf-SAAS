/// <reference lib="deno.ns" />

/**
 * Relatório gerencial no WhatsApp (grupo da direção ou telefone).
 *
 * Um cron diário chama esta função; quem decide "hoje envia?" é
 * `dre_report_targets`, que lê a cadência escolhida pela escola. Sem linha ativa
 * em dre_report_settings nada acontece — a automação nasce muda de propósito.
 *
 * Idempotente por automation_sent (kind=DRE_REPORT). O envio manual usa um
 * subject próprio, para que "enviar agora" não fique bloqueado pelo envio
 * automático do mesmo dia (nem o contrário).
 */

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
import {
  loadTenantWhatsAppRoute,
  resolveTenantConfiguredWhatsAppDestination,
} from "../_shared/tenant-communication.ts";
import {
  type ResolvedEvolutionIntegration,
  resolveEvolutionIntegration,
} from "../_shared/tenant-integration-broker.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const MESES = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
];

/** Formatação sem depender de ICU: o runtime da VPS não é o do navegador. */
function money(v: unknown): string {
  const n = Number(v ?? 0);
  const seguro = Number.isFinite(n) ? n : 0;
  const [inteiro, decimal] = Math.abs(seguro).toFixed(2).split(".");
  const comPontos = inteiro.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${seguro < 0 ? "-" : ""}R$ ${comPontos},${decimal}`;
}

function pct(v: unknown): string {
  const n = Number(v);
  return Number.isFinite(n) ? `${n.toFixed(1).replace(".", ",")}%` : "—";
}

function mesPorExtenso(month: string): string {
  const [ano, mes] = String(month || "").split("-");
  const idx = Number(mes) - 1;
  return MESES[idx] ? `${MESES[idx]} de ${ano}` : String(month);
}

interface Linha {
  label?: string;
  kind?: string;
  valor?: number;
}
interface Alerta {
  nivel?: string;
  texto?: string;
}

function montarMensagem(escola: string, dre: Record<string, unknown>): string {
  const ind = (dre.indicadores ?? {}) as Record<string, unknown>;
  const linhas = (Array.isArray(dre.linhas) ? dre.linhas : []) as Linha[];
  const alertas = (Array.isArray(dre.alertas) ? dre.alertas : []) as Alerta[];

  const despesas = linhas
    .filter((l) => l.kind === "DESPESA" && Number(l.valor) > 0)
    .sort((a, b) => Number(b.valor) - Number(a.valor))
    .slice(0, 5);

  const resultado = Number(dre.resultado ?? 0);
  const partes: string[] = [];

  partes.push(`📊 *Resultado de ${mesPorExtenso(String(dre.month ?? ""))}*`);
  partes.push(`_${escola} · regime de competência_`);
  partes.push("");
  partes.push(`💵 Receita líquida: *${money(dre.receita_liquida)}*`);
  partes.push(`📉 Custo das aulas: *${money(dre.custo_servicos)}*`);
  if (Number(ind.aulas ?? 0) > 0) {
    partes.push(
      `      ${ind.aulas} aulas · ${money(ind.custo_por_aula)} por aula`,
    );
  }
  partes.push(
    `📈 Lucro bruto: *${money(dre.lucro_bruto)}* (${
      pct(dre.margem_bruta_pct)
    })`,
  );
  partes.push(`🏷️ Despesas: *${money(dre.despesas_operacionais)}*`);
  for (const d of despesas) {
    partes.push(`      • ${d.label}: ${money(d.valor)}`);
  }
  partes.push("");
  partes.push(
    `${resultado >= 0 ? "✅" : "🔻"} *Resultado: ${money(resultado)}* (${
      pct(dre.margem_liquida_pct)
    })`,
  );

  if (Number(ind.alunos_atendidos ?? 0) > 0) {
    partes.push("");
    partes.push(
      `👥 ${ind.alunos_atendidos} alunos atendidos · ${
        money(ind.receita_por_aluno)
      } por aluno`,
    );
  }

  // Os alertas são a parte que impede decisão em cima de número irreal —
  // vão sempre, nunca são cortados por tamanho.
  const relevantes = alertas.filter((a) => a.nivel !== "info");
  if (relevantes.length > 0) {
    partes.push("");
    for (const a of relevantes) {
      partes.push(`${a.nivel === "critico" ? "🚨" : "⚠️"} ${a.texto}`);
    }
  }

  return partes.join("\n");
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

    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const pedido = typeof body.tenant === "string" && body.tenant.trim()
      ? body.tenant.trim()
      : null;
    const forceTenant = auth.context.isService ? pedido : auth.context.tenantId;
    const manualRun = !auth.context.isService || Boolean(pedido);

    const { data: alvos, error: alvosError } = await supabase
      .rpc("dre_report_targets", { p_force_tenant: forceTenant });
    if (alvosError) {
      console.error("DRE report targets failed", { code: alvosError.code });
      return new Response(JSON.stringify({ error: "targets_unavailable" }), {
        status: 503,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const resultado = { sent: 0, skipped: 0, failures: [] as string[] };

    for (
      const alvo of scopeAutomationRows<Record<string, unknown>>(
        alvos,
        forceTenant,
      )
    ) {
      const tenantId = String(alvo.tenant_id ?? "");
      const refDate = String(alvo.ref_date ?? "");

      if (!tenantId || !refDate) {
        resultado.skipped++;
        continue;
      }
      const route = await loadTenantWhatsAppRoute(
        supabase,
        tenantId,
        "general",
      );
      if (!route) {
        resultado.failures.push(
          `${tenantId}: canal institucional indisponível`,
        );
        continue;
      }
      const destino = resolveTenantConfiguredWhatsAppDestination(
        route,
        alvo.destino,
      );
      if (!destino) {
        // Recusa VISIVEL. Antes isto virava um item em  dentro do
        // corpo de uma resposta HTTP que ninguém lê — foi assim que o aviso de
        // rateio passou 9 dias mudo sem ninguém notar.
        console.error("[whatsapp] destino recusado: nao pertence a escola", {
          tenant: tenantId,
        });
        resultado.failures.push(`${tenantId}: destino não pertence à escola`);
        continue;
      }

      // Manual e automático não se bloqueiam.
      const subject = manualRun ? `${tenantId}:manual` : tenantId;
      const { data: dup, error: dupError } = await supabase.from(
        "automation_sent",
      ).select("id")
        .eq("kind", "DRE_REPORT").eq("subject_id", subject)
        .eq("ref_date", refDate).maybeSingle();
      if (dupError) {
        resultado.failures.push(`${tenantId}: marcador legado indisponível`);
        continue;
      }
      if (dup) {
        try {
          await markDreReportSent(supabase, tenantId);
        } catch {
          resultado.failures.push(`${tenantId}: marcador DRE indisponível`);
        }
        resultado.skipped++;
        continue;
      }

      const { data: dre, error: dreError } = await supabase.rpc(
        "dre_gerencial",
        {
          p_month: String(alvo.month ?? ""),
          p_tenant: tenantId,
        },
      );
      if (dreError || !dre || (dre as Record<string, unknown>).error) {
        resultado.failures.push(`${tenantId}: dre indisponível`);
        continue;
      }

      const texto = montarMensagem(
        route.identity.brandName,
        dre as Record<string, unknown>,
      );
      let integration: ResolvedEvolutionIntegration;
      try {
        integration = await resolveEvolutionIntegration(
          supabase,
          tenantId,
          "message.send_text",
        );
      } catch {
        resultado.failures.push(`${tenantId}: integração indisponível`);
        continue;
      }

      const claim = await claimFinancialReportMessage(supabase, {
        tenantId,
        notificationKind: "DRE_REPORT",
        subjectId: subject,
        refDate,
      });
      if (claim.action === "ALREADY_FINAL") {
        if (String(claim.status || "").toUpperCase() === "SENT") {
          try {
            await recordDreReportSent(
              supabase,
              tenantId,
              subject,
              refDate,
            );
          } catch {
            resultado.failures.push(
              `${tenantId}: marcador durável indisponível`,
            );
          }
        } else {
          resultado.failures.push(
            `${tenantId}: resultado durável ${claim.status} requer revisão`,
          );
        }
        resultado.skipped++;
        continue;
      }
      if (claim.action !== "SUBMIT_ONCE") {
        if (claim.action === "REVIEW_REQUIRED") {
          resultado.failures.push(
            `${tenantId}: ${claim.reason || "escopo inativo"}`,
          );
        } else {
          resultado.skipped++;
        }
        continue;
      }

      const mark = await markFinancialReportMessageSubmitting(
        supabase,
        claim,
      );
      if (mark.ok !== true || mark.status !== "SUBMITTING") {
        if (mark.status === "SUPPRESSED") {
          resultado.skipped++;
        } else {
          resultado.failures.push(
            `${tenantId}: ${mark.reason || "claim perdido antes do envio"}`,
          );
        }
        continue;
      }

      const providerResult = await sendWhatsTextDetailed({
        base: integration.baseUrl,
        keys: [integration.apiKey],
        instance: route.instanceName,
        to: destino,
        text: texto,
        delayMs: 800,
      });
      const finish = financialReportMessageFinish(providerResult);
      try {
        await finishFinancialReportMessage(supabase, claim, finish);
      } catch {
        resultado.failures.push(
          `${tenantId}: resultado do envio não pôde ser persistido`,
        );
        continue;
      }
      if (finish.status !== "SENT") {
        resultado.failures.push(
          `${tenantId}: ${finish.error || finish.status.toLowerCase()}`,
        );
        continue;
      }

      try {
        await recordDreReportSent(supabase, tenantId, subject, refDate);
        resultado.sent++;
      } catch {
        resultado.failures.push(`${tenantId}: marcador durável indisponível`);
      }
    }

    return new Response(JSON.stringify(resultado), {
      status: resultado.failures.length === 0 ? 200 : 503,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("DRE report failed", {
      type: error instanceof Error ? error.name : "UnknownError",
    });
    return new Response(JSON.stringify({ error: "DRE_REPORT_FAILED" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

async function markDreReportSent(supabase: any, tenantId: string) {
  const { error } = await supabase.rpc("mark_dre_report_sent", {
    p_tenant: tenantId,
  });
  if (error) throw new Error("dre_report_marker_failed");
}

async function recordDreReportSent(
  supabase: any,
  tenantId: string,
  subject: string,
  refDate: string,
) {
  const { error } = await supabase.from("automation_sent").upsert({
    kind: "DRE_REPORT",
    subject_id: subject,
    ref_date: refDate,
  }, {
    onConflict: "kind,subject_id,ref_date",
    ignoreDuplicates: true,
  });
  if (error) throw new Error("dre_report_legacy_marker_failed");
  await markDreReportSent(supabase, tenantId);
}
