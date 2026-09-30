/// <reference lib="deno.ns" />

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.93.3";
import {
  type ClaimedInvite,
  claimInvite,
  finalizeInvite,
  InviteRegistrationError,
  releaseInviteClaim,
} from "../_shared/invite-registration.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const JSON_HEADERS = { ...corsHeaders, "Content-Type": "application/json" };

class InputError extends Error {}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function requiredString(
  value: unknown,
  field: string,
  minLength: number,
  maxLength: number,
): string {
  if (typeof value !== "string") throw new InputError(field);
  const normalized = value.trim();
  if (normalized.length < minLength || normalized.length > maxLength) {
    throw new InputError(field);
  }
  return normalized;
}

/**
 * Cupom escolhido pela escola no convite ("AFILIADA10"). Mesma normalização do
 * banco (`private.normalize_affiliate_code`); fora do formato vira null e o
 * banco gera um cupom próprio.
 */
export function affiliateCodeFromInvite(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim().replace(/[^A-Za-z0-9_-]+/g, "").toUpperCase();
  return /^[A-Z0-9][A-Z0-9_-]{3,31}$/.test(code) ? code : null;
}

/**
 * Cupom que ficou na conta (o do convite ou o que o banco gerou quando o do
 * convite já era de outro). A página de conclusão só oferece "Copiar" com este
 * valor — antes do cadastro o cupom do convite ainda não vale na matrícula.
 */
export function registeredAffiliateCode(row: unknown): string | null {
  if (!row || typeof row !== "object") return null;
  return affiliateCodeFromInvite(
    (row as { affiliate_code?: unknown }).affiliate_code,
  );
}

/** Cupom tomado (ou recusado pelo banco) desde o convite. */
function isAffiliateCodeRejection(
  error: { code?: string; message?: string } | null,
): boolean {
  if (!error) return false;
  return error.code === "23505" || error.code === "22023" ||
    /affiliate_code/i.test(error.message || "");
}

