import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  authorizeRequest,
  type RequestAuthResult,
} from "../_shared/request-auth.ts";
import {
  type EvolutionIntegrationPurpose,
  type ResolvedEvolutionIntegration,
  resolveEvolutionIntegration,
  type TenantIntegrationRpcClient,
} from "../_shared/tenant-integration-broker.ts";
import {
  deriveWhatsAppInboundInstanceTokenV3,
  type EvolutionInboxMessage,
  evolutionMessageItems,
  findActiveProfileById,
  isEvolutionInboxJidAllowed,
  parseEvolutionMessage,
  storeEvolutionInboxMessage,
} from "../_shared/whatsapp-inbox.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const allowedActions = new Set([
  "instance/create",
  "instance/connect",
  "instance/connectionState",
  "instance/logout",
  "instance/delete",
  "message/sendText",
  "group/fetchAllGroups",
  "inbox/enable",
  "inbox/sync",
  "inbox/sendText",
  "inbox/markRead",
  "inbox/setHandoff",
]);

const allowedRoles = [
  "SUPER_ADMIN",
  "SCHOOL_ADMIN",
  "COORDINATOR",
  "TEACHER",
] as const;
const instanceManagementActions = new Set([
  "instance/create",
  "instance/connect",
  "instance/logout",
  "instance/delete",
]);
const inboxActions = new Set([
  "inbox/enable",
  "inbox/sync",
  "inbox/sendText",
  "inbox/markRead",
  "inbox/setHandoff",
]);
const inboxEnabledActions = new Set([
  "inbox/sync",
  "inbox/sendText",
  "inbox/markRead",
  "inbox/setHandoff",
]);
const inboxRoles = new Set(["SUPER_ADMIN", "SCHOOL_ADMIN", "COORDINATOR"]);
const operationalTenantStatuses = new Set(["active", "trial", "trialing"]);
const instanceNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{2,79}$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Keep this list compatible with every supported Evolution API release (v2.2+).
const inboxWebhookEvents = [
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
  // Evolution API v2 names only this update event in the singular.
  "GROUP_UPDATE",
  "GROUP_PARTICIPANTS_UPDATE",
] as const;
const purposeByAction: Partial<Record<string, EvolutionIntegrationPurpose>> = {
  "instance/create": "instance.create",
  "instance/connect": "instance.connect",
  "instance/connectionState": "instance.connection_state",
  "instance/logout": "instance.logout",
  "instance/delete": "instance.delete",
  "message/sendText": "message.send_text",
  "group/fetchAllGroups": "group.list",
  "inbox/sendText": "message.send_text",
};

type JsonObject = Record<string, unknown>;

type ProxyDependencies = {
  getEnv?: (name: string) => string | undefined;
  authorize?: (
    req: Request,
    options: {
      allowedRoles: readonly string[];
      corsHeaders: Record<string, string>;
    },
  ) => Promise<RequestAuthResult>;
  fetchUpstream?: typeof fetch;
  resolveIntegration?: (
    admin: TenantIntegrationRpcClient,
    tenantId: string,
    purpose: EvolutionIntegrationPurpose,
    dependencies: { getEnv: (name: string) => string | undefined },
  ) => Promise<ResolvedEvolutionIntegration>;
};

function json(body: JsonObject, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nestedObject(value: unknown, key: string): JsonObject {
  if (!isObject(value)) return {};
  return isObject(value[key]) ? value[key] as JsonObject : {};
}

function upstreamState(data: unknown): string {
  const instance = nestedObject(data, "instance");
  const state = asString(instance.state) || asString(instance.status);
  return state || "disconnected";
}

function upstreamGroups(data: unknown): Array<{ id: string; subject: string }> {
  let candidates: unknown[] = [];
  if (Array.isArray(data)) {
    candidates = data;
  } else if (isObject(data) && Array.isArray(data.groups)) {
    candidates = data.groups;
  } else if (isObject(data) && Array.isArray(data.data)) {
    candidates = data.data;
  } else if (isObject(data)) {
    candidates = Object.values(data);
  }

  return candidates.flatMap((candidate) => {
    if (!isObject(candidate)) return [];
    const id = asString(candidate.id) || asString(candidate.remoteJid);
    const subject = asString(candidate.subject) || asString(candidate.name);
    if (!id || !subject) return [];
    return [{ id: id.slice(0, 160), subject: subject.slice(0, 160) }];
  });
}

async function readUpstreamJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function limitedString(value: unknown, maximumLength: number): string {
  return asString(value).trim().slice(0, maximumLength);
}

function safeRemoteJid(value: unknown): string {
  const jid = limitedString(value, 160);
  if (!jid.includes("@") || /[\s/?#\\]/.test(jid)) return "";
  return jid;
}

function parseObject(value: unknown): JsonObject | null {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return null;
    }
  }
  if (Array.isArray(candidate)) candidate = candidate[0];
  return isObject(candidate) ? candidate : null;
}

function rpcString(value: JsonObject, ...keys: string[]): string {
  for (const key of keys) {
    const candidate = limitedString(value[key], 4096);
    if (candidate) return candidate;
  }
  return "";
}

function rpcBoolean(value: JsonObject, ...keys: string[]): boolean | null {
  for (const key of keys) {
    if (typeof value[key] === "boolean") return value[key] as boolean;
  }
  return null;
}

async function rpcObject(
  admin: TenantIntegrationRpcClient,
  functionName: string,
  args: Record<string, unknown>,
): Promise<{ data: JsonObject | null; errorCode: string }> {
  const { data, error } = await admin.rpc(functionName, args);
  if (error) {
    return {
      data: null,
      errorCode: limitedString(error.code, 80) || "rpc_error",
    };
  }
  const parsed = parseObject(data);
  return parsed
    ? { data: parsed, errorCode: "" }
    : { data: null, errorCode: "invalid_rpc_result" };
}

function evolutionArrays(value: unknown, ...keys: string[]): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isObject(value)) return [];
  for (const key of keys) {
    const candidate = value[key];
    if (Array.isArray(candidate)) return candidate;
    if (isObject(candidate) && Array.isArray(candidate.records)) {
      return candidate.records;
    }
  }
  return [];
}

