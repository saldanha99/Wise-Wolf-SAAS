/// <reference lib="deno.ns" />

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { authorizeRequest, methodNotAllowed } from "../_shared/request-auth.ts";
import {
  loadTenantWhatsAppRoute,
  safeCommunicationText,
} from "../_shared/tenant-communication.ts";
import {
  claimErrorMessage,
  claimErrorStatus,
  normalizeAcceptOpportunityInput,
} from "./core.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function json(body: UnknownRecord, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function formatClaimStart(value: unknown): string {
  if (typeof value !== "string") return "horário informado no painel";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "horário informado no painel";
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Sao_Paulo",
  }).format(new Date(timestamp));
}

async function notifyTenantAfterClaim(
  admin: any,
  tenantId: string,
  claim: UnknownRecord,
): Promise<void> {
  if (claim.idempotent === true) return;
  const apiUrl = Deno.env.get("EVOLUTION_API_URL")?.trim() || "";
  const apiKey = Deno.env.get("EVOLUTION_API_KEY")?.trim() || "";
  if (!apiUrl || !apiKey) return;

  try {
    const route = await loadTenantWhatsAppRoute(admin, tenantId, "teacher");
    const destination = route?.directorsGroupId || route?.ownerPhone;
    if (!route || !destination) return;

    const teacherName = safeCommunicationText(claim.teacherName, 120) ||
      "Professor(a)";
    const studentName = safeCommunicationText(claim.studentName, 120) ||
      "Aluno(a)";
    const kind = claim.kind === "TRAINING"
      ? "TREINAMENTO"
      : "AULA EXPERIMENTAL";
    const message =
      `🔔 *${kind} ACEITA — ${route.identity.brandName}*\n\n👨🏫 *Professor:* ${teacherName}\n🎓 *Aluno:* ${studentName}\n📅 *Data:* ${
        formatClaimStart(claim.startTime)
      }\n\n✅ Agendamento confirmado no sistema.`;

    const response = await fetch(
      `${apiUrl.replace(/\/+$/, "")}/message/sendText/${
        encodeURIComponent(route.instanceName)
      }`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: apiKey },
        body: JSON.stringify({
          number: destination,
          text: message,
          linkPreview: false,
        }),
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!response.ok) {
      console.warn("accept-opportunity notification was not delivered", {
        opportunityId: claim.opportunityId,
        status: response.status,
      });
    }
  } catch (error) {
    console.warn("accept-opportunity notification failed", {
      opportunityId: claim.opportunityId,
      message: error instanceof Error ? error.message : "unknown",
    });
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return methodNotAllowed(corsHeaders);

  const authorization = await authorizeRequest(req, {
    corsHeaders,
    allowedRoles: ["TEACHER"],
  });
  if (authorization.ok === false) return authorization.response;

  let input;
  try {
    input = normalizeAcceptOpportunityInput(await req.json());
  } catch (error) {
    return json({
      ok: false,
      error: error instanceof Error ? error.message : "INVALID_BODY",
      message: "Use um link válido e atualizado desta oportunidade.",
    }, 400);
  }

  const { admin, profile, userId } = authorization.context;
  const tenantId = profile?.tenant_id;
  if (!tenantId || !userId) {
    return json({ ok: false, error: "TENANT_ACCESS_REQUIRED" }, 403);
  }

  const { data: visibleOpportunity, error: lookupError } = await admin
    .from("opportunities")
    .select("id")
    .eq("id", input.opportunityId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (lookupError) {
    console.error("accept-opportunity tenant lookup failed", {
      code: lookupError.code,
    });
    return json({ ok: false, error: "LOOKUP_FAILED" }, 503);
  }
  if (!visibleOpportunity) {
    return json({
      ok: false,
      error: "opportunity_not_found",
      message: claimErrorMessage("opportunity_not_found"),
    }, 404);
  }

  const { data, error: claimError } = await admin.rpc(
    "claim_opportunity_atomic",
    {
      p_opportunity_id: input.opportunityId,
      p_teacher_id: userId,
      p_claim_generation: input.generation,
    },
  );
  if (claimError) {
    console.error("accept-opportunity atomic claim failed", {
      code: claimError.code,
    });
    return json({ ok: false, error: "CLAIM_FAILED" }, 503);
  }
  if (!isRecord(data)) {
    return json({ ok: false, error: "INVALID_CLAIM_RESPONSE" }, 503);
  }
  if (data.ok !== true) {
    const claimCode = typeof data.error === "string" ? data.error : "unknown";
    return json({
      ok: false,
      error: claimCode,
      message: claimErrorMessage(claimCode),
    }, claimErrorStatus(claimCode));
  }
  if (data.tenantId !== tenantId) {
    console.error("accept-opportunity tenant invariant failed");
    return json({ ok: false, error: "TENANT_INVARIANT_FAILED" }, 503);
  }

  await notifyTenantAfterClaim(admin, tenantId, data);

  return json({
    ok: true,
    idempotent: data.idempotent === true,
    opportunityId: data.opportunityId,
    appointmentId: data.appointmentId,
    kind: data.kind,
    studentName: data.studentName,
    studentPhone: data.studentPhone,
    startTime: data.startTime,
    teacherName: data.teacherName,
  });
});
