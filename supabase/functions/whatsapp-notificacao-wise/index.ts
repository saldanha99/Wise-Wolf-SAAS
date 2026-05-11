
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const EVOLUTION_API_URL = Deno.env.get('EVOLUTION_API_URL') || "https://api.2b.app.br";
const API_TOKEN = Deno.env.get('EVOLUTION_API_KEY') || '';
const INSTANCE_NAME = Deno.env.get('EVOLUTION_DEFAULT_INSTANCE') || "wise-wolf";
const DIRECTOR_PHONE = Deno.env.get('DIRECTOR_PHONE') || "5511971681451";

// Interfaces para os tipos de requisição
interface NotificationRequest {
    type: "DIRECTOR_NEW_CONTRACT" | "STUDENT_APPROVED";
    data: {
        student_name: string;
        student_phone?: string; // Obrigatório para STUDENT_APPROVED
        class_frequency?: string; // Para o Diretor
        portal_link?: string; // Para o Aluno
    };
}

const sendWhatsAppMessage = async (phone: string, text: string) => {
    const url = `${EVOLUTION_API_URL}/message/sendText/${INSTANCE_NAME}`;

    // Clean phone number (just in case)
    const cleanPhone = phone.replace(/\D/g, "");

    console.log(`Sending message to ${cleanPhone}: ${text}`);

    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "apikey": API_TOKEN
        },
        body: JSON.stringify({
            number: cleanPhone,
            options: {
                delay: 1200,
                presence: "composing",
                linkPreview: true
            },
            textMessage: {
                text: text
            }
        })
    });

    if (!response.ok) {
        const errorBody = await response.text();
        console.error(`Evolution API Error: ${response.status} - ${errorBody}`);
        throw new Error(`Failed to send WhatsApp: ${errorBody}`);
    }

    return await response.json();
};

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
        const { type, data } = await req.json() as NotificationRequest;

        if (!type || !data) {
            throw new Error("Missing 'type' or 'data' in request body.");
        }

        let result;

        switch (type) {
            case "DIRECTOR_NEW_CONTRACT":
                if (!data.student_name || !data.class_frequency) {
                    throw new Error("Missing data for DIRECTOR_NEW_CONTRACT");
                }
                const directorMsg = `🐺 NOVA MATRÍCULA! ${data.student_name} assinou o contrato (${data.class_frequency.replace('x', '')}x/semana). Acesse o painel para validar.`;
                result = await sendWhatsAppMessage(DIRECTOR_PHONE, directorMsg);
                break;

            case "STUDENT_APPROVED":
                if (!data.student_name || !data.student_phone || !data.portal_link) {
                    throw new Error("Missing data for STUDENT_APPROVED");
                }
                // Ensure student phone has 55
                let studentPhone = data.student_phone.replace(/\D/g, "");
                if (!studentPhone.startsWith("55")) {
                    studentPhone = "55" + studentPhone;
                }

                const studentMsg = `Seja bem-vindo, ${data.student_name}! 🐺 Sua matrícula foi validada. Acesse seu portal aqui: ${data.portal_link}`;
                result = await sendWhatsAppMessage(studentPhone, studentMsg);
                break;

            default:
                throw new Error(`Unknown notification type: ${type}`);
        }

        return new Response(JSON.stringify({ success: true, result }), {
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });

    } catch (error: any) {
        console.error("Handler Error:", error);
        return new Response(JSON.stringify({ error: error.message }), {
            status: 400,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
    }
});
