import { constantTimeTokenMatches } from "./management-action-policy.ts";

export type WhatsAppInboxRpcClient = {
  rpc: (
    functionName: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: { code?: string } | null }>;
};

type ActiveProfileQuery = {
  eq: (column: string, value: string) => ActiveProfileQuery;
  maybeSingle: () => PromiseLike<{
    data: { id?: unknown } | null;
    error: { code?: string } | null;
  }>;
};

export type ActiveProfileQueryClient = {
  from: (table: "profiles") => {
    select: (columns: "id") => ActiveProfileQuery;
  };
};

/**
 * Confirma somente a identidade e o ciclo de vida global do perfil.
 *
 * O tenant ativo pertence a tenant_memberships/tenant_user_contexts. O campo
 * profiles.tenant_id é legado e pode apontar para outra escola de um gestor
 * multi-escola, portanto nunca deve participar desta validação.
 */
export async function findActiveProfileById(
  client: unknown,
  userId: string,
): Promise<{
  data: { id?: unknown } | null;
  error: { code?: string } | null;
}> {
  const profileClient = client as ActiveProfileQueryClient;
  return await profileClient
    .from("profiles")
    .select("id")
    .eq("id", userId)
    .eq("lifecycle_status", "active")
    .maybeSingle();
}

export type EvolutionInboxMessage = {
  remoteJid: string;
  providerMessageId: string;
  direction: "in" | "out";
  senderKind: "contact" | "human" | "ai" | "system";
  messageType:
    | "text"
    | "audio"
    | "image"
    | "video"
    | "document"
    | "sticker"
    | "location"
    | "contact"
    | "reaction"
    | "unknown";
  body: string;
  occurredAt: string;
  displayName: string | null;
  phone: string | null;
  status:
    | "received"
    | "queued"
    | "dispatching"
    | "sent"
    | "delivered"
    | "read"
    | "failed"
    | "uncertain"
    | "unknown";
  metadata: Record<string, unknown>;
};

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function objectValue(value: unknown, key: string): JsonObject {
  if (!isObject(value) || !isObject(value[key])) return {};
  return value[key] as JsonObject;
}

function bounded(value: unknown, maximum = 4096): string {
  return stringValue(value).replace(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,
    "",
  )
    .trim().slice(0, maximum);
}

export async function authenticateWhatsAppInboundRequest(
  headers: Headers,
  requestUrl: URL,
  expectedToken: string,
  legacyToken = "",
): Promise<"instance-header" | "legacy-header" | "legacy-query" | null> {
  const suppliedHeader = headers.get("x-whatsapp-inbound-token") || "";
  if (
    await constantTimeTokenMatches(
      suppliedHeader,
      expectedToken,
    )
  ) {
    return "instance-header";
  }
  if (
    legacyToken &&
    await constantTimeTokenMatches(suppliedHeader, legacyToken)
  ) {
    return "legacy-header";
  }
  if (
    legacyToken &&
    await constantTimeTokenMatches(
      requestUrl.searchParams.get("token") || "",
      legacyToken,
    )
  ) {
    return "legacy-query";
  }
  return null;
}

export type WhatsAppInboundAuthVersion = 1 | 2 | 3;

export type WhatsAppInboundIntegrationBinding = {
  tenantId: string;
  instanceName: string;
  integrationId: string;
  integrationVersion: number;
};

export type WhatsAppInboundCurrentIntegration = {
  tenantId: string;
  integrationId: string;
  version: number;
};

const integrationIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function signWhatsAppInboundScope(
  rootToken: string,
  scope: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(rootToken),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(scope)),
  );
  let binary = "";
  for (const byte of signature) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/,
    "",
  );
}

/**
 * Deriva uma credencial diferente para cada instância sem persistir o segredo
 * em texto puro no banco. O tenant faz parte do domínio para que o nome de uma
 * instância antiga não possa ser reutilizado por outra escola com o mesmo
 * token. A raiz continua somente no ambiente do servidor.
 */
export async function deriveWhatsAppInboundInstanceToken(
  rootToken: string,
  tenantId: string,
  instanceName: string,
): Promise<string> {
  const tenant = tenantId.trim();
  const instance = instanceName.trim().toLowerCase();
  if (
    rootToken.length < 16 || rootToken.length > 4096 ||
    !/^[A-Za-z0-9._-]{1,120}$/.test(tenant) ||
    !/^[A-Za-z0-9._-]{1,120}$/.test(instance)
  ) {
    throw new Error("invalid_whatsapp_inbound_token_scope");
  }
  return await signWhatsAppInboundScope(
    rootToken,
    `wisewolf:whatsapp-webhook:v2:${tenant}:${instance}`,
  );
}

