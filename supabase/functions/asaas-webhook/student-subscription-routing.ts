/// <reference lib="deno.ns" />

import {
  type CanonicalAsaasReference,
  parseCanonicalAsaasReference,
} from "../_shared/asaas-mutation-guard.ts";

const STUDENT_SUBSCRIPTION_LIFECYCLE_EVENTS = new Set([
  "SUBSCRIPTION_CREATED",
  "SUBSCRIPTION_UPDATED",
  "SUBSCRIPTION_INACTIVATED",
  "SUBSCRIPTION_DELETED",
]);

export type StudentSubscriptionSnapshot = {
  id?: string | null;
  customer?: string | null;
  externalReference?: string | null;
  status?: string | null;
  value?: number | null;
  billingType?: string | null;
  maxPayments?: number | null;
  deleted?: boolean | null;
};

export type StudentSubscriptionProfile = {
  id?: string | null;
  tenant_id?: string | null;
  role?: string | null;
  asaas_customer_id?: string | null;
  subscription_id?: string | null;
};

export type StudentSubscriptionOffer = {
  id?: string | null;
  tenant_id?: string | null;
  kind?: string | null;
  processing_by?: string | null;
  consumed_by?: string | null;
};

export type StudentSubscriptionProfileBinding = {
  ok: true;
  studentId: string;
  tenantId: string;
  reference: CanonicalAsaasReference;
};

export type StudentSubscriptionBindingRejection = {
  ok: false;
  reason:
    | "student_subscription_identity_incomplete"
    | "student_subscription_binding_unresolved"
    | "student_subscription_binding_ambiguous"
    | "student_subscription_reference_mismatch";
  studentId: string | null;
  tenantId: string | null;
};

export type StudentSubscriptionLifecycleOperation = {
  id?: string | null;
  kind:
    | "CREATION"
    | "SUBSCRIPTION_MUTATION"
    | "BILLING_METHOD"
    | "OFFBOARDING"
    | "ACCOUNT_DELETION";
  tenantId?: string | null;
  studentId?: string | null;
  customerId?: string | null;
  subscriptionId?: string | null;
  status?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  externalReference?: string | null;
  mutationKind?: string | null;
  desiredState?: Record<string, unknown> | null;
  targetBillingType?: string | null;
  targetLifecycleStatus?: string | null;
  providerSubscriptionFinalStatus?: string | null;
};

export type StudentSubscriptionLifecycleAuthorization =
  | {
    ok: true;
    operationId: string;
    operationKind: StudentSubscriptionLifecycleOperation["kind"];
  }
  | {
    ok: false;
    reason:
      | "student_subscription_event_timestamp_invalid"
      | "student_subscription_operation_unresolved"
      | "student_subscription_operation_ambiguous";
  };

const text = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const upper = (value: unknown): string => text(value).toUpperCase();

const OPERATION_EARLY_SKEW_MS = 2 * 60 * 1_000;
const STANDARD_OPERATION_LATE_SKEW_MS = 10 * 60 * 1_000;
const LIFECYCLE_OPERATION_LATE_SKEW_MS = 30 * 60 * 1_000;

export function studentSubscriptionOperationQueryWindow(
  eventAt: string,
): { latestStartAt: string; earliestStartAt: string } | null {
  const eventTime = Date.parse(eventAt);
  if (!Number.isFinite(eventTime)) return null;
  return {
    latestStartAt: new Date(eventTime + OPERATION_EARLY_SKEW_MS).toISOString(),
    earliestStartAt: new Date(
      eventTime - LIFECYCLE_OPERATION_LATE_SKEW_MS,
    )
      .toISOString(),
  };
}

export function isStudentSubscriptionLifecycleEvent(
  eventName: unknown,
): boolean {
  return STUDENT_SUBSCRIPTION_LIFECYCLE_EVENTS.has(text(eventName));
}