function normalizedEmail(value: unknown): string {
  const email = requiredString(value, "email", 5, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new InputError("email");
  return email;
}

async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Metodo nao permitido." }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim() || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim() ||
    "";
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ error: "Cadastro temporariamente indisponivel." }, 503);
  }
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  let invite: ClaimedInvite | null = null;
  let userId: string | null = null;
  let finalized = false;

  try {
    const declaredLength = Number(req.headers.get("content-length") || "0");
    if (Number.isFinite(declaredLength) && declaredLength > 32_768) {
      throw new InputError("payload");
    }
    const raw = await req.text();
    if (new TextEncoder().encode(raw).byteLength > 32_768) {
      throw new InputError("payload");
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw || "{}") as Record<string, unknown>;
    } catch {
      throw new InputError("payload");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new InputError("payload");
    }

    // A página de cadastro mostra as regras do programa (comissão, liquidação,
    // saque) e pede o aceite; sem ele a conta não nasce.
    if (body.acceptedTerms !== true) throw new InputError("terms");

    invite = await claimInvite(admin, body.offerPayload, "VENDOR_INVITE");
    const commissionRate = Number(invite.data.commissionRate);
    const requestedCode = affiliateCodeFromInvite(invite.data.affiliateCode);
    const linkedStudentId = invite.data.linkedStudentId;
    let email: string;
    let password: string;
    let name: string;
    let rawPhone: string;
    if (typeof linkedStudentId === "string") {
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{4}-[0-9a-f]{12}$/i
          .test(linkedStudentId)
      ) {
        throw new InputError("linkedStudentId");
      }
      const bearer = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)
        ?.[1];
      if (!bearer) throw new InputError("student_identity");
      const { data: verified, error: verifyError } = await admin.auth.getUser(
        bearer,
      );
      if (verifyError || verified.user?.id !== linkedStudentId) {
        throw new InputError("student_identity");
      }
      const { data: student, error: studentError } = await admin.from(
        "profiles",
      )
        .select("id,full_name,phone,role,tenant_id,email,lifecycle_status")
        .eq("id", linkedStudentId).maybeSingle();
      if (
        studentError || !student || student.role !== "STUDENT" ||
        student.tenant_id !== invite.tenantId ||
        String(student.lifecycle_status || "active").toLowerCase() !== "active"
      ) {
        throw new InputError("student_identity");
      }
      // O perfil financeiro permanece separado internamente, sem outro login
      // oferecido ao aluno. Seu acesso existente resolve o vínculo privado.
      email = `affiliate-${crypto.randomUUID()}@accounts.invalid`;
      password = `${crypto.randomUUID()}${crypto.randomUUID()}`;
      name = requiredString(student.full_name, "name", 2, 120);
      rawPhone = typeof student.phone === "string"
        ? student.phone.replace(/\D/g, "")
        : "";
    } else {
      email = normalizedEmail(body.email);
      password = requiredString(body.password, "password", 8, 128);
      name = requiredString(body.name, "name", 2, 120);
      rawPhone =
        body.phone === undefined || body.phone === null || body.phone === ""
          ? ""
          : requiredString(body.phone, "phone", 8, 24).replace(/\D/g, "");
      if (rawPhone && (rawPhone.length < 10 || rawPhone.length > 15)) {
        throw new InputError("phone");
      }
    }
    const { data: authData, error: authError } = await admin.auth.admin
      .createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: name },
      });
    if (authError || !authData.user) {
      throw new Error("auth_user_creation_failed");
    }
    userId = authData.user.id;

    const trustedIp = req.headers.get("cf-connecting-ip")?.trim() ||
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    const profileRow = {
      id: userId,
      email,
      full_name: name,
      role: "SALESPERSON",
      tenant_id: invite.tenantId,
      phone: rawPhone || null,
      commission_rate: commissionRate,
      status: "Ativo",
      avatar_url: null,
      user_ip: trustedIp,
      accepted_at: new Date().toISOString(),
      contract_accepted: true,
    };
    let { error: profileError } = await admin.from("profiles").upsert(
      requestedCode
        ? { ...profileRow, affiliate_code: requestedCode }
        : profileRow,
    );
    // Cupom do convite tomado desde então (convite antigo, troca manual): o
    // cadastro não trava — nasce com cupom gerado e a direção ajusta na lista.
    if (
      profileError && requestedCode && isAffiliateCodeRejection(profileError)
    ) {
      ({ error: profileError } = await admin.from("profiles").upsert(
        profileRow,
      ));
    }
    if (profileError) throw new Error("profile_creation_failed");

    if (typeof linkedStudentId === "string") {
      const { data: linked, error: linkedError } = await admin.rpc(
        "finalize_linked_vendor_invite_server",
        {
          p_offer_id: invite.offerId,
          p_claim_token: invite.claimToken,
          p_student_user_id: linkedStudentId,
          p_vendor_user_id: userId,
        },
      );
      if (linkedError || linked !== true) {
        // A resposta de rede pode falhar depois do commit. Não apague o perfil
        // financeiro se a transação já consumiu este convite para ele.
        const { data: savedOffer } = await admin.from("offers")
          .select("consumed_by,consumed_at")
          .eq("id", invite.offerId).maybeSingle();
        if (savedOffer?.consumed_by !== userId || !savedOffer.consumed_at) {
          throw new Error("linked_invite_finalize_failed");
        }
      }
    } else {
      await finalizeInvite(admin, invite, userId);
    }
    finalized = true;
    // Leitura de cortesia: a conta já existe e o convite foi usado, então
    // falhar aqui nunca vira erro — a página só deixa de oferecer "Copiar".
    let affiliateCode: string | null = null;
    try {
      const { data: saved } = await admin.from("profiles")
        .select("affiliate_code")
        .eq("id", userId)
        .maybeSingle();
      affiliateCode = registeredAffiliateCode(saved);
    } catch {
      affiliateCode = null;
    }
    return json({
      success: true,
      userId,
      role: "SALESPERSON",
      affiliateCode,
      linkedStudent: typeof linkedStudentId === "string",
    });
  } catch (error) {
    if (!finalized) {
      if (userId) await admin.auth.admin.deleteUser(userId);
      await releaseInviteClaim(admin, invite);
    }
    if (error instanceof InputError) {
      if (error.message === "student_identity") {
        return json(
          { error: "Entre na conta de aluno vinculada ao convite." },
          403,
        );
      }
      return json({ error: "Revise os dados obrigatorios do cadastro." }, 400);
    }
    if (error instanceof InviteRegistrationError) {
      return json(
        { error: "Convite invalido, expirado ou em processamento." },
        400,
      );
    }
    console.error("Vendor registration failed", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return json({ error: "Nao foi possivel concluir o cadastro." }, 500);
  }
}

if (import.meta.main) serve(handleRequest);
