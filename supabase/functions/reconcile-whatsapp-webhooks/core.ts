import {
  type EvolutionIntegrationPurpose,
  type ResolvedEvolutionIntegration,
  resolveEvolutionIntegration,
  type TenantIntegrationRpcClient,
} from "../_shared/tenant-integration-broker.ts";
import { deriveWhatsAppInboundInstanceTokenV3 } from "../_shared/whatsapp-inbox.ts";

export const RECONCILE_WHATSAPP_WEBHOOK_MAX_BATCH = 100;
export const RECONCILE_WHATSAPP_WEBHOOK_DEFAULT_BATCH = 25;
const RECONCILE_WHATSAPP_WEBHOOK_CONCURRENCY = 3;

// Keep this list byte-for-byte compatible with whatsapp-evolution-proxy's
// inbox/enable flow and every supported Evolution API release (v2.2+).
export const EVOLUTION_INBOX_WEBHOOK_EVENTS = [
  "MESSAGES_SET",
  "MESSAGES_UPSERT",
  "MESSAGES_EDITED",
  "MESSAGES_UPDATE",
  "MESSAGES_DELETE",
  "SEND_MESSAGE",
  "CONTACTS_SET",
  "CONTACTS_UPSERT",
  "CONTACTS_UPDATE",
  "CHATS_SET",
  "CHATS_UPSERT",
  "CHATS_UPDATE",
  "CHATS_DELETE",
  "CONNECTION_UPDATE",
  "GROUPS_UPSERT",
  "GROUP_UPDATE",
  "GROUP_PARTICIPANTS_UPDATE",
] as const;

export type ReconcileWhatsAppWebhookOptions = {
  includeAll: boolean;
  limit: number;
};

export type ReconcileWhatsAppWebhookInstance = {
  tenantId: string;
  instanceName: string;
  webhookAuthVersion: 1 | 2 | 3;
  integrationId: string;
  integrationVersion: number;
};

export type ReconcileWhatsAppWebhookErrorCode =
  | "INVALID_INSTANCE"
  | "INTEGRATION_UNAVAILABLE"
  | "INTEGRATION_BINDING_STALE"
  | "TENANT_SCOPE_MISMATCH"
  | "TOKEN_DERIVATION_FAILED"
  | "UPSTREAM_UNAVAILABLE"
  | "UPSTREAM_REJECTED"
  | "AUTH_MARKER_FAILED";

export type ReconcileWhatsAppWebhookItemResult = {
  tenantId: string;
  instanceName: string;
  status: "configured" | "failed";
  error?: ReconcileWhatsAppWebhookErrorCode;
  upstreamStatus?: number;
};

export type ReconcileWhatsAppWebhookResult = {
  selected: number;
  configured: number;
  failed: number;
  results: ReconcileWhatsAppWebhookItemResult[];
};

type ReconcileDependencies = {
  admin: TenantIntegrationRpcClient;
  getEnv: (name: string) => string | undefined;
  loadInstances: (
    options: ReconcileWhatsAppWebhookOptions,
  ) => Promise<ReconcileWhatsAppWebhookInstance[]>;
  fetchUpstream?: typeof fetch;
  resolveIntegration?: (
    admin: TenantIntegrationRpcClient,
    tenantId: string,
    purpose: EvolutionIntegrationPurpose,
  ) => Promise<ResolvedEvolutionIntegration>;
  deriveInstanceToken?: typeof deriveWhatsAppInboundInstanceTokenV3;
};

