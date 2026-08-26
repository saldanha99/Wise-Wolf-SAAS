/// <reference lib="deno.ns" />

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import {
  HubProviderOperationError,
  runHubProviderCancellation,
} from "../_shared/hub-provider-operations.ts";
import { authorizeRequest, methodNotAllowed } from "../_shared/request-auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
    this.name = "ApiError";
  }
}

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
    corsHeaders,
    allowService: true,
    allowedRoles: ["SUPER_ADMIN"],
  });
  if (auth.ok === false) return auth.response;

  try {
    const body = await req.json() as Record<string, unknown>;
    if (
      Object.keys(body).some((key) =>
        !["accountId", "targetStatus", "reason"].includes(key)
      )
    ) {
      throw new ApiError(400, "INVALID_HUB_STATUS_REQUEST");
    }
    const accountId = typeof body.accountId === "string"
      ? body.accountId.trim()
      : "";
    const targetStatus = typeof body.targetStatus === "string"
      ? body.targetStatus.trim().toUpperCase()
      : "";
    const reason = typeof body.reason === "string"
      ? body.reason.trim().slice(0, 200)
      : "ADMIN_REQUEST";
    if (
      !UUID_PATTERN.test(accountId) ||
      !["SUSPENDED", "CLOSED"].includes(targetStatus)
    ) {
      throw new ApiError(400, "INVALID_HUB_STATUS_REQUEST");
    }

    const result = await runHubProviderCancellation({
      admin: auth.context.admin,
      operationKind: "ACCOUNT_STATUS",
      accountId,
      actorUserId: auth.context.userId || null,
      targetStatus: targetStatus as "SUSPENDED" | "CLOSED",
      reason: reason || "ADMIN_REQUEST",
    });
    return json(200, { success: true, result });
  } catch (error) {
    if (error instanceof ApiError) {
      return json(error.status, { error: error.code, code: error.code });
    }
    if (error instanceof HubProviderOperationError) {
      const status = error.code.includes("RECONCILIATION") ||
          error.code.includes("SCOPE_CHANGED") ||
          error.code.includes("VERSION_CHANGED")
        ? 409
        : 503;
      return json(status, { error: error.code, code: error.code });
    }
    console.error("Hub account status change failed", {
      type: error instanceof Error ? error.name : "UnknownError",
    });
    return json(500, {
      error: "HUB_STATUS_CHANGE_FAILED",
      code: "HUB_STATUS_CHANGE_FAILED",
    });
  }
});
