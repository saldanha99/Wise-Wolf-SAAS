import {
  type AsaasIntegrationPurpose,
  resolveAsaasIntegration,
  type ResolvedAsaasIntegration,
  type TenantIntegrationRpcClient,
} from "./tenant-integration-broker.ts";

export type AsaasMutationPurpose = Extract<
  AsaasIntegrationPurpose,
  | "customer.create"
  | "customer.update"
  | "customer.delete"
  | "payment.create"
  | "payment.update"
  | "payment.delete"
  | "subscription.create"
  | "subscription.update"
  | "subscription.delete"
  | "dunning.create"
  | "transfer.submit"
>;

export type AsaasCapabilityFenceFailure = "UNAVAILABLE" | "CHANGED";

export class AsaasCapabilityFenceError extends Error {
  constructor(readonly failure: AsaasCapabilityFenceFailure) {
    super(`ASAAS_MUTATION_CAPABILITY_${failure}`);
    this.name = "AsaasCapabilityFenceError";
  }
}

type CapabilityResolver = (
  admin: TenantIntegrationRpcClient,
  tenantId: string,
  purpose: AsaasIntegrationPurpose,
) => Promise<ResolvedAsaasIntegration>;

function sameCapabilityIdentity(
  expected: ResolvedAsaasIntegration,
  current: ResolvedAsaasIntegration,
): boolean {
  return expected.integrationId === current.integrationId &&
    expected.tenantId === current.tenantId &&
    expected.provider === current.provider &&
    expected.version === current.version &&
    expected.environment === current.environment &&
    expected.mode === current.mode &&
    expected.baseUrl === current.baseUrl &&
    // The database version is authoritative, but the root credential comes
    // from the runtime environment. Compare it too so an env-only rotation
    // cannot cross the durable claim/submit boundary unnoticed.
    expected.apiKey === current.apiKey;
}

/**
 * Re-resolves the exact write capability at the final safe point before an
 * irreversible Asaas request. The returned integration is the only one that
 * may be used for that request.
 */
export async function revalidateAsaasMutationCapability(
  admin: TenantIntegrationRpcClient,
  input: {
    tenantId: string;
    purpose: AsaasMutationPurpose;
    expected: ResolvedAsaasIntegration;
  },
  dependencies: { resolve?: CapabilityResolver } = {},
): Promise<ResolvedAsaasIntegration> {
  if (
    !input.tenantId || input.expected.tenantId !== input.tenantId ||
    input.expected.provider !== "asaas"
  ) {
    throw new AsaasCapabilityFenceError("CHANGED");
  }

  let current: ResolvedAsaasIntegration;
  try {
    current = await (dependencies.resolve || resolveAsaasIntegration)(
      admin,
      input.tenantId,
      input.purpose,
    );
  } catch {
    throw new AsaasCapabilityFenceError("UNAVAILABLE");
  }

  if (!sameCapabilityIdentity(input.expected, current)) {
    throw new AsaasCapabilityFenceError("CHANGED");
  }
  return current;
}
