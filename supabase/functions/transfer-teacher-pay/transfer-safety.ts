export type ProviderTransfer = {
  id?: string | null;
  status?: string | null;
  externalReference?: string | null;
  value?: number | null;
  dateCreated?: string | null;
  failReason?: string | null;
  operationType?: string | null;
  pixAddressKey?: string | null;
  pixAddressKeyType?: string | null;
  bankAccount?: unknown;
};

export type TransferSubmissionSnapshot = {
  attemptId: string;
  tenantId: string;
  destinationFingerprint: string;
  payload: {
    value: number;
    pixAddressKey: string;
    pixAddressKeyType: string;
    description: string;
    operationType: "PIX";
    externalReference: string;
  };
};

export type TransferLookupIdentity =
  | {
    kind: "PROVIDER_ID";
    providerTransferId: string;
  }
  | {
    kind: "EXTERNAL_REFERENCE";
    externalReference: string;
  };

export type TransferIdentityResolution =
  | { kind: "EXACT"; transfer: ProviderTransfer }
  | { kind: "NOT_FOUND" }
  | {
    kind: "CONFLICT";
    reason:
      | "duplicate_provider_id"
      | "duplicate_external_reference"
      | "external_reference_mismatch"
      | "amount_mismatch"
      | "destination_missing"
      | "destination_mismatch";
    transfer?: ProviderTransfer;
  };

function requiredSnapshotString(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== "string") throw new Error(`claim_${field}_invalid`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`claim_${field}_invalid`);
  }
  return normalized;
}

export function transferSubmissionIsEnabled(input: {
  enabled: boolean;
  homologated: boolean;
  productionApproved: boolean;
  baseUrl: string;
  apiKey: string;
}): boolean {
  const production = input.baseUrl.includes("api.asaas.com");
  return Boolean(
    input.enabled &&
      input.homologated &&
      input.baseUrl &&
      input.apiKey &&
      (!production || input.productionApproved),
  );
}

