import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import {
  authorizeRequest,
  methodNotAllowed,
} from "../_shared/request-auth.ts";
import {
  evaluateCommercialSuppression,
  loadCommercialContactFacts,
  reconcileSuppressedLead,
} from "../_shared/commercial-contact-policy.ts";
import { loadTenantWhatsAppRoute } from "../_shared/tenant-communication.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type LeadRow = {
  id: string;
  tenant_id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  source: string | null;
  notification_sent_at: string | null;
  status: string | null;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normalizeBrazilPhone(value: string | null): string {
  const digits = (value ?? "").replace(/\D/g, "");
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  return digits;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return methodNotAllowed(corsHeaders);

  const auth = await authorizeRequest(req, {
    allowService: true,
    corsHeaders,
  });
  if (auth.ok === false) return auth.response;
  if (!auth.context.isService) return json({ error: "Service access required" }, 403);

  let claimedLead: LeadRow | null = null;

  try {
    const payload = await req.json().catch(() => ({}));
    if (!isUuid(payload?.lead_id)) return json({ error: "lead_id is required" }, 400);

    const { data: lead, error: leadError } = await auth.context.admin
      .from("crm_leads")
      .select("id, tenant_id, name, phone, email, source, notification_sent_at, status")
      .eq("id", payload.lead_id)
      .maybeSingle();

    if (leadError) {
      console.error("CRM notification lead lookup failed", { code: leadError.code });
      return json({ error: "Unable to load lead" }, 503);
    }
    if (!lead) return json({ error: "Lead not found" }, 404);
    if (lead.notification_sent_at) return json({ success: true, already_processed: true });

    const facts = await loadCommercialContactFacts(auth.context.admin, lead.tenant_id);
    const suppression = evaluateCommercialSuppression({
      tenantId: lead.tenant_id,
      phone: lead.phone,
      email: lead.email,
      name: lead.name,
      leadStatus: lead.status,
    }, facts);
    if (suppression.suppressed) {
      await reconcileSuppressedLead(auth.context.admin, lead.id, suppression);
      return json({ success: true, suppressed: "existing_student" });
    }

    const claimedAt = new Date().toISOString();
    const { data: claimed, error: claimError } = await auth.context.admin
      .from("crm_leads")
      .update({ notification_sent_at: claimedAt })
      .eq("id", lead.id)
      .is("notification_sent_at", null)
      .select("id, tenant_id, name, phone, email, source, notification_sent_at, status")
      .maybeSingle();

    if (claimError) {
      console.error("CRM notification claim failed", { code: claimError.code });
      return json({ error: "Unable to claim notification" }, 503);
    }
    if (!claimed) return json({ success: true, already_processed: true });
    claimedLead = claimed as LeadRow;

    const evolutionBase = (Deno.env.get("EVOLUTION_API_URL") ?? "https://api.2b.app.br")
      .replace(/\/+$/, "");
    const evolutionKey = Deno.env.get("EVOLUTION_API_KEY")?.trim() ?? "";
    if (!evolutionKey) throw new Error("Evolution integration is unavailable");

    const route = await loadTenantWhatsAppRoute(
      auth.context.admin,
      claimedLead.tenant_id,
      "student",
    );
    if (!route) throw new Error("WhatsApp instance is unavailable");

    const name = claimedLead.name?.trim() || "Contato";
    const leadPhone = normalizeBrazilPhone(claimedLead.phone);
    const directorPhone = normalizeBrazilPhone(route.ownerPhone);
    const endpoint = `${evolutionBase}/message/sendText/${encodeURIComponent(route.instanceName)}`;
    const messages: Array<{ number: string; text: string }> = [];

    if (directorPhone.length >= 12) {
      messages.push({
        number: directorPhone,
        text: `*${route.identity.brandName} - Novo Lead!*\n\n📌 *Nome:* ${name}\n📞 *WhatsApp:* ${claimedLead.phone || "Não informado"}\n📧 *E-mail:* ${claimedLead.email || "Não informado"}\n🌍 *Origem:* ${claimedLead.source || "Direto / Desconhecida"}\n\nAcesse seu CRM para gerenciar este contato.`,
      });
    }

    if (leadPhone.length >= 12) {
      const firstName = name.split(/\s+/)[0];
      messages.push({
        number: leadPhone,
        text: `*Olá ${firstName}, bem-vindo(a) à ${route.identity.brandName}!*\n\nRecebemos seu interesse e nossa equipe entrará em contato em breve para agendar sua aula experimental gratuita. 🚀`,
      });
    }

    if (messages.length === 0) throw new Error("No valid notification destination");

    for (const message of messages) {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": evolutionKey,
        },
        body: JSON.stringify({
          number: message.number,
          options: { delay: 800, presence: "composing", linkPreview: false },
          textMessage: { text: message.text },
          text: message.text,
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`Evolution request failed (${response.status})`);
    }

    console.log("CRM lead notification sent", {
      lead_id: claimedLead.id,
      tenant_id: claimedLead.tenant_id,
      message_count: messages.length,
    });
    return json({ success: true });
  } catch (error) {
    if (claimedLead) {
      await auth.context.admin
        .from("crm_leads")
        .update({ notification_sent_at: null })
        .eq("id", claimedLead.id)
        .eq("notification_sent_at", claimedLead.notification_sent_at);
    }
    console.error("CRM lead notification failed", {
      message: error instanceof Error ? error.message : "unknown error",
    });
    return json({ error: "Notification failed" }, 502);
  }
});
