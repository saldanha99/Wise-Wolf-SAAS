import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const DAY_INDEX: Record<string, number> = {
  Domingo: 0, Segunda: 1, Terça: 2, Quarta: 3, Quinta: 4, Sexta: 5, Sábado: 6,
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, "Content-Type": "application/json" },
});

function isValidLookupToken(value: string): boolean {
  return /^[A-Za-z0-9._~-]{20,512}$/.test(value);
}

function normalizePhone(raw: string | null): string | null {
  let phone = (raw || "").replace(/\D/g, "");
  if (phone.length === 10 || phone.length === 11) phone = `55${phone}`;
  return phone.length >= 12 ? phone : null;
}

function nextStart(day: string, time: string, explicit?: string): string | null {
  if (explicit && !Number.isNaN(new Date(explicit).getTime())) return new Date(explicit).toISOString();
  if (!(day in DAY_INDEX) || !/^\d{2}:\d{2}$/.test(time)) return null;

  const now = Date.now();
  const brtNow = new Date(now - 3 * 60 * 60 * 1000);
  let delta = (DAY_INDEX[day] - brtNow.getUTCDay() + 7) % 7;
  let date = new Date(Date.UTC(brtNow.getUTCFullYear(), brtNow.getUTCMonth(), brtNow.getUTCDate() + delta));
  let ymd = date.toISOString().split("T")[0];
  let start = new Date(`${ymd}T${time}:00-03:00`);
  if (start.getTime() < now + 60 * 60 * 1000) {
    date = new Date(date.getTime() + 7 * 24 * 60 * 60 * 1000);
    ymd = date.toISOString().split("T")[0];
    start = new Date(`${ymd}T${time}:00-03:00`);
  }
  return start.toISOString();
}

function dateLabels(iso: string): { dateLabel: string; timeLabel: string } {
  const date = new Date(iso);
  return {
    dateLabel: new Intl.DateTimeFormat("pt-BR", {
      timeZone: "America/Sao_Paulo", weekday: "long", day: "2-digit", month: "long", year: "numeric",
    }).format(date),
    timeLabel: new Intl.DateTimeFormat("pt-BR", {
      timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit",
    }).format(date),
  };
}

