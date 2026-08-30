import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.93.3";
import { guardAsaasMutationTarget } from "../_shared/asaas-mutation-guard.ts";
import { authorizeScopedAutomation } from "../_shared/automation-auth.ts";
import { resolveAsaasIntegration } from "../_shared/tenant-integration-broker.ts";

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
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

type SubscriptionProfile = {
  id: string;
  tenant_id: string | null;
  asaas_customer_id: string | null;
  subscription_id: string;
};

async function fetchAllSubscriptionProfiles(
  supabase: SupabaseClient,
): Promise<SubscriptionProfile[]> {
  const students: SubscriptionProfile[] = [];
  let afterId: string | null = null;

  for (let page = 0; page < 10_000; page++) {
    let query = supabase
      .from("profiles")
      .select("id, tenant_id, asaas_customer_id, subscription_id")
      .eq("role", "STUDENT")
      .not("subscription_id", "is", null)
      .neq("subscription_id", "")
      .order("id", { ascending: true })
      .limit(1_000);
    if (afterId) query = query.gt("id", afterId);

    const { data, error } = await query;
    if (error) throw error;
    const rows = (data || []) as SubscriptionProfile[];
    students.push(...rows);
    if (rows.length < 1_000) return students;

    const nextId = rows.at(-1)?.id || null;
    if (!nextId || nextId === afterId) {
      throw new Error("subscription_profile_cursor_stalled");
    }
    afterId = nextId;
  }

  throw new Error("subscription_profile_page_limit");
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  const auth = await authorizeScopedAutomation(req, corsHeaders);
  if (auth.ok === false) return auth.response;

  try {
    const supabase = auth.context.admin;

    const students = await fetchAllSubscriptionProfiles(supabase);
    const total = students.length;
    let atualizados = 0;
    let naoEncontrados = 0;
    let falhas = 0;
    let bloqueados = 0;
    const motivos: string[] = [];
    const groups = new Map<string, SubscriptionProfile[]>();

    for (const a of students) {
      const tenantId = String(a.tenant_id || "").trim();
      if (!tenantId) {
        bloqueados++;
        continue;
      }
      groups.set(tenantId, [...(groups.get(tenantId) || []), a]);
    }

    for (const [tenantId, tenantStudents] of groups) {
      let integration: Awaited<ReturnType<typeof resolveAsaasIntegration>>;
      try {
        integration = await resolveAsaasIntegration(
          supabase,
          tenantId,
          "subscription.read",
        );
      } catch {
        bloqueados += tenantStudents.length;
        if (motivos.length < 10) {
          motivos.push(`${tenantId}: integration_unavailable`);
        }
        continue;
      }

      // Primeiro lê a escola inteira, depois grava. Um endpoint/segredo errado
      // em um tenant não pode virar cancelamento em massa nem impedir os demais.
      const lidos: {
        id: string;
        subscriptionId: string;
        customerId: string;
        status: string | null;
        endDate: string | null;
      }[] = [];
      let tenantNotFound = 0;
      for (const student of tenantStudents) {
        try {
          const guard = await guardAsaasMutationTarget({
            admin: supabase,
            baseUrl: integration.baseUrl,
            apiKey: integration.apiKey,
            operation: "sync_subscription_status_read",
            target: {
              tenantId,
              studentId: student.id,
              resource: "subscription",
              entityId: student.subscription_id,
              customerId: String(student.asaas_customer_id || "").trim(),
              subscriptionId: student.subscription_id,
              subscriptionMatch: "entity_id",
            },
          });
          if (guard.ok === false && guard.code === "NOT_FOUND") {
            tenantNotFound++;
            lidos.push({
              id: student.id,
              subscriptionId: student.subscription_id,
              customerId: String(student.asaas_customer_id || "").trim(),
              status: "NOT_FOUND",
              endDate: null,
            });
          } else if (guard.ok === false) {
            if (
              guard.code === "IDENTITY_MISMATCH" ||
              guard.code === "CANONICAL_BINDING_INVALID" ||
              guard.code === "REFERENCE_UNAVAILABLE"
            ) {
              bloqueados++;
            } else {
              falhas++;
            }
            if (motivos.length < 10) {
              motivos.push(
                `${student.subscription_id}: provider_identity_unverified`,
              );
            }
          } else if (guard.entity.errors) {
            falhas++;
            if (motivos.length < 10) {
              motivos.push(`${student.subscription_id}: invalid_response`);
            }
          } else {
            lidos.push({
              id: student.id,
              subscriptionId: student.subscription_id,
              customerId: String(student.asaas_customer_id || "").trim(),
              status: String(guard.entity.status || "").toUpperCase() || null,
              endDate: typeof guard.entity.endDate === "string"
                ? guard.entity.endDate
                : null,
            });
          }
        } catch (e) {
          falhas++;
          if (motivos.length < 10) {
            motivos.push(`${student.subscription_id}: ${(e as Error).message}`);
          }
        }
      }

      if (
        tenantStudents.length > 0 &&
        tenantNotFound === tenantStudents.length
      ) {
        bloqueados += tenantStudents.length;
        if (motivos.length < 10) {
          motivos.push(`${tenantId}: all_subscriptions_404`);
        }
        continue;
      }

      const agora = new Date().toISOString();
      for (const result of lidos) {
        const { data: updated, error: updateError } = await supabase.from(
          "profiles",
        ).update({
          asaas_subscription_status: result.status,
          asaas_subscription_end_date: result.endDate,
          asaas_subscription_synced_at: agora,
        }).eq("id", result.id)
          .eq("tenant_id", tenantId)
          .eq("subscription_id", result.subscriptionId)
          .eq("asaas_customer_id", result.customerId)
          .eq("role", "STUDENT")
          .select("id")
          .maybeSingle();
        if (updateError || !updated) {
          falhas++;
          if (motivos.length < 10) {
            motivos.push(`${result.id}: local_update_failed`);
          }
        } else {
          atualizados++;
          if (result.status === "NOT_FOUND") naoEncontrados++;
        }
      }
    }

    console.log(
      `[sync-subscription-status] inspecionados=${total} atualizados=${atualizados} falhas=${falhas} bloqueados=${bloqueados}`,
    );

    return new Response(
      JSON.stringify({
        ok: bloqueados === 0 && falhas === 0,
        inspecionados: total,
        atualizados,
        nao_encontrados: naoEncontrados,
        falhas,
        bloqueados,
        motivos,
      }),
      {
        status: bloqueados === 0 && falhas === 0 ? 200 : 503,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
