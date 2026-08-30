import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authorizeAutomation } from "../_shared/automation-auth.ts";
import { sendWhatsTextDetailed } from "../_shared/evolution-send.ts";
import {
  loadTenantCentralWhatsAppContext,
  safeCommunicationText,
  type TenantCentralWhatsAppContext,
} from "../_shared/tenant-communication.ts";
import {
  ATTENDANCE_CLAIM_LIMIT,
  type AttendanceDeliveryClaim,
  attendanceDeliveryHttpStatus,
  type AttendanceParticipantProfile,
  buildAttendanceConfirmationUrl,
  dedupeAttendanceDeliveries,
  finalizationForEvolutionResult,
  isFreshAttendanceOccurrence,
  parseAttendanceDeliveryClaims,
  resolveAttendanceDeliveryRecipient,
  resolveAttendancePortal,
} from "./core.ts";

// Cron: envia o link de confirmação de presença somente ao ALUNO e sempre pela
// instância central da escola. O lançamento do professor já é a segunda fonte.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const EVOLUTION_API_BASE = (Deno.env.get("EVOLUTION_API_URL") ||
  "https://api.2b.app.br").replace(/\/+$/, "");
const API_TOKEN = Deno.env.get("EVOLUTION_API_KEY") || "";
const APP_PUBLIC_URL = Deno.env.get("APP_PUBLIC_URL") || "";

type AdminClient = any;

function rpcSucceeded(value: unknown): boolean {
  return Boolean(value) && typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).ok === true;
}

async function completeDelivery(
  admin: AdminClient,
  row: AttendanceDeliveryClaim,
  providerMessageId: string,
): Promise<void> {
  const normalizedMessageId = providerMessageId.trim();
  if (!normalizedMessageId) throw new Error("provider_message_id_required");
  const { data, error } = await admin.rpc(
    "complete_attendance_confirmation_delivery",
    {
      p_confirmation_id: row.id,
      p_claim_token: row.claim_token,
      p_provider_message_id: normalizedMessageId,
    },
  );
  if (error || !rpcSucceeded(data)) {
    throw new Error("delivery_completion_failed");
  }
}

async function failDelivery(
  admin: AdminClient,
  row: AttendanceDeliveryClaim,
  errorCode: string,
  ambiguous = false,
): Promise<void> {
  const { data, error } = await admin.rpc(
    "fail_attendance_confirmation_delivery",
    {
      p_confirmation_id: row.id,
      p_claim_token: row.claim_token,
      p_error_code: errorCode.slice(0, 80),
      p_ambiguous: ambiguous,
    },
  );
  if (error || !rpcSucceeded(data)) {
    throw new Error("delivery_failure_record_failed");
  }
}

async function resolveCentralContext(
  admin: AdminClient,
  tenantId: string | null | undefined,
): Promise<TenantCentralWhatsAppContext | null> {
  if (!tenantId) return null;
  return await loadTenantCentralWhatsAppContext(admin, tenantId, "student");
}

async function loadCurrentDeliveryRecipient(
  admin: AdminClient,
  row: AttendanceDeliveryClaim,
): Promise<{ allowed: boolean; phone: string | null }> {
  if (!row.student_id || !row.teacher_id || !row.tenant_id) {
    return { allowed: false, phone: null };
  }
  const { data, error } = await admin
    .from("profiles")
    .select(
      "id, tenant_id, role, lifecycle_status, is_test_account, attendance_phone, phone",
    )
    .eq("tenant_id", row.tenant_id)
    .in("id", [row.student_id, row.teacher_id]);
  if (error) throw new Error("attendance_participant_revalidation_failed");
  return resolveAttendanceDeliveryRecipient(
    row,
    (data || []) as AttendanceParticipantProfile[],
  );
}

