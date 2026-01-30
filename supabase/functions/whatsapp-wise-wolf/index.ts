
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const EVOLUTION_API_URL = "https://api.2b.app.br/message/sendText/wise-wolf";
const API_TOKEN = "2AFB8724075F-40FB-92CF-414EE13EDA54";

interface RequestBody {
    number: string;
    message: string;
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
        const { number, message } = await req.json() as RequestBody;

        if (!number || !message) {
            throw new Error("Missing 'number' or 'message' in request body.");
        }

        // Clean phone number (ensure only digits)
        let cleanNumber = number.replace(/\D/g, "");

        // Add Brazil Country Code if missing
        if (cleanNumber.length === 10 || cleanNumber.length === 11) {
            cleanNumber = "55" + cleanNumber;
        }

        // Prepare payload for Evolution API
        const evolutionPayload = {
            number: cleanNumber,
            options: {
                delay: 1000,
                presence: "composing",
                linkPreview: true
            },
            textMessage: {
                text: message
            }
        };

        console.log(`Sending WhatsApp to ${cleanNumber}: ${message.substring(0, 20)}...`);

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