/**
 * Token v3: além de tenant/instância, inclui o recibo exato da integração.
 * Recriar o mesmo nome em outra conta ou versão invalida o segredo anterior.
 */
export async function deriveWhatsAppInboundInstanceTokenV3(
  rootToken: string,
  tenantId: string,
  instanceName: string,
  integrationId: string,
  integrationVersion: number,
): Promise<string> {
  const tenant = tenantId.trim();
  const instance = instanceName.trim().toLowerCase();
  const integration = integrationId.trim().toLowerCase();
  if (
    rootToken.length < 16 || rootToken.length > 4096 ||
    !/^[A-Za-z0-9._-]{1,120}$/.test(tenant) ||
    !/^[A-Za-z0-9._-]{1,120}$/.test(instance) ||
    !integrationIdPattern.test(integration) ||
    !Number.isSafeInteger(integrationVersion) || integrationVersion < 1
  ) {
    throw new Error("invalid_whatsapp_inbound_token_scope");
  }
  return await signWhatsAppInboundScope(
    rootToken,
    `wisewolf:whatsapp-webhook:v3:${tenant}:${instance}:${integration}:${integrationVersion}`,
  );
}

export function whatsappInboundIntegrationBindingMatches(
  binding: WhatsAppInboundIntegrationBinding,
  integration: WhatsAppInboundCurrentIntegration,
): boolean {
  return binding.tenantId.trim() === integration.tenantId.trim() &&
    binding.integrationId.trim().toLowerCase() ===
      integration.integrationId.trim().toLowerCase() &&
    Number.isSafeInteger(binding.integrationVersion) &&
    binding.integrationVersion > 0 &&
    binding.integrationVersion === integration.version;
}

/**
 * Autentica a versão registrada e, só depois de validar o segredo, confirma no
 * broker que a instância ainda pertence ao mesmo recibo da integração.
 */
export async function authenticateWhatsAppInboundBoundRequest(
  headers: Headers,
  requestUrl: URL,
  rootToken: string,
  authVersion: WhatsAppInboundAuthVersion,
  binding: WhatsAppInboundIntegrationBinding,
  resolveCurrentIntegration: () => Promise<WhatsAppInboundCurrentIntegration>,
): Promise<"instance-header" | "legacy-header" | "legacy-query" | null> {
  let expectedToken: string;
  try {
    expectedToken = authVersion === 3
      ? await deriveWhatsAppInboundInstanceTokenV3(
        rootToken,
        binding.tenantId,
        binding.instanceName,
        binding.integrationId,
        binding.integrationVersion,
      )
      : await deriveWhatsAppInboundInstanceToken(
        rootToken,
        binding.tenantId,
        binding.instanceName,
      );
  } catch {
    return null;
  }

  const authentication = await authenticateWhatsAppInboundRequest(
    headers,
    requestUrl,
    expectedToken,
    authVersion === 1 ? rootToken : "",
  );
  if (!authentication) return null;

  try {
    const currentIntegration = await resolveCurrentIntegration();
    return whatsappInboundIntegrationBindingMatches(
        binding,
        currentIntegration,
      )
      ? authentication
      : null;
  } catch {
    return null;
  }
}

export function whatsappInboundMethodIsAllowed(method: string): boolean {
  return method === "POST" || method === "OPTIONS";
}

export function normalizeEvolutionEventName(value: unknown): string {
  return bounded(value, 80).toLowerCase().replace(/_/g, ".");
}

export function isEvolutionInboxJidAllowed(
  remoteJid: string,
  managementGroupJid: string | null | undefined,
): boolean {
  if (remoteJid.endsWith("@s.whatsapp.net")) return true;
  return remoteJid.endsWith("@g.us") &&
    remoteJid === String(managementGroupJid || "").trim();
}

function secondsFromTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d{9,16}$/.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (isObject(value)) {
    const low = Number(value.low);
    if (Number.isFinite(low) && low > 0) return low >>> 0;
  }
  return null;
}

function isoTimestamp(value: unknown): string {
  const raw = secondsFromTimestamp(value);
  if (!raw) return new Date().toISOString();
  const milliseconds = raw > 10_000_000_000 ? raw : raw * 1000;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime())
    ? new Date().toISOString()
    : date.toISOString();
}

