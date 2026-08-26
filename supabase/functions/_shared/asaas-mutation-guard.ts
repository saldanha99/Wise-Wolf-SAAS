// A provider ID is only an address. Before any destructive or financial Asaas
// mutation, prove that the object at that address still belongs to the
// canonical student/customer/tenant stored locally.

// The project does not generate Database types for Edge Functions yet.
// deno-lint-ignore no-explicit-any
export type AsaasMutationAdminClient = any;

export type AsaasMutationResource = "subscription" | "payment";
export type AsaasSubscriptionMatch = "entity_id" | "required" | "optional";

export type CanonicalAsaasMutationTarget = {
  tenantId: string;
  studentId: string;
  resource: AsaasMutationResource;
  entityId: string;
  customerId: string;
  subscriptionId: string | null;
  subscriptionMatch: AsaasSubscriptionMatch;
};

export type AsaasMutationGuardResult =
  | { ok: true; entity: Record<string, unknown>; providerStatus: number }
  | {
    ok: false;
    code:
      | "CANONICAL_BINDING_INVALID"
      | "IDENTITY_MISMATCH"
      | "LOOKUP_FAILED"
      | "NOT_FOUND"
      | "REFERENCE_UNAVAILABLE";
    providerStatus: number | null;
  };

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENROLLMENT_REFERENCE_PATTERN =
  /^enrollment:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):(subscription|one-time|pro-rata|fee)$/i;

const text = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

function monetaryCents(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric * 100) : null;
}

export type CanonicalAsaasReference =
  | { kind: "STUDENT" }
  | {
    kind: "ENROLLMENT";
    offerId: string;
    purpose: "subscription" | "one-time" | "pro-rata" | "fee";
  };

export function parseCanonicalAsaasReference(
  reference: unknown,
  studentId: string,
  resource: AsaasMutationResource,
): CanonicalAsaasReference | null {
  const normalizedReference = text(reference);
  if (normalizedReference === studentId) return { kind: "STUDENT" };

  const match = normalizedReference.match(ENROLLMENT_REFERENCE_PATTERN);
  if (!match) return null;
  const purpose = match[2].toLowerCase() as
    | "subscription"
    | "one-time"
    | "pro-rata"
    | "fee";
  if (resource === "subscription" && purpose !== "subscription") return null;
  return {
    kind: "ENROLLMENT",
    offerId: match[1].toLowerCase(),
    purpose,
  };
}

function canonicalBindingMismatchFields(
  target: CanonicalAsaasMutationTarget,
): string[] {
  const fields: string[] = [];
  if (!target.tenantId) fields.push("tenant_id");
  if (!UUID_PATTERN.test(target.studentId)) fields.push("student_id");
  if (!target.entityId) fields.push("entity_id");
  if (!target.customerId) fields.push("customer_id");
  if (
    target.subscriptionMatch === "entity_id" &&
    target.subscriptionId !== target.entityId
  ) {
    fields.push("subscription_id");
  }
  if (
    target.subscriptionMatch === "required" && !target.subscriptionId
  ) {
    fields.push("subscription_id");
  }
  return fields;
}

export function asaasProviderIdentityMismatchFields(
  entity: unknown,
  target: CanonicalAsaasMutationTarget,
  canonicalExternalReference: boolean,
): string[] {
  if (!entity || typeof entity !== "object" || Array.isArray(entity)) {
    return ["body"];
  }
  const provider = entity as Record<string, unknown>;
  const mismatches: string[] = [];
  if (text(provider.id) !== target.entityId) mismatches.push("id");
  if (text(provider.customer) !== target.customerId) {
    mismatches.push("customer");
  }
  if (provider.deleted === true) mismatches.push("deleted");

  if (target.resource === "subscription") {
    if (
      target.subscriptionMatch !== "entity_id" ||
      target.subscriptionId !== target.entityId
    ) {
      mismatches.push("subscription");
    }
  } else {
    const providerSubscription = text(provider.subscription);
    if (
      target.subscriptionMatch === "required" &&
      providerSubscription !== target.subscriptionId
    ) {
      mismatches.push("subscription");
    } else if (
      target.subscriptionMatch === "optional" && providerSubscription &&
      providerSubscription !== target.subscriptionId
    ) {
      mismatches.push("subscription");
    }
  }

  if (!canonicalExternalReference) mismatches.push("externalReference");
  return [...new Set(mismatches)];
}

