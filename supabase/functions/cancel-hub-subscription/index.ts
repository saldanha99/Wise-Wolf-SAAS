/// <reference lib="deno.ns" />

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { providerCancellationIsFinal } from "../_shared/hub-billing-safety.ts";
import { authorizeRequest, methodNotAllowed } from "../_shared/request-auth.ts";
import {
  cancellationAlreadyScheduled,
  CancellationValidationError,
  collectProviderSubscriptionIds,
  parseCancellationRequest,
} from "./core.ts";

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

function cancellationResponse(subscription: {
  id: string;
  status: string;
  current_period_ends_at: string | null;
  metadata: Record<string, unknown> | null;
}): Record<string, unknown> {
  return {
    success: true,
    idempotent: true,
    subscriptionId: subscription.id,
    status: subscription.status,
    cancelAtPeriodEnd: true,
    accessEndsAt: subscription.current_period_ends_at,
    cancellationRequestedAt: subscription.metadata?.cancellationRequestedAt ??
      null,
  };
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
      redirect: "error",
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
    allowService: false,
  });
  if (auth.ok === false) return auth.response;

  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      throw new ApiError(400, "INVALID_HUB_CANCELLATION_REQUEST");
    }
    const { accountId } = parseCancellationRequest(body);
    const actorUserId = auth.context.userId;
    if (!actorUserId) throw new ApiError(401, "AUTHENTICATION_REQUIRED");

    const [accountResult, membershipResult, liveSubscriptionResult] =
      await Promise.all([
        auth.context.admin
          .from("hub_accounts")
          .select("id, status")
          .eq("id", accountId)
          .maybeSingle(),
        auth.context.admin
          .from("hub_memberships")
          .select("membership_role, status")
          .eq("account_id", accountId)
          .eq("user_id", actorUserId)
          .eq("status", "ACTIVE")
          .maybeSingle(),
        auth.context.admin
          .from("hub_subscriptions")
          .select(
            "id, account_id, status, product_family, provider, provider_subscription_id, current_period_ends_at, metadata",
          )
          .eq("account_id", accountId)
          .eq("product_family", "HUB_CORE")
          .eq("status", "ACTIVE")
          .gt("current_period_ends_at", new Date().toISOString())
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);
    if (accountResult.error) throw accountResult.error;
    if (membershipResult.error) throw membershipResult.error;
    if (liveSubscriptionResult.error) throw liveSubscriptionResult.error;
    if (!accountResult.data) throw new ApiError(404, "HUB_ACCOUNT_NOT_FOUND");
    if (accountResult.data.status !== "ACTIVE") {
      throw new ApiError(409, "HUB_ACCOUNT_INACTIVE");
    }
    if (
      !membershipResult.data ||
      !["OWNER", "ADMIN"].includes(
        membershipResult.data.membership_role,
      )
    ) {
      throw new ApiError(403, "HUB_MANAGER_REQUIRED");
    }

    let subscription = liveSubscriptionResult.data;
    if (!subscription) {
      const { data: latestSubscription, error: latestSubscriptionError } =
        await auth.context.admin
          .from("hub_subscriptions")
          .select(
            "id, account_id, status, product_family, provider, provider_subscription_id, current_period_ends_at, metadata",
          )
          .eq("account_id", accountId)
          .eq("product_family", "HUB_CORE")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
      if (latestSubscriptionError) throw latestSubscriptionError;
      if (
        latestSubscription &&
        cancellationAlreadyScheduled(latestSubscription.metadata)
      ) {
        return json(200, cancellationResponse(latestSubscription));
      }
      throw new ApiError(409, "HUB_ACTIVE_PAID_SUBSCRIPTION_REQUIRED");
    }

    if (cancellationAlreadyScheduled(subscription.metadata)) {
      return json(200, cancellationResponse(subscription));
    }

    if (!ASAAS_TOKEN) throw new ApiError(503, "HUB_PROVIDER_UNAVAILABLE");
    const { error: beginError } = await auth.context.admin.rpc(
      "hub_begin_core_cancellation",
      {
        p_account_id: accountId,
        p_actor_user_id: actorUserId,
      },
    );
    if (beginError) {
      const code = ["42501", "55000"].includes(beginError.code || "")
        ? "HUB_CANCELLATION_RECONCILIATION_REQUIRED"
        : "HUB_CANCELLATION_BEGIN_FAILED";
      throw new ApiError(409, code);
    }

    const { data: checkouts, error: checkoutsError } = await auth.context.admin
      .from("hub_checkout_sessions")
      .select("id, status, asaas_subscription_id, asaas_payment_id")
      .eq("account_id", accountId)
      .eq("product_family", "HUB_CORE")
      .in("status", ["CREATED", "PENDING", "OVERDUE", "PAID"]);
    if (checkoutsError) throw checkoutsError;

    const providerSubscriptionIds = collectProviderSubscriptionIds(
      subscription,
      checkouts || [],
    );
    const [accountRecheck, membershipRecheck, subscriptionRecheck] =
      await Promise.all([
        auth.context.admin
          .from("hub_accounts")
          .select("id")
          .eq("id", accountId)
          .eq("status", "ACTIVE")
          .maybeSingle(),
        auth.context.admin
          .from("hub_memberships")
          .select("id")
          .eq("account_id", accountId)
          .eq("user_id", actorUserId)
          .eq("status", "ACTIVE")
          .in("membership_role", ["OWNER", "ADMIN"])
          .maybeSingle(),
        auth.context.admin
          .from("hub_subscriptions")
          .select("id")
          .eq("id", subscription.id)
          .eq("account_id", accountId)
          .eq("status", "ACTIVE")
          .eq("product_family", "HUB_CORE")
          .eq("provider", "ASAAS")
          .contains("metadata", { cancellationInProgress: true })
          .eq(
            "provider_subscription_id",
            subscription.provider_subscription_id,
          )
          .maybeSingle(),
      ]);
    if (
      accountRecheck.error || membershipRecheck.error ||
      subscriptionRecheck.error
    ) {
      throw accountRecheck.error || membershipRecheck.error ||
        subscriptionRecheck.error;
    }
    if (
      !accountRecheck.data || !membershipRecheck.data ||
      !subscriptionRecheck.data
    ) {
      throw new ApiError(409, "HUB_CANCELLATION_SCOPE_CHANGED");
    }

    for (const providerSubscriptionId of providerSubscriptionIds) {
      await cancelProviderSubscription(providerSubscriptionId);
    }

    const { data: result, error: finalizeError } = await auth.context.admin.rpc(
      "hub_schedule_core_cancellation",
      {
        p_account_id: accountId,
        p_actor_user_id: actorUserId,
        p_cancelled_provider_subscription_ids: providerSubscriptionIds,
      },
    );
    if (finalizeError) {
      const code = ["42501", "55000"].includes(finalizeError.code || "")
        ? "HUB_CANCELLATION_RECONCILIATION_REQUIRED"
        : "HUB_CANCELLATION_FINALIZATION_FAILED";
      throw new ApiError(409, code);
    }

    return json(200, result as Record<string, unknown>);
  } catch (error) {
    if (error instanceof CancellationValidationError) {
      const status = error.code === "INVALID_HUB_CANCELLATION_REQUEST"
        ? 400
        : 409;
      return json(status, { error: error.code, code: error.code });
    }
    if (error instanceof ApiError) {
      return json(error.status, { error: error.code, code: error.code });
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
