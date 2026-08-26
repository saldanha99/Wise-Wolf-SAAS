/// <reference lib="deno.ns" />

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import {
  HubProviderOperationError,
  runHubProviderCancellation,
} from "../_shared/hub-provider-operations.ts";
import { authorizeRequest, methodNotAllowed } from "../_shared/request-auth.ts";
import {
  CancellationValidationError,
  parseCancellationRequest,
} from "./core.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return methodNotAllowed(corsHeaders);

  const auth = await authorizeRequest(req, {
    allowInactiveTenant: true,
    corsHeaders,
    allowService: false,
  });
  if (auth.ok === false) return auth.response;

  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      throw new CancellationValidationError(
        "INVALID_HUB_CANCELLATION_REQUEST",
      );
    }
    const { accountId } = parseCancellationRequest(body);
    const actorUserId = auth.context.userId;
    if (!actorUserId) {
      return json(401, {
        error: "AUTHENTICATION_REQUIRED",
        code: "AUTHENTICATION_REQUIRED",
      });
    }

    const result = await runHubProviderCancellation({
      admin: auth.context.admin,
      operationKind: "CORE_CANCELLATION",
      accountId,
      actorUserId,
    });
    return json(200, result);
  } catch (error) {
    if (error instanceof CancellationValidationError) {
      return json(
        error.code === "INVALID_HUB_CANCELLATION_REQUEST" ? 400 : 409,
        { error: error.code, code: error.code },
      );
    }
    if (error instanceof HubProviderOperationError) {
      const status = error.code.includes("RECONCILIATION") ||
          error.code.includes("SCOPE_CHANGED") ||
          error.code.includes("VERSION_CHANGED")
        ? 409
        : 503;
      return json(status, { error: error.code, code: error.code });
    }
    console.error("Hub self-service cancellation failed", {
      type: error instanceof Error ? error.name : "UnknownError",
    });
    return json(500, {
      error: "HUB_CANCELLATION_FAILED",
      code: "HUB_CANCELLATION_FAILED",
    });
  }
});
