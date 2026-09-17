/// <reference lib="deno.ns" />

// Ativação de um lead "Professor Negócio" (SUPER_ADMIN): cria o tenant em trial
// pela RPC `convert_teacher_lead_to_tenant`, garante a conta do dono
// (SCHOOL_ADMIN do tenant novo) e manda o e-mail de ativação — o MESMO
// `sendAccountActivation` que professor e aluno já recebem.
//
// Antes disto o painel inseria o tenant pelo navegador e mostrava um link
// `/teacher-onboarding?tenant=…` que a tela recusa. Cada etapa aqui é
// idempotente, então clicar de novo depois de uma falha só completa o que falta.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { authorizeRequest, methodNotAllowed } from "../_shared/request-auth.ts";
import {
  secureInitialPassword,
  sendAccountActivation,
} from "../_shared/account-invite.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const ERROR_MESSAGES: Record<string, string> = {
  lead_nao_encontrado: "Lead não encontrado.",
  lead_nao_e_de_professor: "Este lead não é de Professor Negócio.",
  lead_sem_email: "O lead não tem e-mail válido — corrija antes de ativar.",
  slug_invalido:
    "Identificador inválido: use só letras minúsculas, números e hífen (3–50 caracteres).",
  slug_reservado: "Este identificador é reservado pela plataforma.",
  slug_em_uso: "Já existe um ambiente com este identificador.",
  nome_invalido: "Informe o nome do ambiente (2–160 caracteres).",
  trial_invalido: "O período de teste precisa ficar entre 0 e 90 dias.",
  plano_inativo: "Plano inativo ou inexistente.",
  plano_nao_e_de_professor:
    "Escolha um plano de professor (Teacher Starter/Growth/Scale).",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return methodNotAllowed(corsHeaders);

  const auth = await authorizeRequest(req, {
    corsHeaders,
    allowedRoles: ["SUPER_ADMIN"],
  });
  if (auth.ok === false) return auth.response;

  try {
    const body = await req.json() as Record<string, unknown>;
    const leadId = typeof body.leadId === "string" ? body.leadId.trim() : "";
    const planId = typeof body.planId === "string" ? body.planId.trim() : "";
    const slug = typeof body.slug === "string"
      ? body.slug.trim().toLowerCase()
      : "";
    const schoolName = typeof body.schoolName === "string"
      ? body.schoolName.trim()
      : "";
    const ownerEmailOverride = typeof body.ownerEmail === "string"
      ? body.ownerEmail.trim().toLowerCase()
      : "";
    const trialDays = body.trialDays === undefined || body.trialDays === null
      ? 14
      : Number(body.trialDays);

    if (!UUID_PATTERN.test(leadId) || !UUID_PATTERN.test(planId)) {
      return json({
        error: "Lead e plano são obrigatórios.",
        code: "INVALID_INPUT",
      }, 400);
    }
    if (!Number.isInteger(trialDays) || trialDays < 0 || trialDays > 90) {
      return json({
        error: ERROR_MESSAGES.trial_invalido,
        code: "INVALID_INPUT",
      }, 400);
    }
    if (
      ownerEmailOverride &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmailOverride)
    ) {
      return json(
        { error: "E-mail do dono inválido.", code: "INVALID_INPUT" },
        400,
      );
    }

    const admin = auth.context.admin;

    // 1) Tenant + assinatura em trial (idempotente por lead.converted_tenant_id).
    const { data: converted, error: convertError } = await admin.rpc(
      "convert_teacher_lead_to_tenant",
      {
        p_lead_id: leadId,
        p_plan_id: planId,
        p_slug: slug,
        p_school_name: schoolName,
        p_trial_days: trialDays,
        p_owner_email: ownerEmailOverride || null,
      },
    );
    if (convertError) {
      console.error("activate-teacher-tenant: conversão falhou", {
        code: convertError.code,
      });
      return json({
        error: "Não foi possível criar o ambiente.",
        code: "CONVERSION_FAILED",
      }, 500);
    }
    const conversion = (converted || {}) as Record<string, unknown>;
    if (conversion.ok !== true) {
      const code = typeof conversion.error === "string"
        ? conversion.error
        : "conversion_rejected";
      return json({
        error: ERROR_MESSAGES[code] || "Conversão recusada.",
        code,
      }, 409);
    }
    const tenantId = String(conversion.tenant_id || "");
    const ownerEmail = String(conversion.owner_email || "").trim()
      .toLowerCase();
    const ownerName = String(conversion.owner_name || "").trim() || ownerEmail;
    if (!tenantId || !ownerEmail) {
      return json({
        error: "Conversão sem tenant ou e-mail.",
        code: "CONVERSION_INCOMPLETE",
      }, 500);
    }

    // 2) Conta do dono. E-mail já existente: só quem veio do Hub (NON_STUDENT)
    //    evolui para dono do tenant — professor/aluno/diretor de outra escola é
    //    recusado, porque trocar o papel dele silenciosamente quebraria o acesso
    //    que ele já tem.
    const { data: existingUserId, error: lookupError } = await admin.rpc(
      "get_user_id_by_email",
      { email_input: ownerEmail },
    );
    if (lookupError) {
      return json({
        error: "Não foi possível verificar o e-mail do dono.",
        code: "OWNER_LOOKUP_FAILED",
      }, 500);
    }

    let userId = (existingUserId as string | null) || null;
    let createdNow = false;
    if (userId) {
      const { data: profile, error: profileError } = await admin
        .from("profiles")
        .select("id, role, tenant_id")
        .eq("id", userId)
        .maybeSingle();
      if (profileError) {
        return json({
          error: "Não foi possível ler o perfil do dono.",
          code: "OWNER_PROFILE_FAILED",
        }, 500);
      }
      const alreadyOwner = profile?.role === "SCHOOL_ADMIN" &&
        profile?.tenant_id === tenantId;
      if (profile && !alreadyOwner && profile.role !== "NON_STUDENT") {
        return json({
          error:
            `O e-mail ${ownerEmail} já pertence a uma conta ${profile.role} de outro ambiente. Use outro e-mail no lead ou trate a conta manualmente.`,
          code: "OWNER_EMAIL_IN_USE",
          tenantId,
        }, 409);
      }
    } else {
      const { data: created, error: createError } = await admin.auth.admin
        .createUser({
          email: ownerEmail,
          password: secureInitialPassword(),
          email_confirm: true,
          user_metadata: {
            full_name: ownerName,
            role: "SCHOOL_ADMIN",
            tenant_id: tenantId,
          },
        });
      if (createError || !created.user) {
        // Corrida com outra ativação: recupera pelo e-mail antes de desistir.
        const retry = await admin.rpc("get_user_id_by_email", {
          email_input: ownerEmail,
        });
        if (retry.error || !retry.data) {
          return json({
            error: createError?.message || "Falha ao criar a conta do dono.",
            code: "OWNER_CREATE_FAILED",
          }, 500);
        }
        userId = retry.data as string;
      } else {
        userId = created.user.id;
        createdNow = true;
      }
    }

    const { error: upsertError } = await admin.from("profiles").upsert({
      id: userId,
      email: ownerEmail,
      full_name: ownerName,
      role: "SCHOOL_ADMIN",
      tenant_id: tenantId,
      status: "Ativo",
      status_financial: "ACTIVE",
    });
    if (upsertError) {
      console.error("activate-teacher-tenant: perfil do dono falhou", {
        code: upsertError.code,
      });
      if (createdNow) {
        await admin.auth.admin.deleteUser(userId).catch(() => undefined);
      }
      return json({
        error:
          "Ambiente criado, mas o perfil do dono não pôde ser gravado. Tente de novo.",
        code: "OWNER_PROFILE_FAILED",
        tenantId,
      }, 500);
    }

    // 3) E-mail de ativação (link de definição de senha, via Resend).
    let activation: "SENT" | "FAILED" = "SENT";
    try {
      await sendAccountActivation(admin, {
        email: ownerEmail,
        name: ownerName,
        accountLabel: `direção do ambiente ${
          String(conversion.plan || "Professor Negócio")
        }`,
        idempotencyKey: `teacher-tenant-activation/${tenantId}/${Date.now()}`,
      });
    } catch (activationError) {
      activation = "FAILED";
      console.error("activate-teacher-tenant: e-mail de ativação falhou", {
        message: activationError instanceof Error
          ? activationError.message
          : "unknown",
      });
    }

    return json({
      ok: true,
      tenantId,
      ownerEmail,
      alreadyConverted: conversion.already_converted === true,
      trialEndsAt: conversion.trial_ends_at ?? null,
      activation,
      message: activation === "SENT"
        ? `Ambiente ${tenantId} criado. E-mail de ativação enviado para ${ownerEmail}.`
        : `Ambiente ${tenantId} criado, mas o e-mail de ativação falhou. Clique em Ativar de novo para reenviar.`,
    });
  } catch (error) {
    console.error("activate-teacher-tenant: falha", {
      message: error instanceof Error ? error.message : "unknown",
    });
    return json(
      { error: "Requisição inválida.", code: "INVALID_REQUEST" },
      400,
    );
  }
});
