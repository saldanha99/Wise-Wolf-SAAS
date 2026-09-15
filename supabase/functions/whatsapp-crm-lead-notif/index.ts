import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { authorizeRequest, methodNotAllowed } from "../_shared/request-auth.ts";
import {
  evaluateCommercialSuppression,
  loadCommercialContactFacts,
  reconcileSuppressedLead,
} from "../_shared/commercial-contact-policy.ts";
import { sendWhatsTextDetailed } from "../_shared/evolution-send.ts";
import {
  loadTenantWhatsAppRoute,
  safeCommunicationText,
} from "../_shared/tenant-communication.ts";
import {
  formWelcomeMessage,
  leadOpeningMessage,
  recentlyMessaged,
  sdrAgentName,
  sdrEnabled,
} from "./first-touch.ts";

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
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value);
}

function normalizeBrazilPhone(value: string | null): string {
  const digits = (value ?? "").replace(/\D/g, "");
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  return digits;
}

const todayBRT = () =>
  new Date(Date.now() - 3 * 3600 * 1000).toISOString().split("T")[0];

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return methodNotAllowed(corsHeaders);

  const auth = await authorizeRequest(req, {
    allowService: true,
    corsHeaders,
  });
  if (auth.ok === false) return auth.response;
  if (!auth.context.isService) {
    return json({ error: "Service access required" }, 403);
  }
  const admin = auth.context.admin;

  let claimedLead: LeadRow | null = null;

  try {
    const payload = await req.json().catch(() => ({}));
    if (!isUuid(payload?.lead_id)) {
      return json({ error: "lead_id is required" }, 400);
    }

    const { data: lead, error: leadError } = await admin
      .from("crm_leads")
      .select(
        "id, tenant_id, name, phone, email, source, notification_sent_at, status",
      )
      .eq("id", payload.lead_id)
      .maybeSingle();

    if (leadError) {
      console.error("CRM notification lead lookup failed", {
        code: leadError.code,
      });
      return json({ error: "Unable to load lead" }, 503);
    }
    if (!lead) return json({ error: "Lead not found" }, 404);
    if (lead.notification_sent_at) {
      return json({ success: true, already_processed: true });
    }

    const facts = await loadCommercialContactFacts(admin, lead.tenant_id);
    const suppression = evaluateCommercialSuppression({
      tenantId: lead.tenant_id,
      phone: lead.phone,
      email: lead.email,
      name: lead.name,
      leadStatus: lead.status,
    }, facts);
    if (suppression.suppressed) {
      await reconcileSuppressedLead(admin, lead.id, suppression);
      return json({ success: true, suppressed: "existing_student" });
    }

    const claimedAt = new Date().toISOString();
    const { data: claimed, error: claimError } = await admin
      .from("crm_leads")
      .update({ notification_sent_at: claimedAt })
      .eq("id", lead.id)
      .is("notification_sent_at", null)
      .select(
        "id, tenant_id, name, phone, email, source, notification_sent_at, status",
      )
      .maybeSingle();

    if (claimError) {
      console.error("CRM notification claim failed", { code: claimError.code });
      return json({ error: "Unable to claim notification" }, 503);
    }
    if (!claimed) return json({ success: true, already_processed: true });
    claimedLead = claimed as LeadRow;

    const evolutionBase =
      (Deno.env.get("EVOLUTION_API_URL") ?? "https://api.2b.app.br")
        .replace(/\/+$/, "");
    const evolutionKey = Deno.env.get("EVOLUTION_API_KEY")?.trim() ?? "";
    if (!evolutionKey) throw new Error("Evolution integration is unavailable");

    const route = await loadTenantWhatsAppRoute(
      admin,
      claimedLead.tenant_id,
      "student",
    );
    if (!route) throw new Error("WhatsApp instance is unavailable");

    const { data: tenantRow } = await admin
      .from("tenants")
      .select("ai_team_config")
      .eq("id", claimedLead.tenant_id)
      .maybeSingle();
    const cfg: unknown = tenantRow?.ai_team_config ?? null;

    const name = claimedLead.name?.trim() || "Contato";
    const leadPhone = normalizeBrazilPhone(claimedLead.phone);
    const directorPhone = normalizeBrazilPhone(route.ownerPhone);
    if (directorPhone.length < 12 && leadPhone.length < 12) {
      throw new Error("No valid notification destination");
    }
    // Resolve o JID antes de enviar (DDD antigo registrado sem o 9º dígito).
    const send = (to: string, text: string) =>
      sendWhatsTextDetailed({
        base: evolutionBase,
        keys: [evolutionKey],
        instance: route.instanceName,
        to,
        text,
      });

    if (directorPhone.length >= 12) {
      const sent = await send(
        directorPhone,
        `*${route.identity.brandName} - Novo Lead!*\n\n📌 *Nome:* ${name}\n📞 *WhatsApp:* ${
          claimedLead.phone || "Não informado"
        }\n📧 *E-mail:* ${claimedLead.email || "Não informado"}\n🌍 *Origem:* ${
          claimedLead.source || "Direto / Desconhecida"
        }\n\nAcesse seu CRM para gerenciar este contato.`,
      );
      if (sent.outcome === "rejected") {
        throw new Error(
          `Evolution request failed (${sent.httpStatus ?? "sem status"})`,
        );
      }
    }

    // O que aconteceu com a mensagem ao lead — vai na resposta e no log.
    let leadMessage = "sem_telefone";
    if (leadPhone.length >= 12 && !sdrEnabled(cfg)) {
      const sent = await send(
        leadPhone,
        formWelcomeMessage(claimedLead.name, route.identity.brandName),
      );
      leadMessage = sent.outcome === "rejected" ? "falhou" : "boas_vindas";
    } else if (leadPhone.length >= 12) {
      const { data: recent } = await admin
        .from("ai_wa_messages")
        .select("created_at")
        .eq("tenant_id", claimedLead.tenant_id)
        .eq("direction", "out")
        .like("phone", `%${leadPhone.slice(-8)}`)
        .order("created_at", { ascending: false })
        .limit(1);
      if (recentlyMessaged(recent?.[0]?.created_at ?? null, Date.now())) {
        leadMessage = "ja_falamos_ha_pouco";
      } else {
        const text = leadOpeningMessage({
          name: claimedLead.name,
          sdrName: safeCommunicationText(sdrAgentName(cfg), 80),
          brandName: route.identity.brandName,
        });
        const sent = await send(leadPhone, text);
        // "ambiguous" pode ter chegado: conta como enviado para não repetir.
        const entregue = sent.outcome !== "rejected";
        // O registro não depende do envio: é o histórico que a atendente lê
        // quando o lead responder.
        await admin.from("ai_wa_messages").insert({
          tenant_id: claimedLead.tenant_id,
          phone: leadPhone,
          agent: "sdr",
          direction: "out",
          content: text,
          meta: {
            lead_id: claimedLead.id,
            kind: "first_touch",
            via: "formulario",
            source: claimedLead.source || null,
            entregue,
          },
        });
        if (entregue) {
          // Entra no robô: a atendente responde e o sdr-followups acompanha.
          await admin.from("crm_leads").update({
            ai_handled: true,
            last_outbound_at: new Date().toISOString(),
          }).eq("id", claimedLead.id);
          // Mesma marca da varredura: o telefone recebe o primeiro toque uma
          // vez só, mesmo que exista outro cadastro dele no CRM.
          const { data: ever } = await admin
            .from("automation_sent")
            .select("id")
            .eq("kind", "SDR_FIRST_TOUCH")
            .eq("subject_id", leadPhone)
            .limit(1);
          if (!ever?.length) {
            await admin.from("automation_sent").insert({
              kind: "SDR_FIRST_TOUCH",
              subject_id: leadPhone,
              ref_date: todayBRT(),
            });
          }
          leadMessage = "atendente";
        } else {
          // Sem marcar o lead: a varredura do funnel-sweeper tenta de novo.
          leadMessage = "falhou";
        }
      }
    }

    console.log("CRM lead notification sent", {
      lead_id: claimedLead.id,
      tenant_id: claimedLead.tenant_id,
      lead_message: leadMessage,
    });
    return json({ success: true, lead_message: leadMessage });
  } catch (error) {
    if (claimedLead) {
      await admin
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
