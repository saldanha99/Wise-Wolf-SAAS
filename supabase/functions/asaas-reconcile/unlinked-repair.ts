export type AuthoritativeUnlinkedRepairTarget = {
  localPaymentId: string;
  studentId: string;
  syncContractDueDay: boolean;
};

type IntegrationIdentity = {
  integrationId: string;
  tenantId: string;
  mode: string;
  version: number;
  environment: string;
  baseUrl: string;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseAuthoritativeUnlinkedRepairTarget(
  value: unknown,
): AuthoritativeUnlinkedRepairTarget | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    JSON.stringify(keys) !==
      JSON.stringify([
        "localPaymentId",
        "studentId",
        "syncContractDueDay",
      ])
  ) return null;
  if (
    typeof record.localPaymentId !== "string" ||
    !UUID_PATTERN.test(record.localPaymentId) ||
    typeof record.studentId !== "string" ||
    !UUID_PATTERN.test(record.studentId) ||
    typeof record.syncContractDueDay !== "boolean"
  ) return null;
  return {
    localPaymentId: record.localPaymentId.toLowerCase(),
    studentId: record.studentId.toLowerCase(),
    syncContractDueDay: record.syncContractDueDay,
  };
}

export function sameIntegrationIdentity(
  left: IntegrationIdentity,
  right: IntegrationIdentity,
): boolean {
  return left.integrationId === right.integrationId &&
    left.tenantId === right.tenantId && left.mode === right.mode &&
    left.version === right.version && left.environment === right.environment &&
    left.baseUrl === right.baseUrl;
}

function selectedSnapshot(
  value: unknown,
  keys: string[],
): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return JSON.stringify(keys.map((key) => record[key] ?? null));
}

export function paymentBindingSnapshot(value: unknown): string | null {
  return selectedSnapshot(value, [
    "id",
    "customer",
    "subscription",
    "status",
    "value",
    "dueDate",
    "paymentDate",
    "estimatedCreditDate",
    "billingType",
    "deleted",
  ]);
}

export function customerBindingSnapshot(value: unknown): string | null {
  return selectedSnapshot(value, [
    "id",
    "cpfCnpj",
    "email",
    "mobilePhone",
    "phone",
    "deleted",
  ]);
}

export function subscriptionBindingSnapshot(value: unknown): string | null {
  return selectedSnapshot(value, [
    "id",
    "customer",
    "status",
    "nextDueDate",
    "deleted",
  ]);
}
