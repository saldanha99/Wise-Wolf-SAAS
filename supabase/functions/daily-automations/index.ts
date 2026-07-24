import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authorizeAutomation } from "../_shared/automation-auth.ts";

// Cron diário (manhã): 3 automações por tenant, enviadas pela instância central da escola.
//   1. BIRTHDAY        — aniversário de alunos E professores
//   2. TEACHER_AGENDA  — agenda de aulas do dia para cada professor
//   3. TRIAL_FOLLOWUP  — follow-up de aula experimental feita há 2 dias sem matrícula
// Idempotente via tabela automation_sent (kind, subject_id, ref_date=hoje).

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const EVOLUTION_API_BASE = "https://api.2b.app.br/message/sendText";
const API_TOKEN = Deno.env.get("EVOLUTION_API_KEY") || "";

function normPhone(raw: string): string {
  let p = (raw || "").replace(/\D/g, "");
  if (p.length === 10 || p.length === 11) p = "55" + p;
  return p;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const authError = await authorizeAutomation(req, corsHeaders, { allowAdmin: true });
  if (authError) return authError;
  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
    const today = new Date().toISOString().split("T")[0];

    // cache de {instance, name} por tenant
    const metaCache: Record<string, { instance: string | null; name: string }> = {};
    async function meta(tenantId: string) {
      if (!(tenantId in metaCache)) {
        const { data: adm } = await supabase.from("profiles").select("whatsapp_instance")
          .eq("tenant_id", tenantId).in("role", ["SCHOOL_ADMIN", "SUPER_ADMIN"])
          .not("whatsapp_instance", "is", null).neq("whatsapp_instance", "").limit(1).maybeSingle();
        const { data: t } = await supabase.from("tenants").select("name").eq("id", tenantId).maybeSingle();
        metaCache[tenantId] = { instance: adm?.whatsapp_instance || null, name: t?.name || "Wise Wolf" };
      }
      return metaCache[tenantId];
    }
    async function already(kind: string, subj: string) {
      const { data } = await supabase.from("automation_sent").select("id")
        .eq("kind", kind).eq("subject_id", subj).eq("ref_date", today).maybeSingle();
      return !!data;
    }
    async function markSent(kind: string, subj: string) {
      await supabase.from("automation_sent").insert({ kind, subject_id: subj, ref_date: today });
    }
    async function send(instance: string, phone: string, text: string) {
      const r = await fetch(`${EVOLUTION_API_BASE}/${instance}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: API_TOKEN },
        body: JSON.stringify({ number: phone, text, delay: 800, linkPreview: true }),
      });
      return r.ok;
    }

    const result = { birthdays: 0, agendas: 0, trials: 0, skipped: 0, failures: [] as string[] };

    // ───────────────────────────── 1. ANIVERSÁRIOS (aluno + professor)
    const { data: bdays } = await supabase.rpc("birthdays_today");
    for (const b of (bdays || [])) {
      const subj = b.id;
      if (await already("BIRTHDAY", subj)) { result.skipped++; continue; }
      const { instance, name: escola } = await meta(b.tenant_id);
      if (!instance) { result.failures.push(`bday ${subj}: tenant sem WhatsApp central`); continue; }
      const phone = normPhone(b.phone);
      if (phone.length < 12) { result.failures.push(`bday ${subj}: telefone inválido`); continue; }
      const nome = (b.name || "").trim().split(" ")[0];
      const text = b.role === "TEACHER"
        ? `Feliz aniversário, ${nome}! 🎉🐺\n\nToda a equipe da ${escola} agradece por ensinar com tanto carinho. Que seu dia seja incrível e cheio de alegria! 💜`
        : `Feliz aniversário, ${nome}! 🎉🐺\n\nA ${escola} deseja um dia maravilhoso pra você. Continue brilhando nos estudos — estamos com você! 💜`;
      if (await send(instance, phone, text)) { await markSent("BIRTHDAY", subj); result.birthdays++; }
      else result.failures.push(`bday ${subj}: falha no envio`);
    }

    // ───────────────────────────── 2. AGENDA DIÁRIA DO PROFESSOR
    const { data: agendas } = await supabase.rpc("teacher_agendas_today");
    for (const a of (agendas || [])) {
      const subj = a.teacher_id;
      if (await already("TEACHER_AGENDA", subj)) { result.skipped++; continue; }
      const { instance } = await meta(a.tenant_id);
      if (!instance) { result.failures.push(`agenda ${subj}: tenant sem WhatsApp central`); continue; }
      const phone = normPhone(a.phone);
      if (phone.length < 12) { result.failures.push(`agenda ${subj}: telefone inválido`); continue; }
      const nome = (a.name || "").trim().split(" ")[0];
      const aulas = (a.classes || []);
      const lista = aulas.map((c: any) => `• ${c.time || "--:--"} — ${(c.student || "aluno").trim()}`).join("\n");
      const n = aulas.length;
      const text = `Bom dia, ${nome}! 🐺☀️\n\nVocê tem *${n} ${n === 1 ? "aula" : "aulas"}* hoje:\n\n${lista}\n\nBom trabalho! 💜`;
      if (await send(instance, phone, text)) { await markSent("TEACHER_AGENDA", subj); result.agendas++; }
      else result.failures.push(`agenda ${subj}: falha no envio`);
    }

    // ───────────────────────────── 3. FOLLOW-UP DE AULA EXPERIMENTAL
    const { data: trials } = await supabase.rpc("trial_followups");
    for (const t of (trials || [])) {
      const subj = t.appointment_id;
      if (await already("TRIAL_FOLLOWUP", subj)) { result.skipped++; continue; }
      const { instance, name: escola } = await meta(t.tenant_id);
      if (!instance) { result.failures.push(`trial ${subj}: tenant sem WhatsApp central`); continue; }
      const phone = normPhone(t.phone);
      if (phone.length < 12) { result.failures.push(`trial ${subj}: telefone inválido`); continue; }
      const nome = (t.student_name || "").trim().split(" ")[0] || "tudo bem";
      const text = `Oi ${nome}! 🐺\n\nQue bom ter você na sua aula experimental aqui na ${escola}! 😊\n\nGostou da experiência? Garanta já a sua vaga e continue evoluindo no inglês com a gente. Posso te ajudar a escolher o melhor horário pra você? 💜`;
      if (await send(instance, phone, text)) { await markSent("TRIAL_FOLLOWUP", subj); result.trials++; }
      else result.failures.push(`trial ${subj}: falha no envio`);
    }

    return new Response(JSON.stringify(result), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
