/// <reference lib="deno.ns" />

import { providerPaymentSplitMatches } from "../_shared/student-provider-lifecycle.ts";

export type HubAsaasCustomerOrigin = "LINKED" | "RECOVERED" | "CREATED";

export type HubAsaasCustomerResolution =
  | { status: "NONE" }
  | { status: "MATCH"; customerId: string }
  | { status: "IDENTITY_CONFLICT" };

export type HubAsaasCustomerPreservationDecision =
  | "NOT_CREATED_BY_ATTEMPT"
  | "KEEP_LINKED_CUSTOMER"
  | "PRESERVE_CREATED_CUSTOMER_FOR_REVIEW";

export type HubAsaasSubscriptionResolution =
  | {
    status: "MATCH";
    subscriptionId: string;
    providerStatus: string;
  }
  | { status: "CONFLICT" };

const normalizedText = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";
const normalizedDigits = (value: unknown) =>
  normalizedText(value).replace(/\D/g, "");

export function hubAsaasCustomerReference(accountId: string): string {
  return `hub-account:${accountId}`;
}

export function normalizeAsaasCustomerId(value: unknown): string | null {
  const customerId = normalizedText(value);
  return customerId.length > 0 && customerId.length <= 200 &&
      /^[A-Za-z0-9_-]+$/.test(customerId)
    ? customerId
    : null;
}

export function resolveHubAsaasSubscriptionCandidate(
  candidate: unknown,
  expected: {
    externalReference: string;
    customerId: string;
    billingType: "PIX" | "BOLETO";
    billingCycle: "MONTHLY" | "YEARLY";
    amount: number;
    nextDueDate: string;
    description: string;
    maxPayments: null;
    splitPolicy: { kind: "NONE" };
  },
): HubAsaasSubscriptionResolution {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { status: "CONFLICT" };
  }

  const record = candidate as Record<string, unknown>;
  const subscriptionId = normalizeAsaasCustomerId(record.id);
  const providerAmount = Number(record.value);
  const providerStatus = normalizedText(record.status).toUpperCase();
  const providerMaxPayments = record.maxPayments === null ||
      record.maxPayments === undefined || record.maxPayments === ""
    ? null
    : Number.isInteger(Number(record.maxPayments)) &&
        Number(record.maxPayments) > 0
    ? Number(record.maxPayments)
    : Number.NaN;
  const amountMatches = Number.isFinite(providerAmount) &&
    Math.round(providerAmount * 100) === Math.round(expected.amount * 100);
  if (
    !subscriptionId || record.deleted === true ||
    normalizedText(record.externalReference) !== expected.externalReference ||
    normalizedText(record.customer) !== expected.customerId ||
    normalizedText(record.billingType).toUpperCase() !== expected.billingType ||
    normalizedText(record.cycle).toUpperCase() !== expected.billingCycle ||
    normalizedText(record.nextDueDate) !== expected.nextDueDate ||
    normalizedText(record.description) !== expected.description ||
    providerStatus !== "ACTIVE" ||
    !amountMatches ||
    !Object.is(providerMaxPayments, expected.maxPayments) ||
    !providerPaymentSplitMatches(record, expected.splitPolicy)
  ) {
    return { status: "CONFLICT" };
  }

  return {
    status: "MATCH",
    subscriptionId,
    providerStatus,
  };
}

export function resolveHubAsaasCustomerCandidate(
  candidates: unknown,
  expectedReference: string,
  expectedCpfCnpj: string,
): HubAsaasCustomerResolution {
  if (!Array.isArray(candidates)) return { status: "NONE" };

  const accountCandidates = candidates.filter((candidate) => {
    if (
      !candidate || typeof candidate !== "object" || Array.isArray(candidate)
    ) {
      return false;
    }
    const record = candidate as Record<string, unknown>;
    return record.deleted !== true &&
      normalizedText(record.externalReference) === expectedReference;
  }) as Array<Record<string, unknown>>;

  if (accountCandidates.length === 0) return { status: "NONE" };

  const identityMatches = accountCandidates.flatMap((candidate) => {
    if (normalizedDigits(candidate.cpfCnpj) !== expectedCpfCnpj) return [];
    const customerId = normalizeAsaasCustomerId(candidate.id);
    if (!customerId) return [];
    return [{
      customerId,
      dateCreated: normalizedText(candidate.dateCreated),
    }];
  });

  if (identityMatches.length === 0) return { status: "IDENTITY_CONFLICT" };

  identityMatches.sort((left, right) => {
    const leftKey = `${left.dateCreated || "9999"}:${left.customerId}`;
    const rightKey = `${right.dateCreated || "9999"}:${right.customerId}`;
    return leftKey.localeCompare(rightKey);
  });

  return { status: "MATCH", customerId: identityMatches[0].customerId };
}

export function decideHubAsaasCustomerPreservation(input: {
  createdCustomerId: string | null;
  linkedCustomerIds: string[];
  linkStateConfirmed: boolean;
}): HubAsaasCustomerPreservationDecision {
  if (!input.createdCustomerId) return "NOT_CREATED_BY_ATTEMPT";
  if (
    input.linkStateConfirmed &&
    input.linkedCustomerIds.includes(input.createdCustomerId)
  ) {
    return "KEEP_LINKED_CUSTOMER";
  }
  // A successful creation claim is immutable. Deleting its provider entity
  // would leave ALREADY_SUCCEEDED pointing at an id that no longer exists.
  return "PRESERVE_CREATED_CUSTOMER_FOR_REVIEW";
}
