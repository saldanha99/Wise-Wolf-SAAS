/// <reference lib="deno.ns" />

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  authorizeRequest,
  hasTenantAccess,
  methodNotAllowed,
} from "../_shared/request-auth.ts";
import {
  secureInitialPassword,
  sendAccountActivation,
} from "../_shared/account-invite.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return methodNotAllowed(corsHeaders);

  const auth = await authorizeRequest(req, {
    corsHeaders,
    allowedRoles: ["SCHOOL_ADMIN", "SUPER_ADMIN"],
  });
  if (auth.ok === false) return auth.response;

  try {
    const body = await req.json();
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const email = typeof body.email === "string"
      ? body.email.trim().toLowerCase()
      : "";
    const tenantId = typeof body.tenantId === "string"
      ? body.tenantId.trim()
      : "";
    const professorId =
      typeof body.professorId === "string" && body.professorId.trim()
        ? body.professorId.trim()
        : null;
    const monthlyFee = body.monthlyFee === undefined || body.monthlyFee === ""
      ? 0
      : Number(body.monthlyFee);
    const dueDay = body.dueDay === undefined || body.dueDay === ""
      ? 10
      : Number(body.dueDay);

    if (!email || !name || !tenantId) {
      return json({ error: "Name, Email and Tenant ID are required" }, 400);
    }
    if (!Number.isFinite(monthlyFee) || monthlyFee < 0) {
      return json({ error: "Monthly fee is invalid" }, 400);
    }
    if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) {
      return json({ error: "Due day must be between 1 and 31" }, 400);
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
      console.error("Student account tenant lookup failed", {
        code: tenantError.code,
      });
      return json({ error: "Could not validate tenant" }, 500);
    }
    if (!tenant) return json({ error: "Tenant not found" }, 404);

    // Retry seguro: se a primeira resposta se perder depois do commit, a tela
    // pode repetir a operação sem criar outro usuário ou trocar sua própria
    // sessão. O vínculo existente só é reutilizado dentro da mesma escola e
    // quando continua sendo uma conta de aluno.
    const { data: existingProfile, error: existingProfileError } = await admin
      .from("profiles")
      .select("id, role, tenant_id, email, lifecycle_status")
      .eq("tenant_id", tenantId)
      .eq("email", email)
      .maybeSingle();
    if (existingProfileError) {
      console.error("Student account idempotency lookup failed", {
        code: existingProfileError.code,
      });
      return json({ error: "Could not validate an existing account" }, 500);
    }
    if (existingProfile) {
      if (existingProfile.role !== "STUDENT") {
        return json({ error: "Email is already used by another role" }, 409);
      }
      if (
        String(existingProfile.lifecycle_status ?? "").trim().toLowerCase() !==
          "active"
      ) {
        return json({
          error:
            "Student account is inactive and must be explicitly reactivated",
        }, 409);
      }
      return json({
        user: { id: existingProfile.id, email: existingProfile.email },
        created: false,
        activationSent: false,
        message: "Student account already exists in this tenant",
      });
    }

    if (professorId) {
      const { data: professor, error: professorError } = await admin
        .from("profiles")
        .select("id, role, tenant_id")
        .eq("id", professorId)
        .maybeSingle();
      if (professorError) {
        console.error("Student account professor lookup failed", {
          code: professorError.code,
        });
        return json({ error: "Could not validate professor" }, 500);
      }
      if (
        !professor || professor.role !== "TEACHER" ||
        professor.tenant_id !== tenantId
      ) {
        return json({
          error: "Professor must be a teacher from the same tenant",
        }, 400);
      }
    }

    const { data: authData, error: authError } = await admin.auth.admin
      .createUser({
        email,
        password: secureInitialPassword(),
        email_confirm: true,
        user_metadata: {
          full_name: name,
          role: "STUDENT",
          tenant_id: tenantId,
        },
      });
    if (authError || !authData.user) {
      return json(
        { error: authError?.message || "Failed to create user" },
        400,
      );
    }

    const userId = authData.user.id;
    const { error: profileError } = await admin.from("profiles").upsert({
      id: userId,
      full_name: name,
      email,
      role: "STUDENT",
      tenant_id: tenantId,
      professor_id: professorId,
      phone: typeof body.phone === "string" ? body.phone.trim() : null,
      monthly_fee: monthlyFee,
      due_day: dueDay,
      // Nunca anuncie uma cobrança como ativa antes de o provedor confirmar a
      // assinatura. A tela promove para ACTIVE somente após receber o ID Asaas.
      status_financial: monthlyFee > 0 ? "PENDING" : "ACTIVE",
      created_at: new Date().toISOString(),
    });

    if (profileError) {
      console.error("Student profile creation failed", {
        code: profileError.code,
      });
      await admin.auth.admin.deleteUser(userId).catch(() => undefined);
      if (profileError.message?.includes("tenant_student_limit_reached")) {
        return json({
          error:
            "O limite de alunos do plano foi atingido. Faça upgrade para adicionar novas matrículas.",
          code: "STUDENT_LIMIT_REACHED",
        }, 409);
      }
      return json({ error: "Failed to create profile" }, 500);
    }

    try {
      await sendAccountActivation(admin, {
        email,
        name,
        accountLabel: "aluno",
      });
    } catch (activationError) {
      console.error("Student activation delivery failed", {
        message: activationError instanceof Error
          ? activationError.message
          : "unknown error",
      });
      const { error: cleanupProfileError } = await admin.from("profiles")
        .delete()
        .eq("id", userId);
      if (cleanupProfileError) {
        console.error("Student activation cleanup failed", {
          code: cleanupProfileError.code,
        });
      }
      await admin.auth.admin.deleteUser(userId).catch(() => undefined);
      return json(
        { error: "Could not deliver the secure activation email" },
        502,
      );
    }

    return json({
      user: authData.user,
      created: true,
      activationSent: true,
      message: "Student account created and activation email sent",
    });
  } catch (error) {
    console.error("Create student account failed", {
      message: error instanceof Error ? error.message : "unknown error",
    });
    return json({ error: "Invalid request" }, 400);
  }
});
