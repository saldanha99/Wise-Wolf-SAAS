/// <reference lib="deno.ns" />
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { authorizeRequest, methodNotAllowed } from "../_shared/request-auth.ts";
import { resolveAsaasIntegration } from "../_shared/tenant-integration-broker.ts";
import { revalidateAsaasMutationCapability } from "../_shared/asaas-capability-fence.ts";
import { guardAsaasMutationTarget } from "../_shared/asaas-mutation-guard.ts";
import {
  type Integration,
  type Json,
  processCancellation,
  type Source,
  uuid,
} from "./core.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: Json, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
const paymentUrl = (source: Source, integration: Integration) =>
  `${integration.baseUrl.replace(/\/$/, "")}/payments/${
    encodeURIComponent(source.provider_payment_id)
  }`;
async function providerRequest(
  source: Source,
  integration: Integration,
  method: "GET" | "DELETE",
) {
  const response = await fetch(paymentUrl(source, integration), {
    method,
    headers: {
      access_token: integration.apiKey,
      "Content-Type": "application/json",
    },
    redirect: "error",
    signal: AbortSignal.timeout(8_000),
  });
  const value = await response.json().catch(() => null);
  const body: Json = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
  return { status: response.status, body };
}

export async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return methodNotAllowed(corsHeaders);
  const auth = await authorizeRequest(req, {
    allowedRoles: ["SCHOOL_ADMIN", "SUPER_ADMIN"],
    allowService: false,
    corsHeaders,
  });
  if (auth.ok === false) return auth.response;
  const body = await req.json().catch(() => null);
  if (
    !body || !uuid(body.operation_id) ||
    Object.keys(body).some((key) => key !== "operation_id")
  ) {
    return json({ ok: false, error: "invalid_request" }, 400);
  }
  const admin = auth.context.admin;
  const rpc = async (name: string, args: Json): Promise<Json> => {
    const { data, error } = await admin.rpc(name, args);
    if (error || !data || typeof data !== "object") {
      throw new Error("operation_rpc_failed");
    }
    return data as Json;
  };
  const result = await processCancellation(
    body.operation_id,
    auth.context.userId!,
    {
      token: () => crypto.randomUUID(),
      claim: (operation, actor, token) =>
        rpc("claim_prepaid_invoice_cancellation", {
          p_operation: operation,
          p_actor: actor,
          p_token: token,
        }),
      resolve: (tenant, purpose) =>
        resolveAsaasIntegration(admin, tenant, purpose),
      get: (source, integration) => providerRequest(source, integration, "GET"),
      verifyCanonical: async (source, provider, integration) => {
        const observedUrl = paymentUrl(source, integration);
        const guard = await guardAsaasMutationTarget({
          admin,
          baseUrl: integration.baseUrl,
          apiKey: integration.apiKey,
          operation: "cancel_prepaid_invoice",
          target: {
            tenantId: source.tenant_id,
            studentId: source.student_id,
            resource: "payment",
            entityId: source.provider_payment_id,
            customerId: source.customer_id,
            subscriptionId: source.subscription_id,
            subscriptionMatch: source.subscription_id ? "required" : "optional",
          },
          // Reuse exactly the observed GET, while still allowing the shared guard
          // to verify a canonical parent subscription when externalReference is absent.
          fetcher: (url, init) =>
            String(url) === observedUrl
              ? Promise.resolve(
                new Response(JSON.stringify(provider), { status: 200 }),
              )
              : fetch(url, {
                ...init,
                redirect: "error",
                signal: AbortSignal.timeout(8_000),
              }),
        });
        return guard.ok === true;
      },
      revalidate: (tenant, expected) =>
        revalidateAsaasMutationCapability(admin, {
          tenantId: tenant,
          purpose: "payment.delete",
          expected,
        }),
      begin: (operation, actor, token, provider, integration) =>
        rpc("begin_prepaid_invoice_delete", {
          p_operation: operation,
          p_actor: actor,
          p_token: token,
          p_provider: provider,
          p_integration: integration,
        }),
      remove: (source, integration) =>
        providerRequest(source, integration, "DELETE"),
      finish: (operation, actor, token, outcome, proof) =>
        rpc("finish_prepaid_invoice_cancellation", {
          p_operation: operation,
          p_actor: actor,
          p_token: token,
          p_outcome: outcome,
          p_proof: proof,
        }),
    },
  );
  return json(result, result.ok === true ? 200 : 409);
}
if (import.meta.main) serve(handleRequest);
