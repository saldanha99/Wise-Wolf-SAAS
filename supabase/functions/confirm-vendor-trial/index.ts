import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  loadTenantCommunicationIdentity,
  safeCommunicationText,
} from "../_shared/tenant-communication.ts";
import {
  isRecord,
  parseVendorTrialLookup,
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
    const startsAt = typeof data.startsAt === "string" ? data.startsAt : "";
    if (!tenantId || !opportunityId || !startsAt) {
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
