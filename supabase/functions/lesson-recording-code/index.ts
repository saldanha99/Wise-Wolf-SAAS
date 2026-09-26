/// <reference lib="deno.ns" />

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.93.3";
import { sendWhatsTextDetailed } from "../_shared/evolution-send.ts";
import { loadTenantCentralWhatsAppContext } from "../_shared/tenant-communication.ts";
import { resolveEvolutionIntegration } from "../_shared/tenant-integration-broker.ts";
import {
  buildCodeMessage,
  httpStatusForIssueError,
  type IssuedCode,
  parseCodeRequest,
  parseIssuedCode,
  type SettleStatus,
  settleStatusFor,
} from "./core.ts";

// Código de 6 dígitos da página pública do termo de registro das aulas
// (/registro-das-aulas). Sem login: quem prova o direito é o token do link
// (64 hex, gerado pela escola) e, agora, a posse do WhatsApp cadastrado.
//
// Fluxo: o banco emite o código e guarda só o hash (por link: 3 envios por
// hora, 6 por dia e 10 no total; passou do total ou de 15 tentativas erradas,
// o link fecha), esta função manda pela instância central da escola usando o
// helper que pede licença ao teto do WhatsApp (`whatsapp_outbound_permit`) e
// registra o resultado. O código nunca volta ao navegador nem vai para log.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MAX_BODY_BYTES = 2_048;

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return json({ error: "metodo_invalido" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim() || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim() ||
    "";
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ error: "indisponivel" }, 503);
  }

  const raw = await req.text().catch(() => "");
  if (!raw || new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
    return json({ error: "resposta_invalida" }, 400);
  }
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
  const request = parseCodeRequest(body);
  if (!request) return json({ error: "resposta_invalida" }, 400);

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await admin.rpc(
    "issue_lesson_recording_consent_code",
    { p_token: request.token, p_relation: request.relation },
  );
  if (error) {
    console.error("[lesson-recording-code] emissão falhou", {
      errorCode: error.code || "unknown",
    });
    return json({ error: "indisponivel" }, 503);
  }
  const issued = parseIssuedCode(data);
  if ("error" in issued) {
    return json(
      {
        error: issued.error,
        ...(issued.retryAfterSeconds
          ? { retry_after_seconds: issued.retryAfterSeconds }
          : {}),
      },
      httpStatusForIssueError(issued.error),
    );
  }

  const settle = async (
    code: IssuedCode,
    status: SettleStatus,
    messageId: string | null,
  ): Promise<void> => {
    const { error: settleError } = await admin.rpc(
      "settle_lesson_recording_consent_code",
      {
        p_challenge_id: code.challengeId,
        p_status: status,
        p_provider_message_id: messageId,
      },
    );
    if (settleError) {
      // O desafio fica ISSUED: conta no limite (o lado seguro) e vence em 10 min.
      console.error("[lesson-recording-code] resultado do envio não gravado", {
        challengeId: code.challengeId,
        status,
      });
    }
  };

  // Instância central da escola (a mesma dos avisos transacionais).
  let instanceName: string | null = null;
  let baseUrl = "";
  let apiKey = "";
  try {
    const context = await loadTenantCentralWhatsAppContext(
      admin,
      issued.tenantId,
      "general",
    );
    if (context) {
      const integration = await resolveEvolutionIntegration(
        admin,
        issued.tenantId,
        "message.send_text",
      );
      instanceName = context.instanceName;
      baseUrl = integration.baseUrl;
      apiKey = integration.apiKey;
    }
  } catch (routeError) {
    console.error("[lesson-recording-code] rota do WhatsApp indisponível", {
      tenantId: issued.tenantId,
      errorType: routeError instanceof Error ? routeError.message : "unknown",
    });
    instanceName = null;
  }
  if (!instanceName || !baseUrl || !apiKey) {
    await settle(issued, "NOT_SENT", null);
    return json({ error: "whatsapp_indisponivel" }, 503);
  }

  const result = await sendWhatsTextDetailed({
    base: baseUrl,
    keys: [apiKey],
    instance: instanceName,
    to: issued.destination,
    text: buildCodeMessage({
      schoolName: issued.schoolName,
      studentFirstName: issued.studentFirstName,
      relation: issued.relation,
      code: issued.code,
    }),
  });
  const status = settleStatusFor(result);
  await settle(issued, status, result.messageId);

  if (status === "NOT_SENT") {
    if (result.throttled) {
      return json({
        error: "aguarde",
        retry_after_seconds: Math.max(
          1,
          Math.ceil(Number(result.retryAfterMs || 60_000) / 1000),
        ),
      }, 429);
    }
    return json({ error: "whatsapp_recusou" }, 502);
  }

  return json({
    ok: true,
    relation: issued.relation,
    sent_to: issued.destinationMasked,
    expires_at: issued.expiresAt,
    uncertain: status === "AMBIGUOUS",
  });
});
