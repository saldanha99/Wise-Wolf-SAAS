import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  authorizeScopedAutomation,
  scopeAutomationRows,
} from "../_shared/automation-auth.ts";
import {
  asaasSubscriptionPostconditionMismatchFields,
  type CanonicalAsaasMutationTarget,
  guardAsaasMutationTarget,
  revalidateCanonicalAsaasBinding,
} from "../_shared/asaas-mutation-guard.ts";
import {
  type AsaasSubscriptionMutationClaim,
  claimAsaasSubscriptionMutation,
  finishAsaasSubscriptionMutation,
  markAsaasSubscriptionMutationSubmitting,
} from "../_shared/asaas-subscription-mutation.ts";
import { ambiguousProviderMutationStatus } from "../_shared/student-provider-lifecycle.ts";
import {
  AsaasCapabilityFenceError,
  revalidateAsaasMutationCapability,
} from "../_shared/asaas-capability-fence.ts";
import {
  resolveAsaasIntegration,
  type ResolvedAsaasIntegration,
} from "../_shared/tenant-integration-broker.ts";

// Aplica na Asaas o valor do aditivo de plano que o ALUNO já assinou.
//
// Só entra aqui o que passou pela assinatura: a fila
// (`claim_plan_changes_awaiting_billing`) reserva exclusivamente linhas com
// status = 'SIGNED'. Esta função NUNCA decide preço — ela repete na Asaas o
// número que o aluno assinou. Quem calcula é o banco. Cada reserva carrega um
// fencing token: uma resposta atrasada nunca pode sobrescrever outro worker.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

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

