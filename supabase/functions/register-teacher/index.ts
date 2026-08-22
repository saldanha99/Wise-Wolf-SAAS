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
import { loadTenantCentralWhatsAppContext } from "../_shared/tenant-communication.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const JSON_HEADERS = { ...corsHeaders, "Content-Type": "application/json" };
const MAX_BODY_BYTES = 8_500_000;

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

function optionalString(
  value: unknown,
  field: string,
  maxLength: number,
): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requiredString(value, field, 1, maxLength);
}

async function requestBody(req: Request): Promise<Record<string, unknown>> {
  const declaredLength = Number(req.headers.get("content-length") || "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new InputError("payload");
  }
  const raw = await req.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    throw new InputError("payload");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw || "{}");
  } catch {
    throw new InputError("payload");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InputError("payload");
  }
  return parsed as Record<string, unknown>;
}

function isValidCpf(cpf: string): boolean {
  if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) return false;
  const digitAt = (position: number): number => {
    const length = position - 1;
    let sum = 0;
    for (let index = 0; index < length; index += 1) {
      sum += Number(cpf[index]) * (position - index);
    }
    const remainder = (sum * 10) % 11;
    return remainder === 10 ? 0 : remainder;
  };
  return digitAt(10) === Number(cpf[9]) && digitAt(11) === Number(cpf[10]);
}

function normalizedEmail(value: unknown): string {
  const email = requiredString(value, "email", 5, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new InputError("email");
  return email;
}

function normalizedPhone(value: unknown): string {
  const phone = requiredString(value, "phone", 8, 24).replace(/\D/g, "");
  if (phone.length < 10 || phone.length > 15) throw new InputError("phone");
  return phone;
}

function normalizedHttpsUrl(value: unknown, field: string): string | null {
  const raw = optionalString(value, field, 2048);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password) {
      throw new Error();
    }
    return url.toString();
  } catch {
    throw new InputError(field);
  }
}

