/// <reference lib="deno.ns" />

/**
 * Aviso de rateio no grupo da direção, no ato em que o pagamento entra.
 *
 * Dois caminhos, o mesmo código:
 *   { payment_id }  — trigger em student_payments (imediato, via pg_net)
 *   { sweep: true }  — cron a cada 15 min, pega o que o caminho imediato perdeu
 *
 * ⚠️ O destino é o grupo do relatório gerencial (dre_report_settings.destino).
 * Não existe segunda lista de grupos de propósito: duas listas saem de sincronia
 * e o aviso passa a ir para um grupo que o diretor achou que tinha desligado.
 *
 * O POST irreversível usa claim -> SUBMITTING -> resultado durável. A tabela
 * automation_sent permanece apenas como marcador legado do envio confirmado;
 * nunca mais é usada como trava temporária nem apagada após timeout.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { authorizeScopedAutomation } from "../_shared/automation-auth.ts";
import { sendWhatsTextDetailed } from "../_shared/evolution-send.ts";
import {
  loadTenantWhatsAppRoute,
  resolveTenantConfiguredWhatsAppDestination,
} from "../_shared/tenant-communication.ts";
import {
  type ResolvedEvolutionIntegration,
  resolveEvolutionIntegration,
} from "../_shared/tenant-integration-broker.ts";
import { montarMensagem } from "./message.ts";
import {
  claimPaymentSplitMessage,
  finishPaymentSplitMessage,
  markPaymentSplitMessageSubmitting,
  paymentSplitMessageFinish,
} from "./outbound-fence.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Só o cron/trigger dispara. O painel usa a RPC de prévia, que não envia nada —
  // assim nenhum caminho de UI consegue inundar o grupo por acidente.
  const auth = await authorizeScopedAutomation(req, corsHeaders);
  if (auth.ok === false) return auth.response;
  const supabase = auth.context.admin;

  const resultado = { sent: 0, skipped: 0, failures: [] as string[] };

  try {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;

    let alvos: string[] = [];
    if (typeof body.payment_id === "string" && body.payment_id.trim()) {
      alvos = [body.payment_id.trim()];
    } else if (body.sweep === true) {
      const { data, error } = await supabase.rpc("payment_split_pending");
      if (error) {
        console.error("payment split pending failed", { code: error.code });
        return new Response(JSON.stringify({ error: "pending_unavailable" }), {
          status: 503,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      alvos = ((data ?? []) as Record<string, unknown>[])
        .map((r) => String(r.payment_id ?? ""))
        .filter(Boolean);
    } else {
      return new Response(JSON.stringify({ error: "payment_id_ou_sweep" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    for (const paymentId of alvos) {
      const { data: b, error: bError } = await supabase
        .rpc("payment_split_breakdown", { p_payment_id: paymentId });

      if (bError || !b || (b as Record<string, unknown>).error) {
        resultado.failures.push(`${paymentId}: rateio indisponível`);
        continue;
      }
      const dados = b as Record<string, unknown>;

      if (!dados.is_active) {
        resultado.skipped++;
        continue;
      }

      const tenantId = String(dados.tenant_id ?? "");
      if (!tenantId) {
        resultado.skipped++;
        continue;
      }

      const { data: cfg } = await supabase.from("dre_report_settings")
        .select("destino").eq("tenant_id", tenantId).maybeSingle();
      const route = await loadTenantWhatsAppRoute(
        supabase,
        tenantId,
        "general",
      );
      if (!route) {
        resultado.failures.push(
          `${paymentId}: canal institucional indisponível`,
        );
        continue;
      }
      const destino = resolveTenantConfiguredWhatsAppDestination(
        route,
        cfg?.destino,
      );
      if (!destino) {
        // Recusa VISIVEL. Antes isto virava um item em  dentro do
        // corpo de uma resposta HTTP que ninguém lê — foi assim que o aviso de
        // rateio passou 9 dias mudo sem ninguém notar.
        console.error("[whatsapp] destino recusado: nao pertence a escola", {
          tenant: tenantId,
        });
        resultado.failures.push(`${paymentId}: destino não pertence à escola`);
        continue;
      }

      // Compatibilidade com os envios anteriores ao fence durável. Uma marca
      // legada já existente é tratada como entregue; criar um claim novo aqui
      // reenviaria pagamentos históricos na primeira execução pós-release.
      const refDate = legacyRefDate(dados);
      const { data: legacySent, error: legacyError } = await supabase
        .from("automation_sent")
        .select("id")
        .eq("kind", "PAYMENT_SPLIT")
        .eq("subject_id", paymentId)
        .eq("ref_date", refDate)
        .maybeSingle();
      if (legacyError) {
        resultado.failures.push(`${paymentId}: marcador legado indisponível`);
        continue;
      }
      if (legacySent) {
        resultado.skipped++;
        continue;
      }

      // Resolve credencial/base estritamente no tenant antes de tomar o claim.
      // Falha de configuração permanece reexecutável porque nenhum POST começou.
      let integration: ResolvedEvolutionIntegration;
      try {
        integration = await resolveEvolutionIntegration(
          supabase,
          tenantId,
          "message.send_text",
        );
      } catch {
        resultado.failures.push(`${paymentId}: integração indisponível`);
        continue;
      }

      const claim = await claimPaymentSplitMessage(supabase, {
        tenantId,
        paymentId,
      });
      if (claim.action === "ALREADY_FINAL") {
        if (String(claim.status || "").toUpperCase() === "SENT") {
          try {
            await recordLegacyMarker(supabase, paymentId, dados);
          } catch {
            resultado.failures.push(
              `${paymentId}: marcador legado indisponível`,
            );
          }
        } else if (
          ["UNKNOWN", "SUBMITTING", "FAILED"].includes(
            String(claim.status || "").toUpperCase(),
          )
        ) {
          resultado.failures.push(
            `${paymentId}: resultado durável ${claim.status} requer revisão`,
          );
        }
        resultado.skipped++;
        continue;
      }
      if (claim.action !== "SUBMIT_ONCE") {
        if (claim.action === "REVIEW_REQUIRED") {
          resultado.failures.push(
            `${paymentId}: ${claim.reason || "escopo inválido"}`,
          );
        } else {
          resultado.skipped++;
        }
        continue;
      }

      const mark = await markPaymentSplitMessageSubmitting(supabase, claim);
      if (mark.ok !== true || mark.status !== "SUBMITTING") {
        if (mark.status === "SUPPRESSED") {
          resultado.skipped++;
        } else {
          resultado.failures.push(
            `${paymentId}: ${mark.reason || "claim perdido antes do envio"}`,
          );
        }
        continue;
      }

      const providerResult = await sendWhatsTextDetailed({
        base: integration.baseUrl,
        keys: [integration.apiKey],
        instance: route.instanceName,
        to: destino,
        text: montarMensagem(dados),
        delayMs: 800,
      });
      const finish = paymentSplitMessageFinish(providerResult);
      try {
        await finishPaymentSplitMessage(supabase, claim, finish);
      } catch {
        // SUBMITTING + submit_attempt_count=1 impede qualquer novo POST. Um
        // resultado que não pôde ser persistido exige conciliação humana.
        resultado.failures.push(
          `${paymentId}: resultado do envio não pôde ser persistido`,
        );
        continue;
      }

      if (finish.status === "SENT") {
        try {
          await recordLegacyMarker(supabase, paymentId, dados);
          resultado.sent++;
        } catch {
          // O claim durável SENT continua sendo a verdade. O próximo sweep
          // apenas repara automation_sent; ele não volta a enviar.
          resultado.failures.push(`${paymentId}: marcador legado indisponível`);
        }
      } else {
        resultado.failures.push(
          `${paymentId}: ${finish.error || finish.status.toLowerCase()}`,
        );
      }
    }

    return new Response(JSON.stringify(resultado), {
      status: resultado.failures.length === 0 ? 200 : 503,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("payment split notify failed", {
      type: error instanceof Error ? error.name : "UnknownError",
    });
    return new Response(JSON.stringify({ error: "PAYMENT_SPLIT_FAILED" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

async function recordLegacyMarker(
  supabase: any,
  paymentId: string,
  breakdown: Record<string, unknown>,
) {
  // ref_date vem da RPC e é o created_at do pagamento, NÃO a data em que ele
  // foi pago. Eventos diferentes da mesma cobrança precisam colidir aqui.
  const refDate = legacyRefDate(breakdown);
  const { error } = await supabase.from("automation_sent").upsert({
    kind: "PAYMENT_SPLIT",
    subject_id: paymentId,
    ref_date: refDate,
  }, {
    onConflict: "kind,subject_id,ref_date",
    ignoreDuplicates: true,
  });
  if (error) throw new Error("payment_split_legacy_marker_failed");
}

function legacyRefDate(breakdown: Record<string, unknown>): string {
  return String(breakdown.ref_date ?? "").slice(0, 10) ||
    new Date().toISOString().slice(0, 10);
}
