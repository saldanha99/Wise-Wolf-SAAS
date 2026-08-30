import {
  hubProviderCancellationDecision,
  providerCancellationIsFinal,
} from "./hub-billing-safety.ts";
import {
  AsaasCapabilityFenceError,
  revalidateAsaasMutationCapability,
} from "./asaas-capability-fence.ts";
import {
  type ResolvedAsaasIntegration,
  resolvePlatformAsaasIntegration,
} from "./tenant-integration-broker.ts";

// The project intentionally keeps Edge Function database clients structural so
// this helper can be tested without importing the network Supabase client.
// deno-lint-ignore no-explicit-any
type AdminClient = any;

type ProviderTarget = {
  providerSubscriptionId: string;
  providerCustomerId: string;
  checkoutId: string;
};

type ProviderOperation = {
  operationId: string;
  leaseToken: string;
  action: "STARTED" | "RESUME" | "ALREADY_SUCCEEDED";
  snapshot: { targets: ProviderTarget[] };
};

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class HubProviderOperationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "HubProviderOperationError";
  }
}

function requiredText(value: unknown, code: string, max = 200): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > max) {
    throw new HubProviderOperationError(code);
  }
  return normalized;
}

function parseOperation(value: unknown): ProviderOperation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HubProviderOperationError("HUB_PROVIDER_OPERATION_INVALID");
  }
  const row = value as Record<string, unknown>;
  const action = requiredText(
    row.action,
    "HUB_PROVIDER_OPERATION_INVALID",
    40,
  );
  if (!["STARTED", "RESUME", "ALREADY_SUCCEEDED"].includes(action)) {
    throw new HubProviderOperationError("HUB_PROVIDER_OPERATION_INVALID");
  }
  const snapshot = row.snapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new HubProviderOperationError("HUB_PROVIDER_OPERATION_INVALID");
  }
  const rawTargets = (snapshot as Record<string, unknown>).targets;
  if (!Array.isArray(rawTargets)) {
    throw new HubProviderOperationError("HUB_PROVIDER_OPERATION_INVALID");
  }
  const targets = rawTargets.map((target) => {
    if (!target || typeof target !== "object" || Array.isArray(target)) {
      throw new HubProviderOperationError("HUB_PROVIDER_OPERATION_INVALID");
    }
    const item = target as Record<string, unknown>;
    return {
      providerSubscriptionId: requiredText(
        item.providerSubscriptionId,
        "HUB_PROVIDER_OPERATION_INVALID",
      ),
      providerCustomerId: requiredText(
        item.providerCustomerId,
        "HUB_PROVIDER_OPERATION_INVALID",
      ),
      checkoutId: requiredText(
        item.checkoutId,
        "HUB_PROVIDER_OPERATION_INVALID",
      ),
    };
  });
  return {
    operationId: requiredText(
      row.operationId,
      "HUB_PROVIDER_OPERATION_INVALID",
    ),
    leaseToken: requiredText(
      row.leaseToken,
      "HUB_PROVIDER_OPERATION_INVALID",
    ),
    action: action as ProviderOperation["action"],
    snapshot: { targets },
  };
}

function assertSameIntegration(
  read: ResolvedAsaasIntegration,
  mutation: ResolvedAsaasIntegration,
): void {
  if (
    read.integrationId !== mutation.integrationId ||
    read.provider !== mutation.provider ||
    read.version !== mutation.version ||
    read.baseUrl !== mutation.baseUrl ||
    read.environment !== mutation.environment ||
    read.tenantId !== mutation.tenantId ||
    read.apiKey !== mutation.apiKey ||
    read.mode !== "PLATFORM_MANAGED_ROOT" ||
    mutation.mode !== "PLATFORM_MANAGED_ROOT"
  ) {
    throw new HubProviderOperationError(
      "HUB_PROVIDER_INTEGRATION_VERSION_CHANGED",
    );
  }
}

