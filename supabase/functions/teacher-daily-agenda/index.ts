import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Cron diário (06:00 BRT): a INSTÂNCIA CENTRAL da escola envia, no privado de cada
// professor, a agenda de aulas do dia — um lembrete matinal.
// Professores NÃO têm mais instância própria; quem dispara é sempre a central.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const EVOLUTION_API_BASE = "https://api.2b.app.br/message/sendText";
const API_TOKEN = "8828462c98512411df3acfe3df4e48a1";

function normalizePhone(raw: string): string | null {
  let phone = (raw || "").replace(/\D/g, "");
  if (phone.length === 10 || phone.length === 11) phone = "55" + phone;
  if (phone.length < 12) return null;
  return phone;
}

async function resolveCentralInstance(supabase: any, tenantId: string | null, cache: Record<string, string | null>): Promise<string | null> {
  const key = tenantId || "_";
  if (key in cache) return cache[key];
  if (!tenantId) { cache[key] = null; return null; }
  const { data } = await supabase
    .from("profiles")
    .select("whatsapp_instance")
    .eq("tenant_id", tenantId)
    .in("role", ["SCHOOL_ADMIN", "SUPER_ADMIN"])
    .not("whatsapp_instance", "is", null)
    .neq("whatsapp_instance", "")
    .limit(1)
    .maybeSingle();
  cache[key] = data?.whatsapp_instance || null;
  return cache[key];
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    // "Hoje" no fuso de São Paulo (UTC-3). O cron roda 09:00 UTC = 06:00 BRT.
    const todayBRT = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().split("T")[0];

    // 1. Aulas de hoje
    const { data: classes, error } = await supabase
      .from("upcoming_classes")
      .select("teacher_id, student_id, student_name_override, class_date, time_text, start_at")
      .eq("class_date", todayBRT);

    if (error) throw error;
    if (!classes || classes.length === 0) {
      return new Response(JSON.stringify({ sent: 0, message: "sem aulas hoje" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 2. Nomes dos alunos (batch)
    const studentIds = [...new Set(classes.map((c: any) => c.student_id).filter(Boolean))];
    const nameById: Record<string, string> = {};
    if (studentIds.length) {
      const { data: studs } = await supabase.from("profiles").select("id, full_name").in("id", studentIds);
      (studs || []).forEach((s: any) => { nameById[s.id] = s.full_name; });
    }

    // 3. Agrupa por professor
    const byTeacher: Record<string, any[]> = {};
    for (const c of classes as any[]) {
      if (!c.teacher_id) continue;
      (byTeacher[c.teacher_id] ||= []).push(c);
    }
    const teacherIds = Object.keys(byTeacher);

    // 4. Perfis dos professores
    const { data: teachers } = await supabase
      .from("profiles")
      .select("id, full_name, phone, tenant_id, date_automation_enabled")
      .in("id", teacherIds);
    const teacherById: Record<string, any> = {};
    (teachers || []).forEach((t: any) => { teacherById[t.id] = t; });

    let sent = 0;
    const failures: string[] = [];
    const instanceCache: Record<string, string | null> = {};

    for (const tid of teacherIds) {
      const t = teacherById[tid];
      if (!t) { failures.push(`${tid}: professor não encontrado`); continue; }
      if (t.date_automation_enabled === false) continue; // professor optou por não receber

      const phone = normalizePhone(t.phone || "");
      if (!phone) { failures.push(`${tid}: telefone inválido`); continue; }

      const instance = await resolveCentralInstance(supabase, t.tenant_id, instanceCache);
      if (!instance) { failures.push(`${tid}: escola sem WhatsApp central`); continue; }

      // Monta a agenda ordenada por horário
      const aulas = byTeacher[tid]
        .slice()
        .sort((a, b) => String(a.time_text || a.start_at).localeCompare(String(b.time_text || b.start_at)));
      const linhas = aulas.map((a) => {
        const hora = (a.time_text || (a.start_at ? new Date(a.start_at).toISOString().slice(11, 16) : "")) || "--:--";
        const aluno = (a.student_id && nameById[a.student_id]) || a.student_name_override || "Aluno";
        return `🕐 *${hora}* — ${aluno}`;
      }).join("\n");

      const primeiro = (t.full_name || "").split(" ")[0] || "";
      const text = `Bom dia${primeiro ? `, ${primeiro}` : ""}! 🐺☀️\n\nSua agenda de hoje na Wise Wolf (${aulas.length} ${aulas.length === 1 ? "aula" : "aulas"}):\n\n${linhas}\n\nBom trabalho! 💜`;

      try {
        const resp = await fetch(`${EVOLUTION_API_BASE}/${instance}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", apikey: API_TOKEN },
          body: JSON.stringify({ number: phone, text, delay: 1000 }),
        });
        if (!resp.ok) {
          const errText = await resp.text();
          failures.push(`${tid}: evolution ${resp.status}`);
          console.error("Evolution error:", errText);
          continue;
        }
        sent++;
      } catch (inner) {
        console.error(`Erro agenda ${tid}:`, inner);
        failures.push(`${tid}: ${(inner as Error).message}`);
      }
    }

    return new Response(
      JSON.stringify({ date: todayBRT, teachers: teacherIds.length, sent, failures: failures.length, failure_reasons: failures.slice(0, 10) }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e: any) {
    console.error("Fatal:", e);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
