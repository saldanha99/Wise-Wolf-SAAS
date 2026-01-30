import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

// Configuração Evolution API
const EVOLUTION_API_URL = "https://api.2b.app.br/message/sendText/wise-wolf";
const EVOLUTION_API_TOKEN = "2AFB8724075F-40FB-92CF-414EE13EDA54"; // Hardcoded as requested

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
    // CORS Preflight
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders })
    }

    try {
        const { phone, full_name, link_portal } = await req.json();

        if (!phone || !full_name) {
            return new Response(JSON.stringify({ error: 'Missing phone or full_name' }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                status: 400
            });
        }

        // Formatação do Número (Adiciona 55 se necessário)
        let cleanPhone = phone.replace(/\D/g, "");
        if (cleanPhone.length === 10 || cleanPhone.length === 11) {
            cleanPhone = "55" + cleanPhone;
        }

        console.log(`Sending Enrollment Notification to ${cleanPhone} (${full_name})...`);

        // Construção da Mensagem
        const message = `🐺 *Bem-vindo à Wise Wolf Language!*

Olá ${full_name}, sua matrícula foi concluída com sucesso.

📄 Acesse seu contrato assinado no portal: ${link_portal || 'https://aluno.wisewolf.com.br'}`;

        // Disparo via Evolution API
        const response = await fetch(EVOLUTION_API_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "apikey": EVOLUTION_API_TOKEN
            },
            body: JSON.stringify({
                number: cleanPhone,
                options: {
                    delay: 1200,
                    presence: "composing",
                    linkPreview: true
                },
                textMessage: {
                    text: message
                }
            })
        });

        const result = await response.json();

        if (!response.ok) {
            throw new Error(`Evolution API Error: ${JSON.stringify(result)}`);
        }

        console.log("✅ Message Sent Successfully:", result);

        return new Response(JSON.stringify(result), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 200,
        });

    } catch (error: any) {
        console.error("❌ Error sending notification:", error.message);
        return new Response(JSON.stringify({ error: error.message }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 500,
        })
    }
})