async function revalidateHubDeleteCapability(
  admin: AdminClient,
  expected: ResolvedAsaasIntegration,
  resolver: (
    admin: AdminClient,
    purpose: "subscription.read" | "subscription.delete",
  ) => Promise<ResolvedAsaasIntegration>,
): Promise<ResolvedAsaasIntegration> {
  try {
    return await revalidateAsaasMutationCapability(
      admin,
      {
        tenantId: expected.tenantId,
        purpose: "subscription.delete",
        expected,
      },
      {
        resolve: async (client, _tenantId, purpose) => {
          if (purpose !== "subscription.delete") {
            throw new Error("HUB_PROVIDER_PURPOSE_INVALID");
          }
          return await resolver(client, purpose);
        },
      },
    );
  } catch (error) {
    throw new HubProviderOperationError(
      error instanceof AsaasCapabilityFenceError &&
        error.failure === "UNAVAILABLE"
        ? "HUB_PROVIDER_INTEGRATION_UNAVAILABLE"
        : "HUB_PROVIDER_INTEGRATION_VERSION_CHANGED",
    );
  }
}

async function exactProviderLookup(
  integration: ResolvedAsaasIntegration,
  target: ProviderTarget,
  fetcher: FetchLike,
): Promise<
  | { kind: "ABSENT" }
  | { kind: "FINAL" }
  | { kind: "ACTIVE"; entity: Record<string, unknown> }
> {
  let response: Response;
  try {
    response = await fetcher(
      `${integration.baseUrl}/subscriptions/${
        encodeURIComponent(target.providerSubscriptionId)
      }`,
      {
        method: "GET",
        headers: { access_token: integration.apiKey },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      },
    );
  } catch {
    throw new HubProviderOperationError("HUB_PROVIDER_LOOKUP_FAILED");
  }
  if (response.status === 404 || response.status === 410) {
    return { kind: "ABSENT" };
  }
  if (!response.ok) {
    throw new HubProviderOperationError("HUB_PROVIDER_LOOKUP_FAILED");
  }
  const entity = await response.json().catch(() => null);
  const decision = hubProviderCancellationDecision(entity, target);
  if (decision === "REVIEW_REQUIRED") {
    throw new HubProviderOperationError(
      "HUB_SUBSCRIPTION_RECONCILIATION_REQUIRED",
    );
  }
  if (decision === "ALREADY_FINAL") return { kind: "FINAL" };
  return { kind: "ACTIVE", entity: entity as Record<string, unknown> };
}

async function confirmedDeletionOutcome(
  deletion: Response,
  integration: ResolvedAsaasIntegration,
  target: ProviderTarget,
  fetcher: FetchLike,
): Promise<"CONFIRMED" | "ABSENT"> {
  if (!providerCancellationIsFinal(deletion.status)) {
    throw new HubProviderOperationError(
      "HUB_PROVIDER_CANCELLATION_OUTCOME_UNKNOWN",
    );
  }
  if (deletion.status === 404 || deletion.status === 410) return "ABSENT";

  // A successful mutation response proves only acceptance. Confirm the
  // terminal scheduler state with one exact GET before mutating local access.
  let confirmed:
    | { kind: "ABSENT" }
    | { kind: "FINAL" }
    | { kind: "ACTIVE"; entity: Record<string, unknown> };
  try {
    confirmed = await exactProviderLookup(integration, target, fetcher);
  } catch {
    throw new HubProviderOperationError(
      "HUB_PROVIDER_CANCELLATION_OUTCOME_UNKNOWN",
    );
  }
  if (confirmed.kind === "ACTIVE") {
    throw new HubProviderOperationError(
      "HUB_PROVIDER_CANCELLATION_OUTCOME_UNKNOWN",
    );
  }
  return confirmed.kind === "ABSENT" ? "ABSENT" : "CONFIRMED";
}

async function rpc(
  admin: AdminClient,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const { data, error } = await admin.rpc(name, args);
  if (error) {
    throw new HubProviderOperationError(
      ["42501", "55000"].includes(error.code || "")
        ? "HUB_PROVIDER_OPERATION_SCOPE_CHANGED"
        : "HUB_PROVIDER_OPERATION_FAILED",
    );
  }
  return data;
}

