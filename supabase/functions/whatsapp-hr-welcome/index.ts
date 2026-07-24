import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import {
  authorizeRequest,
  methodNotAllowed,
} from "../_shared/request-auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://wisewolflanguage.com.br",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type ApplicationRow = {
  id: string;
  tenant_id: string;
  name: string;
  whatsapp: string;
  role: string | null;
  preinterview_status: string | null;
  welcome_notification_sent_at: string | null;
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

function normalizeBrazilPhone(value: string): string {
  const digits = value.replace(/\D/g, "");
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
  if (!auth.ok) return auth.response;
  if (!auth.context.isService) return json({ error: "Service access required" }, 403);

  let claimedApplication: ApplicationRow | null = null;

  try {
    const payload = await req.json().catch(() => ({}));
    if (!isUuid(payload?.application_id)) {
      return json({ error: "application_id is required" }, 400);
    }

    const selectColumns = "id, tenant_id, name, whatsapp, role, preinterview_status, welcome_notification_sent_at";
    const { data: application, error: lookupError } = await auth.context.admin
      .from("job_applications")
      .select(selectColumns)
      .eq("id", payload.application_id)
      .maybeSingle();

    if (lookupError) {
      console.error("HR welcome application lookup failed", { code: lookupError.code });
      return json({ error: "Unable to load application" }, 503);
    }
    if (!application) return json({ error: "Application not found" }, 404);
    if (application.welcome_notification_sent_at) {
      return json({ success: true, already_processed: true });
    }

    const claimedAt = new Date().toISOString();
    const { data: claimed, error: claimError } = await auth.context.admin
      .from("job_applications")
      .update({ welcome_notification_sent_at: claimedAt })
      .eq("id", application.id)
      .is("welcome_notification_sent_at", null)
      .select(selectColumns)
      .maybeSingle();

    if (claimError) {
      console.error("HR welcome claim failed", { code: claimError.code });
      return json({ error: "Unable to claim notification" }, 503);
    }
    if (!claimed) return json({ success: true, already_processed: true });
    claimedApplication = claimed as ApplicationRow;

    const evolutionBase = (Deno.env.get("EVOLUTION_API_URL") ?? "https://api.2b.app.br")
      .replace(/\/+$/, "");
    const evolutionKey = Deno.env.get("EVOLUTION_API_KEY")?.trim() ?? "";
    if (!evolutionKey) throw new Error("Evolution integration is unavailable");

    const { data: director, error: directorError } = await auth.context.admin
      .from("profiles")
      .select("whatsapp_instance")
      .eq("tenant_id", claimedApplication.tenant_id)
      .in("role", ["SCHOOL_ADMIN", "SUPER_ADMIN"])
      .not("whatsapp_instance", "is", null)
      .neq("whatsapp_instance", "")
      .limit(1)
      .maybeSingle();
    if (directorError) throw new Error("Director lookup failed");

    let instanceName = director?.whatsapp_instance?.trim() ?? "";
    if (!instanceName) {
      const { data: instance, error: instanceError } = await auth.context.admin
        .from("whatsapp_instances")
        .select("instance_name")
        .eq("tenant_id", claimedApplication.tenant_id)
        .eq("status", "open")
        .limit(1)
        .maybeSingle();
      if (instanceError) throw new Error("WhatsApp instance lookup failed");
      instanceName = instance?.instance_name?.trim() ?? "";
    }
    if (!instanceName) throw new Error("WhatsApp instance is unavailable");

    const phone = normalizeBrazilPhone(claimedApplication.whatsapp);
    if (phone.length < 12) throw new Error("Application phone is invalid");

    const firstName = claimedApplication.name.trim().split(/\s+/)[0] || "Candidato";
    const isTeacher = !claimedApplication.role ||
      claimedApplication.role.toLowerCase() === "professor";

    let groupBlock = "";
    const { data: tenant } = await auth.context.admin
      .from("tenants")
      .select("talent_group_link")
      .eq("id", claimedApplication.tenant_id)
      .maybeSingle();
    if (tenant?.talent_group_link) {
      groupBlock = `\n\n🎓 *Enquanto isso, entre no nosso Grupo de Talentos:*\n${tenant.talent_group_link}\n\nÉ por lá que as vagas abrem primeiro.`;
    }

    const message = isTeacher
      ? `🐺 *Wise Wolf Language — Processo Seletivo*\n\nOlá, *${firstName}*! 👋\n\nRecebemos sua candidatura para a vaga de *Professor(a) de Inglês* com sucesso. ✅\n\nPara iniciar sua triagem, responda esta mensagem com um *"Oi"*.${groupBlock}\n\n_Equipe Wise Wolf_ 🐾`
      : `🐺 *Wise Wolf Language — Processo Seletivo*\n\nOlá, *${firstName}*! 👋\n\nRecebemos sua candidatura com sucesso. Nossa equipe analisará seu perfil e entrará em contato com os próximos passos.${groupBlock}\n\n_Equipe Wise Wolf_ 🐾`;

    const response = await fetch(
      `${evolutionBase}/message/sendText/${encodeURIComponent(instanceName)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": evolutionKey,
        },
        body: JSON.stringify({
          number: phone,
          options: { delay: 1200, presence: "composing", linkPreview: false },
          textMessage: { text: message },
          text: message,
        }),
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!response.ok) throw new Error(`Evolution request failed (${response.status})`);

    if (isTeacher && !claimedApplication.preinterview_status) {
      const { error: updateError } = await auth.context.admin
        .from("job_applications")
        .update({
          preinterview_status: "SENT",
          preinterview_sent_at: new Date().toISOString(),
        })
        .eq("id", claimedApplication.id)
        .is("preinterview_status", null);
      if (updateError) {
        console.error("HR preinterview status update failed", { code: updateError.code });
      }
    }

    console.log("HR welcome notification sent", {
      application_id: claimedApplication.id,
      tenant_id: claimedApplication.tenant_id,
      teacher: isTeacher,
    });
    return json({ success: true });
  } catch (error) {
    if (claimedApplication) {
      await auth.context.admin
        .from("job_applications")
        .update({ welcome_notification_sent_at: null })
        .eq("id", claimedApplication.id)
        .eq("welcome_notification_sent_at", claimedApplication.welcome_notification_sent_at);
    }
    console.error("HR welcome notification failed", {
      message: error instanceof Error ? error.message : "unknown error",
    });
    return json({ error: "Notification failed" }, 502);
  }
});
