/// <reference lib="deno.ns" />
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  createClient,
  type SupabaseClient,
} from "https://esm.sh/@supabase/supabase-js@2.93.3";
import { authorizeAutomation } from "../_shared/automation-auth.ts";
import {
  loadTenantCentralWhatsAppInstance,
  loadTenantWhatsAppInstance,
} from "../_shared/tenant-communication.ts";
import {
  claimOutboundMessage,
  finishOutboundMessage,
  markOutboundMessageSubmittingDecision,
} from "../_shared/student-billing-period-guard.ts";
import { resolveEvolutionIntegration } from "../_shared/tenant-integration-broker.ts";

// Processa a fila de notificações (lembretes de aula, avisos) e envia via WhatsApp.
//
// Resolução de instância (em ordem):
//   1. Instância canônica conectada do professor com membership ACTIVE no tenant;
//   2. Fallback: instância CENTRAL da escola (WhatsApp do admin do tenant).
// A maioria dos professores não tem instância própria conectada — por isso o fallback
// central é essencial para os lembretes realmente saírem.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const EVOLUTION_API_URL = (Deno.env.get("EVOLUTION_API_URL") || "")
  .trim()
  .replace(/\/+$/, "");
// Chave via env para permitir rotação sem novo deploy.
const EVOLUTION_API_KEYS = Array.from(
  new Set([
    (Deno.env.get("EVOLUTION_API_KEY") || "").trim(),
  ].filter(Boolean)),
);
const MAX_ATTEMPTS = 3;
const PROCESSING_LEASE_MS = 5 * 60 * 1000;

type QueueRelation<T> = T | T[] | null;

type TeacherRelation = {
  id: string;
  tenant_id: string | null;
};

type StudentRelation = {
  id: string;
  is_test_account: boolean | null;
  tenant_id: string | null;
  phone: string | null;
};

type QueueItem = {
  id: string;
  student_phone: string;
  message_body: string;
  tenant_id: string | null;
  attempts: number | null;
  notification_kind: string | null;
  source_id: string | null;
  student_id: string | null;
  teacher: QueueRelation<TeacherRelation>;
  student: QueueRelation<StudentRelation>;
};

function relationOne<T>(value: QueueRelation<T>): T | null {
  return Array.isArray(value) ? value[0] ?? null : value;
}

// Normaliza telefone BR ou JID de grupo para o formato aceito pela Evolution.
function normalizeDestination(raw: string): string | null {
  const destination = (raw || "").trim();
  // Grupos da Evolution usam JID (ex.: 1203...@g.us). A fila também atende
  // telefones comuns, então preservamos somente o formato estrito de grupo.
  if (/^\d{10,25}@g\.us$/.test(destination)) return destination;

  let phone = destination.replace(/\D/g, "");
  if (phone.length === 10 || phone.length === 11) phone = "55" + phone;
  if (phone.length < 12) return null;
  return phone;
}

function providerHttpOutcomeIsUnknown(status: number): boolean {
  return [408, 409, 425, 429].includes(status) || status >= 500;
}

// Resolve a instância central da escola (admin do tenant com WhatsApp conectado).
async function resolveCentralInstance(
  supabase: SupabaseClient,
  tenantId: string | null,
  audience: "student" | "teacher",
  cache: Record<string, string | null>,
): Promise<string | null> {
  const key = `${tenantId || "_"}:${audience}`;
  if (key in cache) return cache[key];
  if (!tenantId) {
    cache[key] = null;
    return null;
  }
  cache[key] = await loadTenantCentralWhatsAppInstance(
    supabase,
    tenantId,
    audience,
  );
  return cache[key];
}

async function resolvePersonalInstance(
  supabase: SupabaseClient,
  tenantId: string,
  userId: string,
  audience: "student" | "teacher",
  cache: Record<string, string | null>,
): Promise<string | null> {
  const key = `${tenantId}:${userId}:${audience}`;
  if (key in cache) return cache[key];
  cache[key] = await loadTenantWhatsAppInstance(
    supabase,
    tenantId,
    userId,
    audience,
  );
  return cache[key];
}