export async function markHubProviderCreationSubmitting(input: {
  admin: AdminClient;
  attemptId: string;
  claimToken: string | null | undefined;
  accountId: string;
  checkoutId: string;
}): Promise<void> {
  const claimToken = requiredText(
    input.claimToken,
    "HUB_PROVIDER_CREATION_CLAIM_INVALID",
  );
  const result = await rpc(
    input.admin,
    "hub_mark_provider_creation_submitting",
    {
      p_attempt_id: requiredText(
        input.attemptId,
        "HUB_PROVIDER_CREATION_CLAIM_INVALID",
      ),
      p_claim_token: claimToken,
      p_account_id: requiredText(
        input.accountId,
        "HUB_PROVIDER_CREATION_CLAIM_INVALID",
      ),
      p_checkout_id: requiredText(
        input.checkoutId,
        "HUB_PROVIDER_CREATION_CLAIM_INVALID",
      ),
    },
  );
  if (
    !result || typeof result !== "object" || Array.isArray(result) ||
    (result as Record<string, unknown>).ok !== true
  ) {
    throw new HubProviderOperationError("HUB_PROVIDER_LIFECYCLE_FENCED");
  }
}

export async function adoptHubProviderCreationBinding(input: {
  admin: AdminClient;
  attemptId: string;
  claimToken?: string | null;
  accountId: string;
  checkoutId: string;
  providerEntityId: string;
  providerStatus?: string | null;
}): Promise<void> {
  const result = await rpc(
    input.admin,
    "hub_adopt_provider_creation_binding",
    {
      p_attempt_id: requiredText(
        input.attemptId,
        "HUB_PROVIDER_CREATION_CLAIM_INVALID",
      ),
      p_claim_token: input.claimToken?.trim() || null,
      p_account_id: requiredText(
        input.accountId,
        "HUB_PROVIDER_CREATION_CLAIM_INVALID",
      ),
      p_checkout_id: requiredText(
        input.checkoutId,
        "HUB_PROVIDER_CREATION_CLAIM_INVALID",
      ),
      p_provider_entity_id: requiredText(
        input.providerEntityId,
        "HUB_PROVIDER_CREATION_CLAIM_INVALID",
      ),
      p_provider_status: input.providerStatus?.trim() || null,
    },
  );
  if (
    !result || typeof result !== "object" || Array.isArray(result) ||
    (result as Record<string, unknown>).ok !== true
  ) {
    throw new HubProviderOperationError("HUB_PROVIDER_LIFECYCLE_FENCED");
  }
}

