import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authorizeAutomation } from "../_shared/automation-auth.ts";

// Espelha para o banco o estado da assinatura na Asaas.
//
// POR QUE EXISTE: o fim do contrato do aluno só existe na Asaas, no campo
// `endDate` da assinatura, e nada na plataforma lia isso. `profiles` tem
// `start_date` e `contract_accepted`, mas NENHUMA data de término;
// `fidelity_plan` é texto livre ("Personalizado / Manual" em 22 de 55 alunos,
// nulo em 29) e não serve como data.
//
// Consequência medida em 07/08/2026: duas assinaturas já tinham expirado sem
// ninguém saber. Uma delas é de uma aluna que pagou 6 de 6 faturas sem atraso —
// ela simplesmente deixaria de ser cobrada em outubro, sem erro e sem alerta.
//
// ⚠️ ESTA FUNÇÃO SÓ LÊ DA ASAAS. Ela não cria, não altera e não cancela
// assinatura: renovar contrato é decisão comercial. O papel dela é fazer o
// sistema ENXERGAR o que a Asaas já sabe.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const ASAAS_KEY = Deno.env.get("ASAAS_API_KEY") || "";
const ASAAS_URL = (Deno.env.get("ASAAS_API_URL") || "https://api.asaas.com/v3").replace(/\/+$/, "");

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const authError = await authorizeAutomation(req, corsHeaders);
  if (authError) return authError;

  // Sem chave a função para aqui, sem tocar em nada. Gravar "assinatura não
  // encontrada" por falta de credencial faria o painel acusar cancelamento em
  // massa por um erro de configuração.
  if (!ASAAS_KEY) {
    return new Response(JSON.stringify({ error: "ASAAS_API_KEY ausente" }), {
      status: 503,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );

    const { data: alunos, error } = await supabase
      .from("profiles")
      .select("id, subscription_id")
      .eq("role", "STUDENT")
      .not("subscription_id", "is", null)
      .neq("subscription_id", "")
      .limit(500);

    if (error) throw error;

    let atualizados = 0;
    let falhas = 0;
    const motivos: string[] = [];

    for (const a of alunos || []) {
      try {
        const resp = await fetch(`${ASAAS_URL}/subscriptions/${encodeURIComponent(a.subscription_id)}`, {
          headers: { access_token: ASAAS_KEY },
        });
        const body = await resp.json().catch(() => ({}));

        if (!resp.ok || body?.errors) {
          // 404 = assinatura sumiu da Asaas. É informação real e vira estado,
          // porque some do faturamento do mesmo jeito que uma expirada.
          if (resp.status === 404) {
            await supabase.from("profiles").update({
              asaas_subscription_status: "NOT_FOUND",
              asaas_subscription_end_date: null,
              asaas_subscription_synced_at: new Date().toISOString(),
            }).eq("id", a.id);
            atualizados++;
            continue;
          }
          falhas++;
          if (motivos.length < 10) motivos.push(`${a.subscription_id}: HTTP ${resp.status}`);
          continue;
        }

        await supabase.from("profiles").update({
          asaas_subscription_status: String(body.status || "").toUpperCase() || null,
          asaas_subscription_end_date: body.endDate || null,
          asaas_subscription_synced_at: new Date().toISOString(),
        }).eq("id", a.id);
        atualizados++;
      } catch (e) {
        falhas++;
        if (motivos.length < 10) motivos.push(`${a.subscription_id}: ${(e as Error).message}`);
      }
    }

    return new Response(JSON.stringify({ ok: true, atualizados, falhas, motivos }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
