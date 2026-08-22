/// <reference lib="deno.ns" />

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  authorizeRequest,
  hasTenantAccess,
  methodNotAllowed,
} from "../_shared/request-auth.ts";
import { secureInitialPassword, sendAccountActivation } from "../_shared/account-invite.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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
  if (auth.ok === false) return auth.response;

  try {
    const body = await req.json();
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const tenantId = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
    const hourlyRate = body.hourlyRate === undefined || body.hourlyRate === ""
      ? 0
      : Number(body.hourlyRate);

    if (!email || !name || !tenantId) {
      return json({ error: "Name, Email and Tenant ID are required" }, 400);
    }
    if (!Number.isFinite(hourlyRate) || hourlyRate < 0) {
      return json({ error: "Hourly rate is invalid" }, 400);
    }
    if (!hasTenantAccess(auth.context, tenantId)) {
      return json({ error: "Cannot create an account in another tenant" }, 403);
    }

    const admin = auth.context.admin;
    const { data: tenant, error: tenantError } = await admin
      .from("tenants")
      .select("id")
      .eq("id", tenantId)
      .maybeSingle();
    if (tenantError) {
      console.error("Teacher account tenant lookup failed", { code: tenantError.code });
      return json({ error: "Could not validate tenant" }, 500);
    }
    if (!tenant) return json({ error: "Tenant not found" }, 404);

    const { data: authData, error: authError } = await admin.auth.admin.createUser({
      email,
      password: secureInitialPassword(),
      email_confirm: true,
      user_metadata: { full_name: name, role: "TEACHER", tenant_id: tenantId },
    });
    if (authError || !authData.user) {
      return json({ error: authError?.message || "Failed to create user" }, 400);
    }

    const userId = authData.user.id;
    const { error: profileError } = await admin.from("profiles").upsert({
      id: userId,
      full_name: name,
      email,
      role: "TEACHER",
      tenant_id: tenantId,
      phone: typeof body.phone === "string" ? body.phone.trim() : null,
      status_financial: "ACTIVE",
      created_at: new Date().toISOString(),
    });

    if (profileError) {
      console.error("Teacher profile creation failed", { code: profileError.code });
      await admin.auth.admin.deleteUser(userId).catch(() => undefined);
      if (profileError.message?.includes("tenant_teacher_limit_reached")) {
        return json({
          error: "O limite de professores do plano foi atingido. Faça upgrade para adicionar novos profissionais.",
          code: "TEACHER_LIMIT_REACHED",
        }, 409);
      }
      return json({ error: "Failed to create profile" }, 500);
    }

    const teacherDetails = {
      id: userId,
      hourly_rate: hourlyRate,
      pix_key: typeof body.pixKey === "string" ? body.pixKey.trim() : null,
      meeting_link: typeof body.zoomLink === "string" ? body.zoomLink.trim() : null,
      whatsapp_id: typeof body.whatsappId === "string" ? body.whatsappId.trim() : null,
    };
    const { error: teacherError } = await admin.from("teachers").upsert(teacherDetails);
    if (teacherError) {
      console.warn("Teacher details table update skipped", { code: teacherError.code });
    }

    const { error: extraError } = await admin.from("profiles").update({
      hourly_rate: hourlyRate,
      pix_key: teacherDetails.pix_key,
      meeting_link: teacherDetails.meeting_link,
      contract_url: typeof body.contractUrl === "string" && body.contractUrl.trim()
        ? body.contractUrl.trim()
        : null,
    }).eq("id", userId);
    if (extraError) {
      console.warn("Teacher extra profile fields update failed", { code: extraError.code });
    }

    try {
      await sendAccountActivation(admin, {
        email,
        name,
        accountLabel: "professor",
      });
    } catch (activationError) {
      console.error("Teacher activation delivery failed", {
        message: activationError instanceof Error ? activationError.message : "unknown error",
      });
      await admin.auth.admin.deleteUser(userId).catch(() => undefined);
      return json({ error: "Could not deliver the secure activation email" }, 502);
    }

    return json({
      user: authData.user,
      message: "Teacher account created and activation email sent",
    });
  } catch (error) {
    console.error("Create teacher account failed", {
      message: error instanceof Error ? error.message : "unknown error",
    });
    return json({ error: "Invalid request" }, 400);
  }
});
