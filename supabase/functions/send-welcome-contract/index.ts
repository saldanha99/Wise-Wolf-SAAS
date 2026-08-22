/// <reference lib="deno.ns" />

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import {
  authorizeRequest,
  methodNotAllowed,
  type RequestAuthContext,
} from "../_shared/request-auth.ts";
import {
  loadTenantCommunicationIdentity,
  safeCommunicationText,
} from "../_shared/tenant-communication.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface WelcomeEmailRequest {
  recipientUserId?: string;
  contractUrl?: string;
  contractBase64?: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    );
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] || character);
}

function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && !url.username && !url.password
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function senderAddress(value: string): string | null {
  const bracketed = value.match(/<([^<>]+)>/)?.[1]?.trim();
  const address = (bracketed || value).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) ? address : null;
}

function formatCnpj(value: string): string {
  return value.replace(
    /^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/,
    "$1.$2.$3/$4-$5",
  );
}

async function selectedSuperAdminTenant(
  context: RequestAuthContext,
): Promise<string | null> {
  if (!context.userId) return null;
  const { data: selected, error: selectedError } = await context.admin
    .from("tenant_user_contexts")
    .select("tenant_id")
    .eq("user_id", context.userId)
    .maybeSingle();
  if (selectedError || !selected?.tenant_id) return null;
  const { data: membership, error: membershipError } = await context.admin
    .from("tenant_memberships")
    .select("tenant_id")
    .eq("user_id", context.userId)
    .eq("tenant_id", selected.tenant_id)
    .eq("status", "ACTIVE")
    .maybeSingle();
  return membershipError || !membership ? null : membership.tenant_id;
}

async function authorizedRecipientTenant(
  context: RequestAuthContext,
  recipientUserId: string,
): Promise<string | null> {
  const { data: memberships, error } = await context.admin
    .from("tenant_memberships")
    .select("tenant_id,is_primary")
    .eq("user_id", recipientUserId)
    .eq("status", "ACTIVE")
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(20);
  if (error || !memberships?.length) return null;

  if (context.isService) {
    const primary = memberships.find((membership) => membership.is_primary === true);
    if (primary) return primary.tenant_id;
    return memberships.length === 1 ? memberships[0].tenant_id : null;
  }

  const role = context.profile?.role || "";
  const callerTenantId = role === "SUPER_ADMIN"
    ? await selectedSuperAdminTenant(context)
    : context.profile?.tenant_id || null;
  if (!callerTenantId) return null;
  const targetMembership = memberships.find((membership) =>
    membership.tenant_id === callerTenantId
  );
  if (!targetMembership) return null;
  if (context.userId === recipientUserId) return callerTenantId;
  return role === "SCHOOL_ADMIN" || role === "SUPER_ADMIN"
    ? callerTenantId
    : null;
}

