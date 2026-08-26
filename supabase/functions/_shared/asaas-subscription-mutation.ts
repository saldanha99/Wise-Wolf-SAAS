import { asaasCreationFingerprint } from "./asaas-creation-guard.ts";
import type { PaymentAdminClient } from "./payment-auth.ts";
import type { ResolvedAsaasIntegration } from "./tenant-integration-broker.ts";

export type AsaasSubscriptionMutationKind = "PLAN_VALUE" | "MAX_PAYMENTS";
export type AsaasSubscriptionMutationState =
  | { valueCents: number }
  | { maxPayments: number };
export type AsaasSubscriptionMutationAction =
  | "SUBMIT_ONCE"
  | "RECONCILE_REQUIRED"
  | "ALREADY_SUCCEEDED"
  | "IN_PROGRESS"
  | "REVIEW_REQUIRED";

export type AsaasSubscriptionMutationClaim = {
  ok: boolean;
  action: AsaasSubscriptionMutationAction;
  operationId: string | null;
  claimToken: string | null;
  reason: string | null;
  retryAfterSeconds: number | null;
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function validAction(value: unknown): value is AsaasSubscriptionMutationAction {
  return value === "SUBMIT_ONCE" || value === "RECONCILE_REQUIRED" ||
    value === "ALREADY_SUCCEEDED" || value === "IN_PROGRESS" ||
    value === "REVIEW_REQUIRED";
}

export function asaasSubscriptionMutationIntegrationSnapshot(
  integration: ResolvedAsaasIntegration,
): Record<string, unknown> {
  return {
    integrationId: integration.integrationId,
    version: integration.version,
    environment: integration.environment,
    mode: integration.mode,
    baseUrl: integration.baseUrl,
  };
}

export async function claimAsaasSubscriptionMutation(
  admin: PaymentAdminClient,
  input: {
    tenantId: string;
    studentId: string;
    customerId: string;
    subscriptionId: string;
    mutationKind: AsaasSubscriptionMutationKind;
    intentKey: string;
    expectedState: AsaasSubscriptionMutationState;
    desiredState: AsaasSubscriptionMutationState;
    integration: ResolvedAsaasIntegration;
    mutationPayload: Record<string, unknown>;
    requestedBy?: string | null;
  },
): Promise<AsaasSubscriptionMutationClaim> {
  const integrationSnapshot = asaasSubscriptionMutationIntegrationSnapshot(
    input.integration,
  );
  // The expected provider state is intentionally excluded. After a timeout,
  // the GET used for reconciliation may already observe the desired state.
  const requestFingerprint = await asaasCreationFingerprint({
    version: 1,
    tenantId: input.tenantId,
    studentId: input.studentId,
    customerId: input.customerId,
    subscriptionId: input.subscriptionId,
    mutationKind: input.mutationKind,
    desiredState: input.desiredState,
    mutationPayload: input.mutationPayload,
    integrationSnapshot,
  });
  const claimToken = crypto.randomUUID();
  const { data, error } = await admin.rpc(
    "claim_asaas_subscription_mutation",
    {
      p_tenant_id: input.tenantId,
      p_student_id: input.studentId,
      p_customer_id: input.customerId,
      p_subscription_id: input.subscriptionId,
      p_mutation_kind: input.mutationKind,
      p_intent_key: input.intentKey,
      p_request_fingerprint: requestFingerprint,
      p_expected_state: input.expectedState,
      p_desired_state: input.desiredState,
      p_integration_snapshot: integrationSnapshot,
      p_requested_by: input.requestedBy || null,
      p_claim_token: claimToken,
      p_lease_seconds: 300,
    },
  );
  const record = asRecord(data);
  if (error || !record || !validAction(record.action)) {
    console.error("[asaas-subscription-mutation] claim failed", {
      code: error?.code || "invalid_rpc_response",
      mutationKind: input.mutationKind,
    });
    throw new Error("asaas_subscription_mutation_claim_failed");
  }
  return {
    ok: record.ok === true,
    action: record.action,
    operationId: text(record.operation_id) || null,
    claimToken: text(record.claim_token) || null,
    reason: text(record.reason) || null,
    retryAfterSeconds: Number.isSafeInteger(Number(record.retry_after_seconds))
      ? Number(record.retry_after_seconds)
      : null,
  };
}

export async function markAsaasSubscriptionMutationSubmitting(
  admin: PaymentAdminClient,
  claim: AsaasSubscriptionMutationClaim,
): Promise<boolean> {
  if (!claim.operationId || !claim.claimToken) return false;
  const { data, error } = await admin.rpc(
    "mark_asaas_subscription_mutation_submitting",
    {
      p_operation_id: claim.operationId,
      p_claim_token: claim.claimToken,
    },
  );
  const record = asRecord(data);
  if (error || record?.ok !== true) {
    console.error("[asaas-subscription-mutation] submit fence lost", {
      code: error?.code || text(record?.reason) || "claim_lost",
    });
    return false;
  }
  return true;
}

export async function finishAsaasSubscriptionMutation(
  admin: PaymentAdminClient,
  claim: AsaasSubscriptionMutationClaim,
  input: {
    status: "SUCCEEDED" | "FAILED" | "UNKNOWN" | "BLOCKED";
    observedState?: AsaasSubscriptionMutationState | null;
    providerHttpStatus?: number | null;
    error?: string | null;
  },
): Promise<boolean> {
  if (!claim.operationId || !claim.claimToken) return false;
  const { data, error } = await admin.rpc(
    "finish_asaas_subscription_mutation",
    {
      p_operation_id: claim.operationId,
      p_claim_token: claim.claimToken,
      p_status: input.status,
      p_observed_state: input.observedState || null,
      p_provider_http_status: input.providerHttpStatus ?? null,
      p_last_error: input.error?.slice(0, 500) || null,
    },
  );
  const record = asRecord(data);
  if (error || record?.ok !== true) {
    console.error("[asaas-subscription-mutation] finish failed", {
      code: error?.code || text(record?.reason) || "claim_lost",
      status: input.status,
    });
    return false;
  }
  return true;
}