async function markClaim(
  supabase: SupabaseClient,
  id: string,
  status: "pending" | "sent" | "failed" | "skipped",
  lastError: string | null,
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { data, error } = await supabase
      .from("notification_queue")
      .update({
        status,
        last_error: lastError,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("status", "processing")
      .select("id")
      .maybeSingle();
    if (!error) return Boolean(data);
  }
  return false;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  const authError = await authorizeAutomation(req, corsHeaders);
  if (authError) return authError;

  try {
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );
    // Recupera claims abandonados por timeout/restart do worker.
    const staleBefore = new Date(Date.now() - PROCESSING_LEASE_MS)
      .toISOString();
    const { data: staleClaims, error: staleClaimsError } = await supabaseClient
      .from("notification_queue")
      .select(
        "id, attempts, notification_kind, tenant_id, student_id, source_id",
      )
      .eq("status", "processing")
      .lt("updated_at", staleBefore)
      .limit(100);
    if (staleClaimsError) throw staleClaimsError;
    for (const stale of (staleClaims || [])) {
      let recoveredStatus: "pending" | "sent" | "failed" | "skipped" =
        (stale.attempts || 0) >= MAX_ATTEMPTS ? "failed" : "pending";
      let recoveredError = "worker_lease_expired";
      if (
        stale.notification_kind === "PAYMENT_CONFIRMED" &&
        stale.tenant_id && stale.student_id && stale.source_id
      ) {
        const { data: outbound, error: outboundError } = await supabaseClient
          .from("asaas_outbound_message_attempts")
          .select("status, submit_attempt_count")
          .eq("tenant_id", stale.tenant_id)
          .eq("student_id", stale.student_id)
          .eq("provider_entity_id", stale.source_id)
          .eq("notification_kind", "PAYMENT_CONFIRMED_WHATSAPP")
          .maybeSingle();
        if (outboundError) throw outboundError;
        const outboundStatus = String(outbound?.status || "").toUpperCase();
        if (outboundStatus === "SENT") {
          recoveredStatus = "sent";
          recoveredError = "";
        } else if (outboundStatus === "SUPPRESSED") {
          recoveredStatus = "skipped";
          recoveredError = "payment_confirmation_suppressed";
        } else if (
          ["FAILED", "UNKNOWN", "SUBMITTING"].includes(outboundStatus) ||
          Number(outbound?.submit_attempt_count || 0) > 0
        ) {
          recoveredStatus = "failed";
          recoveredError = "payment_confirmation_terminal";
        } else if (outboundStatus === "CLAIMED") {
          recoveredStatus = "pending";
          recoveredError = "payment_confirmation_claim_recoverable";
        }
      } else if (stale.notification_kind === "PAYMENT_CONFIRMED") {
        recoveredStatus = "failed";
        recoveredError = "payment_confirmation_binding_missing";
      }
      const { error: staleRecoveryError } = await supabaseClient
        .from("notification_queue")
        .update({
          status: recoveredStatus,
          last_error: recoveredError || null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", stale.id)
        .eq("status", "processing");
      if (staleRecoveryError) throw staleRecoveryError;
    }

    // 1. Busca notificações pendentes e vencidas
    const { data: pending, error: fetchError } = await supabaseClient
      .from("notification_queue")
      .select(`
                id,
                student_phone,
                message_body,
                tenant_id,
                attempts,
                notification_kind,
                source_id,
                student_id,
                teacher:teacher_id ( id, tenant_id ),
                student:student_id ( id, is_test_account, tenant_id, phone )
            `)
      .eq("status", "pending")
      .lte("scheduled_for", new Date().toISOString())
      .limit(50);

    if (fetchError) throw fetchError;
    if (!pending || pending.length === 0) {
      return new Response(
        JSON.stringify({ message: "No pending notifications due." }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const queueItems = pending as unknown as QueueItem[];
    const results: Array<Record<string, unknown>> = [];
    const centralCache: Record<string, string | null> = {};
    const personalCache: Record<string, string | null> = {};
    let persistenceFailed = false;

    // 2. Processa o lote
    for (const item of queueItems) {
      const { id, student_phone, message_body, tenant_id, attempts } = item;
      const teacher = relationOne(item.teacher);
      const student = relationOne(item.student);
      const nextAttempts = (attempts || 0) + 1;
      const { data: claim, error: claimError } = await supabaseClient
        .from("notification_queue")
        .update({
          status: "processing",
          attempts: nextAttempts,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id)
        .eq("status", "pending")
        .select("id")
        .maybeSingle();
      if (claimError || !claim) {
        results.push({ id, status: "skipped" });
        continue;
      }

      if (student?.is_test_account === true) {
        const marked = await markClaim(
          supabaseClient,
          id,
          "skipped",
          "test_fixture_suppressed",
        );
        persistenceFailed ||= !marked;
        results.push({
          id,
          status: marked ? "skipped" : "marker_failed",
        });
        continue;
      }
      if (student?.tenant_id && student.tenant_id !== tenant_id) {
        const marked = await markClaim(
          supabaseClient,
          id,
          "failed",
          "student_tenant_mismatch",
        );
        persistenceFailed ||= !marked;
        results.push({
          id,
          status: marked ? "failed" : "marker_failed",
          error: "tenant_mismatch",
        });
        continue;
      }
      const isPaymentConfirmation =
        item.notification_kind === "PAYMENT_CONFIRMED";
      if (
        isPaymentConfirmation &&
        (!tenant_id || !item.student_id || !item.source_id || !student ||
          student.id !== item.student_id || student.tenant_id !== tenant_id)
      ) {
        const marked = await markClaim(
          supabaseClient,
          id,
          "failed",
          "payment_confirmation_binding_missing",
        );
        persistenceFailed ||= !marked;
        results.push({ id, status: marked ? "failed" : "marker_failed" });
        continue;
      }

      // Aviso em grupo sempre sai da conexão central, que é a participante
      // configurada no grupo da escola. Mensagem individual mantém o fluxo
      // professor → fallback central.
      const isGroupNotification =
        item.notification_kind === "SCHEDULE_CHANGE_GROUP";
      const audience = isGroupNotification ? "teacher" : "student";
      let instanceId: string | null =
        !isGroupNotification && tenant_id && teacher?.id &&
          teacher.tenant_id === tenant_id
          ? await resolvePersonalInstance(
            supabaseClient,
            tenant_id,
            teacher.id,
            audience,
            personalCache,
          )
          : null;
      if (!instanceId) {
        instanceId = await resolveCentralInstance(
          supabaseClient,
          tenant_id,
          audience,
          centralCache,
        );
      }

      if (!instanceId) {
        const marked = await markClaim(
          supabaseClient,
          id,
          "failed",
          "no_whatsapp_instance",
        );
        persistenceFailed ||= !marked;
        results.push({
          id,
          status: marked ? "failed" : "marker_failed",
          error: "no_instance",
        });
        continue;
      }

      const destination = normalizeDestination(student_phone);
      if (!destination) {
        const marked = await markClaim(
          supabaseClient,
          id,
          "failed",
          "invalid_phone",
        );
        persistenceFailed ||= !marked;
        results.push({
          id,
          status: marked ? "failed" : "marker_failed",
          error: "invalid_phone",
        });
        continue;
      }

      // A confirmacao financeira nunca pode herdar as credenciais globais de
      // outra escola. Resolva o endpoint/chave exatos do tenant antes de criar
      // ou marcar o claim submit-once; falha de configuracao continua segura
      // para retry porque nenhum POST foi iniciado.
      let deliveryBaseUrl = EVOLUTION_API_URL;
      let deliveryApiKeys = EVOLUTION_API_KEYS;
      if (isPaymentConfirmation) {
        try {
          const integration = await resolveEvolutionIntegration(
            supabaseClient,
            tenant_id!,
            "message.send_text",
          );
          deliveryBaseUrl = integration.baseUrl;
          deliveryApiKeys = [integration.apiKey];
        } catch {
          const marked = await markClaim(
            supabaseClient,
            id,
            "pending",
            "payment_confirmation_integration_unavailable",
          );
          persistenceFailed ||= !marked;
          results.push({ id, status: marked ? "pending" : "marker_failed" });
          continue;
        }
      }
      if (!deliveryBaseUrl || deliveryApiKeys.length === 0) {
        const finalStatus = nextAttempts >= MAX_ATTEMPTS ? "failed" : "pending";
        const marked = await markClaim(
          supabaseClient,
          id,
          finalStatus,
          "notification_provider_unavailable",
        );
        persistenceFailed ||= !marked;
        results.push({ id, status: marked ? finalStatus : "marker_failed" });
        continue;
      }

      let paymentOutboundClaim:
        | Awaited<ReturnType<typeof claimOutboundMessage>>
        | null = null;
      if (isPaymentConfirmation) {
        const [currentProfileResult, sourcePaymentResult] = await Promise.all([
          supabaseClient.from("profiles")
            .select("id, tenant_id, role, phone")
            .eq("id", item.student_id!)
            .eq("tenant_id", tenant_id!)
            .eq("role", "STUDENT")
            .maybeSingle(),
          supabaseClient.from("student_payments")
            .select("id, tenant_id, student_id, status, provider_status")
            .eq("id", item.source_id!)
            .eq("tenant_id", tenant_id!)
            .eq("student_id", item.student_id!)
            .limit(2),
        ]);
        if (currentProfileResult.error) throw currentProfileResult.error;
        if (sourcePaymentResult.error) throw sourcePaymentResult.error;
        const currentDestination = normalizeDestination(
          String(currentProfileResult.data?.phone || ""),
        );
        const sourcePayments = sourcePaymentResult.data || [];
        const sourceStatus = String(sourcePayments[0]?.status || "")
          .toUpperCase();
        if (
          !currentProfileResult.data || currentDestination !== destination ||
          sourcePayments.length !== 1 ||
          !["RECEIVED", "RECEIVED_IN_CASH", "PAGO"].includes(sourceStatus)
        ) {
          const marked = await markClaim(
            supabaseClient,
            id,
            "failed",
            currentDestination !== destination
              ? "payment_confirmation_destination_changed"
              : "payment_confirmation_source_unsettled",
          );
          persistenceFailed ||= !marked;
          results.push({ id, status: marked ? "failed" : "marker_failed" });
          continue;
        }

        paymentOutboundClaim = await claimOutboundMessage(supabaseClient, {
          tenantId: tenant_id!,
          studentId: item.student_id!,
          providerEntityId: item.source_id!,
          notificationKind: "PAYMENT_CONFIRMED_WHATSAPP",
        });
        if (paymentOutboundClaim.action === "REVIEW_REQUIRED") {
          const marked = await markClaim(
            supabaseClient,
            id,
            "skipped",
            paymentOutboundClaim.reason || "payment_confirmation_suppressed",
          );
          persistenceFailed ||= !marked;
          results.push({ id, status: marked ? "skipped" : "marker_failed" });
          continue;
        }
        if (paymentOutboundClaim.action === "IN_PROGRESS") {
          const marked = await markClaim(
            supabaseClient,
            id,
            "pending",
            "payment_confirmation_claim_in_progress",
          );
          persistenceFailed ||= !marked;
          results.push({ id, status: marked ? "pending" : "marker_failed" });
          continue;
        }
        if (paymentOutboundClaim.action === "ALREADY_FINAL") {
          const outboundStatus = String(paymentOutboundClaim.status || "")
            .toUpperCase();
          const queueStatus = outboundStatus === "SENT"
            ? "sent"
            : outboundStatus === "SUPPRESSED"
            ? "skipped"
            : "failed";
          const marked = await markClaim(
            supabaseClient,
            id,
            queueStatus,
            queueStatus === "sent"
              ? null
              : `payment_confirmation_${
                outboundStatus.toLowerCase() || "terminal"
              }`,
          );
          persistenceFailed ||= !marked;
          results.push({ id, status: marked ? queueStatus : "marker_failed" });
          continue;
        }
        const submit = await markOutboundMessageSubmittingDecision(
          supabaseClient,
          paymentOutboundClaim,
        );
        if (submit.ok !== true || submit.status !== "SUBMITTING") {
          const marked = await markClaim(
            supabaseClient,
            id,
            "skipped",
            submit.reason || "payment_confirmation_suppressed_before_send",
          );
          persistenceFailed ||= !marked;
          results.push({ id, status: marked ? "skipped" : "marker_failed" });
          continue;
        }
      }

      try {
        const url = `${deliveryBaseUrl}/message/sendText/${
          encodeURIComponent(instanceId)
        }`;
        let response: Response | null = null;
        for (const key of deliveryApiKeys) {
          response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", "apikey": key },
            body: JSON.stringify({
              number: destination,
              text: message_body,
              delay: 1000,
            }),
            signal: AbortSignal.timeout(15_000),
          });
          if (response.status !== 401) break; // 401 = chave rotacionada → tenta a próxima
        }

        if (!response || !response.ok) {
          if (paymentOutboundClaim) {
            const unknown = response
              ? providerHttpOutcomeIsUnknown(response.status)
              : true;
            await finishOutboundMessage(supabaseClient, paymentOutboundClaim, {
              status: unknown ? "UNKNOWN" : "FAILED",
              providerHttpStatus: response?.status ?? null,
              error: unknown
                ? "provider_delivery_outcome_unknown"
                : `provider_http_${response?.status ?? "unavailable"}`,
            });
          }
          throw new Error(`provider_http_${response?.status ?? "unavailable"}`);
        }

        if (paymentOutboundClaim) {
          try {
            await finishOutboundMessage(supabaseClient, paymentOutboundClaim, {
              status: "SENT",
              providerHttpStatus: response.status,
            });
          } catch {
            // Delivery happened, but its durable marker is uncertain.
            // Leave the queue claim for stale recovery; never resend.
            persistenceFailed = true;
            results.push({ id, status: "marker_failed" });
            continue;
          }
        }

        const marked = await markClaim(
          supabaseClient,
          id,
          "sent",
          null,
        );
        if (!marked) {
          persistenceFailed = true;
          console.error("Notification delivery marker failed", { id });
        }
        results.push({ id, status: marked ? "sent" : "marker_failed" });
      } catch (err: unknown) {
        const safeReason = err instanceof DOMException &&
            (err.name === "TimeoutError" || err.name === "AbortError")
          ? "provider_timeout"
          : err instanceof Error &&
              /^provider_http_[a-z0-9_-]+$/i.test(err.message)
          ? err.message
          : "provider_network_error";
        console.error("Notification queue delivery failed", {
          id,
          reason: safeReason,
        });
        if (paymentOutboundClaim && !/^provider_http_/i.test(safeReason)) {
          try {
            await finishOutboundMessage(supabaseClient, paymentOutboundClaim, {
              status: "UNKNOWN",
              error: safeReason,
            });
          } catch {
            persistenceFailed = true;
          }
        }
        // Payment confirmations are submit-once: any ambiguous outcome
        // is terminal. Other notification kinds retain bounded retries.
        const finalStatus = isPaymentConfirmation
          ? "failed"
          : nextAttempts >= MAX_ATTEMPTS
          ? "failed"
          : "pending";
        const marked = await markClaim(
          supabaseClient,
          id,
          finalStatus,
          safeReason,
        );
        persistenceFailed ||= !marked;
        results.push({
          id,
          status: marked ? finalStatus : "marker_failed",
          error: safeReason,
        });
      }
    }

    return new Response(
      JSON.stringify({ processed: results.length, details: results }),
      {
        status: persistenceFailed ? 500 : 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (error: unknown) {
    console.error("Notification queue worker failed", {
      type: error instanceof Error ? error.name : "UnknownError",
    });
    return new Response(
      JSON.stringify({ error: "notification_queue_processing_failed" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
