/// <reference lib="deno.ns" />

/**
 * Aviso de rateio no grupo da direção, no ato em que o pagamento entra.
 *
 * Dois caminhos, a mesma outbox transacional:
 *   { management_notification_payment_id } — nudge imediato via pg_net
 *   { sweep: true } — cron pega toda intenção pendente, sem janela de idade
 *
 * ⚠️ O destino é o grupo do relatório gerencial (dre_report_settings.destino).
 * Não existe segunda lista de grupos de propósito: duas listas saem de sincronia
 * e o aviso passa a ir para um grupo que o diretor achou que tinha desligado.
 *
 * O POST irreversível usa claim -> PREPARED -> autorização SUBMITTING ->
 * resultado durável. UNKNOWN e FAILED exigem revisão e jamais voltam à fila
 * automática. Um HTTP 2xx fica apenas aceito; entrega exige receipt do grupo.
 * automation_sent permanece apenas como marcador legado de compatibilidade.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { authorizeScopedAutomation } from "../_shared/automation-auth.ts";
import {
  sendWhatsTextDetailed,
  sendWhatsTextToResolvedDestinationDetailed,
} from "../_shared/evolution-send.ts";
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
  authorizeManagementPaymentNotificationSubmission,
  beginManagementPaymentNotificationSubmission,
  claimManagementPaymentNotification,
  finishManagementPaymentNotification,
  loadManagementPaymentNotificationSource,
  managementPaymentNotificationFinish,
} from "./outbound-fence.ts";
import {
  applyMonthlyPaymentClosureDeliveryResult,
  claimManagementGroupMessage,
  finishManagementGroupMessage,
  managementGroupMessageFinish,
  markManagementGroupMessageSubmitting,
} from "./management-outbound-fence.ts";
import {
  monthlyPaymentCloseMessage,
  paymentReceivedManagementMessage,
} from "./management-summary.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Só o cron/trigger dispara. O painel usa a RPC de prévia, que não envia nada —
  // assim nenhum caminho de UI consegue inundar o grupo por acidente.
  const auth = await authorizeScopedAutomation(req, corsHeaders);
  if (auth.ok === false) return auth.response;
  const supabase = auth.context.admin;

  const resultado = {
    accepted: 0,
    sent: 0,
    skipped: 0,
    failures: [] as string[],
  };

  try {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;

    let targets: Array<{ paymentId: string; tenantId?: string }> = [];
    const explicitPaymentId = [
      body.management_notification_payment_id,
      body.payment_id,
      body.management_payment_id,
    ].find((value) => typeof value === "string" && value.trim());
    if (typeof explicitPaymentId === "string") {
      targets = [{ paymentId: explicitPaymentId.trim() }];
    } else if (body.sweep === true) {
      const pending = await supabase.rpc(
        "management_payment_notification_pending",
        { p_limit: 100 },
      );
      if (pending.error) {
        console.error("management payment notification pending failed", {
          code: String(
            (pending.error as { code?: unknown } | null)?.code ?? "unknown",
          ),
        });
        return new Response(JSON.stringify({ error: "pending_unavailable" }), {
          status: 503,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      targets = ((pending.data ?? []) as Record<string, unknown>[])
        .map((row) => ({
          paymentId: String(row.payment_id ?? ""),
          tenantId: String(row.tenant_id ?? ""),
        }))
        .filter((target) => target.paymentId && target.tenantId);
    } else {
      return new Response(JSON.stringify({ error: "payment_id_ou_sweep" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const uniqueTargets = [
      ...new Map(targets.map((target) => [target.paymentId, target])).values(),
    ];
    for (const target of uniqueTargets) {
      await processManagementPaymentNotification(
        supabase,
        target,
        resultado,
      );
    }

    // O mesmo sweep que já reconcilia avisos individuais mantém os dois meses
    // relevantes atualizados. A competência corrente nunca fecha antes de seu
    // último dia; o mês anterior só envia se não houver nenhuma ambiguidade.
    await processMonthlyPaymentClosures(supabase, resultado);

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

async function resolveManagementRoute(
  supabase: any,
  tenantId: string,
): Promise<
  {
    route: NonNullable<Awaited<ReturnType<typeof loadTenantWhatsAppRoute>>>;
    destination: string;
    integrationId: string;
    integrationVersion: number;
  } | null
> {
  const { data: cfg, error: cfgError } = await supabase
    .from("dre_report_settings")
    .select("destino,is_active")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (cfgError || cfg?.is_active !== true) return null;
  const route = await loadTenantWhatsAppRoute(
    supabase,
    tenantId,
    "general",
    { requireDeliveryReceipts: true },
  );
  if (!route) return null;
  const destination = resolveTenantConfiguredWhatsAppDestination(
    route,
    cfg.destino,
  );
  if (!destination) return null;
  const { data: instance, error: instanceError } = await supabase
    .from("whatsapp_instances")
    .select("integration_id,integration_version")
    .eq("tenant_id", tenantId)
    .eq("instance_name", route.instanceName)
    .maybeSingle();
  const integrationId = String(instance?.integration_id || "");
  const integrationVersion = Number(instance?.integration_version || 0);
  if (
    instanceError || !integrationId ||
    !Number.isSafeInteger(integrationVersion) || integrationVersion <= 0
  ) return null;
  return { route, destination, integrationId, integrationVersion };
}

async function resolveManagementDelivery(
  supabase: any,
  tenantId: string,
): Promise<
  {
    route: NonNullable<Awaited<ReturnType<typeof loadTenantWhatsAppRoute>>>;
    destination: string;
    integration: ResolvedEvolutionIntegration;
  } | null
> {
  const route = await resolveManagementRoute(supabase, tenantId);
  if (!route) return null;
  try {
    const integration = await resolveEvolutionIntegration(
      supabase,
      tenantId,
      "message.send_text",
    );
    if (
      integration.integrationId !== route.integrationId ||
      integration.version !== route.integrationVersion
    ) return null;
    return {
      route: route.route,
      destination: route.destination,
      integration,
    };
  } catch {
    return null;
  }
}

async function processManagementPaymentNotification(
  supabase: any,
  target: { paymentId: string; tenantId?: string },
  result: {
    accepted: number;
    sent: number;
    skipped: number;
    failures: string[];
  },
): Promise<void> {
  const paymentId = target.paymentId;
  let tenantId = String(target.tenantId || "");
  if (!tenantId) {
    const { data: intent, error: intentError } = await supabase
      .from("management_payment_notification_outbox")
      .select("tenant_id")
      .eq("payment_id", paymentId)
      .maybeSingle();
    if (intentError || !intent?.tenant_id) {
      result.failures.push(
        `${paymentId}: intenção financeira durável não encontrada`,
      );
      return;
    }
    tenantId = String(intent.tenant_id);
  }

  let claim;
  try {
    claim = await claimManagementPaymentNotification(supabase, {
      tenantId,
      paymentId,
    });
  } catch {
    result.failures.push(`${paymentId}: trava financeira indisponível`);
    return;
  }
  if (claim.action === "ALREADY_FINAL") {
    const status = String(claim.status || "").toUpperCase();
    if (["UNKNOWN", "FAILED", "SUBMITTING"].includes(status)) {
      result.failures.push(
        `${paymentId}: resultado durável ${status} requer revisão`,
      );
    }
    result.skipped++;
    return;
  }
  if (claim.action !== "SUBMIT_ONCE") {
    if (claim.action === "REVIEW_REQUIRED") {
      result.failures.push(
        `${paymentId}: ${claim.reason || "escopo financeiro inválido"}`,
      );
    } else {
      result.skipped++;
    }
    return;
  }

  const notificationKind = String(claim.notification_kind || "");
  let messageBody = "";
  let breakdown: Record<string, unknown> | null = null;
  let sourceSnapshot: Record<string, unknown>;
  try {
    sourceSnapshot = await loadManagementPaymentNotificationSource(supabase, {
      tenantId,
      paymentId,
      notificationKind: notificationKind as
        | "PAYMENT_SPLIT"
        | "PAYMENT_RECEIVED",
    });
  } catch {
    result.failures.push(`${paymentId}: fonte financeira indisponível`);
    return;
  }
  if (sourceSnapshot.is_test_fixture === true) {
    result.skipped++;
    return;
  }

  if (notificationKind === "PAYMENT_SPLIT") {
    breakdown = sourceSnapshot;
    if (breakdown.is_active !== true) {
      result.failures.push(`${paymentId}: regra de rateio mudou`);
      return;
    }
    messageBody = montarMensagem(breakdown);
  } else if (notificationKind === "PAYMENT_RECEIVED") {
    messageBody = paymentReceivedManagementMessage(sourceSnapshot);
  } else {
    result.failures.push(`${paymentId}: tipo de aviso financeiro inválido`);
    return;
  }

  const delivery = await resolveManagementRoute(supabase, tenantId);
  if (!delivery) {
    result.failures.push(`${paymentId}: canal de gestão indisponível`);
    return;
  }

  let submission;
  try {
    submission = await beginManagementPaymentNotificationSubmission(
      supabase,
      claim,
      {
        expectedDestination: delivery.destination,
        providerDestination: delivery.destination,
        providerInstanceName: delivery.route.instanceName,
        integrationId: delivery.integrationId,
        integrationVersion: delivery.integrationVersion,
        sourceSnapshot,
        messageBody,
      },
    );
  } catch {
    result.failures.push(`${paymentId}: autorização final indisponível`);
    return;
  }
  if (submission.action !== "PREPARED" || submission.ok !== true) {
    if (submission.action === "SUPPRESSED") result.skipped++;
    else {
      result.failures.push(
        `${paymentId}: ${submission.reason || "autorização final recusada"}`,
      );
    }
    return;
  }

  // Credentials/endpoints are resolved only after the business payload has
  // been frozen as PREPARED. A second database fence validates their current
  // integration binding and BYOK secret fingerprints, then returns the exact
  // immutable payload for the sole provider POST.
  let finalIntegration: ResolvedEvolutionIntegration;
  try {
    finalIntegration = await resolveEvolutionIntegration(
      supabase,
      tenantId,
      "message.send_text",
    );
  } catch {
    result.failures.push(`${paymentId}: integração final indisponível`);
    return;
  }

  const [providerEndpointHash, providerCredentialHash] = await Promise.all([
    sha256Hex(finalIntegration.baseUrl),
    sha256Hex(finalIntegration.apiKey),
  ]);

  let authorization;
  try {
    authorization = await authorizeManagementPaymentNotificationSubmission(
      supabase,
      claim,
      {
        integrationId: finalIntegration.integrationId,
        integrationVersion: finalIntegration.version,
        providerEndpointHash,
        providerCredentialHash,
      },
    );
  } catch {
    result.failures.push(`${paymentId}: autorização do provedor indisponível`);
    return;
  }
  if (authorization.action !== "SUBMITTING" || authorization.ok !== true) {
    if (authorization.action === "SUPPRESSED") result.skipped++;
    else {
      result.failures.push(
        `${paymentId}: ${
          authorization.reason || "autorização do provedor recusada"
        }`,
      );
    }
    return;
  }

  // No lookup, RPC or mutable read may be inserted between this fence and the
  // single POST. The provider receives exactly the sealed database snapshot.
  const providerResult = await sendWhatsTextToResolvedDestinationDetailed({
    base: finalIntegration.baseUrl,
    keys: [finalIntegration.apiKey],
    instance: String(authorization.provider_instance_name),
    to: String(authorization.provider_destination),
    text: String(authorization.message_body),
    delayMs: 800,
  });
  const finish = managementPaymentNotificationFinish(providerResult);
  let persistedFinish: Awaited<
    ReturnType<typeof finishManagementPaymentNotification>
  >;
  try {
    persistedFinish = await finishManagementPaymentNotification(
      supabase,
      claim,
      finish,
    );
  } catch {
    result.failures.push(
      `${paymentId}: resultado do envio não pôde ser persistido`,
    );
    return;
  }

  if (
    persistedFinish.status === "SENT" &&
    ["delivered", "read"].includes(
      String(persistedFinish.providerDeliveryStatus || ""),
    )
  ) {
    result.sent++;
  } else if (
    persistedFinish.status === "SUBMITTING" &&
    ["accepted", "sent"].includes(
      String(persistedFinish.providerDeliveryStatus || ""),
    )
  ) {
    // HTTP acceptance and SERVER_ACK are observable, but neither proves that
    // the management group received the message.
    result.accepted++;
  } else {
    result.failures.push(
      `${paymentId}: ${
        finish.error || persistedFinish.status || finish.status
      }`,
    );
  }
}

async function processMonthlyPaymentClosures(
  supabase: any,
  result: {
    accepted: number;
    sent: number;
    skipped: number;
    failures: string[];
  },
): Promise<void> {
  const { data: targets, error: targetsError } = await supabase.rpc(
    "monthly_payment_closure_targets",
  );
  if (targetsError) {
    result.failures.push("fechamento mensal: alvos indisponíveis");
    return;
  }
  for (const target of (targets ?? []) as Record<string, unknown>[]) {
    const tenantId = String(target.tenant_id ?? "");
    const periodStart = String(target.period_start ?? "").slice(0, 10);
    if (!tenantId || !periodStart) continue;
    const { data: refreshed, error: refreshError } = await supabase.rpc(
      "refresh_monthly_payment_closure_financial",
      { p_tenant_id: tenantId, p_period_start: periodStart },
    );
    if (refreshError || !refreshed || typeof refreshed !== "object") {
      result.failures.push(`${periodStart}: fechamento não calculado`);
      continue;
    }
    const closure = refreshed as Record<string, unknown>;
    if (closure.ready !== true || closure.status !== "READY") continue;
    const snapshot = closure.snapshot as Record<string, unknown> | undefined;
    if (!snapshot) {
      result.failures.push(`${periodStart}: snapshot mensal ausente`);
      continue;
    }
    const delivery = await resolveManagementDelivery(supabase, tenantId);
    if (!delivery) {
      result.failures.push(`${periodStart}: canal de gestão indisponível`);
      continue;
    }
    const claim = await claimManagementGroupMessage(supabase, {
      tenantId,
      notificationKind: "MONTHLY_PAYMENT_CLOSE",
      subjectId: tenantId,
      refDate: periodStart,
    });
    if (claim.action === "ALREADY_FINAL") {
      if (claim.attempt_id) {
        try {
          await applyMonthlyPaymentClosureDeliveryResult(supabase, {
            tenantId,
            periodStart,
            attemptId: claim.attempt_id,
          });
        } catch {
          result.failures.push(
            `${periodStart}: resultado mensal durável sem baixa local`,
          );
        }
      }
      if (String(claim.status || "").toUpperCase() !== "SENT") {
        result.failures.push(
          `${periodStart}: fechamento ${claim.status} requer revisão`,
        );
      }
      result.skipped++;
      continue;
    }
    if (claim.action !== "SUBMIT_ONCE") {
      result.skipped++;
      continue;
    }
    const mark = await markManagementGroupMessageSubmitting(supabase, claim);
    if (mark.ok !== true || mark.status !== "SUBMITTING") {
      if (mark.status === "SUPPRESSED" && claim.attempt_id) {
        try {
          await applyMonthlyPaymentClosureDeliveryResult(supabase, {
            tenantId,
            periodStart,
            attemptId: claim.attempt_id,
          });
        } catch {
          result.failures.push(
            `${periodStart}: supressão mensal sem baixa local`,
          );
        }
        result.skipped++;
      } else {
        result.failures.push(`${periodStart}: fechamento perdeu a trava`);
      }
      continue;
    }
    const providerResult = await sendWhatsTextDetailed({
      base: delivery.integration.baseUrl,
      keys: [delivery.integration.apiKey],
      instance: delivery.route.instanceName,
      to: delivery.destination,
      text: monthlyPaymentCloseMessage(snapshot),
      delayMs: 800,
    });
    const finish = managementGroupMessageFinish(providerResult);
    try {
      await finishManagementGroupMessage(supabase, claim, finish);
    } catch {
      result.failures.push(`${periodStart}: resultado mensal não persistido`);
      continue;
    }
    if (!claim.attempt_id) {
      result.failures.push(
        `${periodStart}: tentativa mensal sem identificador`,
      );
      continue;
    }
    try {
      await applyMonthlyPaymentClosureDeliveryResult(supabase, {
        tenantId,
        periodStart,
        attemptId: claim.attempt_id,
      });
    } catch {
      result.failures.push(
        `${periodStart}: resultado mensal durável sem baixa local`,
      );
      continue;
    }
    if (finish.status === "SENT") {
      result.sent++;
    } else {
      result.failures.push(`${periodStart}: ${finish.error || finish.status}`);
    }
  }
}
