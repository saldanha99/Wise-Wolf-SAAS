import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const EVOLUTION_API_URL = "https://api.2b.app.br";
const API_TOKEN = "d037768b3d06382756a0d9edecf3e40e"; // chave global (funciona p/ qualquer instância)
const FALLBACK_INSTANCE = "wise-wolf-main";
const FALLBACK_DIRECTOR_PHONE = "5511971681451";

interface NotificationRequest {
  type: "DIRECTOR_NEW_CONTRACT" | "STUDENT_APPROVED";
  data: {
    student_name: string;
    student_phone?: string;
    class_frequency?: string;
    portal_link?: string;
    tenant_id?: string;
  };
}

const sendWhatsAppMessage = async (phone: string, text: string, instance: string) => {
  const url = `${EVOLUTION_API_URL}/message/sendText/${encodeURIComponent(instance)}`;
  const cleanPhone = phone.replace(/\D/g, "");
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "apikey": API_TOKEN },
    // Evolution v2: 'text' no topo (v1 textMessage.text é rejeitado)
    body: JSON.stringify({ number: cleanPhone, text, delay: 1200, linkPreview: true }),
  });
  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`Evolution API Error (${instance}): ${response.status} - ${errorBody}`);
    throw new Error(`Failed to send WhatsApp: ${errorBody}`);
  }
  return await response.json();
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" },
    });
  }

  try {
    const { type, data } = await req.json() as NotificationRequest;
    if (!type || !data) throw new Error("Missing 'type' or 'data' in request body.");

    const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");

    // Instância central REAL do tenant (o 'wise-wolf-main' fixo não existe)
    let instance = FALLBACK_INSTANCE;
    if (data.tenant_id) {
      const { data: inst } = await supabase.rpc("central_instance_for_tenant", { p_tenant: data.tenant_id });
      if (inst) instance = inst;
    }

    let result;
    switch (type) {
      case "DIRECTOR_NEW_CONTRACT": {
        if (!data.student_name || !data.class_frequency) throw new Error("Missing data for DIRECTOR_NEW_CONTRACT");
        // Telefone do diretor do tenant (não mais hardcoded), com fallback
        let directorPhone = FALLBACK_DIRECTOR_PHONE;
        if (data.tenant_id) {
          const { data: adm } = await supabase.from("profiles")
            .select("owner_phone, phone").eq("tenant_id", data.tenant_id).eq("role", "SCHOOL_ADMIN")
            .limit(1).maybeSingle();
          directorPhone = (adm?.phone || adm?.owner_phone || FALLBACK_DIRECTOR_PHONE).replace(/\D/g, "");
          if (directorPhone.length === 10 || directorPhone.length === 11) directorPhone = "55" + directorPhone;
        }
        const directorMsg = `🐺 NOVA MATRÍCULA! ${data.student_name} assinou o contrato (${data.class_frequency.replace('x', '')}x/semana). Acesse o painel para validar.`;
        result = await sendWhatsAppMessage(directorPhone, directorMsg, instance);
        break;
      }
      case "STUDENT_APPROVED": {
        if (!data.student_name || !data.student_phone || !data.portal_link) throw new Error("Missing data for STUDENT_APPROVED");
        let studentPhone = data.student_phone.replace(/\D/g, "");
        if (!studentPhone.startsWith("55")) studentPhone = "55" + studentPhone;
        const studentMsg = `Seja bem-vindo, ${data.student_name}! 🐺 Sua matrícula foi validada. Acesse seu portal aqui: ${data.portal_link}`;
        result = await sendWhatsAppMessage(studentPhone, studentMsg, instance);
        break;
      }
      default:
        throw new Error(`Unknown notification type: ${type}`);
    }

    return new Response(JSON.stringify({ success: true, result }), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  } catch (error: any) {
    console.error("Handler Error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 400, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
});
