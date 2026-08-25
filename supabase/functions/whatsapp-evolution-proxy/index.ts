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
]);

const allowedRoles = ["SUPER_ADMIN", "SCHOOL_ADMIN", "TEACHER"] as const;
const instanceManagementActions = new Set([
  "instance/create",
  "instance/connect",
  "instance/logout",
  "instance/delete",
]);
const operationalTenantStatuses = new Set(["active", "trial", "trialing"]);
const instanceNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{2,79}$/;
const purposeByAction: Record<string, EvolutionIntegrationPurpose> = {
  "instance/create": "instance.create",
  "instance/connect": "instance.connect",
  "instance/connectionState": "instance.connection_state",
  "instance/logout": "instance.logout",
  "instance/delete": "instance.delete",
  "message/sendText": "message.send_text",
  "group/fetchAllGroups": "group.list",
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
    } | null
  > => {
    let query = supabaseAdmin
      .from("whatsapp_instances")
      .select("id, user_id")
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
    return data?.id && data?.user_id
      ? { id: String(data.id), user_id: String(data.user_id) }
      : null;
  };

  let ownerUserId = userId;
  let instanceRowId = "";
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
  }

  let relativeEndpoint = "";
  let method = "GET";
  let upstreamBody: string | undefined;

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
  }

  let integration: ResolvedEvolutionIntegration;
  try {
    integration = await resolveIntegration(
      supabaseAdmin as unknown as TenantIntegrationRpcClient,
      effectiveTenantId,
      purposeByAction[action],
      { getEnv },
    );
  } catch {
    console.error("[WA Proxy] Broker recusou a integração", { action });
    return json({
      error: "Integração indisponível",
      code: "INTEGRATION_UNAVAILABLE",
    }, 503);
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