export async function transferDestinationFingerprint(
  pixKeyType: string,
  pixKey: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${pixKeyType}:${pixKey}`),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function normalizePixKey(key: string, type: string): string {
  const normalizedType = type === "TELEFONE" ? "PHONE" : type;
  if (["CPF", "CNPJ", "PHONE"].includes(normalizedType)) {
    return key.replace(/\D/g, "");
  }
  return key.trim();
}

export function normalizePixKeyType(type: string): string {
  return type === "TELEFONE" ? "PHONE" : type;
}

type ProviderDestinationResolution =
  | { kind: "PIX"; fingerprint: string }
  | { kind: "MISSING" }
  | { kind: "MISMATCH" };

function providerText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function validPixKey(key: string, type: string): boolean {
  return type === "CPF"
    ? /^\d{11}$/.test(key)
    : type === "CNPJ"
    ? /^\d{14}$/.test(key)
    : type === "PHONE"
    ? /^\d{10,15}$/.test(key)
    : type === "EMAIL"
    ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(key)
    : type === "EVP"
    ? /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(key)
    : false;
}

/**
 * Extracts only the destination fields that the provider itself attested.
 * A bank-account-only response cannot prove a PIX key belongs to that account,
 * so it deliberately remains a mismatch for the PIX-only payload used here.
 */
async function providerTransferDestination(
  transfer: ProviderTransfer,
): Promise<ProviderDestinationResolution> {
  const operationType = providerText(transfer.operationType).toUpperCase();
  const rawKey = providerText(transfer.pixAddressKey);
  const rawKeyType = providerText(transfer.pixAddressKeyType).toUpperCase();
  if (!operationType || !rawKey || !rawKeyType) {
    return transfer.bankAccount ? { kind: "MISMATCH" } : { kind: "MISSING" };
  }
  if (operationType !== "PIX") return { kind: "MISMATCH" };

  const keyType = normalizePixKeyType(rawKeyType);
  const key = normalizePixKey(rawKey, keyType);
  if (!validPixKey(key, keyType)) return { kind: "MISMATCH" };
  return {
    kind: "PIX",
    fingerprint: await transferDestinationFingerprint(keyType, key),
  };
}

export function transferSubmissionFromClaim(
  value: unknown,
): TransferSubmissionSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("claim_snapshot_invalid");
  }
  const claim = value as Record<string, unknown>;
  if (claim.action !== "SUBMIT_ONCE") {
    throw new Error("claim_action_invalid");
  }

  const attemptId = requiredSnapshotString(claim.attempt_id, "attempt_id", 80);
  const tenantId = requiredSnapshotString(claim.tenant_id, "tenant_id", 160);
  const externalReference = requiredSnapshotString(
    claim.external_reference,
    "external_reference",
    240,
  );
  if (!externalReference.startsWith("wisewolf-teacher-closing:")) {
    throw new Error("claim_external_reference_invalid");
  }

  const amount = Number(claim.expected_amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 9_999_999_999.99) {
    throw new Error("claim_expected_amount_invalid");
  }

  const pixKeyType = normalizePixKeyType(
    requiredSnapshotString(
      claim.destination_pix_key_type,
      "destination_pix_key_type",
      16,
    ).toUpperCase(),
  );
  if (!["CPF", "CNPJ", "EMAIL", "PHONE", "EVP"].includes(pixKeyType)) {
    throw new Error("claim_destination_pix_key_type_invalid");
  }
  const claimedPixKey = requiredSnapshotString(
    claim.destination_pix_key,
    "destination_pix_key",
    180,
  );
  const pixKey = normalizePixKey(claimedPixKey, pixKeyType);
  if (pixKey !== claimedPixKey) {
    throw new Error("claim_destination_pix_key_not_normalized");
  }
  if (!validPixKey(pixKey, pixKeyType)) {
    throw new Error("claim_destination_pix_key_invalid");
  }

  const destinationFingerprint = requiredSnapshotString(
    claim.destination_fingerprint,
    "destination_fingerprint",
    64,
  );
  if (!/^[a-f0-9]{64}$/.test(destinationFingerprint)) {
    throw new Error("claim_destination_fingerprint_invalid");
  }
  const description = requiredSnapshotString(
    claim.transfer_description,
    "transfer_description",
    300,
  );
  if (/[\r\n\t]/.test(description)) {
    throw new Error("claim_transfer_description_invalid");
  }

  return {
    attemptId,
    tenantId,
    destinationFingerprint,
    payload: {
      value: amount,
      pixAddressKey: pixKey,
      pixAddressKeyType: pixKeyType,
      description,
      operationType: "PIX",
      externalReference,
    },
  };
}

export function providerTransferOutcome(
  status: unknown,
): "COMPLETED" | "SUBMITTED" | "FAILED" | "UNKNOWN" {
  const normalized = String(status || "").toUpperCase();
  if (normalized === "DONE") return "COMPLETED";
  if (["PENDING", "BANK_PROCESSING", "SCHEDULED"].includes(normalized)) {
    return "SUBMITTED";
  }
  if (["FAILED", "CANCELLED"].includes(normalized)) return "FAILED";
  return "UNKNOWN";
}

export function transferLookupIdentity(
  externalReference: string,
  providerTransferId?: string | null,
): TransferLookupIdentity {
  const knownProviderId = typeof providerTransferId === "string"
    ? providerTransferId.trim()
    : "";
  if (knownProviderId) {
    return {
      kind: "PROVIDER_ID",
      providerTransferId: knownProviderId,
    };
  }

  const normalizedReference = externalReference.trim();
  if (!normalizedReference) throw new Error("transfer_lookup_identity_missing");
  return {
    kind: "EXTERNAL_REFERENCE",
    externalReference: normalizedReference,
  };
}

export function findTransferForAttempt(
  transfers: ProviderTransfer[],
  externalReference: string,
  providerTransferId?: string | null,
): ProviderTransfer | null {
  const lookup = transferLookupIdentity(
    externalReference,
    providerTransferId,
  );
  if (lookup.kind === "PROVIDER_ID") {
    return transfers.find(
      (transfer) => transfer.id === lookup.providerTransferId,
    ) || null;
  }
  const referenceMatches = transfers.filter(
    (transfer) => transfer.externalReference === lookup.externalReference,
  );
  return referenceMatches.length === 1 ? referenceMatches[0] : null;
}

function transferValueCents(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.round(numeric * 100);
}

/**
 * A provider transfer is adoptable only when its immutable business identity
 * agrees with the durable attempt snapshot. A known provider id narrows the
 * lookup; it never replaces the reference and amount checks.
 */
export async function resolveTransferForAttempt(
  transfers: ProviderTransfer[],
  externalReference: string,
  expectedValue: number,
  expectedDestinationFingerprint: string,
  providerTransferId?: string | null,
): Promise<TransferIdentityResolution> {
  if (!/^[a-f0-9]{64}$/.test(expectedDestinationFingerprint)) {
    throw new Error("transfer_destination_fingerprint_invalid");
  }
  const lookup = transferLookupIdentity(externalReference, providerTransferId);
  let candidate: ProviderTransfer;

  if (lookup.kind === "PROVIDER_ID") {
    const matches = transfers.filter(
      (transfer) => transfer.id === lookup.providerTransferId,
    );
    if (matches.length === 0) return { kind: "NOT_FOUND" };
    if (matches.length !== 1) {
      return { kind: "CONFLICT", reason: "duplicate_provider_id" };
    }
    candidate = matches[0];
  } else {
    const matches = transfers.filter(
      (transfer) => transfer.externalReference === lookup.externalReference,
    );
    if (matches.length === 0) return { kind: "NOT_FOUND" };
    if (matches.length !== 1) {
      return { kind: "CONFLICT", reason: "duplicate_external_reference" };
    }
    candidate = matches[0];
  }

  if (candidate.externalReference !== externalReference) {
    return {
      kind: "CONFLICT",
      reason: "external_reference_mismatch",
      transfer: candidate,
    };
  }
  if (
    transferValueCents(candidate.value) !== transferValueCents(expectedValue)
  ) {
    return {
      kind: "CONFLICT",
      reason: "amount_mismatch",
      transfer: candidate,
    };
  }
  const destination = await providerTransferDestination(candidate);
  if (destination.kind === "MISSING") {
    return {
      kind: "CONFLICT",
      reason: "destination_missing",
      transfer: candidate,
    };
  }
  if (
    destination.kind !== "PIX" ||
    destination.fingerprint !== expectedDestinationFingerprint
  ) {
    return {
      kind: "CONFLICT",
      reason: "destination_mismatch",
      transfer: candidate,
    };
  }
  return { kind: "EXACT", transfer: candidate };
}

export function redactTransferResponse(
  transfer: ProviderTransfer,
): ProviderTransfer {
  return {
    id: transfer.id || null,
    status: transfer.status || null,
    externalReference: transfer.externalReference || null,
    value: typeof transfer.value === "number" ? transfer.value : null,
    dateCreated: transfer.dateCreated || null,
    failReason: transfer.failReason || null,
  };
}
