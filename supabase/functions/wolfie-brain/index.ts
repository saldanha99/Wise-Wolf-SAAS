import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

    try {
        let body;
        try {
            body = await req.json();
        } catch (e) {
            console.error("JSON Parse Error:", e);
            throw new Error("Invalid JSON body");
        }

        const { message, audioBase64, studentLevel, previousContext, topic } = body;

        // Log payload size for debugging
        console.log(`Payload received. Text: ${message?.length || 0}, Audio: ${audioBase64 ? (audioBase64.length / 1024).toFixed(2) + 'KB' : 'None'}, Topic: ${topic}`);

        // Auth: Using the working key from previous debugging
        const geminiKey = (Deno.env.get('GEMINI_API_KEY') ?? '').trim();
        if (!geminiKey) {
            throw new Error("GEMINI_API_KEY is not set.");
        }

        // System Prompt
        const systemInstruction = `
CONTEXT: You are Wolfie, an advanced English Voice Tutor used by the Wise Wolf School.
STUDENT LEVEL: ${studentLevel || 'A1'}

YOUR TASKS:
1. LISTEN to the user's audio carefully.
2. ROLE & CONTEXT: 
    - Current Topic: "${topic || 'General Conversation'}"
    - Student Level: "${studentLevel || 'A1'}"
    - ACT ACCORDINGLY: If the topic is specific (e.g., 'IT Meetings', 'Cooking', 'Job Interview'), immerse yourself in that role. Be a colleague, a chef, or a recruiter.
3. INTERACTION STRATEGY (CRITICAL):
    - BE INQUISITIVE: Do not just say "nice". Ask questions that force the student to explain *their reality*.
    - DEEP DIVE: If they mention a meeting, ask "How did you handle the conflict?" or "What was the technical blocker?". Go beyond the surface.
    - ADAPT TO LEVEL:
        - A1/A2: Keep it simple. "What do you do?"
        - B1/B2: Ask about processes and feelings. "How does that make you feel about your team?"
        - C1/C2: Challenge them. "Do you think that methodology is efficient?"
4. PEDAGOGICAL APPROACH (CRITICAL):
    - **IF THE STUDENT IS CORRECT:** 
        - DO NOT suggest "better ways" to say it. DO NOT correct style.
        - PRAISE THEM ("Perfect!", "Exactly!", "Great phrasing!").
        - IMMEDIATELY ask the next relevant question to continue the flow.
    - **IF THE STUDENT IS WRONG (Grammar/Structure):**
        - ONLY then use the correction format: "[Correction: Explain error in Portuguese] / [Correct English phrase]".
        - AFTER correcting, ask them to repeat: "Repeat after me: [Correct Phrase]".
    - **ACCENT:** Ignore minor accent issues. Focus on communication.

5. FEEDBACK LOOP:
    - If correct: Praise -> Follow-up Question.
    - If wrong: Correction -> Repeat -> Follow-up Question.

STYLE:
- Keep responses short (max 2 sentences).
- Extremely friendly but professional if the topic requires.
- If the user gets it right, praise them!
    `;

        // Build the Multimodal Payload
        const contentsParts = [];

        // 1. Add History/Context first (Text)
        if (previousContext) {
            contentsParts.push({ text: `HISTORY:\n${previousContext}` });
        }

        // 2. Add System Instruction + Current Input
        contentsParts.push({ text: systemInstruction });

        // 3. Add Audio if present
        if (audioBase64) {
            // Strip data:audio/type;base64, prefix if present
            const cleanBase64 = audioBase64.replace(/^data:audio\/[a-z]+;base64,/, "");
            contentsParts.push({
                inline_data: {
                    mime_type: "audio/webm", // Assuming webm from browser mediarecorder
                    data: cleanBase64
                }
            });
            contentsParts.push({ text: "Please respond to this audio input." });
        } else if (message) {
            contentsParts.push({ text: `STUDENT SAYS:\n"${message}"` });
        }

        // Use Gemini 2.0 Flash (Multimodal Capable & Confirmed Working)
        // We stick to v1beta for 2.0 models
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`;

        console.log(`Sending to Gemini 2.0... Audio: ${!!audioBase64}, TextLength: ${message?.length}`);

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                contents: [{
                    parts: contentsParts
                }]
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Gemini Multimodal Error (${response.status}): ${errorText}`);
        }

        const data = await response.json();
        const aiText = data.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!aiText) {
            throw new Error("Gemini returned empty response.");
        }

        return new Response(JSON.stringify({ aiText }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });

    } catch (error: any) {
        console.error("Wolfie Brain Fatal Error:", error);
        return new Response(JSON.stringify({
            error: error.message,
        }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }
});