export function classifyStudentSubscriptionProfileBinding(
  subscription: StudentSubscriptionSnapshot,
  candidates: StudentSubscriptionProfile[],
): StudentSubscriptionProfileBinding | StudentSubscriptionBindingRejection {
  const subscriptionId = text(subscription.id);
  const customerId = text(subscription.customer);
  if (!subscriptionId || !customerId) {
    return {
      ok: false,
      reason: "student_subscription_identity_incomplete",
      studentId: null,
      tenantId: null,
    };
  }

  if (candidates.length !== 1) {
    return {
      ok: false,
      reason: candidates.length > 1
        ? "student_subscription_binding_ambiguous"
        : "student_subscription_binding_unresolved",
      studentId: null,
      tenantId: null,
    };
  }

  const profile = candidates[0];
  const studentId = text(profile.id);
  const tenantId = text(profile.tenant_id);
  if (
    text(profile.subscription_id) !== subscriptionId ||
    text(profile.asaas_customer_id) !== customerId ||
    text(profile.role) !== "STUDENT" || !studentId || !tenantId
  ) {
    return {
      ok: false,
      reason: "student_subscription_binding_unresolved",
      studentId: null,
      tenantId: null,
    };
  }
  const reference = parseCanonicalAsaasReference(
    subscription.externalReference,
    studentId,
    "subscription",
  );
  if (!reference) {
    return {
      ok: false,
      reason: "student_subscription_reference_mismatch",
      studentId,
      tenantId,
    };
  }

  return { ok: true, studentId, tenantId, reference };
}

export function studentEnrollmentOfferMatchesBinding(
  binding: StudentSubscriptionProfileBinding,
  offer: StudentSubscriptionOffer | null | undefined,
): boolean {
  if (binding.reference.kind !== "ENROLLMENT") return true;
  return text(offer?.id).toLowerCase() === binding.reference.offerId &&
    text(offer?.tenant_id) === binding.tenantId &&
    text(offer?.kind) === "ENROLLMENT" &&
    [text(offer?.processing_by), text(offer?.consumed_by)].includes(
      binding.studentId,
    );
}

function operationScopeMatches(
  binding: StudentSubscriptionProfileBinding,
  subscription: StudentSubscriptionSnapshot,
  operation: StudentSubscriptionLifecycleOperation,
): boolean {
  return Boolean(text(operation.id)) &&
    text(operation.tenantId) === binding.tenantId &&
    text(operation.studentId) === binding.studentId &&
    text(operation.customerId) === text(subscription.customer) &&
    text(operation.subscriptionId) === text(subscription.id);
}

function eventFallsInsideOperationWindow(
  eventAt: string,
  operation: StudentSubscriptionLifecycleOperation,
): boolean {
  const eventTime = Date.parse(eventAt);
  const startedAt = Date.parse(text(operation.startedAt));
  const endedAt = Date.parse(text(operation.endedAt));
  const allowedDelay = ["OFFBOARDING", "ACCOUNT_DELETION"].includes(
      operation.kind,
    )
    ? LIFECYCLE_OPERATION_LATE_SKEW_MS
    : STANDARD_OPERATION_LATE_SKEW_MS;
  return Number.isFinite(eventTime) && Number.isFinite(startedAt) &&
    Number.isFinite(endedAt) && endedAt >= startedAt &&
    eventTime >= startedAt - OPERATION_EARLY_SKEW_MS &&
    eventTime <= startedAt + allowedDelay;
}

function desiredSubscriptionMutationMatches(
  subscription: StudentSubscriptionSnapshot,
  operation: StudentSubscriptionLifecycleOperation,
): boolean {
  const desired = operation.desiredState;
  if (!desired || typeof desired !== "object" || Array.isArray(desired)) {
    return false;
  }
  if (upper(operation.mutationKind) === "PLAN_VALUE") {
    const expectedCents = Number(desired.valueCents);
    const observedValue = Number(subscription.value);
    return Number.isSafeInteger(expectedCents) && expectedCents > 0 &&
      Number.isFinite(observedValue) && observedValue > 0 &&
      Math.round(observedValue * 100) === expectedCents;
  }
  if (upper(operation.mutationKind) === "MAX_PAYMENTS") {
    const expectedMaximum = Number(desired.maxPayments);
    return Number.isSafeInteger(expectedMaximum) && expectedMaximum > 0 &&
      Number(subscription.maxPayments) === expectedMaximum;
  }
  return false;
}