export async function runHubProviderCancellation(input: {
  admin: AdminClient;
  operationKind: "ACCOUNT_STATUS" | "CORE_CANCELLATION";
  accountId: string;
  actorUserId: string | null;
  targetStatus?: "SUSPENDED" | "CLOSED" | null;
  reason?: string | null;
  fetcher?: FetchLike;
  resolveIntegration?: (
    admin: AdminClient,
    purpose: "subscription.read" | "subscription.delete",
  ) => Promise<ResolvedAsaasIntegration>;
}): Promise<Record<string, unknown>> {
  const fetcher = input.fetcher || fetch;
  const resolveIntegration = input.resolveIntegration ||
    resolvePlatformAsaasIntegration;
  const operation = parseOperation(
    await rpc(
      input.admin,
      "hub_begin_provider_cancellation",
      {
        p_operation_kind: input.operationKind,
        p_account_id: input.accountId,
        p_actor_user_id: input.actorUserId,
        p_target_status: input.targetStatus ?? null,
        p_reason: input.reason ?? null,
      },
    ),
  );
  if (operation.action === "ALREADY_SUCCEEDED") {
    return {
      ok: true,
      idempotent: true,
      operationId: operation.operationId,
    };
  }

  // Purpose/capability are resolved independently.  The operation is then
  // bound to the immutable integration version before any target is claimed.
  const [readIntegration, deleteIntegration] = await Promise.all([
    resolveIntegration(input.admin, "subscription.read"),
    resolveIntegration(input.admin, "subscription.delete"),
  ]);
  assertSameIntegration(readIntegration, deleteIntegration);
  await rpc(input.admin, "hub_bind_provider_operation_integration", {
    p_operation_id: operation.operationId,
    p_lease_token: operation.leaseToken,
    p_integration_id: deleteIntegration.integrationId,
    p_integration_version: deleteIntegration.version,
  });

  for (const target of operation.snapshot.targets) {
    const claim = await rpc(
      input.admin,
      "hub_claim_provider_cancellation_target",
      {
        p_operation_id: operation.operationId,
        p_lease_token: operation.leaseToken,
        p_provider_subscription_id: target.providerSubscriptionId,
      },
    ) as Record<string, unknown>;
    const action = requiredText(
      claim?.action,
      "HUB_PROVIDER_OPERATION_INVALID",
      40,
    );
    if (action === "ALREADY_SUCCEEDED") continue;
    if (!["VERIFY_REQUIRED", "RECONCILE_ONLY"].includes(action)) {
      throw new HubProviderOperationError(
        "HUB_SUBSCRIPTION_RECONCILIATION_REQUIRED",
      );
    }

    const observed = await exactProviderLookup(
      readIntegration,
      target,
      fetcher,
    );
    if (observed.kind === "ABSENT" || observed.kind === "FINAL") {
      await rpc(input.admin, "hub_complete_provider_cancellation_target", {
        p_operation_id: operation.operationId,
        p_lease_token: operation.leaseToken,
        p_provider_subscription_id: target.providerSubscriptionId,
        p_outcome: "ABSENT",
      });
      continue;
    }
    if (action === "RECONCILE_ONLY") {
      // The first worker may have sent DELETE and lost its response. Seeing an
      // active object here is review evidence, never permission to send again.
      throw new HubProviderOperationError(
        "HUB_SUBSCRIPTION_RECONCILIATION_REQUIRED",
      );
    }

    const submit = await rpc(
      input.admin,
      "hub_mark_provider_cancellation_submitting",
      {
        p_operation_id: operation.operationId,
        p_lease_token: operation.leaseToken,
        p_provider_subscription_id: target.providerSubscriptionId,
      },
    ) as Record<string, unknown>;
    const submitAction = requiredText(
      submit.action,
      "HUB_PROVIDER_OPERATION_INVALID",
      40,
    );
    if (submitAction === "ALREADY_SUCCEEDED") continue;
    if (submitAction !== "SUBMIT_ALLOWED") {
      throw new HubProviderOperationError(
        "HUB_SUBSCRIPTION_RECONCILIATION_REQUIRED",
      );
    }

    const freshDeleteIntegration = await revalidateHubDeleteCapability(
      input.admin,
      deleteIntegration,
      resolveIntegration,
    );

    let deletion: Response;
    try {
      deletion = await fetcher(
        `${freshDeleteIntegration.baseUrl}/subscriptions/${
          encodeURIComponent(target.providerSubscriptionId)
        }`,
        {
          method: "DELETE",
          headers: {
            access_token: freshDeleteIntegration.apiKey,
            "Content-Type": "application/json",
          },
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        },
      );
    } catch {
      throw new HubProviderOperationError(
        "HUB_PROVIDER_CANCELLATION_OUTCOME_UNKNOWN",
      );
    }
    const outcome = await confirmedDeletionOutcome(
      deletion,
      freshDeleteIntegration,
      target,
      fetcher,
    );
    await rpc(input.admin, "hub_complete_provider_cancellation_target", {
      p_operation_id: operation.operationId,
      p_lease_token: operation.leaseToken,
      p_provider_subscription_id: target.providerSubscriptionId,
      p_outcome: outcome,
    });
  }

  const finalized = await rpc(
    input.admin,
    "hub_finalize_provider_cancellation",
    {
      p_operation_id: operation.operationId,
      p_lease_token: operation.leaseToken,
    },
  );
  if (!finalized || typeof finalized !== "object" || Array.isArray(finalized)) {
    throw new HubProviderOperationError("HUB_PROVIDER_OPERATION_INVALID");
  }
  return finalized as Record<string, unknown>;
}

