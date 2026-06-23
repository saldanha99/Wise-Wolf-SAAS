import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Cron: envia o link de confirmação de presença ao ALUNO após a aula.
// IMPORTANTE: envia pela INSTÂNCIA CENTRAL da escola (não a do professor),
// para que o professor não consiga interceptar/controlar o canal de verificação.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const EVOLUTION_API_BASE = "https://api.2b.app.br/message/sendText";
// Chave global do servidor Evolution (funciona para qualquer instância)
const API_TOKEN = "8828462c98512411df3acfe3df4e48a1";
// Página de confirmação servida pelo SPA (edge functions do Supabase não renderizam HTML — CSP sandbox)
const APP_URL = Deno.env.get("APP_PUBLIC_URL") || "https://system.wisewolflanguage.com.br";

// Resolve a instância CENTRAL da escola (WhatsApp do admin do tenant).
// Importante para integridade: a verificação NÃO sai pela instância do professor checado.
async function resolveCentralInstance(supabase: any, tenantId: string | null): Promise<string | null> {
  if (!tenantId) return null;
  const { data } = await supabase
    .from("profiles")
    .select("whatsapp_instance")
    .eq("tenant_id", tenantId)
    .in("role", ["SCHOOL_ADMIN", "SUPER_ADMIN"])
    .not("whatsapp_instance", "is", null)
    .neq("whatsapp_instance", "")
    .limit(1)
    .maybeSingle();
  return data?.whatsapp_instance || null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const todayISO = new Date().toISOString().split("T")[0];
    // Janela de envio: só aulas de ONTEM ou HOJE. Confirmações mais antigas que isso
    // NÃO são enviadas (evita que um backlog acumulado dispare em massa fora de hora,
    // mandando "você teve aula" para aulas de dias atrás).
    const minDateISO = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString().split("T")[0];

    const { data: pending, error } = await supabase
      .from("attendance_confirmations")
      .select("id, tenant_id, token, student_name, student_phone, teacher_name, class_date, class_time, send_attempts")
      .is("sent_at", null)
      .eq("status", "PENDING")
      .lte("class_date", todayISO)
      .gte("class_date", minDateISO)
      .lt("send_attempts", 8)
      .limit(50);

    if (error) throw error;
    if (!pending || pending.length === 0) {
      return new Response(JSON.stringify({ sent: 0, message: "nada a enviar" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let sent = 0;
    const failures: string[] = [];
    const instanceCache: Record<string, string | null> = {};

    for (const c of pending) {
      try {
        let phone = (c.student_phone || "").replace(/\D/g, "");
        if (phone.length === 10 || phone.length === 11) phone = "55" + phone;
        if (phone.length < 12) {
          failures.push(`${c.id}: telefone inválido`);
          await supabase.from("attendance_confirmations").update({ send_attempts: (c.send_attempts || 0) + 1 }).eq("id", c.id);
          continue;
        }

        // Instância central da escola (cache por tenant)
        const tk = c.tenant_id || "_";
        if (!(tk in instanceCache)) {
          instanceCache[tk] = await resolveCentralInstance(supabase, c.tenant_id);
        }
        const instance = instanceCache[tk];
        if (!instance) {
          failures.push(`${c.id}: escola sem WhatsApp central conectado`);
          await supabase.from("attendance_confirmations").update({ send_attempts: (c.send_attempts || 0) + 1 }).eq("id", c.id);
          continue;
        }

        const aluno = (c.student_name || "").split(" ")[0] || "";
        const prof = c.teacher_name || "seu professor";
        const link = `${APP_URL}/confirmar-presenca?token=${c.token}`;
        // "hoje" só se a aula for de hoje; senão referencia a data real (DD/MM)
        const quando = c.class_date === todayISO
          ? "hoje"
          : `no dia ${new Date(c.class_date + "T00:00:00").toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })}`;
        const text = `Oi ${aluno}! 🐺 Aqui é a Wise Wolf.\n\nVimos que você teve aula com *${prof}* ${quando}. Pra manter a qualidade, confirme rapidinho (1 toque):\n\n${link}\n\nLeva 5 segundos e é confidencial. Obrigado! 💜`;

        const resp = await fetch(`${EVOLUTION_API_BASE}/${instance}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", apikey: API_TOKEN },
          body: JSON.stringify({
            number: phone,
            text,
            delay: 1000,
            linkPreview: true,
          }),
        });

        if (!resp.ok) {
          const t = await resp.text();
          failures.push(`${c.id}: evolution ${resp.status}`);
          console.error("Evolution error:", t);
          await supabase.from("attendance_confirmations").update({ send_attempts: (c.send_attempts || 0) + 1 }).eq("id", c.id);
          continue;
        }

        await supabase
          .from("attendance_confirmations")
          .update({ sent_at: new Date().toISOString(), send_attempts: (c.send_attempts || 0) + 1 })
          .eq("id", c.id);
        sent++;
      } catch (inner) {
        console.error(`Erro confirmação ${c.id}:`, inner);
        failures.push(`${c.id}: ${(inner as Error).message}`);
      }
    }

    return new Response(
      JSON.stringify({ sent, failures: failures.length, failure_reasons: failures.slice(0, 10) }),
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
