
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const EVOLUTION_API_BASE = "https://api.2b.app.br/message/sendText";
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
        const { type, student_name, student_phone, teacher_name, date, time, instanceName, meeting_link, message } = await req.json() as RequestBody;

        if (!student_phone || !student_name) {
            throw new Error("Missing 'student_phone' or 'student_name'.");
        }

        // Clean phone number (ensure only digits)
        let cleanNumber = student_phone.replace(/\D/g, "");
        if (cleanNumber.length === 10 || cleanNumber.length === 11) {
            cleanNumber = "55" + cleanNumber;
        }

        // Determine Instance (Default to wise-wolf if not provided)
        const activeInstance = instanceName || 'wise-wolf';
        const url = `${EVOLUTION_API_BASE}/${activeInstance}`;

        const link = meeting_link || "https://aluno.wisewolf.com.br";

        // Construct Message based on Type
        // Se a mensagem personalizada foi enviada (template do professor), usa verbatim.
        let finalMessage = (message && message.trim()) ? message.trim() : "";

        if (!finalMessage) {
            if (type === 'CONFIRMATION') {
                finalMessage = `Oi ${student_name}, aqui é o ${teacher_name}! 🐺 Confirmando nossa aula de ${date} às ${time}. Link: ${link}`;
            } else if (type === 'RESCHEDULE') {
                finalMessage = `Oi ${student_name}, aqui é o ${teacher_name}! 🐺 Reposição agendada: ${date} às ${time}. Link: ${link}`;
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
