
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const EVOLUTION_API_BASE = `${(Deno.env.get("EVOLUTION_API_URL") || "https://api.2b.app.br").replace(/\/+$/, "")}/message/sendText`;
// Chave global do servidor Evolution (funciona para qualquer instância)
const API_TOKEN = Deno.env.get("EVOLUTION_API_KEY") || "";

interface RequestBody {
    type: 'CONFIRMATION' | 'RESCHEDULE' | 'CUSTOM';
    student_name: string;
    student_phone: string;
    teacher_name: string;
    date: string;
    time: string;
    instanceName?: string;
    meeting_link?: string;
    // Mensagem personalizada (template do professor já renderizado).
    // Se preenchida, é enviada verbatim, ignorando os templates fixos abaixo.
    message?: string;
}

serve(async (req) => {
    // CORS Headers
    if (req.method === "OPTIONS") {
        return new Response("ok", {
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
            },
        });
    }

    try {
        const authHeader = req.headers.get("Authorization") || "";
        const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
        const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
        const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
        const admin = createClient(supabaseUrl, serviceKey);
        const { data: auth, error: authError } = await admin.auth.getUser(bearer);
        if (authError || !auth.user) {
            return new Response(JSON.stringify({ error: "unauthorized" }), {
                status: 401,
                headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
            });
        }

        const { type, student_name, student_phone, teacher_name, date, time, instanceName, meeting_link, message } = await req.json() as RequestBody;

        if (!student_phone || !student_name) {
            throw new Error("Missing 'student_phone' or 'student_name'.");
        }

        // Clean phone number (ensure only digits)
        let cleanNumber = student_phone.replace(/\D/g, "");
        if (cleanNumber.length === 10 || cleanNumber.length === 11) {
            cleanNumber = "55" + cleanNumber;
        }

        const { data: caller } = await admin.from("profiles")
            .select("role, tenant_id, whatsapp_instance")
            .eq("id", auth.user.id)
            .maybeSingle();
        if (!caller || !["TEACHER", "SCHOOL_ADMIN", "SUPER_ADMIN"].includes(caller.role)) {
            return new Response(JSON.stringify({ error: "forbidden" }), {
                status: 403,
                headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
            });
        }

        let activeInstance = caller.whatsapp_instance || "";
        if (caller.role !== "TEACHER" && instanceName && caller.tenant_id) {
            const { data: tenantInstance } = await admin.from("profiles")
                .select("whatsapp_instance")
                .eq("tenant_id", caller.tenant_id)
                .eq("whatsapp_instance", instanceName)
                .maybeSingle();
            if (tenantInstance?.whatsapp_instance) activeInstance = tenantInstance.whatsapp_instance;
        }
        if (!activeInstance) throw new Error("Nenhuma instância de WhatsApp autorizada para este usuário.");
        const url = `${EVOLUTION_API_BASE}/${activeInstance}`;

        const linkSuffix = meeting_link ? ` Link: ${meeting_link}` : "";

        // Construct Message based on Type
        // Se a mensagem personalizada foi enviada (template do professor), usa verbatim.
        let finalMessage = (message && message.trim()) ? message.trim() : "";

        if (!finalMessage) {
            if (type === 'CONFIRMATION') {
                finalMessage = `Oi ${student_name}, aqui é o ${teacher_name}! 🐺 Confirmando nossa aula de ${date} às ${time}.${linkSuffix}`;
            } else if (type === 'RESCHEDULE') {
                finalMessage = `Oi ${student_name}, aqui é o ${teacher_name}! 🐺 Reposição agendada: ${date} às ${time}.${linkSuffix}`;
            } else {
                finalMessage = `Olá ${student_name}, lembrete de aula: ${date} às ${time}.`;
            }
        }

        // Prepare payload (Evolution API v2: 'text' no topo — formato aceito pelo servidor api.2b.app.br)
        const evolutionPayload = {
            number: cleanNumber,
            text: finalMessage,
            delay: 1000,
            linkPreview: true
        };

        console.log(`Sending ${type} Notification to ${cleanNumber} via ${activeInstance}...`);

        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "apikey": API_TOKEN
            },
            body: JSON.stringify(evolutionPayload)
        });

        if (!response.ok) {
            // If specific instance fails (e.g. not connected), maybe fallback? 
            // For now, just error out so frontend knows.
            const errorText = await response.text();
            console.error("Evolution API Error:", errorText);
            throw new Error(`Evolution API failed: ${response.status} - ${errorText}`);
        }

        const data = await response.json();
        return new Response(JSON.stringify(data), {
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });

    } catch (error: any) {
        console.error("Edge Function Error:", error);
        return new Response(JSON.stringify({ error: error.message }), {
            status: 400,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
    }
});
