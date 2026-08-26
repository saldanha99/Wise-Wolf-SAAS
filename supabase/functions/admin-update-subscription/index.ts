/// <reference lib="deno.ns" />

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  asaasSubscriptionPostconditionMismatchFields,
  type CanonicalAsaasMutationTarget,
  guardAsaasMutationTarget,
  revalidateCanonicalAsaasBinding,
} from "../_shared/asaas-mutation-guard.ts";
import {
  claimAsaasSubscriptionMutation,
  finishAsaasSubscriptionMutation,
  markAsaasSubscriptionMutationSubmitting,
} from "../_shared/asaas-subscription-mutation.ts";
import { authorizeRequest, methodNotAllowed } from "../_shared/request-auth.ts";
import { ambiguousProviderMutationStatus } from "../_shared/student-provider-lifecycle.ts";
import {
  AsaasCapabilityFenceError,
  revalidateAsaasMutationCapability,
} from "../_shared/asaas-capability-fence.ts";
import {
  resolveAsaasIntegration,
  type ResolvedAsaasIntegration,
  TenantIntegrationBrokerError,
} from "../_shared/tenant-integration-broker.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function providerMaxPayments(entity: Record<string, unknown>): number | null {
  const value = Number(entity.maxPayments);
  return Number.isInteger(value) && value >= 1 && value <= 120 ? value : null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return methodNotAllowed(corsHeaders);

  const auth = await authorizeRequest(req, {
    corsHeaders,
    allowedRoles: ["SUPER_ADMIN"],
  });
  if (auth.ok === false) return auth.response;

  try {
    const body = await req.json();
    const action = body.action === "get" || body.action === "update"
      ? body.action
      : null;
    const subscriptionId = typeof body.subscriptionId === "string"
      ? body.subscriptionId.trim()
      : "";
    const maxPayments = Number(body.maxPayments);
    if (!action || !/^[A-Za-z0-9_-]{3,120}$/.test(subscriptionId)) {
      return json({ error: "Invalid request" }, 400);
    }
    if (
      action === "update" &&
      (!Number.isInteger(maxPayments) || maxPayments < 1 || maxPayments > 120)
    ) {
      return json({ error: "Invalid payment limit" }, 400);
    }

    const { data: owners, error: ownerError } = await auth.context.admin
      .from("profiles")
      .select("id,tenant_id,asaas_customer_id,subscription_id")
      .eq("role", "STUDENT")
      .eq("subscription_id", subscriptionId)
      .limit(2);
    if (ownerError) {
      return json({ error: "Subscription scope unavailable" }, 503);
    }
    if (!owners || owners.length !== 1 || !owners[0].tenant_id) {
      return json({ error: "Subscription scope is invalid" }, 409);
    }
    const integration = await resolveAsaasIntegration(
      auth.context.admin,
      owners[0].tenant_id,
      action === "update" ? "subscription.update" : "subscription.read",
    );
    const mutationTarget: CanonicalAsaasMutationTarget = {
      tenantId: owners[0].tenant_id,
      studentId: owners[0].id,
      resource: "subscription",
      entityId: subscriptionId,
      customerId: String(owners[0].asaas_customer_id || "").trim(),
      subscriptionId: String(owners[0].subscription_id || "").trim() || null,
      subscriptionMatch: "entity_id",
    };
    const guard = await guardAsaasMutationTarget({
      admin: auth.context.admin,
      baseUrl: integration.baseUrl,
      apiKey: integration.apiKey,
      operation: action === "update"
        ? "admin_subscription_update"
        : "admin_subscription_read",
      target: mutationTarget,
    });
    if (!guard.ok) {
      return json({ error: "Subscription binding requires review" }, 409);
    }
    if (action === "get") return json(guard.entity);

    const currentMaxPayments = providerMaxPayments(guard.entity);
    if (currentMaxPayments === null) {
      return json({ error: "Subscription state requires review" }, 409);
    }
    const mutation = await claimAsaasSubscriptionMutation(
      auth.context.admin,
      {
        tenantId: mutationTarget.tenantId,
        studentId: mutationTarget.studentId,
        customerId: mutationTarget.customerId,
        subscriptionId,
        mutationKind: "MAX_PAYMENTS",
        intentKey: `admin-max-payments:${crypto.randomUUID()}`,
        expectedState: { maxPayments: currentMaxPayments },
        desiredState: { maxPayments },
        integration,
        mutationPayload: { maxPayments },
        requestedBy: auth.context.userId,
      },
    );
    if (mutation.action === "IN_PROGRESS") {
      return json({ error: "Subscription update is already in progress" }, 409);
    }
    if (mutation.action === "REVIEW_REQUIRED" || !mutation.ok) {
      return json({ error: "Subscription update requires review" }, 409);
    }
    if (
      mutation.action === "ALREADY_SUCCEEDED" ||
      mutation.action === "RECONCILE_REQUIRED"
    ) {
      if (currentMaxPayments !== maxPayments) {
        return json({ error: "Subscription update is unconfirmed" }, 503);
      }
      if (
        mutation.action === "RECONCILE_REQUIRED" &&
        !await finishAsaasSubscriptionMutation(
          auth.context.admin,
          mutation,
          {
            status: "SUCCEEDED",
            observedState: { maxPayments },
            providerHttpStatus: guard.providerStatus,
          },
        )
      ) {
        return json({ error: "Subscription update is unconfirmed" }, 503);
      }
      return json(guard.entity, 200);
    }

    if (currentMaxPayments === maxPayments) {
      if (
        !await finishAsaasSubscriptionMutation(
          auth.context.admin,
          mutation,
          {
            status: "SUCCEEDED",
            observedState: { maxPayments },
            providerHttpStatus: guard.providerStatus,
          },
        )
      ) {
        return json({ error: "Subscription update is unconfirmed" }, 503);
      }
      return json(guard.entity, 200);
    }

    if (
      !(await revalidateCanonicalAsaasBinding({
        admin: auth.context.admin,
        operation: "admin_subscription_update",
        target: mutationTarget,
      }))
    ) {
      await finishAsaasSubscriptionMutation(auth.context.admin, mutation, {
        status: "BLOCKED",
        error: "canonical_binding_changed_before_provider_submit",
      });
      return json({ error: "Subscription binding changed" }, 409);
    }

    if (
      !await markAsaasSubscriptionMutationSubmitting(
        auth.context.admin,
        mutation,
      )
    ) {
      return json({ error: "Subscription update claim was lost" }, 409);
    }

    let submitIntegration: ResolvedAsaasIntegration;
    try {
      submitIntegration = await revalidateAsaasMutationCapability(
        auth.context.admin,
        {
          tenantId: mutationTarget.tenantId,
          purpose: "subscription.update",
          expected: integration,
        },
      );
    } catch (error) {
      const unavailable = error instanceof AsaasCapabilityFenceError &&
        error.failure === "UNAVAILABLE";
      await finishAsaasSubscriptionMutation(auth.context.admin, mutation, {
        status: unavailable ? "FAILED" : "BLOCKED",
        error: unavailable
          ? "subscription_capability_unavailable_before_submit"
          : "subscription_capability_changed_before_submit",
      });
      return json({
        error: unavailable
          ? "Asaas is unavailable for this tenant"
          : "Subscription integration changed before update",
      }, unavailable ? 503 : 409);
    }

    let response: Response;
    try {
      response = await fetch(
        `${submitIntegration.baseUrl}/subscriptions/${
          encodeURIComponent(subscriptionId)
        }`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            access_token: submitIntegration.apiKey,
          },
          body: JSON.stringify({ maxPayments }),
          signal: AbortSignal.timeout(15_000),
        },
      );
    } catch {
      await finishAsaasSubscriptionMutation(auth.context.admin, mutation, {
        status: "UNKNOWN",
        error: "provider_response_unavailable",
      });
      return json({ error: "Subscription update is unconfirmed" }, 503);
    }
    const payload = await response.json().catch(() => ({
      error: "Invalid Asaas response",
    }));
    if (!response.ok && !ambiguousProviderMutationStatus(response.status)) {
      await finishAsaasSubscriptionMutation(auth.context.admin, mutation, {
        status: "FAILED",
        providerHttpStatus: response.status,
        error: "provider_declined_subscription_update",
      });
      return json(payload, response.status);
    }

    const postcondition = await guardAsaasMutationTarget({
      admin: auth.context.admin,
      baseUrl: submitIntegration.baseUrl,
      apiKey: submitIntegration.apiKey,
      operation: "admin_subscription_update_postcondition",
      target: mutationTarget,
    });
    if (
      !postcondition.ok ||
      asaasSubscriptionPostconditionMismatchFields(
          postcondition.entity,
          { maxPayments },
        ).length > 0
    ) {
      await finishAsaasSubscriptionMutation(auth.context.admin, mutation, {
        status: "UNKNOWN",
        providerHttpStatus: response.status,
        error: "provider_postcondition_unverified",
      });
      return json({ error: "Subscription update is unconfirmed" }, 503);
    }
    if (
      !await finishAsaasSubscriptionMutation(
        auth.context.admin,
        mutation,
        {
          status: "SUCCEEDED",
          observedState: { maxPayments },
          providerHttpStatus: response.status,
        },
      )
    ) {
      return json({ error: "Subscription update is unconfirmed" }, 503);
    }
    return json(postcondition.entity, 200);
  } catch (error) {
    if (error instanceof TenantIntegrationBrokerError) {
      return json({ error: "Asaas is unavailable for this tenant" }, 503);
    }
    console.error("Admin subscription operation failed", {
      message: error instanceof Error ? error.message : "unknown error",
    });
    return json({ error: "Invalid request" }, 400);
  }
});
