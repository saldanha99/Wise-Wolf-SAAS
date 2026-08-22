import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  loadTenantCommunicationIdentity,
  loadTenantWhatsAppRoute,
} from "../_shared/tenant-communication.ts";

// BOOK-INTERVIEW — API de agendamento de entrevista do candidato a professor.
//
// O funil de contratação morria aqui: a Rita (triagem IA) aprovava o candidato
// (ai_recommendation = ENTREVISTAR) e NENHUM código escrevia interview_slot —
// ~60 candidaturas paradas e ~2 entrevistas em 2 meses. Este endpoint fecha o ciclo.
//
// A PÁGINA fica no frontend (system.wisewolflanguage.com.br/book-interview, padrão
// /claim-opportunity) — a Supabase passou a forçar text/plain + CSP sandbox em
// respostas HTML no domínio *.supabase.co (anti-phishing), então edge servindo
// HTML direto não renderiza mais. Esta função é só JSON:
//
//   GET  ?t=<booking_token>                 → { ok, name, booked, slots[] }
//   POST { t, slot }                        → reserva atômica + confirmações WhatsApp
//
// Quem envia o link é o funnel-sweeper (convite + follow-ups 24h/72h). O lembrete
// no dia da entrevista já existia no sdr-followups (RITA_INTERVIEW_REMIND).
//
// Regras:
// - Janelas configuráveis em tenants.ai_team_config.rh.interview_windows
//   (default: seg-sex 18:00-21:00 BRT, blocos de 30 min, próximos 7 dias, lead 3h).
// - Corrida de horário: índice único (tenant_id, interview_slot) → o segundo
//   candidato no mesmo slot recebe { reason: "taken" } e a lista atualizada.
// - Slot enviado no POST é validado contra a lista gerada no servidor (nunca
//   se aceita timestamp arbitrário do cliente).

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const EVOLUTION_API_BASE = "https://api.2b.app.br/message/sendText";
const EVOLUTION_KEYS = Array.from(new Set([
  (Deno.env.get("EVOLUTION_API_KEY") || "").trim(),
].filter(Boolean)));

const BRT_OFFSET_MS = 3 * 3600 * 1000; // Brasil não tem mais horário de verão
const DEFAULT_WINDOWS = [{ days: [1, 2, 3, 4, 5], start: "18:00", end: "21:00" }];
const DEFAULT_SLOT_MINUTES = 30;
const HORIZON_DAYS = 7;
const MIN_LEAD_HOURS = 3;

async function sendWhats(instance: string, number: string, text: string): Promise<boolean> {
  for (const key of EVOLUTION_KEYS) {
    try {
      const resp = await fetch(`${EVOLUTION_API_BASE}/${encodeURIComponent(instance)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: key },
        body: JSON.stringify({ number, text, delay: 1200, linkPreview: false }),
        signal: AbortSignal.timeout(15000),
      });
      if (resp.status === 401) continue;
      return resp.ok;
    } catch { return false; }
  }
  return false;
}

function cleanPhone(raw: string): string {
  let p = (raw || "").replace(/\D/g, "");
  if (p.length === 10 || p.length === 11) p = "55" + p;
  return p;
}

// Gera os slots livres (ISO UTC) a partir das janelas BRT do tenant
function generateSlots(windows: Array<{ days: number[]; start: string; end: string }>, slotMinutes: number, bookedIso: Set<string>): string[] {
  const out: string[] = [];
  const now = Date.now();
  const minStart = now + MIN_LEAD_HOURS * 3600 * 1000;
  for (let d = 0; d <= HORIZON_DAYS; d++) {
    const brtDay = new Date(now - BRT_OFFSET_MS + d * 86400 * 1000);
    const ymd = brtDay.toISOString().split("T")[0];
    const weekday = brtDay.getUTCDay(); // 0=dom no calendário BRT
    for (const w of windows) {
      if (!Array.isArray(w.days) || !w.days.includes(weekday)) continue;
      if (!/^\d{2}:\d{2}$/.test(w.start || "") || !/^\d{2}:\d{2}$/.test(w.end || "")) continue;
      for (let t = hm(w.start); t + slotMinutes <= hm(w.end); t += slotMinutes) {
        const hhmm = `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
        const iso = new Date(`${ymd}T${hhmm}:00-03:00`).toISOString();
        if (new Date(iso).getTime() < minStart) continue;
        if (bookedIso.has(iso)) continue;
        out.push(iso);
      }
    }
  }
  return out.sort();
}
const hm = (s: string) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };

