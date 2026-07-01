import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Cron diário: avisa o aluno X dias antes do vencimento da mensalidade (WhatsApp).
// Envia pela instância central da escola (admin do tenant). Idempotente via due_reminder_sent_at.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const EVOLUTION_API_BASE = "https://api.2b.app.br/message/sendText";
const API_TOKEN = "8828462c98512411df3acfe3df4e48a1";
const DAYS_AHEAD = 3; // avisa 3 dias antes

async function centralInstance(supabase: any, tenantId: string | null): Promise<string | null> {
  if (!tenantId) return null;
  const { data } = await supabase.from("profiles").select("whatsapp_instance")
    .eq("tenant_id", tenantId).in("role", ["SCHOOL_ADMIN", "SUPER_ADMIN"])
    .not("whatsapp_instance", "is", null).neq("whatsapp_instance", "").limit(1).maybeSingle();
  return data?.whatsapp_instance || null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");

    const today = new Date();
    const limit = new Date(today.getTime() + DAYS_AHEAD * 86400_000);
    const todayISO = today.toISOString().split("T")[0];
    const limitISO = limit.toISOString().split("T")[0];

    // Cobranças pendentes que vencem nos próximos DAYS_AHEAD dias e ainda não foram avisadas
    const { data: charges, error } = await supabase
      .from("student_payments")
      .select("id, student_id, tenant_id, value, due_date, invoice_url, description")
      .eq("status", "PENDING")
      .gte("due_date", todayISO)
      .lte("due_date", limitISO)
      .is("due_reminder_sent_at", null)
      .limit(100);

    if (error) throw error;
    if (!charges || charges.length === 0) {
      return new Response(JSON.stringify({ sent: 0, message: "nada a avisar" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    let sent = 0;
    const failures: string[] = [];
    const instCache: Record<string, string | null> = {};

    for (const c of charges) {
      try {
        const { data: student } = await supabase.from("profiles").select("full_name, phone, status, status_financial, lifecycle_status").eq("id", c.student_id).maybeSingle();

        // Aluno inativo/arquivado/suspenso/desligado: o diretor optou por NÃO notificar.
        // O eixo confiável é lifecycle_status (o campo `status` fica "Ativo" p/ quase todos).
        // Pula sem marcar como enviado → se reativar, volta a receber o aviso.
        const st = student?.status || "Ativo";
        const inactive = ["Inativo", "INACTIVE", "Inactive", "Arquivado", "Cancelado", "Trancado"].includes(st)
          || student?.status_financial === "ARCHIVED"
          || ["suspended", "offboarded"].includes(student?.lifecycle_status || "");
        if (inactive) { failures.push(`${c.id}: aluno inativo (sem notificar)`); continue; }

        let phone = (student?.phone || "").replace(/\D/g, "");
        if (phone.length === 10 || phone.length === 11) phone = "55" + phone;
        if (phone.length < 12) { failures.push(`${c.id}: sem telefone`); await mark(supabase, c.id); continue; }

        const tk = c.tenant_id || "_";
        if (!(tk in instCache)) instCache[tk] = await centralInstance(supabase, c.tenant_id);
        const instance = instCache[tk];
        if (!instance) { failures.push(`${c.id}: escola sem WhatsApp central`); continue; }

        const nome = (student?.full_name || "").split(" ")[0] || "";
        const valor = `R$ ${Number(c.value || 0).toFixed(2).replace(".", ",")}`;
        const venc = new Date(c.due_date + "T00:00:00").toLocaleDateString("pt-BR");
        let text = `Oi ${nome}! 🐺 Aqui é a Wise Wolf.\n\nSua mensalidade de *${valor}* vence em *${venc}*.`;
        if (c.invoice_url) text += `\n\nPague pelo link: ${c.invoice_url}`;
        text += `\n\nQualquer dúvida, é só chamar. Bons estudos! 💜`;

        const resp = await fetch(`${EVOLUTION_API_BASE}/${instance}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", apikey: API_TOKEN },
          body: JSON.stringify({ number: phone, text, delay: 800, linkPreview: true }),
        });
        if (!resp.ok) { failures.push(`${c.id}: evolution ${resp.status}`); continue; }
        await mark(supabase, c.id);
        sent++;
      } catch (e) { failures.push(`${c.id}: ${(e as Error).message}`); }
    }

    return new Response(JSON.stringify({ sent, failures: failures.length, reasons: failures.slice(0, 10) }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});

async function mark(supabase: any, id: string) {
  await supabase.from("student_payments").update({ due_reminder_sent_at: new Date().toISOString() }).eq("id", id);
}
