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
const API_TOKEN = "2AFB8724075F-40FB-92CF-414EE13EDA54";
const CENTRAL_INSTANCE = "wise-wolf"; // instância central da escola
const FUNCTIONS_BASE = `${Deno.env.get("SUPABASE_URL") ?? ""}/functions/v1`;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const todayISO = new Date().toISOString().split("T")[0];

    // Confirmações ainda não enviadas, de aulas que já ocorreram (data <= hoje),
    // ainda pendentes (sem resposta) e com poucas tentativas.
    const { data: pending, error } = await supabase
      .from("attendance_confirmations")
      .select("id, token, student_name, student_phone, teacher_name, class_date, class_time, send_attempts")
      .is("sent_at", null)
      .eq("status", "PENDING")
      .lte("class_date", todayISO)
      .lt("send_attempts", 3)
      .limit(50);

    if (error) throw error;
    if (!pending || pending.length === 0) {
      return new Response(JSON.stringify({ sent: 0, message: "nada a enviar" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let sent = 0;
    const failures: string[] = [];

    for (const c of pending) {
      try {
        let phone = (c.student_phone || "").replace(/\D/g, "");
        if (phone.length === 10 || phone.length === 11) phone = "55" + phone;
        if (phone.length < 12) {
          failures.push(`${c.id}: telefone inválido`);
          await supabase.from("attendance_confirmations").update({ send_attempts: (c.send_attempts || 0) + 1 }).eq("id", c.id);
          continue;
        }

        const aluno = (c.student_name || "").split(" ")[0] || "";
        const prof = c.teacher_name || "seu professor";
        const link = `${FUNCTIONS_BASE}/confirm-attendance?token=${c.token}`;
        const text = `Oi ${aluno}! 🐺 Aqui é a Wise Wolf.\n\nVimos que você teve aula com *${prof}* hoje. Pra manter a qualidade, confirme rapidinho (1 toque):\n\n${link}\n\nLeva 5 segundos e é confidencial. Obrigado! 💜`;

        const resp = await fetch(`${EVOLUTION_API_BASE}/${CENTRAL_INSTANCE}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", apikey: API_TOKEN },
          body: JSON.stringify({
            number: phone,
            options: { delay: 1000, presence: "composing", linkPreview: true },
            textMessage: { text },
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