function operationAuthorizesEvent(
  eventName: string,
  eventAt: string,
  binding: StudentSubscriptionProfileBinding,
  subscription: StudentSubscriptionSnapshot,
  operation: StudentSubscriptionLifecycleOperation,
): boolean {
  if (
    !operationScopeMatches(binding, subscription, operation) ||
    !eventFallsInsideOperationWindow(eventAt, operation)
  ) return false;

  const operationStatus = upper(operation.status);
  const providerStatus = upper(subscription.status);
  const notDeleted = subscription.deleted !== true;
  switch (operation.kind) {
    case "CREATION":
      return eventName === "SUBSCRIPTION_CREATED" &&
        ["SUBMITTING", "UNKNOWN", "SUCCEEDED"].includes(operationStatus) &&
        text(operation.externalReference) ===
          text(subscription.externalReference) &&
        providerStatus === "ACTIVE" && notDeleted;
    case "SUBSCRIPTION_MUTATION":
      return eventName === "SUBSCRIPTION_UPDATED" &&
        ["SUBMITTING", "UNKNOWN", "SUCCEEDED"].includes(operationStatus) &&
        providerStatus === "ACTIVE" && notDeleted &&
        desiredSubscriptionMutationMatches(subscription, operation);
    case "BILLING_METHOD":
      return eventName === "SUBSCRIPTION_UPDATED" &&
        ["MUTATING", "UNKNOWN", "COMPLETED"].includes(operationStatus) &&
        upper(operation.targetBillingType) ===
          upper(subscription.billingType) &&
        providerStatus === "ACTIVE" && notDeleted;
    case "OFFBOARDING": {
      const target = text(operation.targetLifecycleStatus).toLowerCase();
      const finalStatus = upper(operation.providerSubscriptionFinalStatus);
      const authorizedStatus = [
        "PROVIDER_MUTATING",
        "PROVIDER_COMPLETE",
        "UNKNOWN",
        "COMPLETED",
      ].includes(operationStatus);
      if (!authorizedStatus) return false;
      if (eventName === "SUBSCRIPTION_UPDATED") {
        return target === "active" && finalStatus === "ACTIVE" &&
          providerStatus === "ACTIVE" && notDeleted;
      }
      if (eventName === "SUBSCRIPTION_INACTIVATED") {
        return ["suspended", "offboarded"].includes(target) &&
          finalStatus === "INACTIVE" && providerStatus === "INACTIVE" &&
          notDeleted;
      }
      return eventName === "SUBSCRIPTION_DELETED" &&
        target === "offboarded" && finalStatus === "NOT_FOUND" &&
        subscription.deleted === true;
    }
    case "ACCOUNT_DELETION":
      return eventName === "SUBSCRIPTION_DELETED" &&
        [
          "PROVIDER_MUTATING",
          "PROVIDER_COMPLETE",
          "UNKNOWN",
          "COMPLETED",
        ].includes(operationStatus) && subscription.deleted === true;
  }
}

export function authorizeStudentSubscriptionLifecycleEvent(input: {
  eventName: string;
  eventAt: string;
  binding: StudentSubscriptionProfileBinding;
  subscription: StudentSubscriptionSnapshot;
  operations: StudentSubscriptionLifecycleOperation[];
}): StudentSubscriptionLifecycleAuthorization {
  if (!studentSubscriptionOperationQueryWindow(input.eventAt)) {
    return {
      ok: false,
      reason: "student_subscription_event_timestamp_invalid",
    };
  }
  const matches = input.operations.filter((operation) =>
    operationAuthorizesEvent(
      input.eventName,
      input.eventAt,
      input.binding,
      input.subscription,
      operation,
    )
  );
  if (matches.length !== 1) {
    return {
      ok: false,
      reason: matches.length > 1
        ? "student_subscription_operation_ambiguous"
        : "student_subscription_operation_unresolved",
    };
  }
  return {
    ok: true,
    operationId: text(matches[0].id),
    operationKind: matches[0].kind,
  };
}
