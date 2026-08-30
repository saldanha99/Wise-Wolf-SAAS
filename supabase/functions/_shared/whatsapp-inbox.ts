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
): Promise<"header" | "legacy-query" | null> {
  if (
    await constantTimeTokenMatches(
      headers.get("x-whatsapp-inbound-token") || "",
      expectedToken,
    )
  ) {
    return "header";
  }
  if (
    await constantTimeTokenMatches(
      requestUrl.searchParams.get("token") || "",
      expectedToken,
    )
  ) {
    return "legacy-query";
  }
  return null;
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
  const providerMessageId = bounded(key.id || value.id, 220);
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
  return await sha256(JSON.stringify(sanitized));
}

export async function storeEvolutionInboxMessage(
  client: WhatsAppInboxRpcClient,
  tenantId: string,
  instanceName: string,
  message: EvolutionInboxMessage,
  source: "webhook" | "sync",
): Promise<{ data: unknown; error: { code?: string } | null }> {
  return await client.rpc("store_whatsapp_provider_message", {
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
}
