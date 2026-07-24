import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  authorizeRequest,
  hasTenantAccess,
  methodNotAllowed,
} from "../_shared/request-auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const TARGET_ROLES = [
  "SUPER_ADMIN",
  "SCHOOL_ADMIN",
  "COORDINATOR",
  "TEACHER",
  "STUDENT",
  "SALESPERSON",
] as const;
const SCHOOL_ADMIN_TARGET_ROLES = [
  "COORDINATOR",
  "TEACHER",
  "STUDENT",
  "SALESPERSON",
] as const;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return methodNotAllowed(corsHeaders);

  const auth = await authorizeRequest(req, {
    corsHeaders,
    allowedRoles: ["SCHOOL_ADMIN", "SUPER_ADMIN"],
  });
  if (!auth.ok) return auth.response;

  try {
    const body = await req.json();
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const role = typeof body.role === "string" ? body.role.trim().toUpperCase() : "";
    const tenantId = typeof body.tenantId === "string" ? body.tenantId.trim() : "";

    if (!email || !password || !name || !role || !tenantId) {
      return json({ error: "Dados incompletos para registro." }, 400);
    }
    if (!(TARGET_ROLES as readonly string[]).includes(role)) {
      return json({ error: "Papel de usuário inválido." }, 400);
    }

    const caller = auth.context.profile!;
    if (
      caller.role === "SCHOOL_ADMIN" &&
      !(SCHOOL_ADMIN_TARGET_ROLES as readonly string[]).includes(role)
    ) {
      return json({ error: "Um administrador escolar não pode atribuir esse papel." }, 403);
    }
    if (!hasTenantAccess(auth.context, tenantId)) {
      return json({ error: "Não é permitido registrar usuário em outro tenant." }, 403);
    }

    const admin = auth.context.admin;
    const { data: tenant, error: tenantError } = await admin
      .from("tenants")
      .select("id")
      .eq("id", tenantId)
      .maybeSingle();
    if (tenantError) {
      console.error("Register user tenant lookup failed", { code: tenantError.code });
      return json({ error: "Não foi possível validar o tenant." }, 500);
    }
    if (!tenant) return json({ error: "Tenant não encontrado." }, 404);

    const { data: authData, error: authError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: name, role, tenant_id: tenantId },
    });
    if (authError || !authData.user) {
      return json({ error: authError?.message || "Falha ao criar usuário." }, 400);
    }

    const userId = authData.user.id;
    const safeMetadata: Record<string, string> = {};
    if (
      body.metadata && typeof body.metadata === "object" &&
      typeof body.metadata.department === "string" && body.metadata.department.trim()
    ) {
      safeMetadata.department = body.metadata.department.trim();
    }
    const avatarUrl = typeof body.avatar === "string" && body.avatar.trim()
      ? body.avatar.trim()
      : `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=random`;

    const { error: profileError } = await admin.from("profiles").upsert({
      id: userId,
      email,
      full_name: name,
      role,
      tenant_id: tenantId,
      phone: typeof body.phone === "string" ? body.phone.trim() : null,
      status: "Ativo",
      avatar_url: avatarUrl,
      status_financial: "ACTIVE",
      created_at: new Date().toISOString(),
      ...safeMetadata,
    });

    if (profileError) {
      console.error("Register user profile creation failed", { code: profileError.code });
      await admin.auth.admin.deleteUser(userId).catch(() => undefined);
      return json({ error: "Conta não pôde ser configurada." }, 500);
    }

    return json({
      success: true,
      userId,
      message: "Cadastro realizado com sucesso!",
    });
  } catch (error) {
    console.error("Register user failed", {
      message: error instanceof Error ? error.message : "unknown error",
    });
    return json({ error: "Requisição inválida." }, 400);
  }
});
