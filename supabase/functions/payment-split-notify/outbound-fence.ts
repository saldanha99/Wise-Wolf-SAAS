import type { EvolutionSendResult } from "../_shared/evolution-send.ts";

type RpcClient = {
  rpc: (
    name: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: unknown }>;
};

export type ManagementPaymentNotificationKind =
  | "PAYMENT_SPLIT"
  | "PAYMENT_RECEIVED";

export type ManagementPaymentNotificationClaim = {
  ok: boolean;
  action:
    | "SUBMIT_ONCE"
    | "IN_PROGRESS"
    | "ALREADY_FINAL"
    | "SUPPRESSED"
    | "RETRY"
    | "REVIEW_REQUIRED";
  attempt_id?: string;
  claim_token?: string;
  tenant_id?: string;
  payment_id?: string;
  notification_kind?: ManagementPaymentNotificationKind;
  status?: string;
  reason?: string;
};

export type ManagementPaymentSubmission = {
  ok: boolean;
  action: "PREPARED" | "SUPPRESSED" | "RETRY";
  status?: string;
  reason?: string;
  attempt_id?: string;
  notification_kind?: ManagementPaymentNotificationKind;
  provider_destination?: string;
  provider_instance_name?: string;
  provider_integration_id?: string;
  provider_integration_version?: number;
  message_body?: string;
  source_snapshot_hash?: string;
  snapshot_hash?: string;
};

export type ManagementPaymentProviderAuthorization = {
  ok: boolean;
  action: "SUBMITTING" | "SUPPRESSED" | "RETRY";
  status?: string;
  reason?: string;
  attempt_id?: string;
  notification_kind?: ManagementPaymentNotificationKind;
  provider_destination?: string;
  provider_instance_name?: string;
  provider_integration_id?: string;
  provider_integration_version?: number;
  provider_endpoint_hash?: string;
  provider_credential_hash?: string;
  message_body?: string;
  source_snapshot_hash?: string;
  snapshot_hash?: string;
};

export type ManagementPaymentNotificationSource = Record<string, unknown>;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function validClaim(
  value: unknown,
): value is ManagementPaymentNotificationClaim {
  const claim = record(value);
  if (
    !claim || typeof claim.ok !== "boolean" ||
    typeof claim.action !== "string"
  ) return false;
  if (["REVIEW_REQUIRED", "SUPPRESSED"].includes(String(claim.action))) {
    return true;
  }
  return typeof claim.attempt_id === "string";
}

export async function claimManagementPaymentNotification(
  admin: RpcClient,
  input: { tenantId: string; paymentId: string },
): Promise<ManagementPaymentNotificationClaim> {
  const claimToken = crypto.randomUUID();
  const { data, error } = await admin.rpc(
    "claim_management_payment_notification",
    {
      p_tenant_id: input.tenantId,
      p_payment_id: input.paymentId,
      p_claim_token: claimToken,
      p_lease_seconds: 300,
    },
  );
  if (error || !validClaim(data)) {
    throw new Error("management_payment_notification_claim_failed");
  }
  return data;
}

export async function loadManagementPaymentNotificationSource(
  admin: RpcClient,
  input: {
    tenantId: string;
    paymentId: string;
    notificationKind: ManagementPaymentNotificationKind;
  },
): Promise<ManagementPaymentNotificationSource> {
  const { data, error } = await admin.rpc(
    "management_payment_notification_source_snapshot",
    {
      p_tenant_id: input.tenantId,
      p_payment_id: input.paymentId,
      p_notification_kind: input.notificationKind,
    },
  );
  const source = record(data);
  if (error || !source || typeof source.payment_id !== "string") {
    throw new Error("management_payment_notification_source_unavailable");
  }
  return source;
}

function validSubmission(value: unknown): value is ManagementPaymentSubmission {
  const submission = record(value);
  if (
    !submission || typeof submission.ok !== "boolean" ||
    typeof submission.action !== "string"
  ) return false;
  if (submission.action !== "PREPARED") return true;
  return submission.ok === true &&
    typeof submission.provider_destination === "string" &&
    typeof submission.provider_instance_name === "string" &&
    typeof submission.provider_integration_id === "string" &&
    Number.isSafeInteger(Number(submission.provider_integration_version)) &&
    Number(submission.provider_integration_version) > 0 &&
    typeof submission.message_body === "string" &&
    /^[0-9a-f]{64}$/.test(String(submission.source_snapshot_hash || ""));
}

function validProviderAuthorization(
  value: unknown,
): value is ManagementPaymentProviderAuthorization {
  const authorization = record(value);
  if (
    !authorization || typeof authorization.ok !== "boolean" ||
    typeof authorization.action !== "string"
  ) return false;
  if (authorization.action !== "SUBMITTING") return true;
  return authorization.ok === true &&
    typeof authorization.provider_destination === "string" &&
    typeof authorization.provider_instance_name === "string" &&
    typeof authorization.provider_integration_id === "string" &&
    Number.isSafeInteger(Number(authorization.provider_integration_version)) &&
    Number(authorization.provider_integration_version) > 0 &&
    /^[0-9a-f]{64}$/.test(String(authorization.provider_endpoint_hash || "")) &&
    /^[0-9a-f]{64}$/.test(
      String(authorization.provider_credential_hash || ""),
    ) &&
    typeof authorization.message_body === "string" &&
    /^[0-9a-f]{64}$/.test(String(authorization.source_snapshot_hash || "")) &&
    /^[0-9a-f]{64}$/.test(String(authorization.snapshot_hash || ""));
}

