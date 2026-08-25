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
import {
  loadTenantWhatsAppRoute,
  resolveTenantConfiguredWhatsAppDestination,
} from "../_shared/tenant-communication.ts";

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
    if (!API_TOKEN) {
      return new Response(JSON.stringify({ error: "provider_unavailable" }), {
        status: 503,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
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
        console.error('[whatsapp] destino recusado: nao pertence a escola', {
          tenant: tenantId,
        });
        resultado.failures.push(`${tenantId}: destino não pertence à escola`);
        continue;
      }

      // Manual e automático não se bloqueiam.
      const subject = manualRun ? `${tenantId}:manual` : tenantId;
      const { data: dup } = await supabase.from("automation_sent").select("id")
        .eq("kind", "DRE_REPORT").eq("subject_id", subject)
        .eq("ref_date", refDate).maybeSingle();
      if (dup) {
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

      const resp = await fetch(
        `${EVOLUTION_API_BASE}/${encodeURIComponent(route.instanceName)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", apikey: API_TOKEN },
          body: JSON.stringify({
            number: destino,
            text: texto,
            delay: 800,
            linkPreview: false,
          }),
        },
      );
      if (!resp.ok) {
        resultado.failures.push(`${tenantId}: evolution ${resp.status}`);
        continue;
      }

      await supabase.from("automation_sent").insert({
        kind: "DRE_REPORT",
        subject_id: subject,
        ref_date: refDate,
      });
      await supabase.rpc("mark_dre_report_sent", { p_tenant: tenantId });
      resultado.sent++;
    }

    return new Response(JSON.stringify(resultado), {
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
