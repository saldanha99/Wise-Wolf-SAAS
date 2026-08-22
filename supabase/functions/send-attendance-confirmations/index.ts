import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authorizeAutomation } from "../_shared/automation-auth.ts";
import {
  loadTenantCentralWhatsAppContext,
  type TenantCentralWhatsAppContext,
} from "../_shared/tenant-communication.ts";

// Cron: envia o link de confirmação de presença ao ALUNO após a aula.
// IMPORTANTE: envia pela INSTÂNCIA CENTRAL da escola (não a do professor),
// para que o professor não consiga interceptar/controlar o canal de verificação.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const EVOLUTION_API_BASE = `${(Deno.env.get("EVOLUTION_API_URL") || "https://api.2b.app.br").replace(/\/+$/, "")}/message/sendText`;
// Chave global do servidor Evolution (funciona para qualquer instância)
const API_TOKEN = Deno.env.get("EVOLUTION_API_KEY") || "";
// Resolve a instância CENTRAL da escola (WhatsApp do admin do tenant).
// Importante para integridade: a verificação NÃO sai pela instância do professor checado.
async function resolveCentralContext(
  supabase: any,
  tenantId: string | null,
): Promise<TenantCentralWhatsAppContext | null> {
  if (!tenantId) return null;
  return await loadTenantCentralWhatsAppContext(supabase, tenantId, "student");
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const authError = await authorizeAutomation(req, corsHeaders);
  if (authError) return authError;

  try {
    if (!API_TOKEN) throw new Error("EVOLUTION_API_KEY não configurada");

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
      .select("id, tenant_id, token, student_name, student_phone, teacher_name, class_date, class_time, send_attempts, source_id, source_type")
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

    // REVALIDAÇÃO ANTI-FANTASMA: uma confirmação é criada válida (aula ocorreu),
    // mas o agendamento pode ser DELETADO/cancelado/reposto ANTES do envio. Se enviarmos
    // assim mesmo, o aluno recebe "você teve aula" num dia em que não tem mais aula.
    // upcoming_classes já aplica TODAS as regras (dia da semana, start_date, status
    // SCHEDULED, appointments não cancelados, reposições). Só enviamos confirmações cuja
    // (source_id, source_type, class_date) ainda exista lá; as órfãs viram CANCELLED.
    const validKeys = new Set<string>();
    let validationOk = false;
    try {
      const { data: valid, error: vErr } = await supabase
        .from("upcoming_classes")
        .select("source_id, source_type, class_date")
        .gte("class_date", minDateISO)
        .lte("class_date", todayISO);
      if (vErr) throw vErr;
      for (const v of valid || []) {
        validKeys.add(`${v.source_id}|${v.source_type}|${v.class_date}`);
      }
      validationOk = true;
    } catch (vErr) {
      // Fail-safe: se não conseguir validar, NÃO suprime tudo (quebraria o anti-fraude).
      // Mantém o comportamento antigo (envia) e registra o aviso.
      console.error("Revalidação upcoming_classes falhou, enviando sem filtrar:", vErr);
    }

    let sent = 0;
    let canceladas = 0;
    const failures: string[] = [];
    const contextCache: Record<string, TenantCentralWhatsAppContext | null> = {};

    for (const c of pending) {
      try {
        // Pula (e cancela) confirmações cuja aula não existe mais na agenda atual.
        if (validationOk && c.source_id) {
          const key = `${c.source_id}|${c.source_type}|${c.class_date}`;
          if (!validKeys.has(key)) {
            await supabase
              .from("attendance_confirmations")
              .update({ status: "CANCELLED" })
              .eq("id", c.id);
            canceladas++;
            continue;
          }
        }
        let phone = (c.student_phone || "").replace(/\D/g, "");
        if (phone.length === 10 || phone.length === 11) phone = "55" + phone;
        if (phone.length < 12) {
          failures.push(`${c.id}: telefone inválido`);
          await supabase.from("attendance_confirmations").update({ send_attempts: (c.send_attempts || 0) + 1 }).eq("id", c.id);
          continue;
        }

        // Instância central da escola (cache por tenant)
        const tk = c.tenant_id || "_";
        if (!(tk in contextCache)) {
          contextCache[tk] = await resolveCentralContext(supabase, c.tenant_id);
        }
        const context = contextCache[tk];
        if (!context) {
          failures.push(`${c.id}: escola sem WhatsApp central conectado`);
          await supabase.from("attendance_confirmations").update({ send_attempts: (c.send_attempts || 0) + 1 }).eq("id", c.id);
          continue;
        }
        if (!context.identity.portalUrl) {
          failures.push(`${c.id}: escola sem domínio institucional configurado`);
          await supabase.from("attendance_confirmations").update({ send_attempts: (c.send_attempts || 0) + 1 }).eq("id", c.id);
          continue;
        }

        const aluno = (c.student_name || "").split(" ")[0] || "";
        const prof = c.teacher_name || "seu professor";
        const link = `${context.identity.portalUrl}/confirmar-presenca?token=${c.token}`;
        // "hoje" só se a aula for de hoje; senão referencia a data real (DD/MM)
        const quando = c.class_date === todayISO
          ? "hoje"
          : `no dia ${new Date(c.class_date + "T00:00:00").toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })}`;
        const text = `Oi ${aluno}! Aqui é a ${context.identity.brandName}.\n\nVimos que você teve aula com *${prof}* ${quando}. Pra manter a qualidade, confirme rapidinho (1 toque):\n\n${link}\n\nLeva 5 segundos e é confidencial. Obrigado!`;

        const resp = await fetch(`${EVOLUTION_API_BASE}/${context.instanceName}`, {
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
      JSON.stringify({ sent, canceladas, failures: failures.length, failure_reasons: failures.slice(0, 10) }),
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