function monetaryCents(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const cents = Math.round(numeric * 100);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Cron pela service key, ou diretor autenticado clicando "Sincronizar agora".
  const auth = await authorizeScopedAutomation(req, corsHeaders, {
    allowAdmin: true,
  });
  if (auth.ok === false) return auth.response;
  const admin = auth.context.admin;

  const { data: queue, error: queueError } = await admin.rpc(
    "claim_plan_changes_awaiting_billing",
    {
      p_tenant_id: auth.context.tenantId,
      p_limit: 50,
      p_lease_seconds: 900,
    },
  );
  if (queueError) {
    return json(
      { error: "queue_unavailable", detail: queueError.message },
      500,
    );
  }

  const rows = scopeAutomationRows<Record<string, unknown>>(
    queue,
    auth.context.tenantId,
  );
  if (rows.length === 0) {
    return json({ ok: true, processed: 0, synced: 0, failed: 0 });
  }

  let synced = 0;
  let failed = 0;
  let blocked = 0;
  const results: Record<string, unknown>[] = [];
  const finishPlanChangeClaim = async (
    id: string,
    claimToken: string,
    ok: boolean,
    error?: string,
  ): Promise<boolean> => {
    if (!id || !claimToken) return false;
    const { data: finishResult, error: markError } = await admin.rpc(
      "finish_plan_change_billing_claim",
      {
        p_id: id,
        p_claim_token: claimToken,
        p_ok: ok,
        ...(error ? { p_error: error } : {}),
      },
    );
    if (
      markError || !finishResult || typeof finishResult !== "object" ||
      finishResult.ok !== true
    ) {
      console.error("[sync-plan-change-billing] finish_claim_failed", {
        code: markError?.code || "claim_rejected",
      });
      return false;
    }
    return true;
  };
  const deferPlanChangeClaim = async (
    id: string,
    claimToken: string,
    reason: string,
  ): Promise<boolean> => {
    if (!id || !claimToken) return false;
    const { data, error } = await admin.rpc(
      "defer_plan_change_billing_claim",
      {
        p_id: id,
        p_claim_token: claimToken,
        p_reason: reason,
      },
    );
    return !error && data && typeof data === "object" && data.ok === true;
  };

  const groups = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const tenantId = String(row.tenant_id || "").trim();
    const id = String(row.id || "").trim();
    const claimToken = String(row.billing_claim_token || "").trim();
    if (!tenantId) {
      const released = await finishPlanChangeClaim(
        id,
        claimToken,
        false,
        "tenant ausente na fila de aditivos",
      );
      blocked += 1;
      if (!released) blocked += 1;
      results.push({
        id,
        ok: false,
        detail: released ? "tenant_scope_required" : "local_finish_failed",
      });
      continue;
    }
    groups.set(tenantId, [...(groups.get(tenantId) || []), row]);
  }

  for (const [tenantId, tenantRows] of groups) {
    let integration: Awaited<ReturnType<typeof resolveAsaasIntegration>>;
    try {
      integration = await resolveAsaasIntegration(
        admin,
        tenantId,
        "subscription.update",
      );
    } catch {
      blocked += tenantRows.length;
      for (const row of tenantRows) {
        const id = String(row.id || "").trim();
        const claimToken = String(row.billing_claim_token || "").trim();
        const released = await finishPlanChangeClaim(
          id,
          claimToken,
          false,
          "integracao Asaas indisponivel para o tenant",
        );
        if (!released) blocked += 1;
        results.push({
          id,
          ok: false,
          detail: released ? "integration_unavailable" : "local_finish_failed",
        });
      }
      continue;
    }

    for (const row of tenantRows) {
      const id = String(row.id);
      const claimToken = String(row.billing_claim_token || "").trim();
      const studentId = String(row.student_id || "").trim();
      const subscriptionId = String(row.asaas_subscription_id || "").trim();
      const value = Number(row.to_monthly_fee);

      if (
        !studentId || !subscriptionId || !Number.isFinite(value) || value <= 0
      ) {
        const marked = await finishPlanChangeClaim(
          id,
          claimToken,
          false,
          "assinatura ou valor inválido no aditivo",
        );
        failed += 1;
        if (!marked) blocked += 1;
        results.push({
          id,
          ok: false,
          detail: marked ? "invalid_billing_data" : "local_finish_failed",
        });
        continue;
      }

      let mutation: AsaasSubscriptionMutationClaim | null = null;
      let providerSubmitStarted = false;
      try {
        const { data: student, error: studentError } = await admin.from(
          "profiles",
        ).select(
          "id,tenant_id,role,asaas_customer_id,subscription_id",
        ).eq("id", studentId).eq("tenant_id", tenantId).eq(
          "role",
          "STUDENT",
        ).maybeSingle();
        if (studentError || !student) {
          const marked = await finishPlanChangeClaim(
            id,
            claimToken,
            false,
            "vinculo canonico do aluno indisponivel",
          );
          blocked += 1;
          if (!marked) blocked += 1;
          results.push({
            id,
            ok: false,
            detail: marked
              ? "canonical_binding_unavailable"
              : "local_finish_failed",
          });
          continue;
        }

        const mutationTarget: CanonicalAsaasMutationTarget = {
          tenantId,
          studentId,
          resource: "subscription",
          entityId: subscriptionId,
          customerId: String(student.asaas_customer_id || "").trim(),
          subscriptionId: String(student.subscription_id || "").trim() ||
            null,
          subscriptionMatch: "entity_id",
        };
        const guard = await guardAsaasMutationTarget({
          admin,
          baseUrl: integration.baseUrl,
          apiKey: integration.apiKey,
          operation: "sync_plan_change_subscription_update",
          target: mutationTarget,
        });
        const desiredValueCents = monetaryCents(value);
        const currentValueCents = guard.ok
          ? monetaryCents(guard.entity.value)
          : null;
        if (!guard.ok || !desiredValueCents || !currentValueCents) {
          const marked = await finishPlanChangeClaim(
            id,
            claimToken,
            false,
            "identidade ou valor da assinatura requer revisao",
          );
          blocked += 1;
          if (!marked) blocked += 1;
          results.push({
            id,
            ok: false,
            detail: marked
              ? "provider_identity_unverified"
              : "local_finish_failed",
          });
          continue;
        }
        const normalizedValue = desiredValueCents / 100;
        const updatePendingPayments = row.update_pending_payments !== false;
        mutation = await claimAsaasSubscriptionMutation(admin, {
          tenantId,
          studentId,
          customerId: mutationTarget.customerId,
          subscriptionId,
          mutationKind: "PLAN_VALUE",
          intentKey: `plan-change:${id}`,
          expectedState: { valueCents: currentValueCents },
          desiredState: { valueCents: desiredValueCents },
          integration,
          mutationPayload: {
            valueCents: desiredValueCents,
            updatePendingPayments,
          },
          requestedBy: auth.context.userId,
        });

        if (mutation.action === "IN_PROGRESS") {
          const deferred = await deferPlanChangeClaim(
            id,
            claimToken,
            "mutacao de assinatura em andamento",
          );
          blocked += 1;
          if (!deferred) blocked += 1;
          results.push({
            id,
            ok: false,
            detail: deferred ? "mutation_in_progress" : "local_defer_failed",
          });
          continue;
        }
        if (mutation.action === "REVIEW_REQUIRED" || !mutation.ok) {
          const transientConflict = mutation.reason ===
            "subscription_mutation_in_flight";
          const marked = transientConflict
            ? await deferPlanChangeClaim(
              id,
              claimToken,
              mutation.reason || "subscription_mutation_in_flight",
            )
            : await finishPlanChangeClaim(
              id,
              claimToken,
              false,
              mutation.reason || "mutacao de assinatura requer revisao",
            );
          blocked += 1;
          if (!marked) blocked += 1;
          results.push({
            id,
            ok: false,
            detail: marked
              ? "subscription_mutation_requires_review"
              : "local_finish_failed",
          });
          continue;
        }

        if (
          mutation.action === "ALREADY_SUCCEEDED" ||
          mutation.action === "RECONCILE_REQUIRED"
        ) {
          if (currentValueCents !== desiredValueCents) {
            blocked += 1;
            results.push({
              id,
              ok: false,
              detail: "provider_reconciliation_pending",
            });
            continue;
          }
          if (
            mutation.action === "RECONCILE_REQUIRED" &&
            !await finishAsaasSubscriptionMutation(admin, mutation, {
              status: "SUCCEEDED",
              observedState: { valueCents: desiredValueCents },
              providerHttpStatus: guard.providerStatus,
            })
          ) {
            blocked += 1;
            results.push({
              id,
              ok: false,
              detail: "mutation_reconciliation_finish_failed",
            });
            continue;
          }
          if (await finishPlanChangeClaim(id, claimToken, true)) {
            synced += 1;
            results.push({ id, ok: true, value: normalizedValue });
          } else {
            blocked += 1;
            results.push({ id, ok: false, detail: "local_finish_failed" });
          }
          continue;
        }

        if (currentValueCents === desiredValueCents) {
          const finished = await finishAsaasSubscriptionMutation(
            admin,
            mutation,
            {
              status: "SUCCEEDED",
              observedState: { valueCents: desiredValueCents },
              providerHttpStatus: guard.providerStatus,
            },
          );
          if (finished && await finishPlanChangeClaim(id, claimToken, true)) {
            synced += 1;
            results.push({ id, ok: true, value: normalizedValue });
          } else {
            blocked += 1;
            results.push({ id, ok: false, detail: "local_finish_failed" });
          }
          continue;
        }

        if (
          !(await revalidateCanonicalAsaasBinding({
            admin,
            operation: "sync_plan_change_subscription_update",
            target: mutationTarget,
          }))
        ) {
          await finishAsaasSubscriptionMutation(admin, mutation, {
            status: "BLOCKED",
            error: "canonical_binding_changed_before_provider_submit",
          });
          const marked = await finishPlanChangeClaim(
            id,
            claimToken,
            false,
            "vinculo canonico mudou antes da atualizacao",
          );
          blocked += 1;
          if (!marked) blocked += 1;
          results.push({
            id,
            ok: false,
            detail: marked
              ? "canonical_binding_changed"
              : "local_finish_failed",
          });
          continue;
        }
        if (!await markAsaasSubscriptionMutationSubmitting(admin, mutation)) {
          blocked += 1;
          results.push({ id, ok: false, detail: "mutation_claim_lost" });
          continue;
        }

        let submitIntegration: ResolvedAsaasIntegration;
        try {
          submitIntegration = await revalidateAsaasMutationCapability(
            admin,
            {
              tenantId,
              purpose: "subscription.update",
              expected: integration,
            },
          );
        } catch (error) {
          const unavailable = error instanceof AsaasCapabilityFenceError &&
            error.failure === "UNAVAILABLE";
          const detail = unavailable
            ? "subscription_capability_unavailable_before_submit"
            : "subscription_capability_changed_before_submit";
          const operationFinished = await finishAsaasSubscriptionMutation(
            admin,
            mutation,
            {
              status: unavailable ? "FAILED" : "BLOCKED",
              error: detail,
            },
          );
          const marked = operationFinished && await finishPlanChangeClaim(
            id,
            claimToken,
            false,
            detail,
          );
          blocked += 1;
          if (!marked) blocked += 1;
          results.push({
            id,
            ok: false,
            detail: marked ? detail : "local_finish_failed",
          });
          continue;
        }

        let res: Response;
        providerSubmitStarted = true;
        try {
          res = await fetch(
            `${submitIntegration.baseUrl}/subscriptions/${
              encodeURIComponent(subscriptionId)
            }`,
            {
              method: "PUT",
              headers: {
                "Content-Type": "application/json",
                access_token: submitIntegration.apiKey,
              },
              body: JSON.stringify({
                value: normalizedValue,
                updatePendingPayments,
              }),
              signal: AbortSignal.timeout(15_000),
            },
          );
        } catch {
          await finishAsaasSubscriptionMutation(admin, mutation, {
            status: "UNKNOWN",
            error: "provider_response_unavailable",
          });
          blocked += 1;
          results.push({
            id,
            ok: false,
            detail: "provider_reconciliation_required",
          });
          continue;
        }

        if (!res.ok && !ambiguousProviderMutationStatus(res.status)) {
          const detail = await readAsaasError(res);
          const operationFinished = await finishAsaasSubscriptionMutation(
            admin,
            mutation,
            {
              status: "FAILED",
              providerHttpStatus: res.status,
              error: detail,
            },
          );
          const marked = operationFinished && await finishPlanChangeClaim(
            id,
            claimToken,
            false,
            detail,
          );
          failed += 1;
          if (!marked) blocked += 1;
          results.push({
            id,
            ok: false,
            detail: marked ? detail : "local_finish_failed",
          });
          continue;
        }

        const postcondition = await guardAsaasMutationTarget({
          admin,
          baseUrl: submitIntegration.baseUrl,
          apiKey: submitIntegration.apiKey,
          operation: "sync_plan_change_subscription_postcondition",
          target: mutationTarget,
        });
        const postconditionMismatches = postcondition.ok === true
          ? asaasSubscriptionPostconditionMismatchFields(
            postcondition.entity,
            { value: normalizedValue },
          )
          : [postcondition.code];
        if (postcondition.ok === false || postconditionMismatches.length > 0) {
          await finishAsaasSubscriptionMutation(admin, mutation, {
            status: "UNKNOWN",
            providerHttpStatus: res.status,
            error: "provider_postcondition_unverified",
          });
          blocked += 1;
          results.push({
            id,
            ok: false,
            detail: "provider_postcondition_unverified",
          });
          continue;
        }
        if (
          !await finishAsaasSubscriptionMutation(admin, mutation, {
            status: "SUCCEEDED",
            observedState: { valueCents: desiredValueCents },
            providerHttpStatus: res.status,
          })
        ) {
          blocked += 1;
          results.push({
            id,
            ok: false,
            detail: "mutation_finish_failed",
          });
          continue;
        }

        if (await finishPlanChangeClaim(id, claimToken, true)) {
          synced += 1;
          results.push({ id, ok: true, value: normalizedValue });
        } else {
          blocked += 1;
          results.push({ id, ok: false, detail: "local_finish_failed" });
        }
      } catch (err) {
        const detail = err instanceof Error
          ? err.message
          : "falha inesperada na sincronizacao";
        if (mutation && providerSubmitStarted) {
          await finishAsaasSubscriptionMutation(admin, mutation, {
            status: "UNKNOWN",
            error: detail,
          });
        } else if (mutation) {
          await finishAsaasSubscriptionMutation(admin, mutation, {
            status: "BLOCKED",
            error: detail,
          });
          await finishPlanChangeClaim(id, claimToken, false, detail);
        } else {
          await deferPlanChangeClaim(id, claimToken, detail);
        }
        blocked += 1;
        results.push({ id, ok: false, detail: "sync_requires_review" });
      }
    }
  }

  // Log sem valor nem nome: os IDs bastam para investigar e nada de financeiro
  // do aluno vaza para o log da edge.
  console.log(
    `[sync-plan-change-billing] processados=${rows.length} ok=${synced} falhas=${failed} bloqueados=${blocked}`,
  );

  return json(
    {
      ok: blocked === 0 && failed === 0,
      processed: rows.length,
      synced,
      failed,
      blocked,
      results,
    },
    blocked === 0 && failed === 0 ? 200 : 503,
  );
});
