import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  loadTenantCentralWhatsAppInstance,
  loadTenantCommunicationIdentity,
  safeCommunicationText,
} from "../_shared/tenant-communication.ts";
import {
  buildTeacherClaimUrl,
  isRecord,
  parseVendorTrialLookup,
  shouldNotifyTeacher,
  vendorTrialErrorMessage,
  vendorTrialErrorStatus,
} from "./core.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

function safePhone(value: unknown): string | null {
  const digits = typeof value === "string" ? value.replace(/\D/g, "") : "";
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  return digits.length >= 12 && digits.length <= 15 ? digits : null;
}

function safeFirstName(value: unknown, fallback: string): string {
  return safeCommunicationText(value, 120).split(/\s+/)[0] || fallback;
}

function dateLabels(iso: string): { dateLabel: string; timeLabel: string } {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new Error("INVALID_RPC_RESPONSE");
  return {
    dateLabel: new Intl.DateTimeFormat("pt-BR", {
      timeZone: "America/Sao_Paulo",
      weekday: "long",
      day: "2-digit",
      month: "long",
      year: "numeric",
    }).format(date),
    timeLabel: new Intl.DateTimeFormat("pt-BR", {
      timeZone: "America/Sao_Paulo",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date),
  };
}

async function sendWhatsApp(
  instance: string,
  number: string | null,
  text: string,
): Promise<boolean> {
  const apiUrl = (Deno.env.get("EVOLUTION_API_URL") ||
    "https://api.2b.app.br").replace(/\/+$/, "");
  const apiKey = Deno.env.get("EVOLUTION_API_KEY") || "";
  if (!number || !apiKey) return false;
  try {
    const response = await fetch(
      `${apiUrl}/message/sendText/${encodeURIComponent(instance)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: apiKey },
        body: JSON.stringify({ number, text, delay: 900, linkPreview: false }),
        signal: AbortSignal.timeout(15000),
      },
    );
    return response.ok;
  } catch {
    return false;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "GET" && req.method !== "POST") {
    return json({ ok: false, message: "Método não permitido." }, 405);
  }

  try {
    const lookup = parseVendorTrialLookup(req.url);
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    if (!supabaseUrl || !serviceRoleKey) {
      throw new Error("MISSING_SERVICE_CONFIG");
    }

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await admin.rpc(
      "confirm_vendor_trial_interest_atomic",
      {
        p_link_token: lookup.token,
        p_legacy_opportunity_id: lookup.legacyOpportunityId,
        p_confirm: req.method === "POST",
      },
    );
    if (error) {
      console.error("confirm-vendor-trial rpc", {
        code: error.code,
        message: error.message,
      });
      throw new Error("RPC_FAILED");
    }
    if (!isRecord(data)) throw new Error("INVALID_RPC_RESPONSE");

    if (data.ok !== true) {
      const errorCode = typeof data.error === "string" ? data.error : null;
      return json({
        ok: false,
        confirmed: false,
        requested: data.requested === true,
        conflict: data.conflict === true,
        state: safeCommunicationText(data.state, 40) || undefined,
        message: vendorTrialErrorMessage(errorCode),
      }, vendorTrialErrorStatus(errorCode));
    }

    const tenantId = safeCommunicationText(data.tenantId, 100);
    const opportunityId = safeCommunicationText(data.opportunityId, 64);
    const teacherId = safeCommunicationText(data.teacherId, 64);
    const startsAt = typeof data.startsAt === "string" ? data.startsAt : "";
    const claimGeneration = Number(data.claimGeneration);
    if (!tenantId || !opportunityId || !teacherId || !startsAt) {
      throw new Error("INVALID_RPC_RESPONSE");
    }

    const identity = await loadTenantCommunicationIdentity(admin, tenantId);
    if (!identity) throw new Error("INVALID_TENANT_IDENTITY");
    const labels = dateLabels(startsAt);
    const publicResult = {
      ok: true,
      confirmed: data.confirmed === true,
      requested: data.requested === true,
      conflict: data.conflict === true,
      state: safeCommunicationText(data.state, 40),
      firstName: safeFirstName(data.studentName, "Aluno(a)"),
      teacherName: safeFirstName(data.teacherName, "Professor(a)"),
      schoolName: identity.brandName,
      startsAt,
      ...labels,
    };

    if (req.method === "POST" && shouldNotifyTeacher(data)) {
      const [{ data: teacher }, instance] = await Promise.all([
        admin.from("profiles").select("id,phone").eq("id", teacherId)
          .maybeSingle(),
        loadTenantCentralWhatsAppInstance(admin, tenantId, "teacher"),
      ]);
      const portalOrigin = identity.portalUrl ||
        Deno.env.get("APP_URL") ||
        "https://system.wisewolflanguage.com.br";
      const claimUrl = buildTeacherClaimUrl(
        portalOrigin,
        opportunityId,
        claimGeneration,
      );
      const teacherPhone = teacher?.id === teacherId
        ? safePhone(teacher.phone)
        : null;
      if (instance && teacherPhone && claimUrl) {
        const message = [
          `Nova solicitação individual de aula experimental — ${identity.brandName}.`,
          `Horário pedido: ${labels.dateLabel}, às ${labels.timeLabel}.`,
          "Confirme somente se puder atender. Nenhuma aula foi agendada ainda:",
          claimUrl,
        ].join("\n");
        await sendWhatsApp(instance, teacherPhone, message);
      }
    }

    return json(publicResult);
  } catch (error) {
    const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
    const invalidLookup = message === "INVALID_LOOKUP";
    console.error("confirm-vendor-trial", { message });
    return json({
      ok: false,
      message: invalidLookup
        ? "Link inválido ou expirado."
        : "Não foi possível validar este horário agora.",
    }, invalidLookup ? 404 : 500);
  }
});
