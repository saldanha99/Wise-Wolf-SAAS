/// <reference lib="deno.ns" />

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.93.3";
import { authorizeRequest } from "../_shared/request-auth.ts";
import {
  loadTenantCentralWhatsAppContext,
  type TenantCentralWhatsAppContext,
} from "../_shared/tenant-communication.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type JsonObject = Record<string, unknown>;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_REQUEST_BYTES = 8 * 1024;
const MAX_PROVIDER_RESPONSE_BYTES = 32 * 1024;

const jsonResponse = (
  status: number,
  payload: JsonObject,
): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

async function readJsonObject(
  req: Request,
  maxBytes: number,
): Promise<JsonObject> {
  const mediaType = req.headers.get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE");
  }

  const declaredLength = req.headers.get("content-length");
  if (declaredLength) {
    if (!/^\d+$/.test(declaredLength)) {
      throw new HttpError(400, "INVALID_CONTENT_LENGTH");
    }
    const parsedLength = Number.parseInt(declaredLength, 10);
    if (!Number.isFinite(parsedLength) || parsedLength < 0) {
      throw new HttpError(400, "INVALID_CONTENT_LENGTH");
    }
    if (parsedLength > maxBytes) {
      throw new HttpError(413, "PAYLOAD_TOO_LARGE");
    }
  }

  if (!req.body) throw new HttpError(400, "EMPTY_BODY");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new HttpError(413, "PAYLOAD_TOO_LARGE");
    }
    chunks.push(value);
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(combined),
    );
  } catch {
    throw new HttpError(400, "INVALID_JSON");
  }
  if (!isJsonObject(parsed)) {
    throw new HttpError(400, "JSON_OBJECT_REQUIRED");
  }
  return parsed;
}

async function readProviderPayload(response: Response): Promise<unknown> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_PROVIDER_RESPONSE_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  if (totalBytes === 0) return null;
  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(combined));
  } catch {
    return null;
  }
}

function providerIndicatesFailure(payload: unknown): boolean {
  if (!isJsonObject(payload)) return false;
  if (
    payload.error === true ||
    typeof payload.error === "string" ||
    isJsonObject(payload.error)
  ) {
    return true;
  }
  if (typeof payload.status === "number" && payload.status >= 400) return true;
  if (typeof payload.status === "string") {
    return ["ERROR", "FAILED", "FAILURE"].includes(
      payload.status.toUpperCase(),
    );
  }
  return false;
}

function normalizeBrazilianPhone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let phone = value.replace(/\D/g, "");
  if (phone.length === 10 || phone.length === 11) phone = `55${phone}`;
  return phone.startsWith("55") && (phone.length === 12 || phone.length === 13)
    ? phone
    : null;
}

function safeMessageField(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const withoutControls = Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  }).join("");
  const cleaned = withoutControls
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  return cleaned || fallback;
}

function getEvolutionConfig(): {
  baseUrl: string;
  apiKey: string;
} {
  const rawUrl = (Deno.env.get("EVOLUTION_API_URL") ?? "")
    .trim()
    .replace(/\/+$/, "");
  const apiKey = (Deno.env.get("EVOLUTION_API_KEY") ?? "").trim();
  if (!rawUrl || !apiKey) {
    throw new HttpError(503, "NOTIFICATION_PROVIDER_UNAVAILABLE");
  }
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "https:") {
      throw new Error("invalid protocol");
    }
  } catch {
    throw new HttpError(503, "NOTIFICATION_PROVIDER_UNAVAILABLE");
  }
  return { baseUrl: rawUrl, apiKey };
}

