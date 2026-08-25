/// <reference lib="deno.ns" />

export type HubAsaasCustomerOrigin = "LINKED" | "RECOVERED" | "CREATED";

export type HubAsaasCustomerResolution =
  | { status: "NONE" }
  | { status: "MATCH"; customerId: string }
  | { status: "IDENTITY_CONFLICT" };

export type HubAsaasCustomerCompensationDecision =
  | "NOT_CREATED_BY_ATTEMPT"
  | "DEFER_UNCONFIRMED_STATE"
  | "KEEP_LINKED_CUSTOMER"
  | "DELETE_CREATED_CUSTOMER";

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

export function decideHubAsaasCustomerCompensation(input: {
  createdCustomerId: string | null;
  linkedCustomerIds: string[];
  linkStateConfirmed: boolean;
  providerObjectsSafeToDelete: boolean;
}): HubAsaasCustomerCompensationDecision {
  if (!input.createdCustomerId) return "NOT_CREATED_BY_ATTEMPT";
  if (!input.linkStateConfirmed || !input.providerObjectsSafeToDelete) {
    return "DEFER_UNCONFIRMED_STATE";
  }
  if (input.linkedCustomerIds.includes(input.createdCustomerId)) {
    return "KEEP_LINKED_CUSTOMER";
  }
  return "DELETE_CREATED_CUSTOMER";
}