export class ReconcileWhatsAppWebhooksError extends Error {
  constructor(readonly code: "INBOUND_WEBHOOK_UNAVAILABLE") {
    super(code);
    this.name = "ReconcileWhatsAppWebhooksError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseReconcileWhatsAppWebhookOptions(
  value: unknown,
):
  | { ok: true; value: ReconcileWhatsAppWebhookOptions }
  | { ok: false; code: "INVALID_REQUEST" } {
  if (!isObject(value)) return { ok: false, code: "INVALID_REQUEST" };
  if (value.all !== undefined && typeof value.all !== "boolean") {
    return { ok: false, code: "INVALID_REQUEST" };
  }

  const rawLimit = value.limit ?? RECONCILE_WHATSAPP_WEBHOOK_DEFAULT_BATCH;
  const limit = Number(rawLimit);
  if (
    !Number.isSafeInteger(limit) || limit < 1 ||
    limit > RECONCILE_WHATSAPP_WEBHOOK_MAX_BATCH
  ) {
    return { ok: false, code: "INVALID_REQUEST" };
  }
  return {
    ok: true,
    value: {
      includeAll: value.all === true,
      limit,
    },
  };
}

type InboundWebhookConfiguration = {
  url: string;
  rootToken: string;
};

export function inboundWebhookConfiguration(
  getEnv: (name: string) => string | undefined,
): InboundWebhookConfiguration | null {
  const rootToken = getEnv("WHATSAPP_INBOUND_TOKEN")?.trim() || "";
  if (rootToken.length < 16 || rootToken.length > 4096) return null;

  const publicUrl = getEnv("WHATSAPP_INBOUND_PUBLIC_URL")?.trim() || "";
  if (publicUrl) {
    try {
      const url = new URL(publicUrl);
      if (
        url.protocol !== "https:" || url.username || url.password ||
        url.search || url.hash ||
        url.pathname !== "/functions/v1/whatsapp-inbound"
      ) return null;
      return { url: url.href, rootToken };
    } catch {
      return null;
    }
  }

  const rawUrl = getEnv("SUPABASE_URL")?.trim() || "";
  try {
    const url = new URL(rawUrl);
    const hostedSupabase = url.protocol === "https:" &&
      /^[a-z0-9-]+\.supabase\.co$/i.test(url.hostname);
    const localHost = ["localhost", "127.0.0.1", "[::1]"].includes(
      url.hostname.toLowerCase(),
    ) && ["http:", "https:"].includes(url.protocol);
    if (
      (!hostedSupabase && !localHost) || url.username || url.password ||
      url.search || url.hash || !["", "/"].includes(url.pathname)
    ) return null;
    return {
      url: `${url.origin}/functions/v1/whatsapp-inbound`,
      rootToken,
    };
  } catch {
    return null;
  }
}

export function evolutionInboxWebhookBody(
  webhookUrl: string,
  instanceToken: string,
): Record<string, unknown> {
  return {
    webhook: {
      enabled: true,
      url: webhookUrl,
      headers: {
        "x-whatsapp-inbound-token": instanceToken,
      },
      byEvents: false,
      base64: false,
      events: EVOLUTION_INBOX_WEBHOOK_EVENTS,
    },
  };
}

function failed(
  instance: ReconcileWhatsAppWebhookInstance,
  error: ReconcileWhatsAppWebhookErrorCode,
  upstreamStatus?: number,
): ReconcileWhatsAppWebhookItemResult {
  const safeTenantId = /^[A-Za-z0-9._-]{1,120}$/.test(instance.tenantId)
    ? instance.tenantId
    : "invalid";
  const safeInstanceName = /^[A-Za-z0-9._-]{1,120}$/.test(
      instance.instanceName,
    )
    ? instance.instanceName
    : "invalid";
  return {
    tenantId: safeTenantId,
    instanceName: safeInstanceName,
    status: "failed",
    error,
    ...(upstreamStatus === undefined ? {} : { upstreamStatus }),
  };
}

function validInstance(
  instance: ReconcileWhatsAppWebhookInstance,
): boolean {
  return instance.tenantId.trim().length > 0 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{2,119}$/.test(instance.instanceName.trim());
}

function rpcResultOk(value: unknown): boolean {
  const candidate = Array.isArray(value) ? value[0] : value;
  return isObject(candidate) && candidate.ok === true;
}

async function reconcileOne(
  instance: ReconcileWhatsAppWebhookInstance,
  configuration: InboundWebhookConfiguration,
  dependencies: ReconcileDependencies,
): Promise<ReconcileWhatsAppWebhookItemResult> {
  const canonicalInstance = {
    ...instance,
    tenantId: instance.tenantId.trim(),
    instanceName: instance.instanceName.trim(),
  };
  if (!validInstance(canonicalInstance)) {
    return failed(canonicalInstance, "INVALID_INSTANCE");
  }

  const resolveIntegration = dependencies.resolveIntegration ||
    resolveEvolutionIntegration;
  let integration: ResolvedEvolutionIntegration;
  try {
    integration = await resolveIntegration(
      dependencies.admin,
      canonicalInstance.tenantId,
      "webhook.configure",
    );
  } catch {
    return failed(canonicalInstance, "INTEGRATION_UNAVAILABLE");
  }
  if (integration.tenantId !== canonicalInstance.tenantId) {
    return failed(canonicalInstance, "TENANT_SCOPE_MISMATCH");
  }
  if (
    integration.integrationId !== canonicalInstance.integrationId ||
    integration.version !== canonicalInstance.integrationVersion
  ) {
    return failed(canonicalInstance, "INTEGRATION_BINDING_STALE");
  }

  const deriveInstanceToken = dependencies.deriveInstanceToken ||
    deriveWhatsAppInboundInstanceTokenV3;
  let instanceToken: string;
  try {
    instanceToken = await deriveInstanceToken(
      configuration.rootToken,
      canonicalInstance.tenantId,
      canonicalInstance.instanceName,
      canonicalInstance.integrationId,
      canonicalInstance.integrationVersion,
    );
  } catch {
    return failed(canonicalInstance, "TOKEN_DERIVATION_FAILED");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  let response: Response;
  try {
    response = await (dependencies.fetchUpstream || fetch)(
      `${integration.baseUrl}/webhook/set/${
        encodeURIComponent(canonicalInstance.instanceName)
      }`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: integration.apiKey,
        },
        body: JSON.stringify(
          evolutionInboxWebhookBody(configuration.url, instanceToken),
        ),
        redirect: "error",
        signal: controller.signal,
      },
    );
  } catch {
    // A Evolution pode ter persistido o token v3 antes de a resposta se
    // perder. Não promova o marker sem 2xx; o inbound mantém uma ponte v3
    // vinculada à integração atual enquanto o próximo lote reconcilia.
    return failed(canonicalInstance, "UPSTREAM_UNAVAILABLE");
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    return failed(canonicalInstance, "UPSTREAM_REJECTED", response.status);
  }