async function persistProviderMessages(
  admin: TenantIntegrationRpcClient,
  tenantId: string,
  instanceName: string,
  messages: EvolutionInboxMessage[],
): Promise<{ stored: number; duplicates: number }> {
  if (!messages.length) return { stored: 0, duplicates: 0 };

  const batchMessages = messages.map((message) => ({
    ...message,
    metadata: { ...message.metadata, source: "sync" },
  }));
  const batchResult = await admin.rpc("store_whatsapp_provider_messages", {
    p_tenant_id: tenantId,
    p_instance_name: instanceName,
    p_messages: batchMessages,
  });
  if (!batchResult.error) {
    const result = parseObject(batchResult.data);
    const batchStored = Number(result?.stored);
    if (
      !result || rpcBoolean(result, "ok") === false ||
      !Number.isSafeInteger(batchStored) || batchStored < 0 ||
      batchStored > messages.length
    ) {
      throw new Error("provider_message_batch_result_invalid");
    }
    return {
      stored: batchStored,
      duplicates: messages.length - batchStored,
    };
  }

  const batchErrorCode = limitedString(batchResult.error.code, 80);
  if (!["42883", "PGRST202"].includes(batchErrorCode)) {
    throw new Error("provider_message_batch_persist_failed");
  }

  let stored = 0;
  let duplicates = 0;

  for (let start = 0; start < messages.length; start += 8) {
    const batch = messages.slice(start, start + 8);
    const results = await Promise.all(batch.map(async (message) => {
      const result = await storeEvolutionInboxMessage(
        admin,
        tenantId,
        instanceName,
        message,
        "sync",
      );
      return {
        data: parseObject(result.data),
        errorCode: limitedString(result.error?.code, 80),
      };
    }));

    for (const result of results) {
      if (!result.data || result.errorCode) {
        throw new Error("provider_message_persist_failed");
      }
      if (rpcBoolean(result.data, "duplicate") === true) duplicates += 1;
      else stored += 1;
    }
  }
  return { stored, duplicates };
}

function safePositiveInteger(value: unknown, fallback = 1): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 10_000
    ? parsed
    : fallback;
}

function inboundWebhookUrl(getEnv: (name: string) => string | undefined): {
  url: string;
  token: string;
} | null {
  const token = getEnv("WHATSAPP_INBOUND_TOKEN")?.trim() || "";
  if (token.length < 16 || token.length > 4096) return null;

  const publicUrl = getEnv("WHATSAPP_INBOUND_PUBLIC_URL")?.trim() || "";
  if (publicUrl) {
    try {
      const url = new URL(publicUrl);
      if (
        url.protocol !== "https:" || url.username || url.password ||
        url.search || url.hash ||
        url.pathname !== "/functions/v1/whatsapp-inbound"
      ) return null;
      return { url: url.href, token };
    } catch {
      return null;
    }
  }

  // Compatibilidade controlada: projetos hospedados pela Supabase e testes
  // realmente locais podem derivar a rota. Hosts internos da VPS (kong,
  // api-gw etc.) nunca podem virar a URL entregue à Evolution.
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
      token,
    };
  } catch {
    return null;
  }
}

async function finalizeOutbound(
  admin: TenantIntegrationRpcClient,
  tenantId: string,
  messageId: string,
  status: "sent" | "failed" | "uncertain",
  providerMessageId: string | null,
  errorCode: string | null,
): Promise<boolean> {
  const result = await rpcObject(admin, "finalize_whatsapp_outbound", {
    p_tenant_id: tenantId,
    p_message_id: messageId,
    p_status: status,
    p_provider_message_id: providerMessageId,
    p_error_code: errorCode,
  });
  return Boolean(result.data && !result.errorCode);
}