export async function cancelHubProviderSubscriptionOnce(input: {
  admin: AdminClient;
  accountId: string;
  target: ProviderTarget;
  fetcher?: FetchLike;
  resolveIntegration?: (
    admin: AdminClient,
    purpose: "subscription.read" | "subscription.delete",
  ) => Promise<ResolvedAsaasIntegration>;
}): Promise<void> {
  const fetcher = input.fetcher || fetch;
  const resolveIntegration = input.resolveIntegration ||
    resolvePlatformAsaasIntegration;
  const [readIntegration, deleteIntegration] = await Promise.all([
    resolveIntegration(input.admin, "subscription.read"),
    resolveIntegration(input.admin, "subscription.delete"),
  ]);
  assertSameIntegration(readIntegration, deleteIntegration);

  const claim = await rpc(
    input.admin,
    "hub_claim_webhook_provider_cancellation",
    {
      p_account_id: input.accountId,
      p_checkout_id: input.target.checkoutId,
      p_provider_subscription_id: input.target.providerSubscriptionId,
      p_provider_customer_id: input.target.providerCustomerId,
      p_integration_id: deleteIntegration.integrationId,
      p_integration_version: deleteIntegration.version,
    },
  ) as Record<string, unknown>;
  const action = requiredText(
    claim.action,
    "HUB_PROVIDER_OPERATION_INVALID",
    40,
  );
  const operationId = requiredText(
    claim.operationId,
    "HUB_PROVIDER_OPERATION_INVALID",
  );
  const leaseToken = requiredText(
    claim.leaseToken,
    "HUB_PROVIDER_OPERATION_INVALID",
  );
  if (action === "ALREADY_SUCCEEDED") {
    await rpc(input.admin, "hub_finalize_webhook_provider_cancellation", {
      p_operation_id: operationId,
      p_lease_token: leaseToken,
    });
    return;
  }
  if (!["VERIFY_REQUIRED", "RECONCILE_ONLY"].includes(action)) {
    throw new HubProviderOperationError(
      "HUB_SUBSCRIPTION_RECONCILIATION_REQUIRED",
    );
  }
  const observed = await exactProviderLookup(
    readIntegration,
    input.target,
    fetcher,
  );
  if (observed.kind === "ACTIVE" && action === "RECONCILE_ONLY") {
    throw new HubProviderOperationError(
      "HUB_SUBSCRIPTION_RECONCILIATION_REQUIRED",
    );
  }
  let outcome: "CONFIRMED" | "ABSENT" = "ABSENT";
  if (observed.kind === "ACTIVE") {
    const submit = await rpc(
      input.admin,
      "hub_mark_provider_cancellation_submitting",
      {
        p_operation_id: operationId,
        p_lease_token: leaseToken,
        p_provider_subscription_id: input.target.providerSubscriptionId,
      },
    ) as Record<string, unknown>;
    const submitAction = requiredText(
      submit.action,
      "HUB_PROVIDER_OPERATION_INVALID",
      40,
    );
    if (submitAction === "ALREADY_SUCCEEDED") {
      await rpc(input.admin, "hub_finalize_webhook_provider_cancellation", {
        p_operation_id: operationId,
        p_lease_token: leaseToken,
      });
      return;
    }
    if (submitAction !== "SUBMIT_ALLOWED") {
      throw new HubProviderOperationError(
        "HUB_SUBSCRIPTION_RECONCILIATION_REQUIRED",
      );
    }
    const freshDeleteIntegration = await revalidateHubDeleteCapability(
      input.admin,
      deleteIntegration,
      resolveIntegration,
    );
    let deletion: Response;
    try {
      deletion = await fetcher(
        `${freshDeleteIntegration.baseUrl}/subscriptions/${
          encodeURIComponent(input.target.providerSubscriptionId)
        }`,
        {
          method: "DELETE",
          headers: {
            access_token: freshDeleteIntegration.apiKey,
            "Content-Type": "application/json",
          },
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        },
      );
    } catch {
      throw new HubProviderOperationError(
        "HUB_PROVIDER_CANCELLATION_OUTCOME_UNKNOWN",
      );
    }
    outcome = await confirmedDeletionOutcome(
      deletion,
      freshDeleteIntegration,
      input.target,
      fetcher,
    );
  }
  await rpc(input.admin, "hub_complete_provider_cancellation_target", {
    p_operation_id: operationId,
    p_lease_token: leaseToken,
    p_provider_subscription_id: input.target.providerSubscriptionId,
    p_outcome: outcome,
  });
  await rpc(input.admin, "hub_finalize_webhook_provider_cancellation", {
    p_operation_id: operationId,
    p_lease_token: leaseToken,
  });
}
