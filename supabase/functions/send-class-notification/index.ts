
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const EVOLUTION_API_BASE = "https://api.2b.app.br/message/sendText";
const API_TOKEN = "2AFB8724075F-40FB-92CF-414EE13EDA54";

interface RequestBody {
    type: 'CONFIRMATION' | 'RESCHEDULE';
    student_name: string;
    student_phone: string;
    teacher_name: string;
    date: string;
    time: string;
    instanceName?: string;
    meeting_link?: string;
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
        const { type, student_name, student_phone, teacher_name, date, time, instanceName, meeting_link } = await req.json() as RequestBody;

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
        let message = "";

        if (type === 'CONFIRMATION') {
            message = `Oi ${student_name}, aqui é o ${teacher_name}! 🐺 Confirmando nossa aula de ${date} às ${time}. Link: ${link}`;
        } else if (type === 'RESCHEDULE') {
            message = `Oi ${student_name}, aqui é o ${teacher_name}! 🐺 Reposição agendada: ${date} às ${time}. Link: ${link}`;
        } else {
            message = `Olá ${student_name}, lembrete de aula: ${date} às ${time}.`;
        }

        // Prepare payload
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
