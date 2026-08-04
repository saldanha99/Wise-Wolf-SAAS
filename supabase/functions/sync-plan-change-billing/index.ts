import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authorizeAutomation } from "../_shared/automation-auth.ts";

// Aplica na Asaas o valor do aditivo de plano que o ALUNO já assinou.
//
// Só entra aqui o que passou pela assinatura: a fila
// (`plan_changes_awaiting_billing`) devolve exclusivamente linhas com
// status = 'SIGNED'. Esta função NUNCA decide preço — ela repete na Asaas o
// número que o aluno assinou. Quem calcula é o banco.

let ASAAS_URL = Deno.env.get("ASAAS_API_URL") || "https://api-sandbox.asaas.com";
ASAAS_URL = ASAAS_URL.replace(/\/+$/, "")
  .replace(/\/v3$/, "")
  .replace(/\/api\/v3$/, "")
  .replace(/\/api$/, "");

const ASAAS_API_KEY = (
  Deno.env.get("ASAAS_API_KEY") || Deno.env.get("ASAAS_ACCESS_TOKEN") || ""
).trim();

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

function asaasPathPrefix() {
  return ASAAS_URL.includes("api-sandbox") || ASAAS_URL.includes("api.asaas.com")
    ? "/v3"
    : "/api/v3";
}

// A resposta de erro da Asaas vem em `errors[].description`. Guardar o texto cru
// inteiro encheria a coluna de ruído; guardar só "falhou" não deixa ninguém
// resolver. O meio do caminho é a descrição.
async function readAsaasError(res: Response): Promise<string> {
  try {
    const body = await res.json();
    const first = body?.errors?.[0];
    if (first?.description) return `${res.status}: ${first.description}`;
    return `${res.status}: ${JSON.stringify(body).slice(0, 200)}`;
  } catch {
    return `${res.status}: resposta ilegível da Asaas`;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Cron pela service key, ou diretor autenticado clicando "Sincronizar agora".
  const denied = await authorizeAutomation(req, corsHeaders, { allowAdmin: true });
  if (denied) return denied;

  if (!ASAAS_API_KEY) {
    // Sem chave não há o que tentar: devolver 503 e NÃO consumir tentativa da
    // fila (nada é marcado), senão um erro de configuração queimaria as 6
    // tentativas de todos os aditivos em fila.
    return json({ error: "asaas_key_missing" }, 503);
  }

  const url = Deno.env.get("SUPABASE_URL") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!url || !serviceKey) return json({ error: "config_unavailable" }, 503);

  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: queue, error: queueError } = await admin.rpc("plan_changes_awaiting_billing");
  if (queueError) return json({ error: "queue_unavailable", detail: queueError.message }, 500);

  const rows = (queue as Record<string, unknown>[]) || [];
  if (rows.length === 0) return json({ ok: true, processed: 0, synced: 0, failed: 0 });

  let synced = 0;
  let failed = 0;
  const results: Record<string, unknown>[] = [];

  for (const row of rows) {
    const id = String(row.id);
    const subscriptionId = String(row.asaas_subscription_id || "").trim();
    const value = Number(row.to_monthly_fee);

    if (!subscriptionId || !Number.isFinite(value) || value <= 0) {
      await admin.rpc("mark_plan_change_billing", {
        p_id: id,
        p_ok: false,
        p_error: "assinatura ou valor inválido no aditivo",
      });
      failed += 1;
      continue;
    }

    try {
      const res = await fetch(
        `${ASAAS_URL}${asaasPathPrefix()}/subscriptions/${encodeURIComponent(subscriptionId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", access_token: ASAAS_API_KEY },
          body: JSON.stringify({
            value,
            // Cobrança já gerada do mês em curso: decisão do diretor, gravada no
            // aditivo. Sem isto, o aluno assina o valor novo e recebe a fatura
            // velha — exatamente a divergência que este fluxo existe para matar.
            updatePendingPayments: row.update_pending_payments !== false,
          }),
        },
      );

      if (!res.ok) {
        const detail = await readAsaasError(res);
        await admin.rpc("mark_plan_change_billing", { p_id: id, p_ok: false, p_error: detail });
        failed += 1;
        results.push({ id, ok: false, detail });
        continue;
      }

      await admin.rpc("mark_plan_change_billing", { p_id: id, p_ok: true });
      synced += 1;
      results.push({ id, ok: true, value });
    } catch (err) {
      const detail = err instanceof Error ? err.message : "falha de rede com a Asaas";
      await admin.rpc("mark_plan_change_billing", { p_id: id, p_ok: false, p_error: detail });
      failed += 1;
      results.push({ id, ok: false, detail });
    }
  }

  // Log sem valor nem nome: os IDs bastam para investigar e nada de financeiro
  // do aluno vaza para o log da edge.
  console.log(`[sync-plan-change-billing] processados=${rows.length} ok=${synced} falhas=${failed}`);

  return json({ ok: true, processed: rows.length, synced, failed, results });
});
