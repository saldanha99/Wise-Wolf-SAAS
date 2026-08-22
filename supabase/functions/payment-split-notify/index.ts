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
 * ⚠️ A marca em automation_sent é gravada ANTES do envio. O índice único
 * (kind, subject_id, ref_date) é o que garante que dois disparos concorrentes —
 * o trigger e o cron caindo juntos — não mandem a mesma mensagem duas vezes.
 * Se o envio falhar, a marca é apagada para o cron tentar de novo.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { authorizeScopedAutomation } from "../_shared/automation-auth.ts";
import {
  loadTenantWhatsAppRoute,
  resolveOwnedTenantWhatsAppDestination,
} from "../_shared/tenant-communication.ts";
import { montarMensagem } from "./message.ts";

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

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Só o cron/trigger dispara. O painel usa a RPC de prévia, que não envia nada —
  // assim nenhum caminho de UI consegue inundar o grupo por acidente.
  const auth = await authorizeScopedAutomation(req, corsHeaders);
  if (auth.ok === false) return auth.response;
  if (!API_TOKEN) {
    return new Response(JSON.stringify({ error: "provider_unavailable" }), {
      status: 503,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
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
      const destino = resolveOwnedTenantWhatsAppDestination(
        route,
        cfg?.destino,
      );
      if (!destino) {
        resultado.failures.push(`${paymentId}: destino não pertence à escola`);
        continue;
      }

      // Claim atômico: o índice único (kind, subject_id, ref_date) é quem impede
      // o trigger e o cron de mandarem a mesma mensagem duas vezes.
      //
      // ⚠️ ref_date vem da RPC e é o created_at do pagamento, NÃO a data em que
      // ele foi pago. A Asaas dispara PAYMENT_CONFIRMED e depois PAYMENT_RECEIVED
      // para a mesma cobrança; paid_at muda entre os dois e a chave deixaria de
      // colidir, mandando o mesmo aviso duas vezes no grupo.
      const refDate = String(dados.ref_date ?? "").slice(0, 10) ||
        new Date().toISOString().slice(0, 10);
      const { error: claimError } = await supabase.from("automation_sent")
        .insert({
          kind: "PAYMENT_SPLIT",
          subject_id: paymentId,
          ref_date: refDate,
        });
      if (claimError) {
        resultado.skipped++;
        continue;
      }

      let enviou = false;
      try {
        const resp = await fetch(
          `${EVOLUTION_API_BASE}/${encodeURIComponent(route.instanceName)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", apikey: API_TOKEN },
            body: JSON.stringify({
              number: destino,
              text: montarMensagem(dados),
              delay: 800,
              linkPreview: false,
            }),
          },
        );
        enviou = resp.ok;
        if (!resp.ok) {
          resultado.failures.push(`${paymentId}: evolution ${resp.status}`);
        }
      } catch (sendError) {
        resultado.failures.push(
          `${paymentId}: envio falhou (${
            sendError instanceof Error ? sendError.name : "erro"
          })`,
        );
      }

      if (enviou) {
        resultado.sent++;
      } else {
        // Solta a marca para o sweep tentar de novo. Sem isso, uma queda da
        // Evolution engoliria o aviso em silêncio e para sempre.
        await supabase.from("automation_sent").delete()
          .eq("kind", "PAYMENT_SPLIT").eq("subject_id", paymentId)
          .eq("ref_date", refDate);
      }
    }

    return new Response(JSON.stringify(resultado), {
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