async function handleInboxSendText(input: {
  admin: TenantIntegrationRpcClient;
  tenantId: string;
  instanceName: string;
  integrationId: string;
  integrationVersion: number;
  actorId: string;
  payload: JsonObject;
  getEnv: (name: string) => string | undefined;
  fetchUpstream: typeof fetch;
  resolveIntegration: (
    admin: TenantIntegrationRpcClient,
    tenantId: string,
    purpose: EvolutionIntegrationPurpose,
    dependencies: { getEnv: (name: string) => string | undefined },
  ) => Promise<ResolvedEvolutionIntegration>;
}): Promise<Response> {
  const conversationId = limitedString(input.payload.conversationId, 80);
  const clientRequestId = limitedString(input.payload.clientRequestId, 80);
  const requestedText = asString(input.payload.text).trim();
  if (
    !uuidPattern.test(conversationId) || !uuidPattern.test(clientRequestId) ||
    !requestedText || requestedText.length > 4096
  ) {
    return json({
      error: "Mensagem ou conversa inv\u00e1lida",
      code: "INVALID_INBOX_MESSAGE",
    }, 400);
  }

  // Resolva credenciais antes de criar a outbox: uma indisponibilidade do
  // broker não pode deixar uma mensagem queued que nunca foi despachada.
  let integration: ResolvedEvolutionIntegration;
  try {
    integration = await input.resolveIntegration(
      input.admin,
      input.tenantId,
      "message.send_text",
      { getEnv: input.getEnv },
    );
  } catch {
    console.error("[WA Proxy] Broker recusou envio da inbox");
    return json({
      error: "Integração indisponível",
      code: "INTEGRATION_UNAVAILABLE",
    }, 503);
  }
  if (
    integration.integrationId !== input.integrationId ||
    integration.version !== input.integrationVersion
  ) {
    return json({
      error: "A instância precisa ser recriada após a troca da integração",
      code: "INTEGRATION_BINDING_STALE",
    }, 409);
  }

  const prepared = await rpcObject(input.admin, "prepare_whatsapp_outbound", {
    p_tenant_id: input.tenantId,
    p_instance_name: input.instanceName,
    p_conversation_id: conversationId,
    p_actor_id: input.actorId,
    p_client_request_id: clientRequestId,
    p_body: requestedText,
  });
  if (!prepared.data || prepared.errorCode) {
    console.error("[WA Proxy] Falha ao preparar sa\u00edda", {
      code: prepared.errorCode || "invalid_result",
    });
    return json({
      error: "N\u00e3o foi poss\u00edvel preparar a mensagem",
      code: "OUTBOUND_PREPARE_FAILED",
    }, 503);
  }

  const messageId = rpcString(prepared.data, "messageId", "message_id");
  const preparedStatus = rpcString(prepared.data, "status").toLowerCase();
  const duplicate = rpcBoolean(prepared.data, "duplicate") === true;
  if (!uuidPattern.test(messageId) || !preparedStatus) {
    return json({
      error: "N\u00e3o foi poss\u00edvel preparar a mensagem",
      code: "OUTBOUND_PREPARE_FAILED",
    }, 503);
  }

  if (
    duplicate &&
    ["dispatching", "sent", "delivered", "read", "failed", "uncertain"]
      .includes(preparedStatus)
  ) {
    return json({
      ok: true,
      duplicate: true,
      messageId,
      status: preparedStatus,
    });
  }

  const claim = await rpcObject(input.admin, "claim_whatsapp_outbound", {
    p_tenant_id: input.tenantId,
    p_message_id: messageId,
    p_actor_id: input.actorId,
  });
  if (!claim.data || claim.errorCode) {
    console.error("[WA Proxy] Falha ao reservar sa\u00edda", {
      code: claim.errorCode || "invalid_result",
    });
    return json({
      error: "N\u00e3o foi poss\u00edvel reservar a mensagem",
      code: "OUTBOUND_CLAIM_FAILED",
    }, 503);
  }

  const claimed = rpcBoolean(claim.data, "claimed");
  const claimStatus = rpcString(claim.data, "status").toLowerCase() ||
    preparedStatus;
  if (claimed === false) {
    return json({
      ok: true,
      duplicate: true,
      messageId,
      status: claimStatus,
    });
  }
  if (claimed !== true) {
    return json({
      error: "N\u00e3o foi poss\u00edvel reservar a mensagem",
      code: "OUTBOUND_CLAIM_FAILED",
    }, 503);
  }

  const claimedMessageId = rpcString(claim.data, "messageId", "message_id");
  const claimedConversationId = rpcString(
    claim.data,
    "conversationId",
    "conversation_id",
  );
  const claimedInstanceName = rpcString(
    claim.data,
    "instanceName",
    "instance_name",
  );
  const remoteJid = safeRemoteJid(
    claim.data.remoteJid || claim.data.remote_jid,
  );
  const canonicalText = asString(claim.data.body).trim();
  if (
    claimedMessageId !== messageId ||
    claimedConversationId !== conversationId ||
    claimedInstanceName !== input.instanceName || !remoteJid ||
    !canonicalText || canonicalText.length > 4096
  ) {
    await finalizeOutbound(
      input.admin,
      input.tenantId,
      messageId,
      "failed",
      null,
      "OUTBOUND_CLAIM_INVALID",
    );
    return json({
      error: "Reserva de mensagem inv\u00e1lida",
      code: "OUTBOUND_CLAIM_FAILED",
    }, 503);
  }

  const endpoint = `${integration.baseUrl}/message/sendText/${
    encodeURIComponent(input.instanceName)
  }`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  let response: Response;
  try {
    response = await input.fetchUpstream(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: integration.apiKey,
      },
      body: JSON.stringify({
        number: remoteJid,
        text: canonicalText,
        linkPreview: true,
      }),
      redirect: "error",
      signal: controller.signal,
    });
  } catch (error) {
    const errorCode = error instanceof Error && error.name === "AbortError"
      ? "UPSTREAM_TIMEOUT"
      : "UPSTREAM_NETWORK_ERROR";
    await finalizeOutbound(
      input.admin,
      input.tenantId,
      messageId,
      "uncertain",
      null,
      errorCode,
    );
    console.error("[WA Proxy] Resultado de envio incerto", { code: errorCode });
    return json({
      ok: true,
      uncertain: true,
      messageId,
      status: "uncertain",
    }, 202);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    await finalizeOutbound(
      input.admin,
      input.tenantId,
      messageId,
      "failed",
      null,
      `UPSTREAM_${response.status}`,
    );
    console.error("[WA Proxy] Provedor recusou envio da inbox", {
      status: response.status,
    });
    return json({
      error: "Mensagem recusada pelo provedor",
      code: "UPSTREAM_REJECTED",
      messageId,
      status: "failed",
    }, 502);
  }

  let responseData: unknown;
  try {
    responseData = await readUpstreamJson(response);
  } catch {
    await finalizeOutbound(
      input.admin,
      input.tenantId,
      messageId,
      "uncertain",
      null,
      "UPSTREAM_RESPONSE_UNREADABLE",
    );
    return json({
      ok: true,
      uncertain: true,
      messageId,
      status: "uncertain",
    }, 202);
  }

  const responseRoot = isObject(responseData) ? responseData : {};
  const responseKey = nestedObject(responseData, "key");
  const providerMessageId = limitedString(
    responseKey.id || responseRoot.messageId || responseRoot.providerMessageId,
    200,
  );
  if (!providerMessageId) {
    await finalizeOutbound(
      input.admin,
      input.tenantId,
      messageId,
      "uncertain",
      null,
      "PROVIDER_MESSAGE_ID_MISSING",
    );
    return json({
      ok: true,
      uncertain: true,
      messageId,
      status: "uncertain",
    }, 202);
  }

  const finalized = await finalizeOutbound(
    input.admin,
    input.tenantId,
    messageId,
    "sent",
    providerMessageId,
    null,
  );
  if (!finalized) {
    console.error(
      "[WA Proxy] Envio feito; reconcilia\u00e7\u00e3o local pendente",
    );
    return json({
      ok: true,
      uncertain: true,
      messageId,
      status: "uncertain",
    }, 202);
  }

  return json({
    ok: true,
    duplicate: false,
    messageId,
    providerMessageId,
    status: "sent",
  });
}