  try {
    const { data, error } = await dependencies.admin.rpc(
      "set_whatsapp_webhook_auth_version",
      {
        p_tenant_id: canonicalInstance.tenantId,
        p_instance_name: canonicalInstance.instanceName,
        p_version: 3,
        p_integration_id: canonicalInstance.integrationId,
        p_integration_version: canonicalInstance.integrationVersion,
      },
    );
    if (error || !rpcResultOk(data)) {
      return failed(canonicalInstance, "AUTH_MARKER_FAILED");
    }
  } catch {
    return failed(canonicalInstance, "AUTH_MARKER_FAILED");
  }

  return {
    tenantId: canonicalInstance.tenantId,
    instanceName: canonicalInstance.instanceName,
    status: "configured",
  };
}

export async function reconcileWhatsAppWebhooks(
  options: ReconcileWhatsAppWebhookOptions,
  dependencies: ReconcileDependencies,
): Promise<ReconcileWhatsAppWebhookResult> {
  const configuration = inboundWebhookConfiguration(dependencies.getEnv);
  if (!configuration) {
    throw new ReconcileWhatsAppWebhooksError("INBOUND_WEBHOOK_UNAVAILABLE");
  }

  const requestedLimit = Number.isSafeInteger(options.limit)
    ? Math.min(
      RECONCILE_WHATSAPP_WEBHOOK_MAX_BATCH,
      Math.max(1, options.limit),
    )
    : RECONCILE_WHATSAPP_WEBHOOK_DEFAULT_BATCH;
  const effectiveOptions = {
    includeAll: options.includeAll === true,
    limit: requestedLimit,
  };
  const instances = (await dependencies.loadInstances(effectiveOptions)).slice(
    0,
    requestedLimit,
  );
  const results = new Array<ReconcileWhatsAppWebhookItemResult>(
    instances.length,
  );
  let cursor = 0;
  const workerCount = Math.min(
    RECONCILE_WHATSAPP_WEBHOOK_CONCURRENCY,
    instances.length,
  );
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= instances.length) return;
      results[index] = await reconcileOne(
        instances[index],
        configuration,
        dependencies,
      );
    }
  }));

  const configured =
    results.filter((result) => result.status === "configured").length;
  return {
    selected: results.length,
    configured,
    failed: results.length - configured,
    results,
  };
}