const fmtBRT = (iso: string) => {
  const d = new Date(new Date(iso).getTime() - BRT_OFFSET_MS);
  const [ymd, rest] = d.toISOString().split("T");
  const [y, mo, day] = ymd.split("-");
  const dows = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];
  return { date: `${day}/${mo}/${y}`, time: rest.slice(0, 5), dow: dows[d.getUTCDay()] };
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
    const url = new URL(req.url);

    let token = "", chosenSlot = "";
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      token = String(body?.t || "");
      chosenSlot = String(body?.slot || "");
    } else {
      token = url.searchParams.get("t") || "";
    }
    if (!/^[0-9a-f-]{36}$/i.test(token)) return json({ ok: false, reason: "not_found" }, 404);

    const { data: app } = await sb.from("job_applications")
      .select("id, tenant_id, name, whatsapp, interview_slot, ai_score, status")
      .eq("booking_token", token).maybeSingle();
    if (!app) return json({ ok: false, reason: "not_found" }, 404);
    const identity = await loadTenantCommunicationIdentity(
      sb,
      app.tenant_id,
    );
    if (!identity) return json({ ok: false, reason: "not_found" }, 404);

    const first = (app.name || "").trim().split(/\s+/)[0] || "candidato(a)";

    // Já agendado → devolve a reserva (idempotente para cliques repetidos no link)
    if (app.interview_slot) {
      return json({ ok: true, name: first, booked: new Date(app.interview_slot).toISOString(), slots: [] });
    }

    // Config de janelas do tenant + slots já reservados por outros candidatos
    const { data: tenant } = await sb.from("tenants").select("ai_team_config").eq("id", app.tenant_id).maybeSingle();
    const rhCfg = (tenant?.ai_team_config as any)?.rh || {};
    const windows = Array.isArray(rhCfg.interview_windows) && rhCfg.interview_windows.length ? rhCfg.interview_windows : DEFAULT_WINDOWS;
    // Clamp ≥10 min: valor zero/negativo em config manual travaria o gerador em loop infinito
    const slotMinutes = Math.max(10, Number(rhCfg.interview_slot_minutes) || DEFAULT_SLOT_MINUTES);

    const { data: taken } = await sb.from("job_applications")
      .select("interview_slot").eq("tenant_id", app.tenant_id).not("interview_slot", "is", null)
      .gte("interview_slot", new Date().toISOString());
    const bookedIso = new Set((taken || []).map((r: any) => new Date(r.interview_slot).toISOString()));
    const free = generateSlots(windows, slotMinutes, bookedIso);

    // ---------- POST: reservar ----------
    if (req.method === "POST") {
      const chosenIso = new Date(chosenSlot).toString() !== "Invalid Date" ? new Date(chosenSlot).toISOString() : "";
      if (!chosenIso || !free.includes(chosenIso)) {
        return json({ ok: false, reason: "taken", name: first, slots: free });
      }
      const { data: updated, error: updErr } = await sb.from("job_applications")
        .update({ interview_slot: chosenIso })
        .eq("booking_token", token).is("interview_slot", null)
        .select("id").maybeSingle();
      if (updErr || !updated) {
        // 23505 = outro candidato levou o slot na corrida; null = duplo clique do próprio
        if (updErr && updErr.code !== "23505") console.error("book-interview update:", updErr.message);
        const stillFree = free.filter((s) => s !== chosenIso);
        return json({ ok: false, reason: "taken", name: first, slots: stillFree });
      }

      const f = fmtBRT(chosenIso);
      // Confirmações WhatsApp (falha de envio não desfaz a reserva)
      const route = await loadTenantWhatsAppRoute(sb, app.tenant_id, "teacher");
      if (route) {
        const candPhone = cleanPhone(app.whatsapp || "");
        if (candPhone.length >= 12) {
          const msg = `✅ Entrevista confirmada, ${first}! ${f.date} (${f.dow}) às ${f.time}, horário de Brasília. A direção da ${identity.brandName} vai te chamar aqui no WhatsApp no horário combinado. A Michelle te lembra no dia 😉 Boa sorte!`;
          if (await sendWhats(route.instanceName, candPhone, msg)) {
            await sb.from("ai_wa_messages").insert({ tenant_id: app.tenant_id, phone: candPhone, agent: "rita", direction: "out", content: msg, meta: { application_id: app.id, kind: "interview_booked" } });
          }
        }
        const ownerPhone = cleanPhone(route.ownerPhone || "");
        if (ownerPhone.length >= 12) {
          await sendWhats(route.instanceName, ownerPhone,
            `📅 *RH (IA):* entrevista AGENDADA — *${app.name}* (${cleanPhone(app.whatsapp || "") || "sem tel"}), ${f.date} às ${f.time}.${app.ai_score != null ? ` Score da triagem: ${app.ai_score}.` : ""} Detalhes no painel RH.`);
        }
      }
      await sb.from("automation_sent").insert({ kind: "INTERVIEW_BOOKED", subject_id: String(app.id), ref_date: new Date(Date.now() - BRT_OFFSET_MS).toISOString().split("T")[0] });

      return json({ ok: true, name: first, booked: chosenIso, slots: [] });
    }

    // ---------- GET: lista de horários ----------
    return json({ ok: true, name: first, booked: null, slots: free.slice(0, 36) });
  } catch (e) {
    console.error("book-interview:", (e as Error).message);
    return json({ ok: false, reason: "error" }, 500);
  }
});
