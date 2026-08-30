import type { PaymentAdminClient } from "./payment-auth.ts";

export type AsaasCreationOperation =
  | "CUSTOMER_CREATE"
  | "PAYMENT_CREATE"
  | "SUBSCRIPTION_CREATE";

export type AsaasCreationClaimAction =
  | "SUBMIT_ONCE"
  | "RECONCILE_REQUIRED"
  | "ALREADY_SUCCEEDED"
  | "IN_PROGRESS"
  | "REVIEW_REQUIRED";

export type AsaasCreationClaim = {
  ok: boolean;
  action: AsaasCreationClaimAction;
  attempt_id: string;
  claim_token?: string;
  external_reference?: string;
  provider_entity_id?: string;
  provider_status?: string;
  status?: string;
  reason?: string;
  retry_after_seconds?: number;
};

export type StudentAsaasCreationBindingKind =
  | "CUSTOMER"
  | "ENROLLMENT_PAYMENT"
  | "SUBSCRIPTION"
  | "BILLING_PERIOD_PAYMENT"
  | "STUDENT_PAYMENT"
  | "TOPUP_ORDER";

export type AsaasCollectionLookup<T extends Record<string, unknown>> =
  | { kind: "FOUND"; entity: T }
  | { kind: "NOT_FOUND" }
  | { kind: "CONFLICT"; count: number }
  | { kind: "DUPLICATE"; count: number }
  | { kind: "UNAVAILABLE"; httpStatus?: number };

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? "null" : serialized;
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const source = value as Record<string, unknown>;
  const keys = Object.keys(source).sort();
  return `{${
    keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(source[key])}`)
      .join(",")
  }}`;
}

export async function asaasCreationFingerprint(
  stableInput: Record<string, unknown>,
): Promise<string> {
  const encoded = new TextEncoder().encode(canonicalJson(stableInput));
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function validClaim(data: unknown): data is AsaasCreationClaim {
  if (!data || typeof data !== "object") return false;
  const claim = data as Record<string, unknown>;
  return typeof claim.ok === "boolean" &&
    typeof claim.action === "string" &&
    typeof claim.attempt_id === "string";
}

export async function claimAsaasCreation(
  admin: PaymentAdminClient,
  input: {
    tenantId: string;
    operation: AsaasCreationOperation;
    logicalKey: string;
    externalReference: string;
    requestFingerprint: string;
    claimToken?: string;
  },
): Promise<AsaasCreationClaim> {
  const claimToken = input.claimToken || crypto.randomUUID();
  const { data, error } = await admin.rpc("claim_asaas_provider_creation", {
    p_tenant_id: input.tenantId,
    p_operation: input.operation,
    p_logical_key: input.logicalKey,
    p_external_reference: input.externalReference,
    p_request_fingerprint: input.requestFingerprint,
    p_claim_token: claimToken,
    p_lease_seconds: 300,
  });
  if (error || !validClaim(data)) {
    console.error("[asaas-creation-guard] claim failed", {
      code: error?.code || "invalid_rpc_response",
    });
    throw new Error("asaas_creation_claim_failed");
  }
  return data;
}

export async function freezeEnrollmentPaymentRequest(
  admin: PaymentAdminClient,
  claim: AsaasCreationClaim,
  input: { dueDate: string; description: string },
): Promise<string> {
  const { data, error } = await admin.rpc(
    "freeze_asaas_enrollment_payment_request",
    {
      p_attempt_id: claim.attempt_id,
      p_claim_token: claim.claim_token || null,
      p_due_date: input.dueDate,
      p_description: input.description,
    },
  );
  const dueDate = typeof data?.due_date === "string"
    ? data.due_date.trim()
    : "";
  if (
    error || data?.ok !== true ||
    !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)
  ) {
    console.error("[asaas-creation-guard] request snapshot freeze blocked", {
      code: error?.code || data?.reason || "invalid_rpc_response",
    });
    throw new Error("asaas_creation_request_snapshot_failed");
  }
  return dueDate;
}

export async function markAsaasCreationSubmitting(
  admin: PaymentAdminClient,
  claim: AsaasCreationClaim,
): Promise<void> {
  if (!claim.claim_token) throw new Error("asaas_creation_claim_token_missing");
  const { data, error } = await admin.rpc(
    "mark_asaas_provider_creation_submitting",
    {
      p_attempt_id: claim.attempt_id,
      p_claim_token: claim.claim_token,
    },
  );
  if (error || data?.ok !== true) {
    console.error("[asaas-creation-guard] submit claim lost", {
      code: error?.code || data?.reason || "unknown",
    });
    throw new Error("asaas_creation_claim_lost");
  }
}

export async function revalidateActiveStudentCreationScope(
  admin: PaymentAdminClient,
  input: {
    tenantId: string;
    studentId: string;
    bindingKind: StudentAsaasCreationBindingKind;
    expectedCustomerId: string | null;
  },
): Promise<boolean> {
  const [profileResult, membershipResult] = await Promise.all([
    admin.from("profiles")
      .select(
        "id,tenant_id,role,lifecycle_status,asaas_customer_id,subscription_id,enrollment_payment_id",
      )
      .eq("id", input.studentId)
      .eq("tenant_id", input.tenantId)
      .eq("role", "STUDENT")
      .eq("lifecycle_status", "active")
      .maybeSingle(),
    admin.from("tenant_memberships")
      .select("tenant_id,role,status")
      .eq("user_id", input.studentId)
      .limit(2),
  ]);
  const profile = profileResult.data as Record<string, unknown> | null;
  const memberships = Array.isArray(membershipResult.data)
    ? membershipResult.data as Array<Record<string, unknown>>
    : [];
  if (
    profileResult.error || membershipResult.error || !profile ||
    memberships.length !== 1
  ) {
    return false;
  }
  const membership = memberships[0];
  if (
    String(membership.tenant_id || "").trim() !== input.tenantId ||
    membership.role !== "STUDENT" || membership.status !== "ACTIVE"
  ) return false;

  const customerId = String(profile.asaas_customer_id || "").trim();
  if (input.bindingKind === "CUSTOMER") return customerId === "";
  if (!input.expectedCustomerId || customerId !== input.expectedCustomerId) {
    return false;
  }
  if (input.bindingKind === "ENROLLMENT_PAYMENT") {
    return String(profile.enrollment_payment_id || "").trim() === "";
  }
  if (input.bindingKind === "SUBSCRIPTION") {
    return String(profile.subscription_id || "").trim() === "";
  }
  return true;
}

export async function bindStudentAsaasCreationLifecycle(
  admin: PaymentAdminClient,
  claim: AsaasCreationClaim,
  input: {
    tenantId: string;
    studentId: string;
    bindingKind: StudentAsaasCreationBindingKind;
    expectedCustomerId: string | null;
  },
): Promise<boolean> {
  const { data, error } = await admin.rpc(
    "bind_student_asaas_creation_lifecycle",
    {
      p_attempt_id: claim.attempt_id,
      p_claim_token: claim.claim_token || null,
      p_tenant_id: input.tenantId,
      p_student_id: input.studentId,
      p_binding_kind: input.bindingKind,
      p_expected_customer_id: input.expectedCustomerId,
    },
  );
  if (error || data?.ok !== true) {
    console.error("[asaas-creation-guard] student lifecycle bind blocked", {
      code: error?.code || data?.reason || "unknown",
      bindingKind: input.bindingKind,
    });
    return false;
  }
  return true;
}

export async function markStudentAsaasCreationSubmitting(
  admin: PaymentAdminClient,
  claim: AsaasCreationClaim,
  input: {
    tenantId: string;
    studentId: string;
    bindingKind: StudentAsaasCreationBindingKind;
    expectedCustomerId: string | null;
  },
): Promise<void> {
  if (!claim.claim_token) throw new Error("asaas_creation_claim_token_missing");
  const { data, error } = await admin.rpc(
    "mark_student_asaas_creation_submitting",
    {
      p_attempt_id: claim.attempt_id,
      p_claim_token: claim.claim_token,
      p_tenant_id: input.tenantId,
      p_student_id: input.studentId,
      p_binding_kind: input.bindingKind,
      p_expected_customer_id: input.expectedCustomerId,
    },
  );
  if (error || data?.ok !== true) {
    console.error("[asaas-creation-guard] student submit fence blocked", {
      code: error?.code || data?.reason || "unknown",
      bindingKind: input.bindingKind,
    });
    throw new Error("student_asaas_creation_lifecycle_blocked");
  }
}

export async function releaseStudentAsaasCreationLifecycle(
  admin: PaymentAdminClient,
  claim: AsaasCreationClaim,
  input: {
    tenantId: string;
    studentId: string;
    providerEntityId: string;
  },
): Promise<boolean> {
  const { data, error } = await admin.rpc(
    "release_student_asaas_creation_lifecycle",
    {
      p_attempt_id: claim.attempt_id,
      p_tenant_id: input.tenantId,
      p_student_id: input.studentId,
      p_provider_entity_id: input.providerEntityId,
    },
  );
  if (error || data?.ok !== true) {
    console.error("[asaas-creation-guard] student lifecycle release failed", {
      code: error?.code || data?.reason || "unknown",
    });
    return false;
  }
  return true;
}

export async function recordAsaasCreationState(
  admin: PaymentAdminClient,
  claim: AsaasCreationClaim,
  input: {
    status: "RETRY" | "UNKNOWN" | "SUCCEEDED" | "FAILED" | "BLOCKED";
    providerEntityId?: string | null;
    providerStatus?: string | null;
    httpStatus?: number | null;
    error?: string | null;
  },
): Promise<void> {
  if (!claim.claim_token) throw new Error("asaas_creation_claim_token_missing");
  const providerEntityId = input.providerEntityId?.trim() || null;
  const providerStatus = input.providerStatus?.trim() || null;
  const { data, error } = await admin.rpc(
    "record_asaas_provider_creation_state",
    {
      p_attempt_id: claim.attempt_id,
      p_claim_token: claim.claim_token,
      p_status: input.status,
      p_provider_entity_id: providerEntityId,
      p_provider_status: providerStatus,
      p_http_status: input.httpStatus ?? null,
      p_error: input.error?.slice(0, 200) || null,
      // Only a deliberately small, PII-free summary is persisted.
      p_provider_response: providerEntityId
        ? { id: providerEntityId, status: providerStatus }
        : null,
    },
  );
  if (error || data?.ok !== true) {
    console.error("[asaas-creation-guard] state persistence failed", {
      code: error?.code || data?.reason || "unknown",
      targetStatus: input.status,
    });
    throw new Error("asaas_creation_state_persistence_failed");
  }
}

/**
 * Reads every provider page before deciding uniqueness. A single result from a
 * `limit=1` query is not evidence that no duplicate exists.
 */
export async function findUniqueAsaasEntity<
  T extends Record<string, unknown>,
>(input: {
  baseUrl: string;
  apiKey: string;
  path: string;
  query: Record<string, string>;
  matches: (entity: T) => boolean;
  /**
   * Identifies an entity that occupies the same provider identity key (for
   * example externalReference) but has divergent immutable fields. Such an
   * entity is a conflict, never evidence that it is safe to POST again.
   */
  conflicts?: (entity: T) => boolean;
}): Promise<AsaasCollectionLookup<T>> {
  const matches: T[] = [];
  let conflictCount = 0;
  let offset = 0;
  let exhaustedPageLimit = true;

  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const url = new URL(input.path, `${input.baseUrl.replace(/\/$/, "")}/`);
    for (const [key, value] of Object.entries(input.query)) {
      url.searchParams.set(key, value);
    }
    url.searchParams.set("limit", "100");
    url.searchParams.set("offset", String(offset));

    let response: Response;
    try {
      response = await fetch(url, {
        headers: { access_token: input.apiKey },
        signal: AbortSignal.timeout(12_000),
      });
    } catch {
      return { kind: "UNAVAILABLE" };
    }
    if (!response.ok) {
      return { kind: "UNAVAILABLE", httpStatus: response.status };
    }

    const payload = await response.json().catch(() => null) as
      | Record<string, unknown>
      | null;
    if (!payload || !Array.isArray(payload.data)) {
      return { kind: "UNAVAILABLE", httpStatus: response.status };
    }
    const page = payload.data as T[];
    for (const entity of page) {
      if (input.matches(entity)) {
        matches.push(entity);
      } else if (input.conflicts?.(entity)) {
        conflictCount += 1;
      }
      if (matches.length > 1) {
        return { kind: "DUPLICATE", count: matches.length };
      }
    }

    const hasMore = payload.hasMore === true;
    if (!hasMore) {
      exhaustedPageLimit = false;
      break;
    }
    if (page.length === 0) return { kind: "UNAVAILABLE" };
    offset += page.length;
  }

  if (exhaustedPageLimit) return { kind: "UNAVAILABLE" };
  // A matching object plus another object using the same identity key is also
  // unsafe: accepting the match would hide provider-side divergence.
  if (conflictCount > 0) return { kind: "CONFLICT", count: conflictCount };
  if (matches.length === 1) return { kind: "FOUND", entity: matches[0] };
  return { kind: "NOT_FOUND" };
}

export function asaasCreationHttpOutcome(
  responseOk: boolean,
  httpStatus: number,
  providerEntityId: string,
): "SUCCEEDED" | "FAILED" | "UNKNOWN" {
  if (responseOk && providerEntityId) return "SUCCEEDED";
  // Timeout, conflict and throttling responses can race with provider commit.
  // Only deterministic client/validation rejections are terminal.
  if (
    [
      400,
      401,
      403,
      404,
      405,
      406,
      410,
      411,
      412,
      413,
      414,
      415,
      416,
      417,
      421,
      422,
    ].includes(httpStatus)
  ) {
    return "FAILED";
  }
  return "UNKNOWN";
}

export function isAsaasSettledPaymentStatus(status: unknown): boolean {
  const normalized = String(status || "").trim().toUpperCase();
  return normalized === "RECEIVED" || normalized === "RECEIVED_IN_CASH";
}

export function isAsaasRefundedPaymentStatus(status: unknown): boolean {
  return String(status || "").trim().toUpperCase() === "REFUNDED";
}