async function markAcceptedStateAmbiguous(
  admin: AdminClient,
  row: AttendanceDeliveryClaim,
): Promise<void> {
  try {
    await failDelivery(admin, row, "completion_state_unknown", true);
  } catch (error) {
    // Se a primeira finalização foi aplicada e somente sua resposta se perdeu,
    // esta segunda chamada pode ser recusada pelo claim token. A linha já está
    // segura como SENT nesse caso. Nunca repetimos o envio nesta execução.
    console.error("attendance_ambiguous_finalization_failed", {
      confirmationId: row.id,
      errorType: error instanceof Error ? error.message : "unknown",
    });
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  const authError = await authorizeAutomation(req, corsHeaders);
  if (authError) return authError;

  try {
    if (!API_TOKEN) throw new Error("EVOLUTION_API_KEY não configurada");

    const admin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );

    // O claim incrementa tentativas e cria um lease em uma única transação.
    // Duas execuções simultâneas não recebem a mesma confirmação.
    const { data, error } = await admin.rpc(
      "claim_attendance_confirmation_deliveries",
      // Mantém a execução bem abaixo do lease mesmo quando a Evolution demora.
      // A rota detalhada tem até 10s para JID + 15s para envio: 5 linhas
      // sequenciais consomem no pior caso ~125s de um lease de 5 minutos.
      // O cron roda a cada 15 minutos e busca o próximo lote na rodada seguinte.
      { p_limit: ATTENDANCE_CLAIM_LIMIT },
    );
    if (error) throw error;
    const claimed = parseAttendanceDeliveryClaims(data);
    if (claimed.length === 0) {
      return new Response(JSON.stringify({ claimed: 0, sent: 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { deliveries, duplicates } = dedupeAttendanceDeliveries(claimed);
    if (duplicates.length > 0) {
      // O RPC só pode devolver uma canônica por delivery_key. Não despacha
      // parcialmente um lote impossível de finalizar com segurança.
      throw new Error("duplicate_attendance_claim_contract");
    }
    let sent = 0;
    let failed = 0;
    let suppressed = 0;
    let ambiguous = 0;
    const failureCodes: string[] = [];

    const contextCache = new Map<
      string,
      TenantCentralWhatsAppContext | null
    >();
    const now = new Date();

    for (const row of deliveries) {
      try {
        // Fixtures e identidades sem elegibilidade atual nunca atravessam a
        // fronteira externa, mesmo se foram marcadas depois do claim no banco.
        const recipient = await loadCurrentDeliveryRecipient(admin, row);
        if (!recipient.allowed) {
          await failDelivery(
            admin,
            row,
            "test_or_ineligible_participant_suppressed",
          );
          suppressed++;
          continue;
        }

        // Defesa independente do SQL: um rollout desalinhado jamais despacha o
        // backlog de vários dias acumulado durante uma pane.
        if (!isFreshAttendanceOccurrence(row.class_date, row.class_time, now)) {
          await failDelivery(admin, row, "stale_delivery_suppressed");
          suppressed++;
          continue;
        }

        const phone = recipient.phone;
        if (!phone) {
          await failDelivery(admin, row, "invalid_attendance_phone");
          failed++;
          failureCodes.push("invalid_attendance_phone");
          continue;
        }

        const tenantKey = row.tenant_id || "";
        if (!contextCache.has(tenantKey)) {
          contextCache.set(
            tenantKey,
            await resolveCentralContext(admin, row.tenant_id),
          );
        }
        const context = contextCache.get(tenantKey) || null;
        if (!context) {
          await failDelivery(admin, row, "central_whatsapp_unavailable");
          failed++;
          failureCodes.push("central_whatsapp_unavailable");
          continue;
        }

        const portal = resolveAttendancePortal(
          context.identity.portalUrl,
          APP_PUBLIC_URL,
        );
        const confirmationUrl = buildAttendanceConfirmationUrl(
          portal,
          row.token,
        );
        if (!confirmationUrl) {
          await failDelivery(admin, row, "invalid_confirmation_token");
          failed++;
          failureCodes.push("invalid_confirmation_token");
          continue;
        }

        const studentFirstName = safeCommunicationText(
          (row.student_name || "").trim().split(/\s+/)[0],
          60,
        );
        const teacherName = safeCommunicationText(row.teacher_name, 120) ||
          "seu professor";
        const brandName = safeCommunicationText(
          context.identity.brandName,
          120,
        ) || "sua escola";
        const todayInSaoPaulo = now.toLocaleDateString("en-CA", {
          timeZone: "America/Sao_Paulo",
        });
        const when = row.class_date === todayInSaoPaulo
          ? "hoje"
          : `no dia ${
            new Date(`${row.class_date}T12:00:00Z`).toLocaleDateString(
              "pt-BR",
              { day: "2-digit", month: "2-digit", timeZone: "UTC" },
            )
          }`;
        const greeting = studentFirstName ? `Oi ${studentFirstName}!` : "Oi!";
        const text = `${greeting} Aqui é a ${brandName}.\n\n` +
          `Sua aula com *${teacherName}* estava marcada para ${when}. ` +
          `O que aconteceu? Confirme rapidinho (1 toque):\n\n` +
          `${confirmationUrl}\n\nLeva 5 segundos. Obrigado!`;

        const providerResult = await sendWhatsTextDetailed({
          base: EVOLUTION_API_BASE,
          keys: [API_TOKEN],
          instance: context.instanceName,
          to: phone,
          text,
          delayMs: 1000,
        });
        const finalization = finalizationForEvolutionResult(providerResult);
        if (finalization.action === "complete") {
          try {
            await completeDelivery(
              admin,
              row,
              finalization.providerMessageId,
            );
            sent++;
          } catch {
            // O provedor aceitou; uma nova tentativa de envio seria duplicidade.
            await markAcceptedStateAmbiguous(admin, row);
            failed++;
            ambiguous++;
            failureCodes.push("completion_state_unknown");
          }
          continue;
        }

        await failDelivery(
          admin,
          row,
          finalization.errorCode,
          finalization.ambiguous,
        );
        failed++;
        if (finalization.ambiguous) ambiguous++;
        failureCodes.push(finalization.errorCode);
      } catch (inner) {
        console.error("attendance_delivery_failed", {
          confirmationId: row.id,
          errorType: inner instanceof Error ? inner.message : "unknown",
        });
        failed++;
        failureCodes.push("delivery_processing_failed");
        try {
          await failDelivery(admin, row, "delivery_processing_failed");
        } catch {
          failureCodes.push("failure_state_unknown");
        }
      }
    }

    const summary = {
      claimed: claimed.length,
      sent,
      failed,
      suppressed,
      ambiguous,
      failure_codes: failureCodes.slice(0, 10),
    };
    return new Response(JSON.stringify(summary), {
      status: attendanceDeliveryHttpStatus(summary),
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("attendance_delivery_fatal", error);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "internal_error",
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
