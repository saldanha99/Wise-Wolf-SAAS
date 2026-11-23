/// <reference lib="deno.ns" />
// Atividade por link/QR (Hub Fase 1): o professor gera o link e o QR; o aluno abre sem cadastro
// e vê a versão do aluno (sem gabarito). O banco guarda só o sha256 do token.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.93.3";
import { toString as qrToString } from "https://esm.sh/qrcode@1.5.4";
import { authorizeRequest, methodNotAllowed } from "../_shared/request-auth.ts";
import { aiFetch, textAiKey } from "../_shared/ai-gateway.ts";
import { parseAiUsage, recordAiUsage } from "../_shared/ai-usage.ts";
import {
  buildOpenPrompt,
  gradeClosed,
  type KeyMode,
  mergeOpenFeedback,
  OPEN_FEEDBACK_SCHEMA,
  parseAnswers,
} from "./grade.ts";
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
    if (raw.length > 40_000) return json(413, { code: "REQUEST_TOO_LARGE" });
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

  // Aluno: envia as respostas (sem login). Fechadas por código; abertas pela IA, na cota.
  if (body.action === "submit") {
    if (!isShareToken(body.token)) return json(404, { code: "LINK_INVALID" });
    const answers = parseAnswers(body.answers);
    if (!answers) return json(400, { code: "INVALID_ANSWERS" });
    const studentName = typeof body.studentName === "string"
      ? body.studentName.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 80)
      : "";
    const { data: ctx, error: ctxError } = await admin.rpc(
      "hub_material_share_for_grading",
      { p_token_sha256: await sha256Hex(body.token) },
    );
    if (ctxError) return json(503, { code: "SERVICE_UNAVAILABLE" });
    if (!ctx?.ok) {
      const code = String(ctx?.code ?? "LINK_INVALID");
      return json(
        code === "SUBMISSION_LIMIT_REACHED" ? 429 : statusForCode(code),
        { code },
      );
    }
    const mode: KeyMode = ctx.answerKeyMode === "never"
      ? "never"
      : "after_submit";
    const graded = gradeClosed(ctx.material ?? {}, answers, mode);
    let items = graded.items;
    let aiCorrected = false;
    if (graded.open.length && Number(ctx.aiRemaining) > 0 && textAiKey()) {
      try {
        const response = await aiFetch(
          "https://openrouter.ai/api/v1/chat/completions",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${textAiKey()}`,
            },
            body: JSON.stringify({
              model: "anthropic/claude-haiku",
              messages: [
                {
                  role: "system",
                  content: "Return only JSON that matches the schema.",
                },
                {
                  role: "user",
                  content: buildOpenPrompt(
                    String(ctx.level ?? "A2"),
                    graded.open,
                  ),
                },
              ],
              max_tokens: 1_500,
              response_format: {
                type: "json_schema",
                json_schema: {
                  name: "hub_open_feedback",
                  strict: true,
                  schema: OPEN_FEEDBACK_SCHEMA,
                },
              },
            }),
            signal: AbortSignal.timeout(40_000),
          },
        );
        if (response.ok) {
          const payload = await response.json();
          const text = payload?.choices?.[0]?.message?.content;
          const parsed = typeof text === "string"
            ? JSON.parse(text.replace(/^```(?:json)?|```$/g, "").trim())
            : null;
          items = mergeOpenFeedback(items, parsed, mode);
          aiCorrected = true;
          await recordAiUsage(admin, {
            tenantId: null,
            userId: String(ctx.ownerUserId),
            feature: "hub_share_correction",
            provider: "anthropic",
            model: "anthropic/claude-haiku",
            usage: parseAiUsage(payload),
          });
        }
      } catch (error) {
        console.warn("Hub share AI correction failed", {
          reason: (error as Error).name,
        });
      }
    }
    if (!aiCorrected) {
      items = items.map((it) =>
        it.kind === "open" && it.given
          ? {
            ...it,
            feedback_pt:
              "Resposta registrada. Seu professor vai ver e comentar.",
          }
          : it
      );
    }
    const result = {
      items,
      right: graded.right,
      total: graded.total,
      keyMode: mode,
    };
    const { error: recordError } = await admin.rpc(
      "hub_material_share_record",
      {
        p_link_id: ctx.linkId,
        p_student_name: studentName,
        p_answers: answers,
        p_result: result,
        p_closed_right: graded.right,
        p_closed_total: graded.total,
        p_ai_corrected: aiCorrected,
      },
    );
    if (recordError) {
      console.error("Hub share record failed", { code: recordError.code });
      return json(503, { code: "SERVICE_UNAVAILABLE" });
    }
    return json(200, result);
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
    if (body.answerKeyMode === "never") {
      await admin.rpc("hub_material_share_set_mode", {
        p_user_id: userId,
        p_token_sha256: await sha256Hex(token),
        p_mode: "never",
      });
    }
    const url = shareUrl(token, Deno.env.get("HUB_PUBLIC_URL"));
    const qrSvg = await qrToString(url, {
      type: "svg",
      margin: 1,
      errorCorrectionLevel: "M",
    });
    return json(200, { url, qrSvg, expiresAt: data.expiresAt });
  }

  if (body.action === "results") {
    const { data, error } = await admin.rpc("hub_material_share_results", {
      p_user_id: userId,
      p_material_id: body.materialId,
    });
    if (error) return json(503, { code: "SERVICE_UNAVAILABLE" });
    if (!data?.ok) {
      const code = String(data?.code ?? "MATERIAL_ACCESS_DENIED");
      return json(statusForCode(code), { code });
    }
    return json(200, { submissions: data.submissions ?? [] });
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