function providerStatus(value: unknown, fromMe: boolean) {
  const normalized =
    (typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : bounded(value, 40)).toUpperCase();
  if (["READ", "PLAYED", "4", "5"].includes(normalized)) return "read" as const;
  if (["DELIVERY_ACK", "DELIVERED", "3"].includes(normalized)) {
    return "delivered" as const;
  }
  if (["SERVER_ACK", "SENT", "2"].includes(normalized)) return "sent" as const;
  if (["PENDING", "1"].includes(normalized)) return "queued" as const;
  if (["ERROR", "FAILED", "-1", "0"].includes(normalized)) {
    return "failed" as const;
  }
  return fromMe ? "sent" as const : "received" as const;
}

function messageContent(message: JsonObject): {
  type: EvolutionInboxMessage["messageType"];
  body: string;
} {
  const extended = objectValue(message, "extendedTextMessage");
  const image = objectValue(message, "imageMessage");
  const video = objectValue(message, "videoMessage");
  const document = objectValue(message, "documentMessage");
  const location = objectValue(message, "locationMessage");
  const contact = objectValue(message, "contactMessage");
  const reaction = objectValue(message, "reactionMessage");
  const buttons = objectValue(message, "buttonsResponseMessage");
  const list = objectValue(message, "listResponseMessage");
  const template = objectValue(message, "templateButtonReplyMessage");

  const text = bounded(message.conversation) || bounded(extended.text) ||
    bounded(buttons.selectedDisplayText) || bounded(buttons.selectedButtonId) ||
    bounded(objectValue(list, "singleSelectReply").selectedRowId) ||
    bounded(template.selectedDisplayText) || bounded(template.selectedId);
  if (text) return { type: "text", body: text };
  if (Object.keys(image).length) {
    return { type: "image", body: bounded(image.caption) || "[Imagem]" };
  }
  if (Object.keys(video).length) {
    return { type: "video", body: bounded(video.caption) || "[Vídeo]" };
  }
  if (
    isObject(message.audioMessage) || isObject(message.pttMessage)
  ) return { type: "audio", body: "[Áudio]" };
  if (Object.keys(document).length) {
    return {
      type: "document",
      body: bounded(document.caption) || bounded(document.fileName) ||
        "[Documento]",
    };
  }
  if (isObject(message.stickerMessage)) {
    return { type: "sticker", body: "[Figurinha]" };
  }
  if (Object.keys(location).length) {
    return {
      type: "location",
      body: bounded(location.name) || bounded(location.address) ||
        "[Localização]",
    };
  }
  if (Object.keys(contact).length) {
    return {
      type: "contact",
      body: bounded(contact.displayName) || "[Contato]",
    };
  }
  if (Object.keys(reaction).length) {
    return { type: "reaction", body: bounded(reaction.text) || "[Reação]" };
  }
  return { type: "unknown", body: "[Mensagem não suportada]" };
}

export function evolutionMessageItems(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (!isObject(data)) return [];
  const messages = objectValue(data, "messages");
  if (Array.isArray(messages.records)) return messages.records;
  if (Array.isArray(data.records)) return data.records;
  if (Array.isArray(data.data)) return data.data;
  return [data];
}

export function parseEvolutionMessage(
  value: unknown,
  options: { senderKind?: EvolutionInboxMessage["senderKind"] } = {},
): EvolutionInboxMessage | null {
  if (!isObject(value)) return null;
  const key = objectValue(value, "key");
  const update = objectValue(value, "update");
  const message = objectValue(value, "message");
  const originalRemoteJid = bounded(key.remoteJid || value.remoteJid, 220);
  const remoteJidAlt = bounded(key.remoteJidAlt || value.remoteJidAlt, 220);
  const remoteJid = originalRemoteJid.endsWith("@lid") &&
      remoteJidAlt.endsWith("@s.whatsapp.net")
    ? remoteJidAlt
    : originalRemoteJid;
  // Baileys envia key.id. Evolution v2.4 também emite MESSAGES_UPDATE com
  // keyId no topo; sem este fallback, recibos DELIVERED/READ eram descartados.
  const providerMessageId = bounded(
    key.id || value.keyId || value.messageId || value.id,
    220,
  );
  if (!remoteJid || !providerMessageId) return null;

  const fromMe = key.fromMe === true || value.fromMe === true;
  const content = messageContent(message);
  const directPhone = remoteJid.endsWith("@s.whatsapp.net")
    ? remoteJid.split("@")[0].replace(/\D/g, "").slice(0, 20)
    : "";
  const participant = bounded(key.participant || value.participant, 220);
  const status = providerStatus(
    update.status || value.status || value.messageStatus,
    fromMe,
  );

  return {
    remoteJid,
    providerMessageId,
    direction: fromMe ? "out" : "in",
    senderKind: options.senderKind || (fromMe ? "system" : "contact"),
    messageType: content.type,
    body: content.body,
    occurredAt: isoTimestamp(
      value.messageTimestamp || value.timestamp || update.messageTimestamp,
    ),
    displayName: bounded(
      value.pushName || value.verifiedBizName || value.name || value.notify,
      160,
    ) || null,
    phone: directPhone || null,
    status,
    metadata: {
      source: "evolution",
      fromMe,
      ...(participant ? { participant } : {}),
      ...(remoteJidAlt ? { remoteJidAlt } : {}),
      ...(remoteJid !== originalRemoteJid ? { originalRemoteJid } : {}),
    },
  };
}