function decodeContractPdf(value: unknown): Uint8Array {
  const encoded = requiredString(value, "contractPdfBase64", 100, 8_000_000);
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(
      atob(encoded),
      (character) => character.charCodeAt(0),
    );
  } catch {
    throw new InputError("contractPdfBase64");
  }
  if (
    bytes.byteLength < 100 || bytes.byteLength > 6_000_000 ||
    new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-"
  ) {
    throw new InputError("contractPdfBase64");
  }
  return bytes;
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
  let signedDocumentPath: string | null = null;
  let finalized = false;

  try {
    const body = await requestBody(req);
    const email = normalizedEmail(body.email);
    const password = requiredString(body.password, "password", 8, 128);
    const name = requiredString(body.name, "name", 2, 120);
    const phone = normalizedPhone(body.phone);
    const pixKey = optionalString(body.pixKey, "pixKey", 160);
    const meetingLink = normalizedHttpsUrl(body.meetLink, "meetLink");
    const rg = requiredString(body.rg, "rg", 3, 30);
    const cpf = requiredString(body.cpf, "cpf", 11, 14).replace(/\D/g, "");
    const address = requiredString(body.address, "address", 5, 300);
    const birthDate = requiredString(body.birthDate, "birthDate", 10, 10);
    if (!isValidCpf(cpf)) throw new InputError("cpf");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) {
      throw new InputError("birthDate");
    }
    const parsedBirthDate = new Date(`${birthDate}T00:00:00.000Z`);
    if (
      Number.isNaN(parsedBirthDate.getTime()) ||
      parsedBirthDate.toISOString().slice(0, 10) !== birthDate ||
      parsedBirthDate >= new Date()
    ) {
      throw new InputError("birthDate");
    }
    if (body.contractAccepted !== true) {
      throw new InputError("contractAccepted");
    }
    const contractPdf = decodeContractPdf(body.contractPdfBase64);

    invite = await claimInvite(admin, body.offerPayload, "TEACHER_INVITE");
    const hourlyRate = Number(invite.data.hourlyRate);
    const subject = String(invite.data.subject).trim();
    const schoolInfo = invite.data.schoolInfo as Record<string, unknown>;

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
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      req.headers.get("x-real-ip")?.trim() || "unknown";
    const acceptedAt = new Date().toISOString();
    const { error: profileError } = await admin.from("profiles").upsert({
      id: userId,
      email,
      full_name: name,
      role: "TEACHER",
      tenant_id: invite.tenantId,
      phone,
      module: subject,
      hourly_rate: hourlyRate,
      pix_key: pixKey,
      meeting_link: meetingLink,
      status: "Ativo",
      avatar_url: null,
      rg,
      cpf,
      address,
      birth_date: birthDate,
      contract_accepted: true,
      accepted_at: acceptedAt,
      user_ip: trustedIp,
    });
    if (profileError) throw new Error("profile_creation_failed");

    signedDocumentPath =
      `${invite.tenantId}/${userId}/contrato-prestacao-servicos-${Date.now()}.pdf`;
    const { error: uploadError } = await admin.storage.from("contracts").upload(
      signedDocumentPath,
      contractPdf,
      { contentType: "application/pdf", upsert: false },
    );
    if (uploadError) throw new Error("contract_archive_failed");
    const { error: contractRecordError } = await admin
      .from("tenant_contract_records")
      .insert({
        tenant_id: invite.tenantId,
        user_id: userId,
        contract_kind: "TEACHER",
        party_snapshot: {
          fullName: name,
          rg,
          cpf,
          address,
          birthDate,
        },
        legal_snapshot: schoolInfo,
        commercial_snapshot: { hourlyRate, subject },
        signed_document_path: signedDocumentPath,
        accepted_at: acceptedAt,
        accepted_ip: trustedIp,
      });
    if (contractRecordError) throw new Error("contract_snapshot_failed");
    const { error: documentUpdateError } = await admin.from("profiles")
      .update({ signed_document_url: signedDocumentPath })
      .eq("id", userId)
      .eq("tenant_id", invite.tenantId);
    if (documentUpdateError) throw new Error("contract_reference_failed");

    await finalizeInvite(admin, invite, userId);
    finalized = true;

    try {
      const apiKey = Deno.env.get("EVOLUTION_API_KEY")?.trim() || "";
      const baseUrl =
        Deno.env.get("EVOLUTION_API_URL")?.trim().replace(/\/$/, "") || "";
      const parsedBase = baseUrl ? new URL(baseUrl) : null;
      const communication = await loadTenantCentralWhatsAppContext(
        admin,
        invite.tenantId,
        "teacher",
      );
      if (
        apiKey && parsedBase?.protocol === "https:" && communication
      ) {
        const recipient = phone.startsWith("55") ? phone : `55${phone}`;
        const accessLine = communication.identity.portalUrl
          ? `\n\nAcesse: ${communication.identity.portalUrl}`
          : "";
        const message = `Ola ${
          name.split(/\s+/)[0]
        }! Sua conta de professor na ${communication.identity.brandName} foi criada.\n\nLogin: ${email}\n\nPor seguranca, sua senha nao e enviada por mensagem. O contrato assinado esta disponivel na area autenticada.${accessLine}`;
        await fetch(
          `${baseUrl}/message/sendText/${
            encodeURIComponent(communication.instanceName)
          }`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", apikey: apiKey },
            body: JSON.stringify({
              number: recipient,
              text: message,
              options: { delay: 1200, presence: "composing" },
            }),
            signal: AbortSignal.timeout(8_000),
          },
        );
        console.log("Teacher welcome notification attempted", {
          tenantId: invite.tenantId,
          phoneLastFour: recipient.slice(-4),
        });
      }
    } catch (notificationError) {
      console.error("Teacher welcome notification failed", {
        name: notificationError instanceof Error
          ? notificationError.name
          : "UnknownError",
      });
    }

    return json({
      success: true,
      userId,
      message: "Cadastro realizado com sucesso!",
    });
  } catch (error) {
    if (!finalized) {
      if (signedDocumentPath) {
        await admin.storage.from("contracts").remove([signedDocumentPath]);
      }
      if (userId) await admin.auth.admin.deleteUser(userId);
      await releaseInviteClaim(admin, invite);
    }
    if (error instanceof InputError) {
      return json({ error: "Revise os dados obrigatorios do cadastro." }, 400);
    }
    if (error instanceof InviteRegistrationError) {
      return json(
        { error: "Convite invalido, expirado ou em processamento." },
        400,
      );
    }
    console.error("Teacher registration failed", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return json({ error: "Nao foi possivel concluir o cadastro." }, 500);
  }
}

if (import.meta.main) serve(handleRequest);
