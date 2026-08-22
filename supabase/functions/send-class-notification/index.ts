
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { authorizeRequest } from "../_shared/request-auth.ts";
import {
    loadTenantCentralWhatsAppInstance,
    loadTenantWhatsAppInstance,
} from "../_shared/tenant-communication.ts";

const EVOLUTION_API_BASE = `${(Deno.env.get("EVOLUTION_API_URL") || "https://api.2b.app.br").replace(/\/+$/, "")}/message/sendText`;
// Chave global do servidor Evolution (funciona para qualquer instância)
const API_TOKEN = Deno.env.get("EVOLUTION_API_KEY") || "";
const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface RequestBody {
    type: 'CONFIRMATION' | 'RESCHEDULE' | 'CUSTOM';
    student_name: string;
    student_phone: string;
    teacher_name: string;
    date: string;
    time: string;
    meeting_link?: string;
    // Mensagem personalizada (template do professor já renderizado).
    // Se preenchida, é enviada verbatim, ignorando os templates fixos abaixo.
    message?: string;
}

serve(async (req) => {
    // CORS Headers
    if (req.method === "OPTIONS") {
        return new Response("ok", {
            headers: corsHeaders,
        });
    }

    try {
        const authorization = await authorizeRequest(req, {
            corsHeaders,
            allowedRoles: ["TEACHER", "SCHOOL_ADMIN", "SUPER_ADMIN"],
        });
        if (authorization.ok === false) return authorization.response;
        const admin = authorization.context.admin;
        const caller = authorization.context.profile;
        const userId = authorization.context.userId;
        const tenantId = caller?.tenant_id;
        if (!caller || !userId || !tenantId) {
            return new Response(JSON.stringify({ error: "tenant_access_required" }), {
                status: 403,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
        }

        const { type, student_name, student_phone, teacher_name, date, time, meeting_link, message } = await req.json() as RequestBody;

        if (!student_phone || !student_name) {
            throw new Error("Missing 'student_phone' or 'student_name'.");
        }

        // Clean phone number (ensure only digits)
        let cleanNumber = student_phone.replace(/\D/g, "");
        if (cleanNumber.length === 10 || cleanNumber.length === 11) {
            cleanNumber = "55" + cleanNumber;
        }

        const activeInstance = caller.role === "TEACHER"
            ? await loadTenantWhatsAppInstance(admin, tenantId, userId, "student")
            : await loadTenantCentralWhatsAppInstance(admin, tenantId, "student");
        if (!activeInstance) {
            return new Response(JSON.stringify({ error: "whatsapp_instance_unavailable" }), {
                status: 409,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
        }
        const url = `${EVOLUTION_API_BASE}/${activeInstance}`;

        const linkSuffix = meeting_link ? ` Link: ${meeting_link}` : "";

        // Construct Message based on Type
        // Se a mensagem personalizada foi enviada (template do professor), usa verbatim.
        let finalMessage = (message && message.trim()) ? message.trim() : "";

        if (!finalMessage) {
            if (type === 'CONFIRMATION') {
                finalMessage = `Oi ${student_name}, aqui é o ${teacher_name}! Confirmando nossa aula de ${date} às ${time}.${linkSuffix}`;
            } else if (type === 'RESCHEDULE') {
                finalMessage = `Oi ${student_name}, aqui é o ${teacher_name}! Reposição agendada: ${date} às ${time}.${linkSuffix}`;
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

        console.log(`Sending ${type} class notification`);

        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "apikey": API_TOKEN
            },
            body: JSON.stringify(evolutionPayload)
        });

        if (!response.ok) {
            console.error("Evolution API rejected class notification", {
                status: response.status,
            });
            throw new Error("notification_provider_rejected");
        }

        return new Response(JSON.stringify({ success: true, delivery: "accepted" }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });

    } catch (error: any) {
        console.error("Edge Function Error:", error);
        return new Response(JSON.stringify({ error: error.message }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }
});