const REDACTED_KEY =
  /(apikey|api_key|authorization|token|secret|password|base64|url|media_?key|direct_?path|jpeg_?thumbnail|thumbnail_?(?:sha256|encsha256)|file_?(?:sha256|encsha256)|sidecar|device_?list_?metadata)$/i;

function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth > 8) return "[truncated]";
  if (typeof value === "string") return value.slice(0, 4096);
  if (
    typeof value === "number" || typeof value === "boolean" || value === null
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 200).map((item) => sanitizeValue(item, depth + 1));
  }
  if (!isObject(value)) return null;
  return Object.fromEntries(
    Object.entries(value).slice(0, 200).map(([key, child]) => [
      key,
      REDACTED_KEY.test(key) ? "[redacted]" : sanitizeValue(child, depth + 1),
    ]),
  );
}

export function sanitizeEvolutionWebhook(
  value: unknown,
  maximumBytes = 131_072,
): Record<string, unknown> {
  const sanitized = sanitizeValue(value, 0);
  const object = isObject(sanitized) ? sanitized : {};
  if (new TextEncoder().encode(JSON.stringify(object)).length <= maximumBytes) {
    return object;
  }
  return {
    event: bounded(object.event, 80),
    instance: bounded(object.instance, 120),
    date_time: bounded(object.date_time, 80),
    truncated: true,
    messageIds: evolutionMessageItems(object.data).flatMap((item) => {
      if (!isObject(item)) return [];
      const id = bounded(objectValue(item, "key").id || item.id, 220);
      return id ? [id] : [];
    }).slice(0, 200),
  };
}

function canonicalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeJsonValue(item));
  }
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [
      key,
      canonicalizeJsonValue(value[key]),
    ]),
  );
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest)).map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

export async function evolutionWebhookEventKey(
  value: unknown,
): Promise<string> {
  const sanitized = sanitizeEvolutionWebhook(value);
  // A Evolution não fornece event-id. O hash do envelope sanitizado distingue,
  // por exemplo, DELIVERY_ACK de READ para a mesma mensagem, mas permanece
  // estável quando o provedor reentrega exatamente o mesmo webhook.
  return await sha256(JSON.stringify(canonicalizeJsonValue(sanitized)));
}

export async function storeEvolutionInboxMessage(
  client: WhatsAppInboxRpcClient,
  tenantId: string,
  instanceName: string,
  message: EvolutionInboxMessage,
  source: "webhook" | "sync",
): Promise<{ data: unknown; error: { code?: string } | null }> {
  const stored = await client.rpc("store_whatsapp_provider_message", {
    p_tenant_id: tenantId,
    p_instance_name: instanceName,
    p_remote_jid: message.remoteJid,
    p_provider_message_id: message.providerMessageId,
    p_direction: message.direction,
    p_sender_kind: message.senderKind,
    p_message_type: message.messageType,
    p_body: message.body,
    p_occurred_at: message.occurredAt,
    p_display_name: message.displayName,
    p_phone: message.phone,
    p_status: message.status,
    p_metadata: { ...message.metadata, source },
  });
  if (stored.error || message.direction !== "out") return stored;
  if (!["sent", "delivered", "read", "failed"].includes(message.status)) {
    return stored;
  }

  // A inbox canônica e as automações possuem ledgers diferentes. O recibo do
  // provedor baixa ambos pela mesma identidade externa, sem transformar um
  // retry de webhook em um novo envio.
  const receipt = await client.rpc("reconcile_whatsapp_provider_delivery", {
    p_tenant_id: tenantId,
    p_instance_name: instanceName,
    p_provider_message_id: message.providerMessageId,
    p_provider_status: message.status,
    p_occurred_at: message.occurredAt,
  });
  return receipt.error ? receipt : stored;
}
