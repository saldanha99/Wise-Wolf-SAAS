import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Cron mensal (início do mês): gera os fechamentos do mês anterior para todos os professores
// (run_monthly_teacher_closing) e avisa cada professor pelo WhatsApp com o resumo + onde ver o PDF.
// Idempotente: a geração já é idempotente (NOT EXISTS); o aviso usa automation_sent
// (kind=MONTHLY_CLOSING, subject_id=`teacher:month`) ignorando ref_date (1 aviso por mês/professor).

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const EVOLUTION_API_BASE = "https://api.2b.app.br/message/sendText";
const API_TOKEN = "8828462c98512411df3acfe3df4e48a1";
const MONTHS_PT = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

function normPhone(raw: string): string {
  let p = (raw || "").replace(/\D/g, "");
  if (p.length === 10 || p.length === 11) p = "55" + p;
  return p;
}
const money = (v: any) => `R$ ${Number(v || 0).toFixed(2).replace(".", ",")}`;
function monthLabel(m: string) {
  const [y, mo] = (m || "").split("-");
  return mo ? `${MONTHS_PT[Number(mo) - 1]} de ${y}` : m;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
    const today = new Date().toISOString().split("T")[0];

    // mês alvo: body.month ('YYYY-MM') ou mês anterior (default da RPC)
    let month: string | null = null;
    try { const b = await req.json(); month = b?.month || null; } catch { /* sem body */ }

    // 1. Gera os fechamentos (idempotente)
    const { data: gen, error: genErr } = await supabase.rpc("run_monthly_teacher_closing", { p_month: month });
    if (genErr) throw genErr;
    const targetMonth: string = gen?.month || month || "";

    // 2. Avisa cada professor
    const { data: closings } = await supabase.rpc("monthly_closings_to_notify", { p_month: targetMonth });
    const result = { month: targetMonth, generated: gen?.created ?? 0, notified: 0, skipped: 0, failures: [] as string[] };

    const instCache: Record<string, string | null> = {};
    async function instance(tenantId: string) {
      if (!(tenantId in instCache)) {
        const { data: adm } = await supabase.from("profiles").select("whatsapp_instance")
          .eq("tenant_id", tenantId).in("role", ["SCHOOL_ADMIN", "SUPER_ADMIN"])
          .not("whatsapp_instance", "is", null).neq("whatsapp_instance", "").limit(1).maybeSingle();
        instCache[tenantId] = adm?.whatsapp_instance || null;
      }
      return instCache[tenantId];
    }

    for (const c of (closings || [])) {
      if (!Number(c.lessons)) { result.skipped++; continue; } // sem aulas no mês → não avisa
      const subj = `${c.teacher_id}:${targetMonth}`;

      // dedupe ignorando ref_date (1 aviso por mês/professor)
      const { data: dup } = await supabase.from("automation_sent").select("id")
        .eq("kind", "MONTHLY_CLOSING").eq("subject_id", subj).maybeSingle();
      if (dup) { result.skipped++; continue; }

      const phone = normPhone(c.phone || "");
      if (phone.length < 12) { result.failures.push(`${c.teacher_id}: telefone inválido`); continue; }

      const inst = await instance(c.tenant_id);
      if (!inst) { result.failures.push(`${c.teacher_id}: tenant sem WhatsApp central`); continue; }

      const nome = (c.name || "").trim().split(" ")[0];
      const text = `Olá ${nome}! 🐺\n\nSeu fechamento de *${monthLabel(targetMonth)}* já está pronto:\n\n` +
        `📚 Aulas pagas: *${c.lessons}*\n` +
        `💰 Total a receber: *${money(c.amount)}*\n\n` +
        `Você pode conferir o relatório completo e baixar o PDF na plataforma, em *Financeiro → Meu Relatório (PDF)*.\n\n` +
        `Qualquer dúvida, é só chamar. Obrigado pelo seu trabalho! 💜`;

      const resp = await fetch(`${EVOLUTION_API_BASE}/${inst}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: API_TOKEN },
        body: JSON.stringify({ number: phone, text, delay: 800, linkPreview: false }),
      });
      if (!resp.ok) { result.failures.push(`${c.teacher_id}: evolution ${resp.status}`); continue; }
      await supabase.from("automation_sent").insert({ kind: "MONTHLY_CLOSING", subject_id: subj, ref_date: today });
      result.notified++;
    }

    return new Response(JSON.stringify(result), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
