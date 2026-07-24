import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

const allowedRoles = new Set(["SUPER_ADMIN", "SCHOOL_ADMIN", "TEACHER"]);
const instanceNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{2,79}$/;

type JsonObject = Record<string, unknown>;

type ProxyDependencies = {
  getEnv?: (name: string) => string | undefined;
  createSupabaseClient?: (
    url: string,
    anonKey: string,
    options: unknown,
  ) => any;
  fetchUpstream?: typeof fetch;
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
  const createSupabaseClient = dependencies.createSupabaseClient ||
    ((url, anonKey, options) =>
      createClient(
        url,
        anonKey,
        options as Parameters<typeof createClient>[2],
      ));
  const fetchUpstream = dependencies.fetchUpstream || fetch;

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

  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : "";
  if (!token) {
    return json({ error: "Não autenticado", code: "UNAUTHENTICATED" }, 401);
  }

  const supabaseUrl = getEnv("SUPABASE_URL") || "";
  const supabaseAnonKey = getEnv("SUPABASE_ANON_KEY") || "";
  const supabaseServiceRoleKey = getEnv("SUPABASE_SERVICE_ROLE_KEY") || "";
  const evolutionApiUrl = (getEnv("EVOLUTION_API_URL") || "").replace(
    /\/+$/,
    "",
  );
  const evolutionApiKey = getEnv("EVOLUTION_API_KEY") || "";

  if (
    !supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey ||
    !evolutionApiUrl || !evolutionApiKey
  ) {
    console.error("[WA Proxy] Configuração server-side incompleta");
    return json({
      error: "Integração indisponível",
      code: "INTEGRATION_UNAVAILABLE",
    }, 503);
  }

  const supabase = createSupabaseClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const supabaseAdmin = createSupabaseClient(
    supabaseUrl,
    supabaseServiceRoleKey,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const { data: authData, error: authError } = await supabase.auth.getUser(
    token,
  );
  const user = authData.user;
  if (authError || !user) {
    return json({ error: "Sessão inválida", code: "UNAUTHENTICATED" }, 401);
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("id, role, tenant_id, whatsapp_instance")
    .eq("id", user.id)
    .single();

  if (profileError || !profile) {
    console.error(
      "[WA Proxy] Perfil do chamador indisponível",
      profileError?.code || "not_found",
    );
    return json({
      error: "Perfil não autorizado",
      code: "PROFILE_NOT_AUTHORIZED",
    }, 403);
  }

  if (!allowedRoles.has(String(profile.role || ""))) {
    return json({
      error: "Papel sem permissão para WhatsApp",
      code: "ROLE_FORBIDDEN",
    }, 403);
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

  const callerTenantId = asString(profile.tenant_id).trim();
  if (
    !callerTenantId || !requestedTenantId ||
    requestedTenantId !== callerTenantId
  ) {
    return json(
      { error: "Tenant não autorizado", code: "TENANT_FORBIDDEN" },
      403,
    );
  }

  let instanceName = asString(requestBody.instanceName).trim();
  if (instanceName === "default") {
    instanceName = asString(profile.whatsapp_instance).trim();
  }
  if (!instanceNamePattern.test(instanceName)) {
    return json({ error: "Instância inválida", code: "INVALID_INSTANCE" }, 400);
  }

  const findInstanceOwner = async (): Promise<{ id: string } | null> => {
    let query = supabaseAdmin
      .from("profiles")
      .select("id")
      .eq("tenant_id", callerTenantId)
      .eq("whatsapp_instance", instanceName)
      .limit(1);

    if (String(profile.role) === "TEACHER") {
      query = query.eq("id", user.id);
    }

    const { data, error } = await query.maybeSingle();
    if (error) {
      console.error(
        "[WA Proxy] Falha ao validar posse da instância",
        error.code || "query_error",
      );
      return null;
    }
    return data?.id ? { id: String(data.id) } : null;
  };

  let ownerUserId = user.id;
  if (action === "instance/create") {
    const recreate = payload.recreate === true;
    const requestedOwnerId = asString(payload.ownerUserId).trim() || user.id;
    const mayManageTenant = ["SCHOOL_ADMIN", "SUPER_ADMIN"].includes(
      String(profile.role),
    );

    if (requestedOwnerId !== user.id && !mayManageTenant) {
      return json({
        error: "Responsável fora do seu escopo",
        code: "OWNER_FORBIDDEN",
      }, 403);
    }

    const { data: ownerProfile, error: ownerError } = await supabaseAdmin
      .from("profiles")
      .select("id, whatsapp_instance")
      .eq("id", requestedOwnerId)
      .eq("tenant_id", callerTenantId)
      .maybeSingle();

    if (ownerError || !ownerProfile) {
      return json({
        error: "Responsável fora do seu tenant",
        code: "OWNER_FORBIDDEN",
      }, 403);
    }
    ownerUserId = String(ownerProfile.id);

    const owned =
      asString(ownerProfile.whatsapp_instance).trim() === instanceName;

    if (recreate && !owned) {
      return json({
        error: "Instância fora do seu escopo",
        code: "INSTANCE_FORBIDDEN",
      }, 403);
    }

    if (!recreate) {
      const existingName = asString(ownerProfile.whatsapp_instance).trim();

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
    }
  } else {
    const owner = await findInstanceOwner();
    if (!owner) {
      return json({
        error: "Instância fora do seu escopo",
        code: "INSTANCE_FORBIDDEN",
      }, 403);
    }
    ownerUserId = owner.id;
  }

  let endpoint = "";
  let method = "GET";
  let upstreamBody: string | undefined;

  switch (action) {
    case "instance/create":
      endpoint = `${evolutionApiUrl}/instance/create`;
      method = "POST";
      upstreamBody = JSON.stringify({
        instanceName,
        qrcode: true,
        integration: "WHATSAPP-BAILEYS",
      });
      break;
    case "instance/connect":
      endpoint = `${evolutionApiUrl}/instance/connect/${
        encodeURIComponent(instanceName)
      }`;
      break;
    case "instance/connectionState":
      endpoint = `${evolutionApiUrl}/instance/connectionState/${
        encodeURIComponent(instanceName)
      }`;
      break;
    case "instance/logout":
      endpoint = `${evolutionApiUrl}/instance/logout/${
        encodeURIComponent(instanceName)
      }`;
      method = "DELETE";
      break;
    case "instance/delete":
      endpoint = `${evolutionApiUrl}/instance/delete/${
        encodeURIComponent(instanceName)
      }`;
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
      endpoint = `${evolutionApiUrl}/message/sendText/${
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
      endpoint = `${evolutionApiUrl}/group/fetchAllGroups/${
        encodeURIComponent(instanceName)
      }?getParticipants=false`;
      break;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  let response: Response;
  try {
    response = await fetchUpstream(endpoint, {
      method,
      headers: {
        "Content-Type": "application/json",
        apikey: evolutionApiKey,
      },
      body: upstreamBody,
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
    callerTenantId,
    user.id,
  );

  switch (action) {
    case "instance/create": {
      const instance = nestedObject(data, "instance");
      const instanceId = asString(instance.instanceId) || instanceName;
      const state = asString(instance.status) || asString(instance.state) ||
        "created";

      const { error: profileUpdateError } = await supabaseAdmin
        .from("profiles")
        .update({ whatsapp_instance: instanceName })
        .eq("id", ownerUserId)
        .eq("tenant_id", callerTenantId);
      if (profileUpdateError) {
        console.error(
          "[WA Proxy] Instância criada, mas vínculo falhou",
          profileUpdateError.code || "update_error",
        );
        return json({
          error: "Falha ao vincular a instância",
          code: "OWNERSHIP_PERSIST_FAILED",
        }, 500);
      }

      const { data: existingRow, error: lookupError } = await supabaseAdmin
        .from("whatsapp_instances")
        .select("id")
        .eq("user_id", ownerUserId)
        .limit(1)
        .maybeSingle();
      if (lookupError) {
        console.error(
          "[WA Proxy] Falha ao localizar vínculo",
          lookupError.code || "lookup_error",
        );
        return json({
          error: "Falha ao registrar a instância",
          code: "OWNERSHIP_PERSIST_FAILED",
        }, 500);
      }

      const instanceRecord = {
        user_id: ownerUserId,
        instance_name: instanceName,
        instance_id: instanceId,
        status: state,
        api_key: null,
        updated_at: new Date().toISOString(),
      };
      const persistence = existingRow?.id
        ? await supabaseAdmin.from("whatsapp_instances").update(instanceRecord)
          .eq("id", existingRow.id)
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
      const { data: stateRow } = await supabaseAdmin
        .from("whatsapp_instances")
        .select("id")
        .eq("user_id", ownerUserId)
        .eq("instance_name", instanceName)
        .limit(1)
        .maybeSingle();
      const stateRecord = {
        user_id: ownerUserId,
        instance_name: instanceName,
        instance_id: instanceName,
        status: state,
        api_key: null,
        updated_at: new Date().toISOString(),
      };
      const statePersistence = stateRow?.id
        ? await supabaseAdmin
          .from("whatsapp_instances")
          .update(stateRecord)
          .eq("id", stateRow.id)
        : await supabaseAdmin.from("whatsapp_instances").insert(stateRecord);
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
        .eq("user_id", ownerUserId)
        .eq("instance_name", instanceName);
      return json({ ok: true });
    case "instance/delete": {
      const { error: rowsError } = await supabaseAdmin
        .from("whatsapp_instances")
        .delete()
        .eq("user_id", ownerUserId)
        .eq("instance_name", instanceName);
      const { error: profileUpdateError } = await supabaseAdmin
        .from("profiles")
        .update({ whatsapp_instance: null, whatsapp_token: null })
        .eq("id", ownerUserId)
        .eq("whatsapp_instance", instanceName);
      if (rowsError || profileUpdateError) {
        console.error(
          "[WA Proxy] Instância removida, mas limpeza local falhou",
          rowsError?.code || profileUpdateError?.code || "cleanup_error",
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