async function enrollmentReferenceBelongsToStudent(
  admin: AsaasMutationAdminClient,
  target: CanonicalAsaasMutationTarget,
  reference: Extract<CanonicalAsaasReference, { kind: "ENROLLMENT" }>,
): Promise<{ ok: boolean; unavailable: boolean }> {
  try {
    const { data, error } = await admin.from("offers")
      .select("id,tenant_id,processing_by,consumed_by")
      .eq("id", reference.offerId)
      .eq("tenant_id", target.tenantId)
      .maybeSingle();
    if (error) return { ok: false, unavailable: true };
    return {
      ok: Boolean(
        data?.id === reference.offerId &&
          data?.tenant_id === target.tenantId &&
          (data?.processing_by === target.studentId ||
            data?.consumed_by === target.studentId),
      ),
      unavailable: false,
    };
  } catch {
    return { ok: false, unavailable: true };
  }
}

async function recordCriticalIdentityIssue(
  admin: AsaasMutationAdminClient,
  input: {
    operation: string;
    target: CanonicalAsaasMutationTarget;
    kind:
      | "ASAAS_CANONICAL_BINDING_INVALID"
      | "ASAAS_PROVIDER_IDENTITY_MISMATCH"
      | "ASAAS_REFERENCE_VERIFICATION_UNAVAILABLE";
    mismatchFields: string[];
    observedEntity?: Record<string, unknown> | null;
    providerStatus?: number | null;
  },
): Promise<void> {
  const observed = input.observedEntity || {};
  const fingerprint = [
    "asaas-mutation-guard",
    input.operation,
    input.target.tenantId || "tenant-missing",
    input.target.resource,
    input.target.entityId || "entity-missing",
    input.kind,
  ].join(":").toLowerCase();
  try {
    const { error } = await admin.from("asaas_reconciliation_issues").insert({
      tenant_id: input.target.tenantId || null,
      source: "MUTATION_GUARD",
      kind: input.kind,
      severity: "CRITICAL",
      provider_entity_id: input.target.entityId || text(observed.id) || null,
      local_entity_id: input.target.studentId || null,
      fingerprint,
      details: {
        operation: input.operation,
        resource: input.target.resource,
        mismatchFields: input.mismatchFields,
        expectedEntityId: input.target.entityId || null,
        observedEntityId: text(observed.id) || null,
        providerStatus: input.providerStatus ?? null,
      },
    });
    if (error && error.code !== "23505") {
      console.error("[asaas-mutation-guard] critical_signal_failed", {
        code: error.code || "unknown",
        operation: input.operation,
      });
    }
  } catch {
    console.error("[asaas-mutation-guard] critical_signal_failed", {
      code: "unexpected",
      operation: input.operation,
    });
  }
  console.error("[asaas-mutation-guard] critical_identity_block", {
    kind: input.kind,
    operation: input.operation,
    resource: input.target.resource,
    mismatchFields: input.mismatchFields,
  });
}

export async function revalidateCanonicalAsaasBinding(input: {
  admin: AsaasMutationAdminClient;
  operation: string;
  target: CanonicalAsaasMutationTarget;
}): Promise<boolean> {
  try {
    const { data, error } = await input.admin.from("profiles")
      .select("id,tenant_id,role,asaas_customer_id,subscription_id")
      .eq("id", input.target.studentId)
      .eq("tenant_id", input.target.tenantId)
      .eq("role", "STUDENT")
      .maybeSingle();
    const subscriptionMatches = input.target.subscriptionMatch === "optional"
      ? !input.target.subscriptionId ||
        text(data?.subscription_id) === input.target.subscriptionId
      : text(data?.subscription_id) === input.target.subscriptionId;
    if (
      !error && data?.id === input.target.studentId &&
      text(data.asaas_customer_id) === input.target.customerId &&
      subscriptionMatches
    ) {
      return true;
    }
  } catch {
    // Fail closed and emit the same durable signal as other binding failures.
  }
  await recordCriticalIdentityIssue(input.admin, {
    operation: `${input.operation}_local_recheck`,
    target: input.target,
    kind: "ASAAS_CANONICAL_BINDING_INVALID",
    mismatchFields: ["local_binding_changed"],
  });
  return false;
}

export function asaasSubscriptionPostconditionMismatchFields(
  entity: unknown,
  expected: { value?: number; maxPayments?: number },
): string[] {
  if (!entity || typeof entity !== "object" || Array.isArray(entity)) {
    return ["body"];
  }
  const subscription = entity as Record<string, unknown>;
  const mismatches: string[] = [];
  if (
    expected.value !== undefined &&
    monetaryCents(subscription.value) !== monetaryCents(expected.value)
  ) {
    mismatches.push("value");
  }
  if (
    expected.maxPayments !== undefined &&
    Number(subscription.maxPayments) !== expected.maxPayments
  ) {
    mismatches.push("maxPayments");
  }
  return mismatches;
}

