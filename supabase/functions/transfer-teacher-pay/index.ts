/// <reference lib="deno.ns" />

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { authorizeRequest, methodNotAllowed } from "../_shared/request-auth.ts";
import {
  AsaasCapabilityFenceError,
  revalidateAsaasMutationCapability,
} from "../_shared/asaas-capability-fence.ts";
import {
  resolveAsaasIntegration,
  type ResolvedAsaasIntegration,
} from "../_shared/tenant-integration-broker.ts";
import { ambiguousProviderMutationStatus } from "../_shared/student-provider-lifecycle.ts";
import {
  type ProviderTransfer,
  providerTransferOutcome,
  redactTransferResponse,
  resolveTransferForAttempt,
  transferDestinationFingerprint,
  transferLookupIdentity,
  transferSubmissionFromClaim,
  transferSubmissionIsEnabled,
  type TransferSubmissionSnapshot,
} from "./transfer-safety.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

function submissionIsEnabled(integration: ResolvedAsaasIntegration): boolean {
  return transferSubmissionIsEnabled({
    enabled: Deno.env.get("ASAAS_TEACHER_TRANSFER_ENABLED") === "true",
    homologated: Deno.env.get("ASAAS_TEACHER_TRANSFER_HOMOLOGATED") === "true",
    productionApproved:
      Deno.env.get("ASAAS_TEACHER_TRANSFER_PRODUCTION_APPROVED") === "true",
    baseUrl: integration.baseUrl,
    apiKey: integration.apiKey,
  });
}

async function parseJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json().catch(() => ({}))) as Record<string, unknown>;
}

