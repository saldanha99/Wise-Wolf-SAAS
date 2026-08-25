type RpcError = {
  code?: string;
};

export type TenantIntegrationRpcClient = {
  rpc: (
    functionName: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: RpcError | null }>;
};

export type DnsRecordType = "A" | "AAAA";
export type DnsResolver = (
  hostname: string,
  recordType: DnsRecordType,
) => Promise<string[]>;

export type EvolutionIntegrationPurpose =
  | "instance.create"
  | "instance.connect"
  | "instance.connection_state"
  | "instance.logout"
  | "instance.delete"
  | "message.send_text"
  | "group.list";

export type ResolvedEvolutionIntegration = {
  integrationId: string;
  tenantId: string;
  provider: "evolution";
  mode: "PLATFORM_MANAGED" | "TENANT_BYOK";
  version: number;
  baseUrl: string;
  apiKey: string;
};

type BrokerDependencies = {
  getEnv?: (name: string) => string | undefined;
  resolveDns?: DnsResolver;
};

type IntegrationResolution = {
  integrationId: string;
  tenantId: string;
  provider: string;
  mode: string;
  version: number;
  baseUrl: string | null;
  apiKey: string | null;
};

export class TenantIntegrationBrokerError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "TenantIntegrationBrokerError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(
  value: unknown,
  code: string,
  maximumLength: number,
): string {
  if (typeof value !== "string") throw new TenantIntegrationBrokerError(code);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength) {
    throw new TenantIntegrationBrokerError(code);
  }
  return normalized;
}

function asResolution(value: unknown): IntegrationResolution {
  if (!isObject(value)) {
    throw new TenantIntegrationBrokerError("INTEGRATION_RESOLUTION_INVALID");
  }
  const version = Number(value.version);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new TenantIntegrationBrokerError("INTEGRATION_RESOLUTION_INVALID");
  }
  return {
    integrationId: requiredString(
      value.integrationId,
      "INTEGRATION_RESOLUTION_INVALID",
      80,
    ),
    tenantId: requiredString(
      value.tenantId,
      "INTEGRATION_RESOLUTION_INVALID",
      160,
    ),
    provider: requiredString(
      value.provider,
      "INTEGRATION_RESOLUTION_INVALID",
      32,
    ),
    mode: requiredString(
      value.mode,
      "INTEGRATION_RESOLUTION_INVALID",
      48,
    ),
    version,
    baseUrl: typeof value.baseUrl === "string" ? value.baseUrl.trim() : null,
    apiKey: typeof value.apiKey === "string" ? value.apiKey.trim() : null,
  };
}

function parseIpv4(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return -1;
    const octet = Number(part);
    return octet >= 0 && octet <= 255 ? octet : -1;
  });
  return octets.every((octet) => octet >= 0) ? octets : null;
}

function parseIpv6(value: string): number[] | null {
  let normalized = value.toLowerCase().replace(/^\[|\]$/g, "");
  const zoneIndex = normalized.indexOf("%");
  if (zoneIndex >= 0) normalized = normalized.slice(0, zoneIndex);

  const ipv4TailMatch = normalized.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/);
  if (ipv4TailMatch) {
    const ipv4 = parseIpv4(ipv4TailMatch[1]);
    if (!ipv4) return null;
    normalized = normalized.slice(0, -ipv4TailMatch[1].length) +
      `${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${
        ((ipv4[2] << 8) | ipv4[3]).toString(16)
      }`;
  }

  if (!normalized.includes(":")) return null;
  if ((normalized.match(/::/g) || []).length > 1) return null;
  const halves = normalized.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/.test(part))) {
    return null;
  }
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [
    ...left,
    ...Array.from({ length: missing }, () => "0"),
    ...right,
  ].map((part) => Number.parseInt(part, 16));
  return groups.length === 8 ? groups : null;
}

function isPublicIpv4(value: string): boolean {
  const octets = parseIpv4(value);
  if (!octets) return false;
  const [first, second, third] = octets;
  if (first === 0 || first === 10 || first === 127 || first >= 224) {
    return false;
  }
  if (first === 100 && second >= 64 && second <= 127) return false;
  if (first === 169 && second === 254) return false;
  if (first === 172 && second >= 16 && second <= 31) return false;
  if (first === 192 && second === 168) return false;
  if (first === 192 && second === 0 && third === 0) return false;
  if (first === 192 && second === 0 && third === 2) return false;
  if (first === 192 && second === 88 && third === 99) return false;
  if (first === 198 && (second === 18 || second === 19)) return false;
  if (first === 198 && second === 51 && third === 100) return false;
  if (first === 203 && second === 0 && third === 113) return false;
  return true;
}

function isPublicIpv6(value: string): boolean {
  const groups = parseIpv6(value);
  if (!groups) return false;
  if (groups.every((group) => group === 0)) return false;
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) {
    return false;
  }
  const first = groups[0];
  if ((first & 0xfe00) === 0xfc00) return false;
  if ((first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0) return false;
  if ((first & 0xff00) === 0xff00) return false;
  if (first === 0x100 && groups.slice(1, 4).every((group) => group === 0)) {
    return false;
  }
  if (
    first === 0x64 && groups[1] === 0xff9b &&
    groups.slice(2, 6).every((group) => group === 0)
  ) return false;
  if (first === 0x2001 && groups[1] === 0x0db8) return false;
  if (first === 0x2001 && groups[1] === 0) return false;
  if (first === 0x2002) return false;
  const ipv4Mapped = groups.slice(0, 5).every((group) => group === 0) &&
    groups[5] === 0xffff;
  if (ipv4Mapped) {
    return isPublicIpv4(
      `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${
        groups[7] & 255
      }`,
    );
  }
  if (groups.slice(0, 6).every((group) => group === 0)) return false;
  return true;
}

