import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Cron semanal (segunda de manhã): resumo de métricas da semana para o diretor de cada escola.
// Enviado pela instância central da escola para o telefone do SCHOOL_ADMIN.
// Idempotente via automation_sent (kind=WEEKLY_DIGEST, subject_id=tenant_id, ref_date=hoje).

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
const money = (v: any) => `R$ ${Number(v || 0).toFixed(2).replace(".", ",")}`;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
    const today = new Date().toISOString().split("T")[0];

    const { data: rows } = await supabase.rpc("weekly_digest_rows");
    const result = { sent: 0, skipped: 0, failures: [] as string[] };

    for (const r of (rows || [])) {
      const phone = normPhone(r.director_phone || "");
      if (phone.length < 12) { result.skipped++; continue; }

      // dedupe
      const { data: dup } = await supabase.from("automation_sent").select("id")
        .eq("kind", "WEEKLY_DIGEST").eq("subject_id", r.tenant_id).eq("ref_date", today).maybeSingle();
      if (dup) { result.skipped++; continue; }

      // instância central da escola
      const { data: adm } = await supabase.from("profiles").select("whatsapp_instance")
        .eq("tenant_id", r.tenant_id).in("role", ["SCHOOL_ADMIN", "SUPER_ADMIN"])
        .not("whatsapp_instance", "is", null).neq("whatsapp_instance", "").limit(1).maybeSingle();
      const instance = adm?.whatsapp_instance;
      if (!instance) { result.failures.push(`${r.tenant_id}: sem WhatsApp central`); continue; }

      const text = `📊 *Resumo da semana — ${r.school}*\n\n` +
        `👥 Alunos ativos: *${r.active_students}*\n` +
        `📚 Aulas (últimos 7 dias): *${r.classes_week}*\n` +
        `💰 Recebido na semana: *${money(r.received_week)}*\n` +
        `⚠️ Inadimplência: *${r.overdue_count}* ${r.overdue_count === 1 ? "cobrança" : "cobranças"} (${money(r.overdue_amount)})\n\n` +
        `Tenha uma ótima semana! 🐺💜`;

      const resp = await fetch(`${EVOLUTION_API_BASE}/${instance}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: API_TOKEN },
        body: JSON.stringify({ number: phone, text, delay: 800, linkPreview: false }),
      });
      if (!resp.ok) { result.failures.push(`${r.tenant_id}: evolution ${resp.status}`); continue; }
      await supabase.from("automation_sent").insert({ kind: "WEEKLY_DIGEST", subject_id: r.tenant_id, ref_date: today });
      result.sent++;
    }

    return new Response(JSON.stringify(result), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