async function listTransfersForAttempt(
  integration: ResolvedAsaasIntegration,
  createdAt: string,
): Promise<ProviderTransfer[]> {
  const created = new Date(createdAt);
  const start = new Date(created.getTime() - 2 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const end = new Date().toISOString().slice(0, 10);
  const transfers: ProviderTransfer[] = [];

  for (let offset = 0, pages = 0; pages < 500; offset += 100, pages++) {
    const params = new URLSearchParams({
      limit: "100",
      offset: String(offset),
    });
    params.set("dateCreated[ge]", start);
    params.set("dateCreated[le]", end);
    const response = await fetch(`${integration.baseUrl}/transfers?${params}`, {
      method: "GET",
      headers: {
        accept: "application/json",
        access_token: integration.apiKey,
      },
      signal: AbortSignal.timeout(15_000),
    });
    const body = await parseJson(response);
    if (!response.ok) {
      throw new Error(`transfer_lookup_http_${response.status}`);
    }
    const page = Array.isArray(body.data)
      ? (body.data as ProviderTransfer[])
      : [];
    transfers.push(...page);
    if (body.hasMore !== true) return transfers;
  }
  throw new Error("transfer_lookup_page_limit");
}

async function getTransferById(
  integration: ResolvedAsaasIntegration,
  providerTransferId: string,
): Promise<ProviderTransfer | null> {
  const response = await fetch(
    `${integration.baseUrl}/transfers/${
      encodeURIComponent(providerTransferId)
    }`,
    {
      method: "GET",
      headers: {
        accept: "application/json",
        access_token: integration.apiKey,
      },
      signal: AbortSignal.timeout(15_000),
    },
  );
  const body = await parseJson(response);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`transfer_lookup_http_${response.status}`);
  }
  return body as ProviderTransfer;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return methodNotAllowed(corsHeaders);

  const auth = await authorizeRequest(req, {
    corsHeaders,
    allowService: false,
    allowedRoles: ["SCHOOL_ADMIN", "SUPER_ADMIN"],
  });
  if (auth.ok === false) return auth.response;

  try {
    const body = (await req.json().catch(() => ({}))) as {
      closingId?: unknown;
    };
    const closingId = typeof body.closingId === "string"
      ? body.closingId.trim()
      : "";
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(closingId)) {
      return new Response(JSON.stringify({ error: "closing_id_invalido" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    const { data: priorAttempt, error: priorError } = await auth.context.admin
      .from("asaas_teacher_transfer_attempts")
      .select("status,tenant_id")
      .eq("closing_id", closingId)
      .maybeSingle();
    if (priorError) throw priorError;

    // Resolve credentials before creating a SUBMIT_ONCE attempt so disabled
    // integrations do not strand a fresh claim. Existing attempts carry their
    // immutable tenant; only a first claim needs this read-only scope preview.
    let scopeTenantId = typeof priorAttempt?.tenant_id === "string"
      ? priorAttempt.tenant_id
      : "";
    if (
      scopeTenantId &&
      auth.context.profile?.role !== "SUPER_ADMIN" &&
      scopeTenantId !== auth.context.profile?.tenant_id
    ) {
      return new Response(JSON.stringify({ error: "closing_not_found" }), {
        status: 404,
        headers: corsHeaders,
      });
    }
    if (!scopeTenantId) {
      const { data: closingScope, error: closingScopeError } = await auth
        .context
        .admin
        .from("teacher_closings")
        .select("tenant_id")
        .eq("id", closingId)
        .maybeSingle();
      if (closingScopeError) throw closingScopeError;
      if (
        !closingScope ||
        (auth.context.profile?.role !== "SUPER_ADMIN" &&
          closingScope.tenant_id !== auth.context.profile?.tenant_id)
      ) {
        return new Response(JSON.stringify({ error: "closing_not_found" }), {
          status: 404,
          headers: corsHeaders,
        });
      }
      scopeTenantId = closingScope.tenant_id;
    }

    const integration = await resolveAsaasIntegration(
      auth.context.admin,
      scopeTenantId,
      priorAttempt ? "transfer.read" : "transfer.submit",
    );
    if (!priorAttempt && !submissionIsEnabled(integration)) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "TRANSFER_DISABLED_PENDING_HOMOLOGATION",
        }),
        { status: 503, headers: corsHeaders },
      );
    }

    const claimToken = crypto.randomUUID();
    const { data: claim, error: claimError } = await auth.context.admin.rpc(
      "claim_asaas_teacher_transfer",
      {
        p_closing_id: closingId,
        p_actor_id: auth.context.userId,
        p_claim_token: claimToken,
      },
    );
    if (claimError) throw claimError;
    if (!claim?.ok) {
      return new Response(
        JSON.stringify({ success: false, error: claim?.reason }),
        {
          status: claim?.reason === "not_authorized" ? 404 : 409,
          headers: corsHeaders,
        },
      );
    }
    if (claim.action === "ALREADY_COMPLETED") {
      return new Response(JSON.stringify({ success: true, duplicate: true }), {
        status: 200,
        headers: corsHeaders,
      });
    }
    if (claim.action === "IN_PROGRESS") {
      return new Response(
        JSON.stringify({ success: false, status: "IN_PROGRESS" }),
        {
          status: 409,
          headers: corsHeaders,
        },
      );
    }

    if (claim.action === "RECONCILE_REQUIRED") {
      // A concurrent request can create the attempt between our initial read
      // and the claim. Resolve the read capability explicitly in that race;
      // a submit credential is never implicitly reused for reconciliation.
      const claimedTenantId = typeof claim.tenant_id === "string"
        ? claim.tenant_id
        : "";
      if (!claimedTenantId) throw new Error("claim_tenant_snapshot_invalid");
      const readIntegration = priorAttempt &&
          integration.tenantId === claimedTenantId
        ? integration
        : await resolveAsaasIntegration(
          auth.context.admin,
          claimedTenantId,
          "transfer.read",
        );
      const lookup = transferLookupIdentity(
        claim.external_reference,
        claim.provider_transfer_id,
      );
      const expectedDestinationFingerprint =
        typeof claim.destination_fingerprint ===
            "string"
          ? claim.destination_fingerprint.trim()
          : "";
      if (!/^[a-f0-9]{64}$/.test(expectedDestinationFingerprint)) {
        const recorded = await auth.context.admin.rpc(
          "record_asaas_teacher_transfer_state",
          {
            p_attempt_id: claim.attempt_id,
            p_claim_token: claimToken,
            p_status: "BLOCKED",
            p_error: "claim_destination_fingerprint_invalid",
          },
        );
        if (recorded.error) throw recorded.error;
        if (recorded.data?.ok !== true) {
          throw new Error("transfer_state_claim_lost");
        }
        return new Response(
          JSON.stringify({
            success: false,
            status: "BLOCKED",
            retryBlocked: true,
          }),
          { status: 409, headers: corsHeaders },
        );
      }
      let candidates: ProviderTransfer[];
      if (lookup.kind === "PROVIDER_ID") {
        const transfer = await getTransferById(
          readIntegration,
          lookup.providerTransferId,
        );
        candidates = transfer ? [transfer] : [];
      } else {
        candidates = await listTransfersForAttempt(
          readIntegration,
          claim.created_at,
        );
      }
      const resolution = await resolveTransferForAttempt(
        candidates,
        claim.external_reference,
        Number(claim.expected_amount),
        expectedDestinationFingerprint,
        lookup.kind === "PROVIDER_ID" ? lookup.providerTransferId : null,
      );
      if (resolution.kind === "CONFLICT") {
        const recorded = await auth.context.admin.rpc(
          "record_asaas_teacher_transfer_state",
          {
            p_attempt_id: claim.attempt_id,
            p_claim_token: claimToken,
            p_status: "BLOCKED",
            p_provider_transfer_id: resolution.transfer?.id ||
              (lookup.kind === "PROVIDER_ID"
                ? lookup.providerTransferId
                : null),
            p_error: `provider_transfer_identity_${resolution.reason}`,
            p_provider_response: resolution.transfer
              ? redactTransferResponse(resolution.transfer)
              : null,
            p_destination_fingerprint: expectedDestinationFingerprint,
          },
        );
        if (recorded.error) throw recorded.error;
        if (recorded.data?.ok !== true) {
          throw new Error("transfer_state_claim_lost");
        }
        return new Response(
          JSON.stringify({
            success: false,
            status: "BLOCKED",
            retryBlocked: true,
          }),
          { status: 409, headers: corsHeaders },
        );
      }
      if (resolution.kind === "NOT_FOUND") {
        const recorded = await auth.context.admin.rpc(
          "record_asaas_teacher_transfer_state",
          {
            p_attempt_id: claim.attempt_id,
            p_claim_token: claimToken,
            p_status: "UNKNOWN",
            p_provider_transfer_id: lookup.kind === "PROVIDER_ID"
              ? lookup.providerTransferId
              : null,
            p_error: lookup.kind === "PROVIDER_ID"
              ? "persisted_provider_transfer_id_not_found"
              : "provider_transfer_not_found_after_ambiguous_submit",
          },
        );
        if (recorded.error) throw recorded.error;
        if (recorded.data?.ok !== true) {
          throw new Error("transfer_state_claim_lost");
        }
        return new Response(
          JSON.stringify({
            success: false,
            status: "UNKNOWN",
            retryBlocked: true,
          }),
          { status: 202, headers: corsHeaders },
        );
      }

      const matched = resolution.transfer;
      const outcome = providerTransferOutcome(matched.status);
      const recorded = await auth.context.admin.rpc(
        "record_asaas_teacher_transfer_state",
        {
          p_attempt_id: claim.attempt_id,
          p_claim_token: claimToken,
          p_status: outcome,
          p_provider_transfer_id: matched.id,
          p_provider_status: matched.status || null,
          p_provider_response: redactTransferResponse(matched),
          p_destination_fingerprint: expectedDestinationFingerprint,
        },
      );
      if (recorded.error) throw recorded.error;
      if (recorded.data?.ok !== true) {
        throw new Error("transfer_state_claim_lost");
      }
      return new Response(
        JSON.stringify({
          success: outcome === "COMPLETED",
          status: outcome,
          reconciled: true,
        }),
        { status: outcome === "COMPLETED" ? 200 : 202, headers: corsHeaders },
      );
    }

    let submission: TransferSubmissionSnapshot;
    try {
      submission = transferSubmissionFromClaim(claim);
    } catch (error) {
      const recorded = await auth.context.admin.rpc(
        "record_asaas_teacher_transfer_state",
        {
          p_attempt_id: claim.attempt_id,
          p_claim_token: claimToken,
          p_status: "BLOCKED",
          p_error: error instanceof Error
            ? error.message
            : "claim_snapshot_invalid",
        },
      );
      if (recorded.error) throw recorded.error;
      if (recorded.data?.ok !== true) {
        throw new Error("transfer_state_claim_lost");
      }
      return new Response(
        JSON.stringify({ error: "TRANSFER_CLAIM_SNAPSHOT_INVALID" }),
        {
          status: 500,
          headers: corsHeaders,
        },
      );
    }

    const destinationFingerprint = await transferDestinationFingerprint(
      submission.payload.pixAddressKeyType,
      submission.payload.pixAddressKey,
    );
    if (
      integration.tenantId !== submission.tenantId ||
      destinationFingerprint !== submission.destinationFingerprint
    ) {
      const recorded = await auth.context.admin.rpc(
        "record_asaas_teacher_transfer_state",
        {
          p_attempt_id: submission.attemptId,
          p_claim_token: claimToken,
          p_status: "BLOCKED",
          p_error: integration.tenantId !== submission.tenantId
            ? "claim_tenant_snapshot_mismatch"
            : "claim_destination_fingerprint_mismatch",
        },
      );
      if (recorded.error) throw recorded.error;
      if (recorded.data?.ok !== true) {
        throw new Error("transfer_state_claim_lost");
      }
      return new Response(
        JSON.stringify({ error: "TRANSFER_CLAIM_SNAPSHOT_MISMATCH" }),
        { status: 409, headers: corsHeaders },
      );
    }
    const payload = submission.payload;

    let submitIntegration: ResolvedAsaasIntegration;
    try {
      submitIntegration = await revalidateAsaasMutationCapability(
        auth.context.admin,
        {
          tenantId: submission.tenantId,
          purpose: "transfer.submit",
          expected: integration,
        },
      );
    } catch (error) {
      const unavailable = error instanceof AsaasCapabilityFenceError &&
        error.failure === "UNAVAILABLE";
      const recorded = await auth.context.admin.rpc(
        "record_asaas_teacher_transfer_state",
        {
          p_attempt_id: claim.attempt_id,
          p_claim_token: claimToken,
          p_status: unavailable ? "FAILED" : "BLOCKED",
          p_error: unavailable
            ? "transfer_capability_unavailable_before_submit"
            : "transfer_capability_changed_before_submit",
          p_destination_fingerprint: destinationFingerprint,
        },
      );
      if (recorded.error) throw recorded.error;
      if (recorded.data?.ok !== true) {
        throw new Error("transfer_state_claim_lost");
      }
      return new Response(
        JSON.stringify({
          success: false,
          status: unavailable ? "FAILED" : "BLOCKED",
          retryBlocked: true,
        }),
        { status: unavailable ? 503 : 409, headers: corsHeaders },
      );
    }
    if (!submissionIsEnabled(submitIntegration)) {
      const recorded = await auth.context.admin.rpc(
        "record_asaas_teacher_transfer_state",
        {
          p_attempt_id: claim.attempt_id,
          p_claim_token: claimToken,
          p_status: "FAILED",
          p_error: "transfer_disabled_before_submit",
          p_destination_fingerprint: destinationFingerprint,
        },
      );
      if (recorded.error) throw recorded.error;
      if (recorded.data?.ok !== true) {
        throw new Error("transfer_state_claim_lost");
      }
      return new Response(
        JSON.stringify({
          success: false,
          status: "FAILED",
          error: "TRANSFER_DISABLED_PENDING_HOMOLOGATION",
        }),
        { status: 503, headers: corsHeaders },
      );
    }

    let response: Response;
    try {
      response = await fetch(`${submitIntegration.baseUrl}/transfers`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          access_token: submitIntegration.apiKey,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      const recorded = await auth.context.admin.rpc(
        "record_asaas_teacher_transfer_state",
        {
          p_attempt_id: claim.attempt_id,
          p_claim_token: claimToken,
          p_status: "UNKNOWN",
          p_error: error instanceof Error ? error.name : "network_failure",
          p_destination_fingerprint: destinationFingerprint,
        },
      );
      if (recorded.error) throw recorded.error;
      if (recorded.data?.ok !== true) {
        throw new Error("transfer_state_claim_lost");
      }
      return new Response(
        JSON.stringify({
          success: false,
          status: "UNKNOWN",
          retryBlocked: true,
        }),
        { status: 202, headers: corsHeaders },
      );
    }

    const providerBody = await parseJson(response);
    const providerTransfer = providerBody as ProviderTransfer;
    if (!response.ok) {
      const ambiguous = ambiguousProviderMutationStatus(response.status);
      const recorded = await auth.context.admin.rpc(
        "record_asaas_teacher_transfer_state",
        {
          p_attempt_id: claim.attempt_id,
          p_claim_token: claimToken,
          p_status: ambiguous ? "UNKNOWN" : "FAILED",
          p_http_status: response.status,
          p_error: ambiguous
            ? "ambiguous_provider_response"
            : "provider_rejected_transfer",
          p_provider_response: redactTransferResponse(providerTransfer),
          p_destination_fingerprint: destinationFingerprint,
        },
      );
      if (recorded.error) throw recorded.error;
      if (recorded.data?.ok !== true) {
        throw new Error("transfer_state_claim_lost");
      }
      return new Response(
        JSON.stringify({
          success: false,
          status: ambiguous ? "UNKNOWN" : "FAILED",
          retryBlocked: true,
        }),
        { status: ambiguous ? 202 : 422, headers: corsHeaders },
      );
    }

    if (typeof providerTransfer.id !== "string" || !providerTransfer.id) {
      const recorded = await auth.context.admin.rpc(
        "record_asaas_teacher_transfer_state",
        {
          p_attempt_id: claim.attempt_id,
          p_claim_token: claimToken,
          p_status: "UNKNOWN",
          p_http_status: response.status,
          p_error: "successful_response_without_transfer_id",
          p_provider_response: redactTransferResponse(providerTransfer),
          p_destination_fingerprint: destinationFingerprint,
        },
      );
      if (recorded.error) throw recorded.error;
      if (recorded.data?.ok !== true) {
        throw new Error("transfer_state_claim_lost");
      }
      return new Response(
        JSON.stringify({
          success: false,
          status: "UNKNOWN",
          retryBlocked: true,
        }),
        { status: 202, headers: corsHeaders },
      );
    }

    const submittedIdentity = await resolveTransferForAttempt(
      [providerTransfer],
      payload.externalReference,
      payload.value,
      destinationFingerprint,
      providerTransfer.id,
    );
    if (submittedIdentity.kind !== "EXACT") {
      const recorded = await auth.context.admin.rpc(
        "record_asaas_teacher_transfer_state",
        {
          p_attempt_id: claim.attempt_id,
          p_claim_token: claimToken,
          p_status: "BLOCKED",
          p_provider_transfer_id: providerTransfer.id,
          p_provider_status: providerTransfer.status || null,
          p_http_status: response.status,
          p_error: submittedIdentity.kind === "CONFLICT"
            ? `provider_transfer_identity_${submittedIdentity.reason}`
            : "provider_transfer_identity_missing",
          p_provider_response: redactTransferResponse(providerTransfer),
          p_destination_fingerprint: destinationFingerprint,
        },
      );
      if (recorded.error) throw recorded.error;
      if (recorded.data?.ok !== true) {
        throw new Error("transfer_state_claim_lost");
      }
      return new Response(
        JSON.stringify({
          success: false,
          status: "BLOCKED",
          retryBlocked: true,
        }),
        { status: 409, headers: corsHeaders },
      );
    }

    const outcome = providerTransferOutcome(providerTransfer.status);
    const recorded = await auth.context.admin.rpc(
      "record_asaas_teacher_transfer_state",
      {
        p_attempt_id: claim.attempt_id,
        p_claim_token: claimToken,
        p_status: outcome,
        p_provider_transfer_id: providerTransfer.id,
        p_provider_status: providerTransfer.status || null,
        p_http_status: response.status,
        p_provider_response: redactTransferResponse(providerTransfer),
        p_destination_fingerprint: destinationFingerprint,
      },
    );
    if (recorded.error) throw recorded.error;
    if (recorded.data?.ok !== true) {
      throw new Error("transfer_state_claim_lost");
    }

    return new Response(
      JSON.stringify({
        success: outcome === "COMPLETED",
        status: outcome,
        transferId: providerTransfer.id,
      }),
      { status: outcome === "COMPLETED" ? 200 : 202, headers: corsHeaders },
    );
  } catch (error) {
    console.error("[transfer-teacher-pay] operation failed", {
      type: error instanceof Error ? error.name : "unknown",
    });
    return new Response(
      JSON.stringify({ error: "TRANSFER_OPERATION_FAILED" }),
      {
        status: 500,
        headers: corsHeaders,
      },
    );
  }
});