export async function handleRequest(
  req: Request,
  dependencies: ProxyDependencies = {},
): Promise<Response> {
  const getEnv = dependencies.getEnv || ((name: string) => Deno.env.get(name));
  const authorize = dependencies.authorize || authorizeRequest;
  const fetchUpstream = dependencies.fetchUpstream || fetch;
  const resolveIntegration = dependencies.resolveIntegration ||
    resolveEvolutionIntegration;

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json(
      { error: "Método não permitido", code: "METHOD_NOT_ALLOWED" },
      405,
    );
  }

  const contentLength = Number(req.headers.get("content-length") || "0");
  if (Number.isFinite(contentLength) && contentLength > 16_384) {
    return json(
      { error: "Requisição muito grande", code: "PAYLOAD_TOO_LARGE" },
      413,
    );
  }

  const authorization = req.headers.get("authorization")?.trim() || "";
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || "";
  if (!token) {
    return json({ error: "Não autenticado", code: "UNAUTHENTICATED" }, 401);
  }

  const auth = await authorize(req, { corsHeaders, allowedRoles });
  if (auth.ok === false) return auth.response;
  const { admin: supabaseAdmin, profile, userId } = auth.context;
  if (!profile || !userId) {
    return json({ error: "Sessão inválida", code: "UNAUTHENTICATED" }, 401);
  }

  let requestBody: JsonObject;
  try {
    const parsed = await req.json();
    if (!isObject(parsed)) throw new Error("invalid body");
    requestBody = parsed;
  } catch {
    return json({ error: "JSON inválido", code: "INVALID_JSON" }, 400);
  }

  const action = asString(requestBody.action);
  const requestedTenantId = asString(requestBody.tenantId).trim();
  const payload = isObject(requestBody.payload) ? requestBody.payload : {};

  if (!allowedActions.has(action)) {
    return json(
      { error: "Operação não permitida", code: "ACTION_FORBIDDEN" },
      400,
    );
  }

  const callerRole = profile.role;
  const callerTenantId = asString(profile.tenant_id).trim();
  let effectiveTenantId = callerTenantId;

  if (callerRole === "SUPER_ADMIN") {
    const { data: selectedContext, error: contextError } = await supabaseAdmin
      .from("tenant_user_contexts")
      .select("tenant_id")
      .eq("user_id", userId)
      .maybeSingle();
    if (contextError) {
      console.error("[WA Proxy] Falha ao validar contexto do superadmin", {
        code: contextError.code || "query_error",
      });
      return json({
        error: "Não foi possível validar o contexto da escola",
        code: "TENANT_CONTEXT_VALIDATION_FAILED",
      }, 503);
    }

    effectiveTenantId = asString(selectedContext?.tenant_id).trim();
    if (!effectiveTenantId) {
      return json({
        error: "Selecione uma escola antes de continuar",
        code: "TENANT_CONTEXT_REQUIRED",
      }, 403);
    }

    const { data: activeMembership, error: membershipError } =
      await supabaseAdmin
        .from("tenant_memberships")
        .select("tenant_id")
        .eq("user_id", userId)
        .eq("tenant_id", effectiveTenantId)
        .eq("status", "ACTIVE")
        .maybeSingle();
    if (membershipError) {
      console.error("[WA Proxy] Falha ao validar associação do superadmin", {
        code: membershipError.code || "query_error",
      });
      return json({
        error: "Não foi possível validar o acesso à escola",
        code: "TENANT_MEMBERSHIP_VALIDATION_FAILED",
      }, 503);
    }
    if (!activeMembership) {
      return json({
        error: "Associação ativa com a escola é obrigatória",
        code: "TENANT_MEMBERSHIP_INACTIVE",
      }, 403);
    }
  } else if (!effectiveTenantId) {
    return json(
      { error: "Tenant não autorizado", code: "TENANT_FORBIDDEN" },
      403,
    );
  }

  if (
    requestedTenantId && requestedTenantId !== effectiveTenantId
  ) {
    return json(
      { error: "Tenant não autorizado", code: "TENANT_FORBIDDEN" },
      403,
    );
  }

  if (inboxActions.has(action) && !inboxRoles.has(callerRole)) {
    return json({
      error: "A inbox est\u00e1 restrita \u00e0 gest\u00e3o da escola",
      code: "INBOX_FORBIDDEN",
    }, 403);
  }

  // COORDINATOR foi inclu\u00eddo no autorizador exclusivamente para a inbox.
  // As capacidades legadas mant\u00eam o mesmo conjunto de pap\u00e9is anterior.
  if (callerRole === "COORDINATOR" && !inboxActions.has(action)) {
    return json({
      error: "Opera\u00e7\u00e3o n\u00e3o permitida",
      code: "ACTION_FORBIDDEN",
    }, 403);
  }

  if (
    callerRole === "TEACHER" && instanceManagementActions.has(action)
  ) {
    return json({
      error: "Professor não pode gerenciar instâncias",
      code: "INSTANCE_MANAGEMENT_FORBIDDEN",
    }, 403);
  }

  const { data: tenant, error: tenantError } = await supabaseAdmin
    .from("tenants")
    .select("id, saas_status")
    .eq("id", effectiveTenantId)
    .maybeSingle();
  if (tenantError) {
    console.error("[WA Proxy] Falha ao validar tenant", {
      code: tenantError.code || "query_error",
    });
    return json({
      error: "Não foi possível validar a escola",
      code: "TENANT_VALIDATION_FAILED",
    }, 503);
  }
  const tenantStatus = asString(tenant?.saas_status).trim().toLowerCase();
  if (!tenant || !operationalTenantStatuses.has(tenantStatus)) {
    return json({
      error: "Escola sem assinatura ativa",
      code: "TENANT_INACTIVE",
    }, 403);
  }

  let instanceName = asString(requestBody.instanceName).trim();
  if (instanceName === "default") {
    const { data: defaultInstance, error: defaultError } = await supabaseAdmin
      .from("whatsapp_instances")
      .select("instance_name")
      .eq("tenant_id", effectiveTenantId)
      .eq("user_id", userId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (defaultError) {
      console.error("[WA Proxy] Falha ao resolver instância padrão", {
        code: defaultError.code || "query_error",
      });
      return json({
        error: "Não foi possível validar a instância",
        code: "INSTANCE_VALIDATION_FAILED",
      }, 503);
    }
    instanceName = asString(defaultInstance?.instance_name).trim();
  }
  if (!instanceNamePattern.test(instanceName)) {
    return json({ error: "Instância inválida", code: "INVALID_INSTANCE" }, 400);
  }

  const findInstanceOwner = async (): Promise<
    {
      id: string;
      user_id: string;
      inbox_enabled: boolean;
      integration_id: string;
      integration_version: number;
    } | null
  > => {
    let query = supabaseAdmin
      .from("whatsapp_instances")
      .select(
        "id, user_id, inbox_enabled, integration_id, integration_version",
      )
      .eq("tenant_id", effectiveTenantId)
      .eq("instance_name", instanceName)
      .limit(1);

    if (callerRole === "TEACHER") {
      query = query.eq("user_id", userId);
    }

    const { data, error } = await query.maybeSingle();
    if (error) {
      console.error(
        "[WA Proxy] Falha ao validar posse da instância",
        error.code || "query_error",
      );
      return null;
    }
    const integrationId = asString(data?.integration_id).trim();
    const integrationVersion = Number(data?.integration_version);
    return data?.id && data?.user_id && integrationId &&
        Number.isSafeInteger(integrationVersion) && integrationVersion > 0
      ? {
        id: String(data.id),
        user_id: String(data.user_id),
        inbox_enabled: data.inbox_enabled === true,
        integration_id: integrationId,
        integration_version: integrationVersion,
      }
      : null;
  };

  let ownerUserId = userId;
  let instanceRowId = "";
  let inboxEnabled = false;
  let instanceIntegrationId = "";
  let instanceIntegrationVersion = 0;
  if (action === "instance/create") {
    const recreate = payload.recreate === true;
    const requestedOwnerId = asString(payload.ownerUserId).trim() || userId;
    const { data: ownerMembership, error: ownerError } = await supabaseAdmin
      .from("tenant_memberships")
      .select("user_id, role")
      .eq("user_id", requestedOwnerId)
      .eq("tenant_id", effectiveTenantId)
      .eq("status", "ACTIVE")
      .maybeSingle();

    if (
      ownerError || !ownerMembership ||
      !["SCHOOL_ADMIN", "TEACHER"].includes(
        asString(ownerMembership.role),
      )
    ) {
      return json({
        error: "Responsável fora do seu tenant",
        code: "OWNER_FORBIDDEN",
      }, 403);
    }
    ownerUserId = String(ownerMembership.user_id);

    const { data: ownedInstance, error: ownedError } = await supabaseAdmin
      .from("whatsapp_instances")
      .select("id, instance_name")
      .eq("tenant_id", effectiveTenantId)
      .eq("user_id", ownerUserId)
      .limit(1)
      .maybeSingle();
    if (ownedError) {
      console.error("[WA Proxy] Falha ao validar vínculo existente", {
        code: ownedError.code || "query_error",
      });
      return json({
        error: "Não foi possível validar a instância",
        code: "INSTANCE_VALIDATION_FAILED",
      }, 503);
    }

    const existingName = asString(ownedInstance?.instance_name).trim();
    const owned = existingName === instanceName;
    if (recreate && !owned) {
      return json({
        error: "Instância fora do seu escopo",
        code: "INSTANCE_FORBIDDEN",
      }, 403);
    }
    instanceRowId = owned ? asString(ownedInstance?.id) : "";

    if (!recreate) {
      if (existingName && existingName !== instanceName) {
        return json({
          error: "Já existe uma instância vinculada a este usuário",
          code: "INSTANCE_ALREADY_LINKED",
        }, 409);
      }
      if (existingName === instanceName) {
        return json({
          error: "Instância já vinculada; use a operação de reconexão",
          code: "INSTANCE_ALREADY_LINKED",
        }, 409);
      }

      const { data: unavailableInstance, error: availabilityError } =
        await supabaseAdmin
          .from("whatsapp_instances")
          .select("id")
          .ilike("instance_name", instanceName)
          .limit(1)
          .maybeSingle();
      if (availabilityError) {
        console.error("[WA Proxy] Falha ao validar disponibilidade", {
          code: availabilityError.code || "query_error",
        });
        return json({
          error: "Não foi possível validar a instância",
          code: "INSTANCE_VALIDATION_FAILED",
        }, 503);
      }
      if (unavailableInstance) {
        return json({
          error: "Nome de instância indisponível",
          code: "INSTANCE_NAME_UNAVAILABLE",
        }, 409);
      }
    }
  } else {
    const owner = await findInstanceOwner();
    if (!owner) {
      return json({
        error: "Instância fora do seu escopo",
        code: "INSTANCE_FORBIDDEN",
      }, 403);
    }
    instanceRowId = owner.id;
    ownerUserId = owner.user_id;
    inboxEnabled = owner.inbox_enabled;
    instanceIntegrationId = owner.integration_id;
    instanceIntegrationVersion = owner.integration_version;
  }

  const validateInstitutionalInboxOwner = async (): Promise<
    Response | null
  > => {
    const { data: institutionalOwner, error: ownerMembershipError } =
      await supabaseAdmin
        .from("tenant_memberships")
        .select("user_id")
        .eq("tenant_id", effectiveTenantId)
        .eq("user_id", ownerUserId)
        .eq("role", "SCHOOL_ADMIN")
        .eq("status", "ACTIVE")
        .maybeSingle();
    if (ownerMembershipError) {
      console.error(
        "[WA Proxy] Falha ao validar instância institucional",
        { code: ownerMembershipError.code || "query_error" },
      );
      return json({
        error: "Não foi possível validar a instância institucional",
        code: "INBOX_OWNER_VALIDATION_FAILED",
      }, 503);
    }
    if (!institutionalOwner) {
      return json({
        error: "A inbox exige uma instância institucional da escola",
        code: "INBOX_REQUIRES_SCHOOL_ADMIN_INSTANCE",
      }, 403);
    }

    const { data: activeOwnerProfile, error: ownerProfileError } =
      await findActiveProfileById(supabaseAdmin, ownerUserId);
    if (ownerProfileError) {
      console.error(
        "[WA Proxy] Falha ao validar ciclo de vida do responsável",
        { code: ownerProfileError.code || "query_error" },
      );
      return json({
        error: "Não foi possível validar a instância institucional",
        code: "INBOX_OWNER_VALIDATION_FAILED",
      }, 503);
    }
    if (!activeOwnerProfile) {
      return json({
        error: "A inbox exige um responsável institucional ativo",
        code: "INBOX_REQUIRES_ACTIVE_SCHOOL_ADMIN",
      }, 403);
    }
    return null;
  };

  if (inboxActions.has(action)) {
    const ownerValidationResponse = await validateInstitutionalInboxOwner();
    if (ownerValidationResponse) return ownerValidationResponse;
  }

  if (inboxEnabledActions.has(action) && !inboxEnabled) {
    return json({
      error: "Ative a inbox desta inst\u00e2ncia antes de continuar",
      code: "INBOX_DISABLED",
    }, 409);
  }

  const findInboxConversation = async (conversationId: string): Promise<{
    conversation: { id: string; remoteJid: string } | null;
    failed: boolean;
  }> => {
    const { data, error } = await supabaseAdmin
      .from("whatsapp_conversations")
      .select("id, remote_jid, instance_id")
      .eq("tenant_id", effectiveTenantId)
      .eq("instance_id", instanceRowId)
      .eq("id", conversationId)
      .maybeSingle();
    if (error) {
      console.error("[WA Proxy] Falha ao validar conversa", {
        code: error.code || "query_error",
      });
      return { conversation: null, failed: true };
    }
    const remoteJid = safeRemoteJid(data?.remote_jid);
    return data?.id && remoteJid
      ? {
        conversation: { id: String(data.id), remoteJid },
        failed: false,
      }
      : { conversation: null, failed: false };
  };

  type ActiveManagementGroup = { jid: string | null; failed: boolean };
  let activeManagementGroupPromise: Promise<ActiveManagementGroup> | null =
    null;
  const loadActiveManagementGroup = (): Promise<ActiveManagementGroup> => {
    if (activeManagementGroupPromise) return activeManagementGroupPromise;
    activeManagementGroupPromise = (async () => {
      const { data, error } = await supabaseAdmin
        .from("dre_report_settings")
        .select("destino, is_active")
        .eq("tenant_id", effectiveTenantId)
        .maybeSingle();
      if (error) return { jid: null, failed: true };
      if (data?.is_active !== true) return { jid: null, failed: false };
      const candidate = safeRemoteJid(data.destino);
      return {
        jid: candidate.endsWith("@g.us") ? candidate : null,
        failed: false,
      };
    })();
    return activeManagementGroupPromise;
  };

  const validateCurrentInboxDestination = async (
    remoteJid: string,
  ): Promise<Response | null> => {
    if (remoteJid.endsWith("@s.whatsapp.net")) return null;
    if (!remoteJid.endsWith("@g.us")) {
      return json({
        error: "Destino da conversa não autorizado",
        code: "INBOX_DESTINATION_FORBIDDEN",
      }, 403);
    }

    const managementGroup = await loadActiveManagementGroup();
    if (managementGroup.failed) {
      console.error("[WA Proxy] Falha ao revalidar grupo de gestão");
      return json({
        error: "Não foi possível validar o grupo de gestão",
        code: "INBOX_GROUP_VALIDATION_FAILED",
      }, 503);
    }
    if (!isEvolutionInboxJidAllowed(remoteJid, managementGroup.jid)) {
      return json({
        error: "O grupo desta conversa não está mais ativo",
        code: "INBOX_GROUP_FORBIDDEN",
      }, 403);
    }
    return null;
  };

  const rpcAdmin = supabaseAdmin as unknown as TenantIntegrationRpcClient;

  if (action === "inbox/enable") {
    if (typeof payload.enabled !== "boolean") {
      return json({
        error: "Estado da inbox inv\u00e1lido",
        code: "INVALID_INBOX_STATE",
      }, 400);
    }

    if (payload.enabled) {
      const webhook = inboundWebhookUrl(getEnv);
      if (!webhook) {
        return json({
          error: "Configura\u00e7\u00e3o da inbox indispon\u00edvel",
          code: "INBOX_WEBHOOK_UNAVAILABLE",
        }, 503);
      }

      let integration: ResolvedEvolutionIntegration;
      try {
        integration = await resolveIntegration(
          rpcAdmin,
          effectiveTenantId,
          "webhook.configure",
          { getEnv },
        );
      } catch {
        console.error(
          "[WA Proxy] Broker recusou configura\u00e7\u00e3o do webhook",
        );
        return json({
          error: "Integra\u00e7\u00e3o indispon\u00edvel",
          code: "INTEGRATION_UNAVAILABLE",
        }, 503);
      }
      if (
        integration.integrationId !== instanceIntegrationId ||
        integration.version !== instanceIntegrationVersion
      ) {
        return json({
          error: "A instância precisa ser recriada após a troca da integração",
          code: "INTEGRATION_BINDING_STALE",
        }, 409);
      }

      let instanceWebhookToken: string;
      try {
        instanceWebhookToken = await deriveWhatsAppInboundInstanceTokenV3(
          webhook.token,
          effectiveTenantId,
          instanceName,
          integration.integrationId,
          integration.version,
        );
      } catch {
        return json({
          error: "Configura\u00e7\u00e3o da inbox indispon\u00edvel",
          code: "INBOX_WEBHOOK_UNAVAILABLE",
        }, 503);
      }

      const webhookController = new AbortController();
      const webhookTimeout = setTimeout(
        () => webhookController.abort(),
        20_000,
      );
      let webhookResponse: Response;
      try {
        webhookResponse = await fetchUpstream(
          `${integration.baseUrl}/webhook/set/${
            encodeURIComponent(instanceName)
          }`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              apikey: integration.apiKey,
            },
            body: JSON.stringify({
              webhook: {
                enabled: true,
                url: webhook.url,
                headers: {
                  "x-whatsapp-inbound-token": instanceWebhookToken,
                },
                byEvents: false,
                base64: false,
                events: inboxWebhookEvents,
              },
            }),
            redirect: "error",
            signal: webhookController.signal,
          },
        );
      } catch (error) {
        console.error("[WA Proxy] Falha ao configurar webhook da inbox", {
          code: error instanceof Error ? error.name : "network_error",
        });
        // O provedor pode ter aceitado o token v3 antes do timeout. O marker
        // continua antigo até existir 2xx, e o inbound aceita essa ponte v3
        // somente enquanto o binding exato da integração permanecer atual.
        return json({
          error:
            "N\u00e3o foi poss\u00edvel preparar a sincroniza\u00e7\u00e3o",
          code: "INBOX_WEBHOOK_CONFIG_FAILED",
        }, 502);
      } finally {
        clearTimeout(webhookTimeout);
      }
      if (!webhookResponse.ok) {
        console.error("[WA Proxy] Evolution recusou webhook da inbox", {
          status: webhookResponse.status,
        });
        return json({
          error:
            "N\u00e3o foi poss\u00edvel preparar a sincroniza\u00e7\u00e3o",
          code: "INBOX_WEBHOOK_CONFIG_FAILED",
        }, 502);
      }

      const authVersion = await rpcObject(
        rpcAdmin,
        "set_whatsapp_webhook_auth_version",
        {
          p_tenant_id: effectiveTenantId,
          p_instance_name: instanceName,
          p_version: 3,
          p_integration_id: integration.integrationId,
          p_integration_version: integration.version,
        },
      );
      if (
        !authVersion.data || authVersion.errorCode ||
        rpcBoolean(authVersion.data, "ok") !== true
      ) {
        console.error("[WA Proxy] Webhook seguro sem marker local", {
          code: authVersion.errorCode || "invalid_result",
        });
        return json({
          error:
            "N\u00e3o foi poss\u00edvel concluir a prote\u00e7\u00e3o do webhook",
          code: "INBOX_WEBHOOK_AUTH_MARKER_FAILED",
        }, 503);
      }
    }

    const enabled = await rpcObject(rpcAdmin, "enable_whatsapp_inbox", {
      p_tenant_id: effectiveTenantId,
      p_instance_name: instanceName,
      p_actor_id: userId,
      p_enabled: payload.enabled,
    });
    if (!enabled.data || enabled.errorCode) {
      console.error("[WA Proxy] Falha ao alterar inbox", {
        code: enabled.errorCode || "invalid_result",
      });
      return json({
        error: "N\u00e3o foi poss\u00edvel alterar a inbox",
        code: "INBOX_ENABLE_FAILED",
      }, 503);
    }
    return json({
      ok: true,
      instanceId: rpcString(enabled.data, "instanceId", "instance_id"),
      instanceName: rpcString(
        enabled.data,
        "instanceName",
        "instance_name",
      ) || instanceName,
      inboxEnabled: rpcBoolean(
        enabled.data,
        "inboxEnabled",
        "inbox_enabled",
      ) === true,
      inboxEnabledAt: rpcString(
        enabled.data,
        "inboxEnabledAt",
        "inbox_enabled_at",
      ) || null,
    });
  }

  if (action === "inbox/markRead" || action === "inbox/setHandoff") {
    const conversationId = limitedString(payload.conversationId, 80);
    if (!uuidPattern.test(conversationId)) {
      return json({
        error: "Conversa inv\u00e1lida",
        code: "INVALID_CONVERSATION",
      }, 400);
    }
    const validated = await findInboxConversation(conversationId);
    if (validated.failed) {
      return json({
        error: "N\u00e3o foi poss\u00edvel validar a conversa",
        code: "CONVERSATION_VALIDATION_FAILED",
      }, 503);
    }
    if (!validated.conversation) {
      return json({
        error: "Conversa n\u00e3o encontrada",
        code: "CONVERSATION_NOT_FOUND",
      }, 404);
    }

    if (action === "inbox/markRead") {
      const marked = await rpcObject(
        rpcAdmin,
        "mark_whatsapp_conversation_read",
        {
          p_tenant_id: effectiveTenantId,
          p_conversation_id: conversationId,
          p_actor_id: userId,
        },
      );
      if (!marked.data || marked.errorCode) {
        return json({
          error: "N\u00e3o foi poss\u00edvel marcar a conversa",
          code: "MARK_READ_FAILED",
        }, 503);
      }
      return json({
        ok: true,
        conversationId,
        lastReadAt: rpcString(marked.data, "lastReadAt", "last_read_at") ||
          null,
      });
    }

    if (typeof payload.active !== "boolean") {
      return json({
        error: "Estado do atendimento inv\u00e1lido",
        code: "INVALID_HANDOFF_STATE",
      }, 400);
    }
    const handoff = await rpcObject(
      rpcAdmin,
      "set_whatsapp_conversation_handoff",
      {
        p_tenant_id: effectiveTenantId,
        p_conversation_id: conversationId,
        p_actor_id: userId,
        p_active: payload.active,
      },
    );
    if (!handoff.data || handoff.errorCode) {
      return json({
        error: "N\u00e3o foi poss\u00edvel alterar o atendimento",
        code: "HANDOFF_UPDATE_FAILED",
      }, 503);
    }
    return json({
      ok: true,
      conversationId,
      handoffActive: rpcBoolean(
        handoff.data,
        "handoffActive",
        "handoff_active",
      ) === true,
      handoffUntil: rpcString(
        handoff.data,
        "handoffUntil",
        "handoff_until",
      ) || null,
    });
  }

  if (action === "inbox/sendText") {
    const conversationId = limitedString(payload.conversationId, 80);
    if (!uuidPattern.test(conversationId)) {
      return json({
        error: "Mensagem ou conversa inválida",
        code: "INVALID_INBOX_MESSAGE",
      }, 400);
    }
    const validated = await findInboxConversation(conversationId);
    if (validated.failed) {
      return json({
        error: "Não foi possível validar a conversa",
        code: "CONVERSATION_VALIDATION_FAILED",
      }, 503);
    }
    if (!validated.conversation) {
      return json({
        error: "Conversa não encontrada",
        code: "CONVERSATION_NOT_FOUND",
      }, 404);
    }
    const destinationError = await validateCurrentInboxDestination(
      validated.conversation.remoteJid,
    );
    if (destinationError) return destinationError;

    return await handleInboxSendText({
      admin: rpcAdmin,
      tenantId: effectiveTenantId,
      instanceName,
      integrationId: instanceIntegrationId,
      integrationVersion: instanceIntegrationVersion,
      actorId: userId,
      payload,
      getEnv,
      fetchUpstream,
      resolveIntegration,
    });
  }

  let relativeEndpoint = "";
  let method = "GET";
  let upstreamBody: string | undefined;
  let integrationPurpose: EvolutionIntegrationPurpose | undefined =
    purposeByAction[action];
  let inboxSyncMode: "chats" | "history" | null = null;
  let inboxSyncPage = 1;
  let inboxSyncRemoteJid = "";

  switch (action) {
    case "instance/create":
      relativeEndpoint = "/instance/create";
      method = "POST";
      upstreamBody = JSON.stringify({
        instanceName,
        qrcode: true,
        integration: "WHATSAPP-BAILEYS",
      });
      break;
    case "instance/connect":
      relativeEndpoint = `/instance/connect/${
        encodeURIComponent(instanceName)
      }`;
      break;
    case "instance/connectionState":
      relativeEndpoint = `/instance/connectionState/${
        encodeURIComponent(instanceName)
      }`;
      break;
    case "instance/logout":
      relativeEndpoint = `/instance/logout/${encodeURIComponent(instanceName)}`;
      method = "DELETE";
      break;
    case "instance/delete":
      relativeEndpoint = `/instance/delete/${encodeURIComponent(instanceName)}`;
      method = "DELETE";
      break;
    case "message/sendText": {
      const number = asString(payload.number).replace(/\D/g, "");
      const text = asString(payload.text).trim();
      if (!/^\d{10,15}$/.test(number) || !text || text.length > 4096) {
        return json({
          error: "Mensagem ou destinatário inválido",
          code: "INVALID_MESSAGE",
        }, 400);
      }
      relativeEndpoint = `/message/sendText/${
        encodeURIComponent(instanceName)
      }`;
      method = "POST";
      upstreamBody = JSON.stringify({
        number,
        text,
        delay: 1200,
        linkPreview: true,
      });
      break;
    }
    case "group/fetchAllGroups":
      relativeEndpoint = `/group/fetchAllGroups/${
        encodeURIComponent(instanceName)
      }?getParticipants=false`;
      break;
    case "inbox/sync": {
      method = "POST";
      const conversationId = limitedString(payload.conversationId, 80);
      if (
        payload.conversationId !== undefined &&
        !uuidPattern.test(conversationId)
      ) {
        return json({
          error: "Conversa inv\u00e1lida",
          code: "INVALID_CONVERSATION",
        }, 400);
      }
      if (conversationId) {
        const validated = await findInboxConversation(conversationId);
        if (validated.failed) {
          return json({
            error: "N\u00e3o foi poss\u00edvel validar a conversa",
            code: "CONVERSATION_VALIDATION_FAILED",
          }, 503);
        }
        if (!validated.conversation) {
          return json({
            error: "Conversa n\u00e3o encontrada",
            code: "CONVERSATION_NOT_FOUND",
          }, 404);
        }
        const destinationError = await validateCurrentInboxDestination(
          validated.conversation.remoteJid,
        );
        if (destinationError) return destinationError;
        inboxSyncMode = "history";
        inboxSyncPage = safePositiveInteger(payload.page, 1);
        inboxSyncRemoteJid = validated.conversation.remoteJid;
        integrationPurpose = "chat.history";
        relativeEndpoint = `/chat/findMessages/${
          encodeURIComponent(instanceName)
        }`;
        upstreamBody = JSON.stringify({
          where: { key: { remoteJid: validated.conversation.remoteJid } },
          page: inboxSyncPage,
          offset: 100,
        });
      } else {
        inboxSyncMode = "chats";
        integrationPurpose = "chat.list";
        relativeEndpoint = `/chat/findChats/${
          encodeURIComponent(instanceName)
        }`;
        upstreamBody = JSON.stringify({ take: 100, skip: 0 });
      }
      break;
    }
  }

  if (!integrationPurpose) {
    return json(
      {
        error: "Opera\u00e7\u00e3o n\u00e3o permitida",
        code: "ACTION_FORBIDDEN",
      },
      400,
    );
  }

  let integration: ResolvedEvolutionIntegration;
  try {
    integration = await resolveIntegration(
      supabaseAdmin as unknown as TenantIntegrationRpcClient,
      effectiveTenantId,
      integrationPurpose,
      { getEnv },
    );
  } catch {
    console.error("[WA Proxy] Broker recusou a integração", { action });
    return json({
      error: "Integração indisponível",
      code: "INTEGRATION_UNAVAILABLE",
    }, 503);
  }
  if (
    action !== "instance/create" &&
    (integration.integrationId !== instanceIntegrationId ||
      integration.version !== instanceIntegrationVersion)
  ) {
    return json({
      error: "A instância precisa ser recriada após a troca da integração",
      code: "INTEGRATION_BINDING_STALE",
    }, 409);
  }
  const endpoint = `${integration.baseUrl}${relativeEndpoint}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  let response: Response;
  try {
    response = await fetchUpstream(endpoint, {
      method,
      headers: {
        "Content-Type": "application/json",
        apikey: integration.apiKey,
      },
      body: upstreamBody,
      redirect: "error",
      signal: controller.signal,
    });
  } catch (error) {
    console.error(
      "[WA Proxy] Falha de rede na operação",
      action,
      error instanceof Error ? error.name : "unknown",
    );
    return json({
      error: "Falha ao acessar o provedor",
      code: "UPSTREAM_UNAVAILABLE",
    }, 502);
  } finally {
    clearTimeout(timeout);
  }

  const data = await readUpstreamJson(response);
  if (!response.ok) {
    console.error(
      "[WA Proxy] Provedor rejeitou operação",
      action,
      response.status,
    );
    const status = response.status === 404
      ? 404
      : response.status === 409
      ? 409
      : 502;
    const code = response.status === 404
      ? "INSTANCE_NOT_FOUND"
      : "UPSTREAM_REJECTED";
    return json({
      error: response.status === 404
        ? "Instância não encontrada"
        : "Operação recusada pelo provedor",
      code,
    }, status);
  }

  console.log(
    "[WA Proxy] Operação autorizada",
    action,
    effectiveTenantId,
    userId,
    integration.integrationId,
    integration.version,
    integration.mode,
  );

  switch (action) {
    case "instance/create": {
      const instance = nestedObject(data, "instance");
      const instanceId = asString(instance.instanceId) || instanceName;
      const state = asString(instance.status) || asString(instance.state) ||
        "created";

      const instanceRecord = {
        tenant_id: effectiveTenantId,
        user_id: ownerUserId,
        instance_name: instanceName,
        instance_id: instanceId,
        status: state,
        api_key: null,
        integration_id: integration.integrationId,
        integration_version: integration.version,
        webhook_auth_version: 1,
        updated_at: new Date().toISOString(),
      };
      const persistence = instanceRowId
        ? await supabaseAdmin.from("whatsapp_instances").update(instanceRecord)
          .eq("id", instanceRowId)
          .eq("tenant_id", effectiveTenantId)
        : await supabaseAdmin.from("whatsapp_instances").insert(instanceRecord);
      if (persistence.error) {
        console.error(
          "[WA Proxy] Falha ao persistir vínculo",
          persistence.error.code || "persist_error",
        );
        return json({
          error: "Falha ao registrar a instância",
          code: "OWNERSHIP_PERSIST_FAILED",
        }, 500);
      }

      return json({ ok: true, instanceName, instanceId, state });
    }
    case "instance/connect": {
      const root = isObject(data) ? data : {};
      const qrcodeObject = nestedObject(data, "qrcode");
      const qrcode = asString(root.base64) || asString(qrcodeObject.base64);
      return json({ ok: true, state: upstreamState(data), qrcode });
    }
    case "instance/connectionState": {
      const state = upstreamState(data);
      const statePersistence = await supabaseAdmin
        .from("whatsapp_instances")
        .update({ status: state, updated_at: new Date().toISOString() })
        .eq("id", instanceRowId)
        .eq("tenant_id", effectiveTenantId);
      if (statePersistence.error) {
        console.error(
          "[WA Proxy] Falha ao atualizar status local",
          statePersistence.error.code || "status_persist_error",
        );
      }
      return json({ ok: true, state });
    }
    case "instance/logout":
      await supabaseAdmin
        .from("whatsapp_instances")
        .update({
          status: "disconnected",
          updated_at: new Date().toISOString(),
        })
        .eq("tenant_id", effectiveTenantId)
        .eq("user_id", ownerUserId)
        .eq("instance_name", instanceName);
      return json({ ok: true });
    case "instance/delete": {
      const { error: rowsError } = await supabaseAdmin
        .from("whatsapp_instances")
        .delete()
        .eq("tenant_id", effectiveTenantId)
        .eq("user_id", ownerUserId)
        .eq("instance_name", instanceName);
      if (rowsError) {
        console.error(
          "[WA Proxy] Instância removida, mas limpeza local falhou",
          rowsError.code || "cleanup_error",
        );
      }
      return json({ ok: true });
    }
    case "message/sendText": {
      const root = isObject(data) ? data : {};
      const key = nestedObject(data, "key");
      const messageId = asString(key.id) || asString(root.id);
      return json({ ok: true, messageId: messageId.slice(0, 160) });
    }
    case "group/fetchAllGroups":
      return json({ ok: true, groups: upstreamGroups(data) });
    case "inbox/sync": {
      let managementGroupJid: string | null = null;
      if (inboxSyncMode === "chats") {
        const managementGroup = await loadActiveManagementGroup();
        if (managementGroup.failed) {
          // Falha fechada para grupos: contatos diretos ainda podem ser importados.
          console.error("[WA Proxy] Falha ao validar grupo de gestão");
        } else managementGroupJid = managementGroup.jid;
      }

      const candidates = inboxSyncMode === "history"
        ? evolutionMessageItems(data)
        : evolutionArrays(data, "chats", "data", "records").flatMap(
          (candidate) => {
            const chat = parseObject(candidate);
            if (!chat) return [];
            const lastMessage = parseObject(
              chat.lastMessage || chat.last_message,
            );
            if (!lastMessage) return [];

            const key = parseObject(lastMessage.key) || {};
            const chatRemoteJid = safeRemoteJid(
              chat.remoteJid || chat.remote_jid || key.remoteJid,
            );
            if (!chatRemoteJid) return [];
            return [{
              ...lastMessage,
              key: { ...key, remoteJid: key.remoteJid || chatRemoteJid },
              pushName: lastMessage.pushName || chat.pushName || chat.name ||
                chat.subject,
            }];
          },
        );

      let ignored = 0;
      const messages = candidates.flatMap((candidate) => {
        const parsed = parseEvolutionMessage(candidate);
        if (!parsed) {
          ignored += 1;
          return [];
        }
        const allowed = inboxSyncMode === "history"
          ? parsed.remoteJid === inboxSyncRemoteJid
          : isEvolutionInboxJidAllowed(
            parsed.remoteJid,
            managementGroupJid,
          );
        if (!allowed) {
          ignored += 1;
          return [];
        }
        return [parsed];
      });

      let persisted: { stored: number; duplicates: number };
      try {
        persisted = await persistProviderMessages(
          rpcAdmin,
          effectiveTenantId,
          instanceName,
          messages,
        );
      } catch {
        console.error("[WA Proxy] Falha ao persistir sincronização da inbox");
        return json({
          error: "Não foi possível salvar a sincronização",
          code: "INBOX_SYNC_PERSIST_FAILED",
        }, 503);
      }

      if (inboxSyncMode === "history") {
        const root = isObject(data) ? data : {};
        const messagePage = parseObject(root.messages) || {};
        return json({
          ok: true,
          mode: "history",
          page: safePositiveInteger(messagePage.currentPage, inboxSyncPage),
          pages: safePositiveInteger(messagePage.pages, inboxSyncPage),
          total: Math.max(0, Number(messagePage.total) || 0),
          received: candidates.length,
          stored: persisted.stored,
          duplicates: persisted.duplicates,
          ignored,
        });
      }

      return json({
        ok: true,
        mode: "chats",
        received: candidates.length,
        stored: persisted.stored,
        duplicates: persisted.duplicates,
        ignored,
      });
    }
    default:
      return json(
        { error: "Operação não permitida", code: "ACTION_FORBIDDEN" },
        400,
      );
  }
}

if (import.meta.main) {
  serve((req) => handleRequest(req));
}