async function sendWhats(instance: string, number: string | null, text: string): Promise<boolean> {
  const apiUrl = (Deno.env.get("EVOLUTION_API_URL") || "https://api.2b.app.br").replace(/\/+$/, "");
  const apiKey = Deno.env.get("EVOLUTION_API_KEY") || "";
  if (!number || !apiKey) return false;
  try {
    const response = await fetch(`${apiUrl}/message/sendText/${encodeURIComponent(instance)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: apiKey },
      body: JSON.stringify({ number, text, delay: 900, linkPreview: false }),
      signal: AbortSignal.timeout(15000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const url = new URL(req.url);
    const token = url.searchParams.get("token") || "";
    const legacyOpportunityId = url.searchParams.get("legacy") || "";
    if (token && !isValidLookupToken(token)) return json({ ok: false, message: "Link inválido." }, 404);
    if (!token && !/^[0-9a-f-]{36}$/i.test(legacyOpportunityId)) return json({ ok: false, message: "Link inválido." }, 404);

    const sb = createClient(Deno.env.get("SUPABASE_URL") || "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "");
    let linkQuery = sb.from("enrollment_links")
      .select("id, tenant_id, opportunity_id, link_token, link_url, status, student_name, student_phone, professor_id, used_at")
      .limit(1);
    linkQuery = token
      ? linkQuery.eq("link_token", token)
      : linkQuery.eq("opportunity_id", legacyOpportunityId).like("link_url", "%/experimental?data=%");
    const { data: link } = await linkQuery.maybeSingle();
    if (!link || !link.opportunity_id || !link.professor_id) return json({ ok: false, message: "Link inválido ou expirado." }, 404);

    const { data: opportunity } = await sb.from("opportunities")
      .select("id, tenant_id, student_name, student_phone, slots_proposed, trial_appointment_id")
      .eq("id", link.opportunity_id).maybeSingle();
    if (!opportunity) return json({ ok: false, message: "A oportunidade não foi encontrada." }, 404);

    const { data: teacher } = await sb.from("profiles").select("id, full_name, phone").eq("id", link.professor_id).maybeSingle();
    const { data: tenant } = await sb.from("tenants").select("name").eq("id", link.tenant_id).maybeSingle();
    if (!teacher) return json({ ok: false, message: "Professor não encontrado." }, 409);

    const slot = Array.isArray(opportunity.slots_proposed) ? opportunity.slots_proposed[0] : null;
    const startsAt = nextStart(String(slot?.day || ""), String(slot?.time || ""), slot?.start_time);
    if (!startsAt || new Date(startsAt).getTime() <= Date.now()) {
      return json({ ok: false, message: "O horário deste link expirou. Solicite outro à escola." }, 410);
    }

    const labels = dateLabels(startsAt);
    const base = {
      ok: true,
      firstName: String(link.student_name || opportunity.student_name || "Aluno(a)").trim().split(/\s+/)[0],
      teacherName: String(teacher.full_name || "Professor(a)").trim().split(/\s+/)[0],
      schoolName: tenant?.name || "Wise Wolf Language School",
      startsAt,
      ...labels,
    };
    if (link.status === "USED" || opportunity.trial_appointment_id) return json({ ...base, confirmed: true });

    const startDate = new Date(startsAt);
    const windowStart = new Date(startDate.getTime() - 29 * 60 * 1000).toISOString();
    const windowEnd = new Date(startDate.getTime() + 29 * 60 * 1000).toISOString();
    const { count: appointmentConflicts } = await sb.from("appointments").select("id", { count: "exact", head: true })
      .eq("teacher_id", teacher.id).neq("status", "cancelled").gte("start_time", windowStart).lte("start_time", windowEnd);

    const [slotHour, slotMinute] = String(slot?.time || "").split(":").map(Number);
    const slotMinutes = slotHour * 60 + slotMinute;
    const { data: recurring } = await sb.from("bookings").select("time_slot")
      .eq("teacher_id", teacher.id).eq("day_of_week", String(slot?.day || ""));
    const recurringConflict = (recurring || []).some((booking) => {
      const [hour, minute] = String(booking.time_slot || "").slice(0, 5).split(":").map(Number);
      return Number.isFinite(hour) && Math.abs((hour * 60 + minute) - slotMinutes) < 30;
    });
    const conflict = Boolean(appointmentConflicts || recurringConflict);
    if (req.method !== "POST") return json({ ...base, confirmed: false, conflict });
    if (conflict) return json({ ...base, confirmed: false, conflict: true, message: "Horário indisponível." }, 409);

    const { data: claimed } = await sb.from("enrollment_links")
      .update({ status: "USED", used_at: new Date().toISOString() })
      .eq("id", link.id).eq("status", "PENDING").select("id").maybeSingle();
    if (!claimed) return json({ ...base, confirmed: true });

    const { data: appointment, error: appointmentError } = await sb.from("appointments").insert({
      start_time: startsAt,
      status: "scheduled",
      type: "experimental",
      professor_id: teacher.id,
      teacher_id: teacher.id,
      tenant_id: opportunity.tenant_id,
      student_name: opportunity.student_name,
      student_phone: opportunity.student_phone,
    }).select("id").single();

    if (appointmentError || !appointment) {
      await sb.from("enrollment_links").update({ status: "PENDING", used_at: null }).eq("id", link.id);
      throw appointmentError || new Error("Falha ao criar o agendamento.");
    }

    const { data: updatedOpportunity, error: opportunityError } = await sb.from("opportunities").update({
      status: "CLAIMED",
      winner_teacher_id: teacher.id,
      trial_appointment_id: appointment.id,
      trial_status: "SCHEDULED",
      conversion_status: "OPEN",
    }).eq("id", opportunity.id).is("trial_appointment_id", null).select("id").maybeSingle();

    if (opportunityError || !updatedOpportunity) {
      await sb.from("appointments").delete().eq("id", appointment.id);
      await sb.from("enrollment_links").update({ status: "PENDING", used_at: null }).eq("id", link.id);
      throw opportunityError;
    }

    const { data: admin } = await sb.from("profiles").select("whatsapp_instance")
      .eq("tenant_id", link.tenant_id).in("role", ["SCHOOL_ADMIN", "SUPER_ADMIN"])
      .not("whatsapp_instance", "is", null).neq("whatsapp_instance", "").limit(1).maybeSingle();
    if (admin?.whatsapp_instance) {
      const studentText = `Olá ${base.firstName}! 🐺 Sua aula experimental com ${base.teacherName} foi confirmada para ${labels.dateLabel}, às ${labels.timeLabel}. A escola enviará o link da aula pelo WhatsApp.`;
      const teacherText = `🐺 Nova aula experimental confirmada\n\nAluno(a): ${opportunity.student_name}\nData: ${labels.dateLabel}\nHorário: ${labels.timeLabel}`;
      await Promise.all([
        sendWhats(admin.whatsapp_instance, normalizePhone(opportunity.student_phone), studentText),
        sendWhats(admin.whatsapp_instance, normalizePhone(teacher.phone), teacherText),
      ]);
    }

    return json({ ...base, confirmed: true });
  } catch (error) {
    console.error("confirm-vendor-trial:", error);
    return json({ ok: false, message: error instanceof Error ? error.message : "Erro interno." }, 500);
  }
});
