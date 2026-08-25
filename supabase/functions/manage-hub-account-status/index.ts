/// <reference lib="deno.ns" />

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { authorizeRequest, methodNotAllowed } from "../_shared/request-auth.ts";
import { providerCancellationIsFinal } from "../_shared/hub-billing-safety.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ASAAS_URL = (Deno.env.get("ASAAS_API_URL") || "https://api.asaas.com")
  .replace(/\/+$/, "")
  .replace(/\/v3$/, "");
const ASAAS_TOKEN =
  (Deno.env.get("ASAAS_ACCESS_TOKEN") || Deno.env.get("ASAAS_API_KEY") || "")
    .trim();
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

async function cancelProviderSubscription(subscriptionId: string) {
  const response = await fetch(
    `${ASAAS_URL}/v3/subscriptions/${encodeURIComponent(subscriptionId)}`,
    {
      method: "DELETE",
      headers: {
        access_token: ASAAS_TOKEN,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!providerCancellationIsFinal(response.status)) {
    throw new ApiError(503, "HUB_PROVIDER_CANCELLATION_FAILED");
  }
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

    const { data: account, error: accountError } = await auth.context.admin
      .from("hub_accounts")
      .select("id, status")
      .eq("id", accountId)
      .maybeSingle();
    if (accountError) throw accountError;
    if (!account) throw new ApiError(404, "HUB_ACCOUNT_NOT_FOUND");

    const { data: subscriptions, error: subscriptionsError } = await auth
      .context.admin
      .from("hub_subscriptions")
      .select(
        "id, provider, provider_subscription_id, hub_plans!inner(code)",
      )
      .eq("account_id", accountId)
      .in("status", ["TRIALING", "INCOMPLETE", "ACTIVE", "PAST_DUE"]);
    if (subscriptionsError) throw subscriptionsError;

    const { data: checkouts, error: checkoutsError } = await auth.context.admin
      .from("hub_checkout_sessions")
      .select("id, status, asaas_subscription_id, asaas_payment_id")
      .eq("account_id", accountId)
      .in("status", ["CREATED", "PENDING", "OVERDUE", "PAID"]);
    if (checkoutsError) throw checkoutsError;

    const providerSubscriptionIds = new Set<string>();
    for (const subscription of subscriptions || []) {
      const plan = Array.isArray(subscription.hub_plans)
        ? subscription.hub_plans[0]
        : subscription.hub_plans;
      const providerSubscriptionId = subscription.provider_subscription_id
        ?.trim() || "";
      if (
        plan?.code === "DISCOVERY" && !subscription.provider &&
        !providerSubscriptionId
      ) {
        continue;
      }
      if (
        subscription.provider !== "ASAAS" || !providerSubscriptionId ||
        providerSubscriptionId.length > 200
      ) {
        throw new ApiError(409, "HUB_SUBSCRIPTION_RECONCILIATION_REQUIRED");
      }
      providerSubscriptionIds.add(providerSubscriptionId);
    }

    for (const checkout of checkouts || []) {
      const providerSubscriptionId = checkout.asaas_subscription_id?.trim() ||
        "";
      if (!providerSubscriptionId) {
        if (checkout.status !== "CREATED" || checkout.asaas_payment_id) {
          throw new ApiError(409, "HUB_SUBSCRIPTION_RECONCILIATION_REQUIRED");
        }
        continue;
      }
      if (providerSubscriptionId.length > 200) {
        throw new ApiError(409, "HUB_SUBSCRIPTION_RECONCILIATION_REQUIRED");
      }
      providerSubscriptionIds.add(providerSubscriptionId);
    }

    if (providerSubscriptionIds.size > 0 && !ASAAS_TOKEN) {
      throw new ApiError(503, "HUB_PROVIDER_UNAVAILABLE");
    }
    for (const providerSubscriptionId of providerSubscriptionIds) {
      await cancelProviderSubscription(providerSubscriptionId);
    }

    const { data: result, error: finalizeError } = await auth.context.admin.rpc(
      "hub_finalize_account_status_change",
      {
        p_account_id: accountId,
        p_target_status: targetStatus,
        p_cancelled_provider_subscription_ids: [
          ...providerSubscriptionIds,
        ],
        p_actor_user_id: auth.context.userId,
        p_reason: reason || "ADMIN_REQUEST",
      },
    );
    if (finalizeError) {
      if (["42501", "55000"].includes(finalizeError.code || "")) {
        throw new ApiError(409, "HUB_STATUS_RECONCILIATION_REQUIRED");
      }
      throw finalizeError;
    }

    return json(200, { success: true, account, result });
  } catch (error) {
    if (error instanceof ApiError) {
      return json(error.status, { error: error.code, code: error.code });
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
