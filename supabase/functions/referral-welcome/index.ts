/// <reference lib="deno.ns" />

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.93.3";
import { methodNotAllowed } from "../_shared/request-auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const evolutionApiUrl = (Deno.env.get("EVOLUTION_API_URL") || "https://api.2b.app.br").replace(/\/+$/, "");
const evolutionApiKey = Deno.env.get("EVOLUTION_API_KEY") || "";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return methodNotAllowed(corsHeaders);

  try {
    const body = await req.json();
    const inviteeName = typeof body.invitee_name === "string" ? body.invitee_name.trim().slice(0, 120) : "";
    const inviteeEmail = typeof body.invitee_email === "string" ? body.invitee_email.trim().toLowerCase().slice(0, 254) : "";
    const inviteePhone = typeof body.invitee_phone === "string" ? body.invitee_phone.replace(/\D/g, "") : "";
    const referrerId = typeof body.referrer_id === "string" ? body.referrer_id.trim() : "";
    if (
      inviteeName.length < 2
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inviteeEmail)
      || !/^\d{10,13}$/.test(inviteePhone)
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(referrerId)
    ) {
      return json({ error: "Invalid referral data" }, 400);
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL") || "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
      { auth: { autoRefreshToken: false, persistSession: false } },
    );

    const clientAddress = (req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for") || "unknown")
      .split(",")[0].trim();
    const rateKey = await sha256(`${clientAddress}:${referrerId}`);
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data: currentLimit } = await admin
      .from("referral_submission_limits")
      .select("request_count, window_started_at")
      .eq("rate_key", rateKey)
      .maybeSingle();
    if (currentLimit && currentLimit.window_started_at > oneHourAgo && currentLimit.request_count >= 5) {
      return json({ error: "Too many attempts. Try again later." }, 429);
    }
    const resetWindow = !currentLimit || currentLimit.window_started_at <= oneHourAgo;
    const { error: rateError } = await admin.from("referral_submission_limits").upsert({
      rate_key: rateKey,
      window_started_at: resetWindow ? new Date().toISOString() : currentLimit.window_started_at,
      request_count: resetWindow ? 1 : currentLimit.request_count + 1,
      updated_at: new Date().toISOString(),
    });
    if (rateError) return json({ error: "Could not process referral" }, 503);

    const { data: referrer, error: referrerError } = await admin
      .from("profiles")
      .select("id, full_name, whatsapp_instance, tenant_id")
      .eq("id", referrerId)
      .not("tenant_id", "is", null)
      .maybeSingle();
    if (referrerError || !referrer?.tenant_id) return json({ error: "Referrer not found" }, 404);

    const { data: existing } = await admin
      .from("referral_invites")
      .select("id, status")
      .eq("referrer_id", referrerId)
      .eq("invitee_email", inviteeEmail)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existing?.status === "CONVERTED") {
      return json({ success: true, already_registered: true });
    }

    const inviteData = {
      referrer_id: referrerId,
      invitee_name: inviteeName,
      invitee_email: inviteeEmail,
      invitee_phone: inviteePhone,
      tenant_id: referrer.tenant_id,
      status: "PENDING",
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    };
    const inviteWrite = existing
      ? await admin.from("referral_invites").update(inviteData).eq("id", existing.id)
      : await admin.from("referral_invites").insert(inviteData);
    if (inviteWrite.error) {
      console.error("Referral persistence failed", { code: inviteWrite.error.code });
      return json({ error: "Could not register referral" }, 500);
    }

    let instanceName = referrer.whatsapp_instance;
    if (!instanceName) {
      const { data: adminProfile } = await admin
        .from("profiles")
        .select("whatsapp_instance")
        .eq("tenant_id", referrer.tenant_id)
        .in("role", ["SCHOOL_ADMIN", "SUPER_ADMIN"])
        .not("whatsapp_instance", "is", null)
        .limit(1)
        .maybeSingle();
      instanceName = adminProfile?.whatsapp_instance || null;
    }

    let sent = false;
    if (instanceName && evolutionApiKey) {
      const phoneWithCountry = inviteePhone.startsWith("55") ? inviteePhone : `55${inviteePhone}`;
      const referrerName = (referrer.full_name || "seu amigo").split(" ")[0];
      const firstName = inviteeName.split(" ")[0];
      const message = `Oi ${firstName}! 🐺\n\n*${referrerName}* te indicou para aprender inglês na *Wise Wolf Language School*!\n\nNossa equipe vai entrar em contato em breve para apresentar os planos e agendar sua aula experimental gratuita.`;
      const response = await fetch(`${evolutionApiUrl}/message/sendText/${encodeURIComponent(instanceName)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: evolutionApiKey },
        body: JSON.stringify({ number: phoneWithCountry, text: message }),
        signal: AbortSignal.timeout(10000),
      }).catch(() => null);
      sent = Boolean(response?.ok);
    }

    return json({ success: true, whatsapp_sent: sent });
  } catch (error) {
    console.error("Referral submission failed", {
      message: error instanceof Error ? error.message : "unknown error",
    });
    return json({ error: "Invalid request" }, 400);
  }
});
