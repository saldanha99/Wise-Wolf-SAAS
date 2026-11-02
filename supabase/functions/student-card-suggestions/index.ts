/// <reference lib="deno.ns" />
// Sugestões da IA para o cartão do aluno (migration 20260928130000).
//
// Duas portas:
//   * {"action":"tick"} — só a chave de serviço (cron wisewolf-student-card-
//     suggestions, que só chama quando o banco tem aula pronta): lê até 3 aulas
//     aprovadas e autorizadas e grava as sugestões PENDING;
//   * {"action":"generate","student_id":"…"} — o professor (ou coordenação/
//     direção) pelo botão do cartão no dossiê: lê a aula aprovada mais recente
//     ainda não lida. A permissão é a do cartão, conferida no banco como a
//     própria pessoa.
//
// Nenhuma resposta leva texto da aula nem das sugestões (a do cron fica
// guardada no pg_net); a tela relê pelo get_student_card_suggestions.
//
// Configuração (runtime das edge functions, na VPS):
//   STUDENT_CARD_SUGGESTIONS_ENABLED=true   liga (ausente = desligado)
//   STUDENT_CARD_SUGGESTIONS_MODEL          fornecedor/modelo; ausente = o do
//                                           resumo (GOOGLE_MEET_SUMMARY_MODEL)
//   OPENROUTER_API_KEY                      a mesma do resumo e do Planner
// O modelo precisa de preço em ai_model_pricing com o MESMO id.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.93.3";
import { authorizeRequest } from "../_shared/request-auth.ts";
import { recordAiUsage } from "../_shared/ai-usage.ts";
import { isRecord, type SummaryPricing, text } from "../google-meet/core.ts";
import { suggestionsModelId } from "./core.ts";
import {
  runManualSuggestions,
  runSuggestionsTick,
  type SuggestionBackend,
  type SuggestionDeps,
} from "./runner.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization,x-client-info,apikey,content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });

// O worker morre em 150 s: trabalho novo só até 125 s.
const DEADLINE_MS = 125_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function config() {
  const env = (key: string) => Deno.env.get(key)?.trim() || "";
  const key = env("OPENROUTER_API_KEY");
  const model = suggestionsModelId(
    env("STUDENT_CARD_SUGGESTIONS_MODEL"),
    env("GOOGLE_MEET_SUMMARY_MODEL"),
  );
  return {
    aiEnabled: env("STUDENT_CARD_SUGGESTIONS_ENABLED") === "true" && !!key &&
      !!model,
    key,
    model: model || "",
  };
}

async function loadPricing(
  db: SupabaseClient,
  model: string,
): Promise<SummaryPricing | null> {
  if (!model) return null;
  const { data, error } = await db.from("ai_model_pricing").select(
    "input_usd_per_1m,output_usd_per_1m,cached_usd_per_1m",
  ).eq("model", model).maybeSingle();
  if (error || !data) return null;
  return {
    input_usd_per_1m: Number(data.input_usd_per_1m),
    output_usd_per_1m: Number(data.output_usd_per_1m),
    cached_usd_per_1m: Number(data.cached_usd_per_1m || 0),
  };
}

function deps(db: SupabaseClient, model: string): SuggestionDeps {
  const backend: SuggestionBackend = async (action, scope, payload = {}) => {
    const { data, error } = await db.rpc("student_card_suggestions_backend", {
      p_action: action,
      p_tenant_id: scope.tenantId,
      p_actor_id: scope.actorId,
      p_session_id: scope.sessionId,
      p_payload: payload,
    });
    if (error) {
      throw new Error(
        /^[a-z_]+$/.test(error.message || "")
          ? error.message
          : "card_suggestions_storage_unavailable",
      );
    }
    return isRecord(data) ? data : {};
  };
  return {
    backend,
    recordUsage: (usage, scope) =>
      recordAiUsage(db, {
        tenantId: scope.tenantId,
        userId: scope.actorId,
        feature: "student_card_suggestions",
        provider: "openrouter",
        model,
        usage: {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cachedTokens: usage.cachedTokens,
          reasoningTokens: usage.reasoningTokens,
        },
      }),
  };
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const authorization = await authorizeRequest(req, {
    allowedRoles: ["TEACHER", "COORDINATOR", "SCHOOL_ADMIN"],
    allowService: true,
    corsHeaders: cors,
  });
  if (authorization.ok === false) return authorization.response;
  const auth = authorization.context, db = auth.admin;
  const started = Date.now();
  const cfg = config();
  try {
    const bodyText = await req.text();
    if (bodyText.length > 4000) {
      return json({ error: "request_too_large" }, 413);
    }
    const body: unknown = JSON.parse(bodyText || "{}");
    if (!isRecord(body)) return json({ error: "invalid_request" }, 400);
    const action = text(body.action, 20);

    if (action === "tick") {
      if (!auth.isService) return json({ error: "forbidden" }, 403);
      const result = await runSuggestionsTick({
        aiEnabled: cfg.aiEnabled,
        key: cfg.key,
        model: cfg.model,
        loadPricing: () => loadPricing(db, cfg.model),
        deadline: started + DEADLINE_MS,
      }, deps(db, cfg.model));
      return json({ ok: true, ...result });
    }

    if (action === "generate") {
      const tenantId = auth.profile?.tenant_id || "";
      const actorId = auth.userId || "";
      const studentId = UUID.test(text(body.student_id, 40))
        ? text(body.student_id, 40)
        : "";
      if (auth.isService || !tenantId || !actorId) {
        return json({ error: "forbidden" }, 403);
      }
      if (!studentId) return json({ error: "invalid_student" }, 400);
      const outcome = await runManualSuggestions({
        tenantId,
        actorId,
        studentId,
        aiEnabled: cfg.aiEnabled,
        key: cfg.key,
        model: cfg.model,
        loadPricing: () => loadPricing(db, cfg.model),
        deadline: started + DEADLINE_MS,
      }, deps(db, cfg.model));
      // Só o estado e as contagens: a tela relê as sugestões pela RPC.
      if (outcome.status === "SUCCEEDED") {
        return json({
          ok: true,
          status: outcome.status,
          saved: outcome.saved,
          dropped: outcome.dropped,
        });
      }
      if (outcome.status === "FAILED") {
        return json(
          { ok: false, status: outcome.status, error: outcome.error },
          502,
        );
      }
      return json({
        ok: false,
        status: outcome.status,
        reason: outcome.reason,
      });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "";
    if (message === "sem_permissao") return json({ error: message }, 403);
    console.error("[student-card-suggestions] falhou", {
      code: /^[a-z_]{1,80}$/.test(message) ? message : "unexpected",
    });
    return json({
      error: /^[a-z_]{1,80}$/.test(message)
        ? message
        : "card_suggestions_failed",
    }, 500);
  }
});