async function compensateWelcomeMarker(
  supabase: SupabaseClient,
  student: {
    id: string;
    tenant_id: string;
    contract_sent_at: string | null;
  },
  claimTimestamp: string,
): Promise<void> {
  const { error } = await supabase
    .from("profiles")
    .update({
      wa_welcome_sent: false,
      contract_sent_at: student.contract_sent_at,
    })
    .eq("id", student.id)
    .eq("tenant_id", student.tenant_id)
    .eq("wa_welcome_sent", true)
    .eq("contract_sent_at", claimTimestamp);
  if (error) {
    console.error("[welcome-whatsapp] marker compensation failed", {
      code: error.code,
    });
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "METHOD_NOT_ALLOWED" }), {
      status: 405,
      headers: {
        ...corsHeaders,
        "Allow": "POST",
        "Content-Type": "application/json",
      },
    });
  }

  try {
    const authorization = await authorizeRequest(req, {
      corsHeaders,
      allowService: true,
      allowedRoles: ["STUDENT"],
    });
    if (authorization.ok === false) return authorization.response;

    const body = await readJsonObject(req, MAX_REQUEST_BYTES);
    const studentId = typeof body.student_id === "string"
      ? body.student_id.trim()
      : "";
    if (!UUID_PATTERN.test(studentId)) {
      throw new HttpError(400, "INVALID_STUDENT_ID");
    }

    const supabase = authorization.context.admin;
    const isService = authorization.context.isService;

    let caller:
      | { id: string; role: string; tenant_id: string | null }
      | null = null;
    if (!isService) {
      const callerProfile = authorization.context.profile;
      if (
        !callerProfile ||
        callerProfile.role !== "STUDENT" ||
        !callerProfile.tenant_id
      ) {
        throw new HttpError(403, "STUDENT_PROFILE_REQUIRED");
      }
      caller = callerProfile;
      if (caller.id !== studentId) {
        throw new HttpError(403, "FORBIDDEN");
      }
    }

    const { data: student, error: studentError } = await supabase
      .from("profiles")
      .select(
        "id, role, full_name, email, phone, tenant_id, wa_welcome_sent, contract_sent_at, contract_accepted, is_test_account",
      )
      .eq("id", studentId)
      .maybeSingle();
    if (studentError) {
      console.error("[welcome-whatsapp] student lookup failed", {
        code: studentError.code,
      });
      throw new HttpError(503, "SERVICE_UNAVAILABLE");
    }
    if (
      !student ||
      student.role !== "STUDENT" ||
      typeof student.tenant_id !== "string" ||
      !student.tenant_id
    ) {
      throw new HttpError(404, "STUDENT_NOT_FOUND");
    }
    if (
      caller &&
      (caller.tenant_id !== student.tenant_id || caller.id !== student.id)
    ) {
      throw new HttpError(403, "FORBIDDEN");
    }
    if (student.is_test_account === true) {
      return jsonResponse(200, {
        success: true,
        skipped: "test_fixture",
      });
    }
    if (student.contract_accepted !== true) {
      throw new HttpError(409, "CONTRACT_NOT_ACCEPTED");
    }
    if (student.wa_welcome_sent === true) {
      return jsonResponse(200, {
        success: true,
        skipped: "already_sent",
      });
    }

    const recipient = normalizeBrazilianPhone(student.phone);
    if (!recipient) throw new HttpError(422, "INVALID_STUDENT_PHONE");

    let communicationContext: TenantCentralWhatsAppContext | null = null;
    try {
      communicationContext = await loadTenantCentralWhatsAppContext(
        supabase,
        student.tenant_id,
        "student",
      );
    } catch {
      console.error("[welcome-whatsapp] tenant instance lookup failed", {
        reason: "lookup",
      });
      throw new HttpError(503, "SERVICE_UNAVAILABLE");
    }
    if (!communicationContext) {
      throw new HttpError(503, "WHATSAPP_INSTANCE_UNAVAILABLE");
    }
    if (!communicationContext.identity.portalUrl) {
      throw new HttpError(503, "TENANT_PORTAL_UNAVAILABLE");
    }

    const evolution = getEvolutionConfig();
    const portalUrl = communicationContext.identity.portalUrl;
    const claimTimestamp = new Date().toISOString();
    const { data: claimed, error: claimError } = await supabase
      .from("profiles")
      .update({
        wa_welcome_sent: true,
        contract_sent_at: claimTimestamp,
      })
      .eq("id", student.id)
      .eq("tenant_id", student.tenant_id)
      .eq("role", "STUDENT")
      .or("wa_welcome_sent.is.null,wa_welcome_sent.eq.false")
      .select("id")
      .maybeSingle();
    if (claimError) {
      console.error("[welcome-whatsapp] marker claim failed", {
        code: claimError.code,
      });
      throw new HttpError(503, "SERVICE_UNAVAILABLE");
    }
    if (!claimed) {
      return jsonResponse(200, {
        success: true,
        skipped: "already_sent",
      });
    }

    const fullName = safeMessageField(student.full_name, "Aluno(a)");
    const email = safeMessageField(student.email, "seu e-mail cadastrado");
    const message = `*Bem-vindo(a) à ${communicationContext.identity.brandName}!*

Olá *${fullName}*, sua matrícula foi realizada com sucesso! 🚀

Aqui estão seus dados de acesso ao portal do aluno:

📧 *Login:* ${email}
🔑 *Senha:* use a senha que você criou na matrícula

🔗 *Acesse agora:* ${portalUrl}

_Guarde essas informações com segurança!_`;

    let providerResponse: Response;
    try {
      providerResponse = await fetch(
        `${evolution.baseUrl}/message/sendText/${
          encodeURIComponent(communicationContext.instanceName)
        }`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "apikey": evolution.apiKey,
          },
          body: JSON.stringify({
            number: recipient,
            options: {
              delay: 1_200,
              presence: "composing",
              linkPreview: true,
            },
            textMessage: { text: message },
            text: message,
          }),
          signal: AbortSignal.timeout(15_000),
        },
      );
    } catch (error) {
      await compensateWelcomeMarker(
        supabase,
        {
          id: student.id,
          tenant_id: student.tenant_id,
          contract_sent_at: student.contract_sent_at,
        },
        claimTimestamp,
      );
      const timedOut = error instanceof DOMException &&
        (error.name === "TimeoutError" || error.name === "AbortError");
      console.warn("[welcome-whatsapp] provider request failed", {
        reason: timedOut ? "timeout" : "network",
      });
      throw new HttpError(
        timedOut ? 504 : 502,
        timedOut ? "NOTIFICATION_TIMEOUT" : "NOTIFICATION_PROVIDER_UNAVAILABLE",
      );
    }

    let providerPayload: unknown;
    try {
      providerPayload = await readProviderPayload(providerResponse);
    } catch {
      await compensateWelcomeMarker(
        supabase,
        {
          id: student.id,
          tenant_id: student.tenant_id,
          contract_sent_at: student.contract_sent_at,
        },
        claimTimestamp,
      );
      console.warn("[welcome-whatsapp] provider response read failed", {
        reason: "network",
      });
      throw new HttpError(502, "NOTIFICATION_PROVIDER_UNAVAILABLE");
    }
    if (
      !providerResponse.ok ||
      providerIndicatesFailure(providerPayload)
    ) {
      await compensateWelcomeMarker(
        supabase,
        {
          id: student.id,
          tenant_id: student.tenant_id,
          contract_sent_at: student.contract_sent_at,
        },
        claimTimestamp,
      );
      console.warn("[welcome-whatsapp] provider rejected request", {
        status: providerResponse.status,
      });
      throw new HttpError(502, "NOTIFICATION_PROVIDER_REJECTED");
    }

    return jsonResponse(200, {
      success: true,
      delivery: "accepted",
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonResponse(error.status, {
        error: error.code,
        code: error.code,
      });
    }
    console.error("[welcome-whatsapp] request failed", {
      reason: "internal",
    });
    return jsonResponse(500, {
      error: "INTERNAL_ERROR",
      code: "INTERNAL_ERROR",
    });
  }
});
