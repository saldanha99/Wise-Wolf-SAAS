/// <reference lib="deno.ns" />
// Atividade por link/QR (Hub Fase 1): o professor gera o link e o QR; o aluno abre sem cadastro
// e vê a versão do aluno (sem gabarito). O banco guarda só o sha256 do token.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.93.3";
import { toString as qrToString } from "https://esm.sh/qrcode@1.5.4";
import { authorizeRequest, methodNotAllowed } from "../_shared/request-auth.ts";
import {
  isShareToken,
  isUuid,
  newShareToken,
  sha256Hex,
  shareUrl,
  statusForCode,
} from "./core.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store, max-age=0",
};

const json = (status: number, payload: Record<string, unknown>) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

function serviceClient() {
  const url = (Deno.env.get("SUPABASE_URL") ?? "").trim();
  const key = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "").trim();
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return methodNotAllowed(corsHeaders);
  let body: Record<string, unknown>;
  try {
    const raw = await req.text();
    if (raw.length > 4_000) return json(413, { code: "REQUEST_TOO_LARGE" });
    body = JSON.parse(raw || "{}");
  } catch {
    return json(400, { code: "INVALID_JSON" });
  }
  const admin = serviceClient();
  if (!admin) return json(503, { code: "SERVICE_UNAVAILABLE" });

  // Aluno: abre o link sem login.
  if (body.action === "view") {
    if (!isShareToken(body.token)) return json(404, { code: "LINK_INVALID" });
    const { data, error } = await admin.rpc("hub_material_share_view", {
      p_token_sha256: await sha256Hex(body.token),
    });
    if (error) {
      console.error("Hub share view failed", { code: error.code });
      return json(503, { code: "SERVICE_UNAVAILABLE" });
    }
    if (!data?.ok) {
      const code = String(data?.code ?? "LINK_INVALID");
      return json(statusForCode(code), { code });
    }
    return json(200, data);
  }

  // Professor: cria ou revoga.
  const auth = await authorizeRequest(req, {
    corsHeaders,
    allowedRoles: [
      "NON_STUDENT",
      "TEACHER",
      "SCHOOL_ADMIN",
      "SUPER_ADMIN",
      "COORDINATOR",
    ],
  });
  if (auth.ok === false) return auth.response;
  const userId = auth.context.userId;
  if (!userId || !isUuid(body.materialId)) {
    return json(400, { code: "INVALID_REQUEST" });
  }

  if (body.action === "create") {
    const token = newShareToken();
    const { data, error } = await admin.rpc("hub_material_share_create", {
      p_user_id: userId,
      p_material_id: body.materialId,
      p_token_sha256: await sha256Hex(token),
    });
    if (error) {
      console.error("Hub share create failed", { code: error.code });
      return json(503, { code: "SERVICE_UNAVAILABLE" });
    }
    if (!data?.ok) {
      const code = String(data?.code ?? "MATERIAL_ACCESS_DENIED");
      return json(statusForCode(code), { code });
    }
    const url = shareUrl(token, Deno.env.get("HUB_PUBLIC_URL"));
    const qrSvg = await qrToString(url, {
      type: "svg",
      margin: 1,
      errorCorrectionLevel: "M",
    });
    return json(200, { url, qrSvg, expiresAt: data.expiresAt });
  }

  if (body.action === "revoke") {
    const { data, error } = await admin.rpc("hub_material_share_revoke", {
      p_user_id: userId,
      p_material_id: body.materialId,
    });
    if (error) return json(503, { code: "SERVICE_UNAVAILABLE" });
    if (!data?.ok) {
      const code = String(data?.code ?? "MATERIAL_ACCESS_DENIED");
      return json(statusForCode(code), { code });
    }
    return json(200, { revoked: data.revoked ?? 0 });
  }

  return json(400, { code: "INVALID_ACTION" });
});