export function isPublicNetworkAddress(value: string): boolean {
  return parseIpv4(value) !== null ? isPublicIpv4(value) : isPublicIpv6(value);
}

function isIpLiteral(hostname: string): boolean {
  return parseIpv4(hostname) !== null || parseIpv6(hostname) !== null;
}

function safeHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    !normalized.includes(".") || isIpLiteral(normalized) ||
    normalized === "localhost" || normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") || normalized.endsWith(".internal") ||
    normalized.endsWith(".lan") || normalized.endsWith(".home.arpa")
  ) {
    return false;
  }
  const metadataHosts = new Set([
    "instance-data",
    "instance-data.ec2.internal",
    "metadata.google.internal",
    "metadata.google",
    "metadata.azure.internal",
  ]);
  return !metadataHosts.has(normalized) &&
    /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$/
      .test(normalized);
}

async function defaultDnsResolver(
  hostname: string,
  recordType: DnsRecordType,
): Promise<string[]> {
  try {
    return await Deno.resolveDns(hostname, recordType);
  } catch {
    return [];
  }
}

async function publicDnsAddresses(
  hostname: string,
  resolver: DnsResolver,
): Promise<string[]> {
  const [ipv4, ipv6] = await Promise.all([
    resolver(hostname, "A").catch(() => []),
    resolver(hostname, "AAAA").catch(() => []),
  ]);
  const addresses = [
    ...new Set([...ipv4, ...ipv6].map((value) => value.trim())),
  ]
    .filter(Boolean)
    .sort();
  if (
    addresses.length === 0 ||
    addresses.some((address) => !isPublicNetworkAddress(address))
  ) {
    throw new TenantIntegrationBrokerError("INTEGRATION_ENDPOINT_BLOCKED");
  }
  return addresses;
}

async function validatedBaseUrl(
  rawBaseUrl: string,
  resolver: DnsResolver,
  requireStableDns: boolean,
): Promise<string> {
  let url: URL;
  try {
    url = new URL(rawBaseUrl);
  } catch {
    throw new TenantIntegrationBrokerError("INTEGRATION_ENDPOINT_BLOCKED");
  }
  if (
    url.protocol !== "https:" || url.username || url.password ||
    (url.port && url.port !== "443") || url.search || url.hash ||
    !safeHostname(url.hostname)
  ) {
    throw new TenantIntegrationBrokerError("INTEGRATION_ENDPOINT_BLOCKED");
  }
  const firstResolution = await publicDnsAddresses(url.hostname, resolver);
  if (requireStableDns) {
    const secondResolution = await publicDnsAddresses(url.hostname, resolver);
    if (firstResolution.join(",") !== secondResolution.join(",")) {
      throw new TenantIntegrationBrokerError("INTEGRATION_DNS_REBINDING");
    }
  }
  return url.toString().replace(/\/+$/, "");
}

export async function resolveEvolutionIntegration(
  admin: TenantIntegrationRpcClient,
  tenantId: string,
  purpose: EvolutionIntegrationPurpose,
  dependencies: BrokerDependencies = {},
): Promise<ResolvedEvolutionIntegration> {
  const canonicalTenantId = requiredString(
    tenantId,
    "TENANT_SCOPE_REQUIRED",
    160,
  );
  const { data, error } = await admin.rpc(
    "resolve_tenant_integration_for_service",
    {
      p_tenant_id: canonicalTenantId,
      p_provider: "evolution",
      p_capability: "automation.whatsapp",
      p_purpose: purpose,
    },
  );
  if (error) {
    throw new TenantIntegrationBrokerError("INTEGRATION_UNAVAILABLE");
  }

  const resolution = asResolution(data);
  if (
    resolution.tenantId !== canonicalTenantId ||
    resolution.provider !== "evolution" ||
    !["PLATFORM_MANAGED", "TENANT_BYOK"].includes(resolution.mode)
  ) {
    throw new TenantIntegrationBrokerError("INTEGRATION_RESOLUTION_INVALID");
  }

  const getEnv = dependencies.getEnv || ((name: string) => Deno.env.get(name));
  const resolver = dependencies.resolveDns || defaultDnsResolver;
  const platformManaged = resolution.mode === "PLATFORM_MANAGED";
  const rawBaseUrl = platformManaged
    ? getEnv("EVOLUTION_API_URL") || ""
    : resolution.baseUrl || "";
  const apiKey = platformManaged
    ? getEnv("EVOLUTION_API_KEY") || ""
    : resolution.apiKey || "";
  const normalizedApiKey = requiredString(
    apiKey,
    "INTEGRATION_UNAVAILABLE",
    4096,
  );
  if (normalizedApiKey.length < 8) {
    throw new TenantIntegrationBrokerError("INTEGRATION_UNAVAILABLE");
  }

  const baseUrl = await validatedBaseUrl(
    rawBaseUrl,
    resolver,
    !platformManaged,
  );
  return {
    integrationId: resolution.integrationId,
    tenantId: resolution.tenantId,
    provider: "evolution",
    mode: resolution.mode as ResolvedEvolutionIntegration["mode"],
    version: resolution.version,
    baseUrl,
    apiKey: normalizedApiKey,
  };
}
