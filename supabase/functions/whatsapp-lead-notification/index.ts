/// <reference lib="deno.ns" />

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { authorizeRequest, methodNotAllowed } from "../_shared/request-auth.ts";
import {
  loadTenantCommunicationIdentity,
  loadTenantWhatsAppRoute,
  safeCommunicationText,
} from "../_shared/tenant-communication.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

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

function normalizeBrazilPhone(value: unknown): string {
  const digits = typeof value === "string" ? value.replace(/\D/g, "") : "";
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  return digits;
}

async function sendText(
  endpoint: string,
  apiKey: string,
  number: string,
  text: string,
): Promise<boolean> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: apiKey },
    body: JSON.stringify({
      number,
      options: { delay: 1200, presence: "composing", linkPreview: false },
      textMessage: { text },
      text,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    console.error("Lead notification delivery failed", { status: response.status });
  }
  return response.ok;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return methodNotAllowed(corsHeaders);

  const auth = await authorizeRequest(req, { corsHeaders, allowService: true });
  if (auth.ok === false) return auth.response;
  if (!auth.context.isService) {
    return json({ error: "Service authentication required" }, 403);
  }

  try {
    const payload = await req.json().catch(() => ({}));
    if (!isUuid(payload?.lead_id)) return json({ error: "lead_id is required" }, 400);

    const { data: lead, error: leadError } = await auth.context.admin
      .from("crm_leads")
      .select("id,tenant_id,name,email,phone,source,notes")
      .eq("id", payload.lead_id)
      .maybeSingle();
    if (leadError) return json({ error: "Unable to load lead" }, 503);
    if (!lead?.tenant_id) return json({ error: "Lead not found" }, 404);

    const identity = await loadTenantCommunicationIdentity(
      auth.context.admin,
      lead.tenant_id,
    );
    if (!identity) return json({ error: "Active tenant linkage is required" }, 409);
    const route = await loadTenantWhatsAppRoute(
      auth.context.admin,
      identity.tenantId,
      "student",
    );
    if (!route) return json({ error: "WhatsApp route is unavailable" }, 409);

    const evolutionApiUrl = (Deno.env.get("EVOLUTION_API_URL") || "https://api.2b.app.br")
      .replace(/\/+$/, "");
    const evolutionApiKey = Deno.env.get("EVOLUTION_API_KEY")?.trim() || "";
    if (!evolutionApiKey) return json({ error: "WhatsApp integration is unavailable" }, 503);

    const phone = normalizeBrazilPhone(lead.phone);
    if (phone.length < 12 || phone.length > 15) {
      return json({ error: "Lead phone is invalid" }, 422);
    }
    const name = safeCommunicationText(lead.name, 120) || "Contato";
    const firstName = name.split(/\s+/)[0];
    const source = safeCommunicationText(lead.source, 120) || "Não informada";
    const notes = safeCommunicationText(lead.notes, 500);
    const email = safeCommunicationText(lead.email, 254);
    const endpoint = `${evolutionApiUrl}/message/sendText/${encodeURIComponent(route.instanceName)}`;

    const confirmMessage = `🏫 *${identity.brandName}*\n\nOlá, *${firstName}*! 👋\n\nRecebemos sua solicitação com sucesso. Nossa equipe entrará em contato em breve para os próximos passos.\n\n_Equipe ${identity.brandName}_`;
    const leadSent = await sendText(
      endpoint,
      evolutionApiKey,
      phone,
      confirmMessage,
    );

    const notificationDestination = route.hrGroupId || route.ownerPhone;
    let groupSent = false;
    if (notificationDestination) {
      const now = new Date();
      const date = now.toLocaleDateString("pt-BR", {
        timeZone: "America/Sao_Paulo",
      });
      const time = now.toLocaleTimeString("pt-BR", {
        timeZone: "America/Sao_Paulo",
        hour: "2-digit",
        minute: "2-digit",
      });
      const groupMessage = `🔔 *NOVO LEAD — ${identity.brandName}*\n\n👤 *Nome:* ${name}\n🏫 *Escola:* ${identity.brandName}\n📱 *WhatsApp:* ${phone}\n${email ? `📧 *E-mail:* ${email}\n` : ""}📌 *Origem:* ${source}\n${notes ? `📝 *Obs.:* ${notes}\n` : ""}📅 *Data:* ${date} às ${time}`;
      groupSent = await sendText(
        endpoint,
        evolutionApiKey,
        notificationDestination,
        groupMessage,
      );
    }

    if (!leadSent && !groupSent) return json({ error: "Notification failed" }, 502);
    return json({ success: true, lead_sent: leadSent, group_sent: groupSent });
  } catch (error) {
    console.error("Lead notification failed", {
      message: error instanceof Error ? error.message : "unknown error",
    });
    return json({ error: "Notification failed" }, 502);
  }
});