export async function guardAsaasMutationTarget(input: {
  admin: AsaasMutationAdminClient;
  baseUrl: string;
  apiKey: string;
  operation: string;
  target: CanonicalAsaasMutationTarget;
  fetcher?: FetchLike;
}): Promise<AsaasMutationGuardResult> {
  const canonicalMismatches = canonicalBindingMismatchFields(input.target);
  if (canonicalMismatches.length > 0) {
    await recordCriticalIdentityIssue(input.admin, {
      operation: input.operation,
      target: input.target,
      kind: "ASAAS_CANONICAL_BINDING_INVALID",
      mismatchFields: canonicalMismatches,
    });
    return {
      ok: false,
      code: "CANONICAL_BINDING_INVALID",
      providerStatus: null,
    };
  }

  const fetcher = input.fetcher || fetch;
  const resourcePath = input.target.resource === "subscription"
    ? "subscriptions"
    : "payments";
  let response: Response;
  try {
    response = await fetcher(
      `${input.baseUrl.replace(/\/$/, "")}/${resourcePath}/${
        encodeURIComponent(input.target.entityId)
      }`,
      {
        method: "GET",
        headers: { access_token: input.apiKey },
        signal: AbortSignal.timeout(12_000),
      },
    );
  } catch {
    return { ok: false, code: "LOOKUP_FAILED", providerStatus: null };
  }

  if (response.status === 404) {
    return { ok: false, code: "NOT_FOUND", providerStatus: 404 };
  }
  if (!response.ok) {
    return {
      ok: false,
      code: "LOOKUP_FAILED",
      providerStatus: response.status,
    };
  }
  const entity = await response.json().catch(() => null) as unknown;
  if (!entity || typeof entity !== "object" || Array.isArray(entity)) {
    await recordCriticalIdentityIssue(input.admin, {
      operation: input.operation,
      target: input.target,
      kind: "ASAAS_PROVIDER_IDENTITY_MISMATCH",
      mismatchFields: ["body"],
      providerStatus: response.status,
    });
    return {
      ok: false,
      code: "IDENTITY_MISMATCH",
      providerStatus: response.status,
    };
  }

  const providerEntity = entity as Record<string, unknown>;
  const reference = parseCanonicalAsaasReference(
    providerEntity.externalReference,
    input.target.studentId,
    input.target.resource,
  );
  let canonicalReference = reference?.kind === "STUDENT";
  if (reference?.kind === "ENROLLMENT") {
    const verification = await enrollmentReferenceBelongsToStudent(
      input.admin,
      input.target,
      reference,
    );
    if (verification.unavailable) {
      await recordCriticalIdentityIssue(input.admin, {
        operation: input.operation,
        target: input.target,
        kind: "ASAAS_REFERENCE_VERIFICATION_UNAVAILABLE",
        mismatchFields: ["externalReference"],
        observedEntity: providerEntity,
        providerStatus: response.status,
      });
      return {
        ok: false,
        code: "REFERENCE_UNAVAILABLE",
        providerStatus: response.status,
      };
    }
    canonicalReference = verification.ok;
  }
  if (
    !reference && !text(providerEntity.externalReference) &&
    input.target.resource === "payment"
  ) {
    const providerSubscriptionId = text(providerEntity.subscription);
    if (
      providerSubscriptionId &&
      providerSubscriptionId === input.target.subscriptionId
    ) {
      // Asaas guarantees the `subscription` field on charges generated by a
      // recurrence, but legacy/generated charges may not repeat the
      // subscription's externalReference. In that case, prove the reference on
      // the canonical parent subscription instead of weakening the check.
      const subscriptionGuard = await guardAsaasMutationTarget({
        admin: input.admin,
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
        operation: `${input.operation}_subscription_reference`,
        target: {
          ...input.target,
          resource: "subscription",
          entityId: providerSubscriptionId,
          subscriptionId: providerSubscriptionId,
          subscriptionMatch: "entity_id",
        },
        fetcher,
      });
      canonicalReference = subscriptionGuard.ok;
    }
  }

  const mismatchFields = asaasProviderIdentityMismatchFields(
    providerEntity,
    input.target,
    canonicalReference,
  );
  if (mismatchFields.length > 0) {
    await recordCriticalIdentityIssue(input.admin, {
      operation: input.operation,
      target: input.target,
      kind: "ASAAS_PROVIDER_IDENTITY_MISMATCH",
      mismatchFields,
      observedEntity: providerEntity,
      providerStatus: response.status,
    });
    return {
      ok: false,
      code: "IDENTITY_MISMATCH",
      providerStatus: response.status,
    };
  }

  return {
    ok: true,
    entity: providerEntity,
    providerStatus: response.status,
  };
}