export async function beginManagementPaymentNotificationSubmission(
  admin: RpcClient,
  claim: ManagementPaymentNotificationClaim,
  input: {
    expectedDestination: string;
    providerDestination: string;
    providerInstanceName: string;
    integrationId: string;
    integrationVersion: number;
    sourceSnapshot: ManagementPaymentNotificationSource;
    messageBody: string;
  },
): Promise<ManagementPaymentSubmission> {
  if (!claim.attempt_id || !claim.claim_token) {
    throw new Error("management_payment_notification_claim_token_missing");
  }
  const { data, error } = await admin.rpc(
    "begin_management_payment_notification_submission",
    {
      p_attempt_id: claim.attempt_id,
      p_claim_token: claim.claim_token,
      p_expected_destination: input.expectedDestination,
      p_provider_destination: input.providerDestination,
      p_provider_instance_name: input.providerInstanceName,
      p_integration_id: input.integrationId,
      p_integration_version: input.integrationVersion,
      p_source_snapshot: input.sourceSnapshot,
      p_message_body: input.messageBody,
    },
  );
  if (error || !validSubmission(data)) {
    throw new Error("management_payment_notification_submission_failed");
  }
  return data;
}

export async function authorizeManagementPaymentNotificationSubmission(
  admin: RpcClient,
  claim: ManagementPaymentNotificationClaim,
  input: {
    integrationId: string;
    integrationVersion: number;
    providerEndpointHash: string;
    providerCredentialHash: string;
  },
): Promise<ManagementPaymentProviderAuthorization> {
  if (!claim.attempt_id || !claim.claim_token) {
    throw new Error("management_payment_notification_claim_token_missing");
  }
  const { data, error } = await admin.rpc(
    "authorize_management_payment_notification_submission",
    {
      p_attempt_id: claim.attempt_id,
      p_claim_token: claim.claim_token,
      p_integration_id: input.integrationId,
      p_integration_version: input.integrationVersion,
      p_provider_endpoint_hash: input.providerEndpointHash,
      p_provider_credential_hash: input.providerCredentialHash,
    },
  );
  if (error || !validProviderAuthorization(data)) {
    throw new Error("management_payment_provider_authorization_failed");
  }
  return data;
}

export async function finishManagementPaymentNotification(
  admin: RpcClient,
  claim: ManagementPaymentNotificationClaim,
  input: {
    status: "SENT" | "FAILED" | "UNKNOWN";
    providerMessageId?: string | null;
    providerHttpStatus?: number | null;
    error?: string | null;
  },
): Promise<{ status: string; providerDeliveryStatus: string | null }> {
  if (!claim.attempt_id || !claim.claim_token) {
    throw new Error("management_payment_notification_claim_token_missing");
  }
  const { data, error } = await admin.rpc(
    "finish_management_payment_notification",
    {
      p_attempt_id: claim.attempt_id,
      p_claim_token: claim.claim_token,
      p_status: input.status,
      p_provider_message_id: input.providerMessageId?.slice(0, 320) || null,
      p_provider_http_status: input.providerHttpStatus ?? null,
      p_error: input.error?.slice(0, 200) || null,
    },
  );
  const result = record(data);
  if (
    error || result?.ok !== true || typeof result.status !== "string"
  ) {
    throw new Error("management_payment_notification_finish_failed");
  }
  return {
    status: result.status,
    providerDeliveryStatus: typeof result.provider_delivery_status === "string"
      ? result.provider_delivery_status
      : null,
  };
}

export function managementPaymentNotificationFinish(
  result: EvolutionSendResult,
): {
  status: "SENT" | "FAILED" | "UNKNOWN";
  providerMessageId: string | null;
  providerHttpStatus: number | null;
  error: string | null;
} {
  if (result.outcome === "accepted") {
    if (!result.messageId) {
      return {
        status: "UNKNOWN",
        providerMessageId: null,
        providerHttpStatus: result.httpStatus,
        error: "provider_acceptance_without_message_id",
      };
    }
    return {
      status: "SENT",
      providerMessageId: result.messageId,
      providerHttpStatus: result.httpStatus,
      error: null,
    };
  }
  if (result.outcome === "ambiguous") {
    return {
      status: "UNKNOWN",
      providerMessageId: result.messageId,
      providerHttpStatus: result.httpStatus,
      error: "provider_delivery_outcome_unknown",
    };
  }
  return {
    status: "FAILED",
    providerMessageId: result.messageId,
    providerHttpStatus: result.httpStatus,
    error: "provider_delivery_rejected",
  };
}