const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return methodNotAllowed(corsHeaders);

  const auth = await authorizeRequest(req, { allowService: true, corsHeaders });
  if (auth.ok === false) return auth.response;

  try {
    const contentLength = Number(req.headers.get("content-length") || "0");
    if (Number.isFinite(contentLength) && contentLength > 14_000_000) {
      return json({ error: "Payload muito grande" }, 413);
    }
    const body = await req.json() as WelcomeEmailRequest;
    const recipientUserId = body.recipientUserId ||
      (!auth.context.isService ? auth.context.userId : null);
    if (!isUuid(recipientUserId)) {
      return json({ error: "Destinatário canônico obrigatório" }, 400);
    }

    const tenantId = await authorizedRecipientTenant(auth.context, recipientUserId);
    if (!tenantId) return json({ error: "Vínculo ativo com a escola é obrigatório" }, 403);
    const identity = await loadTenantCommunicationIdentity(auth.context.admin, tenantId);
    if (!identity) return json({ error: "Escola ativa não encontrada" }, 403);

    const { data: recipient, error: recipientError } = await auth.context.admin
      .from("profiles")
      .select("id,email,full_name")
      .eq("id", recipientUserId)
      .maybeSingle();
    if (recipientError) return json({ error: "Não foi possível carregar o destinatário" }, 503);
    const recipientEmail = typeof recipient?.email === "string"
      ? recipient.email.trim().toLowerCase()
      : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) {
      return json({ error: "Destinatário sem e-mail válido" }, 422);
    }
    const recipientName = safeCommunicationText(recipient?.full_name, 120) ||
      "Aluno(a)";

    const resendApiKey = Deno.env.get("RESEND_API_KEY")?.trim() || "";
    const fromAddress = senderAddress(
      Deno.env.get("RESEND_FROM_EMAIL")?.trim() ||
        "nao-responda@wisewolflanguage.com.br",
    );
    if (!resendApiKey || !fromAddress) {
      return json({ error: "Serviço de e-mail indisponível" }, 503);
    }

    const contractUrl = httpsUrl(body.contractUrl);
    if (body.contractUrl && !contractUrl) {
      return json({ error: "URL de contrato inválida" }, 400);
    }
    if (
      body.contractBase64 &&
      (typeof body.contractBase64 !== "string" || body.contractBase64.length > 13_500_000)
    ) return json({ error: "Contrato inválido" }, 400);

    const attachments: Array<Record<string, string>> = [];
    if (contractUrl) attachments.push({ filename: "Contrato.pdf", path: contractUrl });
    else if (body.contractBase64) {
      attachments.push({ filename: "Contrato.pdf", content: body.contractBase64 });
    }

    const brandName = escapeHtml(identity.brandName);
    const name = escapeHtml(recipientName);
    const portalUrl = identity.portalUrl ? escapeHtml(identity.portalUrl) : null;
    const logoUrl = identity.logoUrl ? escapeHtml(identity.logoUrl) : null;
    const supportPhone = identity.supportPhone;
    const supportUrl = supportPhone ? `https://wa.me/${supportPhone}` : null;
    const legalIdentity = [
      identity.legalName !== identity.brandName
        ? `<p>${escapeHtml(identity.legalName)}</p>`
        : "",
      identity.taxId ? `<p>CNPJ: ${formatCnpj(identity.taxId)}</p>` : "",
    ].filter(Boolean).join("");
    const actions = [
      portalUrl
        ? `<a href="${portalUrl}" class="btn primary">Acessar portal</a>`
        : "",
      supportUrl
        ? `<a href="${supportUrl}" class="btn secondary">Falar com a escola</a>`
        : "",
    ].filter(Boolean).join("");
    const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
body{font-family:Arial,sans-serif;background:#f4f4f5;color:#27272a;margin:0;padding:24px}
.container{max-width:600px;margin:auto;background:#fff;border-radius:12px;overflow:hidden}
.header{background:${identity.primaryColor};padding:28px;text-align:center;color:#fff}.header img{max-width:160px;max-height:80px}
.content{padding:36px 30px;text-align:center}.content h1{color:${identity.primaryColor};font-size:24px}.content p{font-size:16px;line-height:1.6;color:#52525b}
.actions{display:flex;gap:12px;justify-content:center;flex-wrap:wrap;margin-top:28px}.btn{padding:13px 22px;border-radius:999px;text-decoration:none;font-weight:700}.primary{background:${identity.primaryColor};color:#fff}.secondary{border:2px solid ${identity.secondaryColor};color:${identity.secondaryColor}}
.footer{background:#f4f4f5;padding:18px;text-align:center;font-size:12px;color:#71717a}
</style></head><body><div class="container"><div class="header">
${logoUrl ? `<img src="${logoUrl}" alt="${brandName}">` : `<strong>${brandName}</strong>`}
</div><div class="content"><h1>Bem-vindo(a) à ${brandName}</h1>
<p>Olá, <strong>${name}</strong>.<br><br>Seu contrato de prestação de serviços foi processado${attachments.length ? " e segue em anexo para sua conferência" : ""}.</p>
${actions ? `<div class="actions">${actions}</div>` : ""}</div>
<div class="footer"><p>© ${new Date().getFullYear()} ${brandName}</p>${legalIdentity}</div></div></body></html>`;

    const fallbackReplyTo = Deno.env.get("RESEND_REPLY_TO")?.trim() || "";
    const replyTo = identity.supportEmail ||
      (fallbackReplyTo ? senderAddress(fallbackReplyTo) : null);
    const resendResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `${identity.brandName} <${fromAddress}>`,
        to: [recipientEmail],
        subject: `Seu contrato - ${identity.brandName}`,
        html,
        attachments: attachments.length ? attachments : undefined,
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
      signal: AbortSignal.timeout(15000),
    });
    const resendResult = await resendResponse.json().catch(() => ({}));
    if (!resendResponse.ok) {
      console.error("Resend rejected welcome contract email", {
        status: resendResponse.status,
      });
      return json({ error: "Falha ao enviar contrato" }, 502);
    }
    return json(resendResult);
  } catch (error) {
    console.error("Welcome contract email failed", {
      message: error instanceof Error ? error.message : "unknown error",
    });
    return json({ error: "Falha ao enviar contrato" }, 500);
  }
};

serve(handler);
