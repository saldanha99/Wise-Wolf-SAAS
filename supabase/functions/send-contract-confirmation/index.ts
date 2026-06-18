
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const EVOLUTION_BASE_URL = "https://api.2b.app.br";
const API_TOKEN = "8828462c98512411df3acfe3df4e48a1";

interface RequestBody {
    student_name: string;
    phone: string;
    class_frequency: string;
    link_pdf: string;
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
        const { student_name, phone, class_frequency, link_pdf } = await req.json() as RequestBody;

        if (!phone || !student_name) {
            throw new Error("Missing 'phone' or 'student_name' in request body.");
        }

        // Clean phone number (ensure only digits)
        let cleanNumber = phone.replace(/\D/g, "");

        // Add Brazil Country Code if missing (10 or 11 digits)
        if (cleanNumber.length === 10 || cleanNumber.length === 11) {
            cleanNumber = "55" + cleanNumber;
        }

        // Construct Message
        const message = `🐺 *Matrícula Confirmada, ${student_name}!*
Seu contrato de ${class_frequency}x na semana foi assinado com sucesso.

📄 Acesse seu contrato aqui: ${link_pdf}

🔐 Seu acesso ao portal está liberado!`;

        // Prepare payload for Evolution API v2
        const evolutionPayload = {
            number: cleanNumber,
            text: message,
            delay: 1000,
            linkPreview: true
        };

        const instance = Deno.env.get('EVOLUTION_INSTANCE') || 'wise-wolf';
        const EVOLUTION_API_URL = `${EVOLUTION_BASE_URL}/message/sendText/${instance}`;

        console.log(`Sending Confirmation WhatsApp to ${cleanNumber}...`);

        const response = await fetch(EVOLUTION_API_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "apikey": API_TOKEN
            },
            body: JSON.stringify(evolutionPayload)
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error("Evolution API Error:", errorText);
            throw new Error(`Evolution API failed: ${response.status} - ${errorText}`);
        }

        const data = await response.json();
        console.log("Success:", data);

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
