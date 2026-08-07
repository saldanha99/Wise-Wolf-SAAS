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
const ASAAS_URL = (Deno.env.get("ASAAS_API_URL") || "https://api-sandbox.asaas.com").replace(/\/+$/, "");

// ⚠️ `ASAAS_API_URL` no runtime é a BASE, sem `/v3` — o prefixo é montado aqui.
// A primeira versão desta função assumiu que a env já trazia `/v3` (é o que está
// escrito no arquivo .env) e montou `https://api.asaas.com/subscriptions/...`,
// levando 404 nas 25 assinaturas. Mesma convenção de create-asaas-subscription,
// create-wolfie-topup e sync-plan-change-billing.
function asaasPathPrefix() {
  return ASAAS_URL.includes("api-sandbox") || ASAAS_URL.includes("api.asaas.com")
    ? "/v3"
    : "/api/v3";
}

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

    const prefix = asaasPathPrefix();
    const total = (alunos || []).length;

    // Primeiro LÊ tudo, depois GRAVA. A separação é a trava contra o incidente
    // de 07/08/2026: uma URL montada errada devolveu 404 nas 25 assinaturas e a
    // versão anterior gravou "NOT_FOUND" em todas, fazendo o painel anunciar 20
    // contratos encerrados que não existiam. Falha sistêmica não pode virar 25
    // fatos de negócio.
    const lidos: { id: string; status: string | null; endDate: string | null }[] = [];
    let naoEncontrados = 0;
    let falhas = 0;
    const motivos: string[] = [];

    for (const a of alunos || []) {
      try {
        const resp = await fetch(
          `${ASAAS_URL}${prefix}/subscriptions/${encodeURIComponent(a.subscription_id)}`,
          { headers: { access_token: ASAAS_KEY } },
        );
        const body = await resp.json().catch(() => ({}));

        if (resp.status === 404) {
          naoEncontrados++;
          lidos.push({ id: a.id, status: "NOT_FOUND", endDate: null });
          continue;
        }
        if (!resp.ok || body?.errors) {
          falhas++;
          if (motivos.length < 10) motivos.push(`${a.subscription_id}: HTTP ${resp.status}`);
          continue;
        }

        lidos.push({
          id: a.id,
          status: String(body.status || "").toUpperCase() || null,
          endDate: body.endDate || null,
        });
      } catch (e) {
        falhas++;
        if (motivos.length < 10) motivos.push(`${a.subscription_id}: ${(e as Error).message}`);
      }
    }

    // Se TODAS deram 404, o problema é configuração (URL, chave, conta trocada),
    // não 25 alunos que cancelaram no mesmo dia. Aborta sem gravar nada.
    if (total > 0 && naoEncontrados === total) {
      return new Response(JSON.stringify({
        ok: false,
        error: "todas as assinaturas retornaram 404 — provável erro de configuração (URL/chave). Nada foi gravado.",
        inspecionados: total,
      }), { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    let atualizados = 0;
    const agora = new Date().toISOString();
    for (const r of lidos) {
      await supabase.from("profiles").update({
        asaas_subscription_status: r.status,
        asaas_subscription_end_date: r.endDate,
        asaas_subscription_synced_at: agora,
      }).eq("id", r.id);
      atualizados++;
    }

    return new Response(JSON.stringify({
      ok: true, inspecionados: total, atualizados, nao_encontrados: naoEncontrados, falhas, motivos,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
