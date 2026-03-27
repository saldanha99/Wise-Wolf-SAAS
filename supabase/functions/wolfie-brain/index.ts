import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.23.0";

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ============================================================
// SINGLE MIGHTY AGENT: WOLFIE (Gemini 2.0 Flash)
// ============================================================
// Replacing the old 5-agent system with a single prompt 
// directly outputting structured JSON for chat, correction, 
// vocabulary, translation, and quiz.
// ============================================================

export type WolfieMode = 'fluency' | 'grammar_focus' | 'exam_prep' | 'job_interview' | 'roleplay';

export interface WolfieConfig {
    topic: string;
    studentLevel: 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2';
    nativeLanguage: 'pt-BR';
    mode: WolfieMode;
    correctionStrictness: 1 | 2 | 3;
    allowPortuguese: boolean;
    targetTalkRatio: number;
    maxSentencesPerTurn: number;
    translationEnabled: boolean;
    vocabularyEnabled: boolean;
    turnCount: number;
}

interface AgentResponse {
    chatResponse: string;
    correction: {
        original: string;
        corrected: string;
        explanation_pt: string;
    } | null;
    translation: string | null;
    vocabulary: {
        keyTerms: Array<{
            term: string;
            definition: string;
            level: string;
            synonyms: string[];
            example: string;
        }>;
        grammarNote: string;
    } | null;
    quiz: {
        question: string;
        options: string[];
        correctIndex: number;
        explanation: string;
    } | null;
    conversationId: string | null;
    configUsed: WolfieConfig;
}

const WOLFIE_MOODS = ['bubbly', 'contemplative', 'cheerful', 'playful', 'warm'] as const;
const sessionMood = WOLFIE_MOODS[Math.floor(Math.random() * WOLFIE_MOODS.length)];

function buildSystemPrompt(config: WolfieConfig, studentName?: string, studentGoal?: string, previousContext?: string): string {
    const isPedagogicalAdvisor = previousContext?.includes('Pedagogical Advisor');

    if (isPedagogicalAdvisor) {
        return `You are a Pedagogical Advisor. You will be asked to suggest a topic.
RETURN ONLY A VALID JSON OBJECT EXACTLY LIKE THIS (NO MARKDOWN WRAPPERS):
{
  "chatResponse": "your suggestion here",
  "correction": null,
  "translation": null,
  "vocabulary": null,
  "quiz": null
}`;
    }

    const { studentLevel, turnCount, allowPortuguese, translationEnabled, vocabularyEnabled, mode } = config;

    const levelGuidance = (studentLevel === 'A1' || studentLevel === 'A2')
        ? `The student is a BEGINNER (${studentLevel}). Use very simple words. Speak clearly and patiently.`
        : (studentLevel === 'B1' || studentLevel === 'B2')
            ? `The student is INTERMEDIATE (${studentLevel}). Use natural everyday English. Ask follow-up questions.`
            : `The student is ADVANCED (${studentLevel}). Speak naturally, use idioms and complex structures. Challenge them.`;

    const chatLangInstruct = turnCount === 0
        ? `First interaction: Greet ${studentName || 'the student'} warmly IN PORTUGUESE. Tell them you are the Smart Wolf (Lobo Inteligente) and ask them what is their goal for today's practice (e.g., job interview, daily conversation). Stop and let them reply.`
        : `Continue the conversation NATURALLY IN ENGLISH (mostly). If the student speaks Portuguese, you can reply in Portuguese to explain but pivot back to English quickly. Make your response flow like a real tutor/friend. End with an engaging question. Keep it concise, 1-3 sentences max.`;

    const trans = translationEnabled ? `"Natural PT-BR translation of your English chatResponse (if your response was in English)"` : "null";
    const vocab = vocabularyEnabled ? `null | {\n    "keyTerms": [\n      { "term": "word", "definition": "meaning", "level": "${studentLevel}", "synonyms": ["syn1"], "example": "example" }\n    ],\n    "grammarNote": "short note in PT if a specific grammatical point is relevant"\n  }` : "null";

    return `You are WOLFIE (Smart Wolf), an advanced native English Tutor and friendly Conversation Partner from Wise Wolf.
YOUR MOOD THIS SESSION: ${sessionMood}. Let this subtly influence your tone.

STUDENT INFO:
- Name: ${studentName || 'Student'}
- Level: ${studentLevel}
- Goal: ${studentGoal || 'practice speaking fluently'}

${levelGuidance}

CRITICAL INSTRUCTION - STRUCTURED JSON OUTPUT ONLY:
You MUST process the student's input (which may have speech-to-text errors) and ALWAYS return a SINGLE RAW JSON Object.
DO NOT WRAP THE JSON IN MARKDOWN BLOCKS (\`\`\`json). RETURN ONLY THE RAW BRACES { ... }.

EXPECTED JSON FORMAT:
{
  "chatResponse": "Your actual spoken reply to the student. ${chatLangInstruct} Use contractions (I'm, don't). DO NOT include markdown, emojis, asterisks or bullet points here because it will be passed to Text-to-Speech.",
  
  "correction": null | {
    "original": "the exact text the student got wrong, if any major grammar/lexical errors occurred in their English",
    "corrected": "the natural/correct way to say it",
    "explanation_pt": "short explanation in Portuguese about the correction"
  },
  
  "translation": ${trans},
  
  "vocabulary": ${vocab},
  
  "quiz": null
}

RULES:
- Be incredibly smart and contextual. You are Gemini. You know how to hold a fascinating conversation about anything.
- If the student made a noticeable English error, provide a 'correction' object. Otherwise, set it to null.
- If 'vocabularyEnabled' is true and you used useful terms, populate 'vocabulary' (up to 2 terms). Otherwise, set to null.
- The 'chatResponse' is text-to-speech, so make it conversational and VERY natural to speak aloud.
`;
}

// ============================================================
// GEMINI CALL HELPER
// ============================================================
async function callGemini(
    geminiKey: string,
    systemPrompt: string,
    userContent: any[],
    jsonMode: boolean = true
): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`;

    const payload: any = {
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: userContent }],
    };

    if (jsonMode) {
        payload.generationConfig = { response_mime_type: "application/json" };
    }

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        const errorText = await response.text();
        console.error(`Gemini Error: ${errorText}`);
        throw new Error(`Gemini Error: ${errorText}`);
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("Gemini returned empty response");
    return text;
}


// ============================================================
// MAIN ORCHESTRATOR
// ============================================================
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

        const { message, audioBase64, previousContext, conversationId } = body;

        const config: WolfieConfig = {
            topic: body.topic || 'General Conversation',
            studentLevel: body.studentLevel || 'A1',
            nativeLanguage: 'pt-BR',
            mode: body.mode || 'fluency',
            correctionStrictness: body.correctionStrictness || 1,
            allowPortuguese: body.allowPortuguese !== false,
            targetTalkRatio: 0.7,
            maxSentencesPerTurn: 3,
            translationEnabled: body.translationEnabled ?? true,
            vocabularyEnabled: body.vocabularyEnabled ?? true,
            turnCount: body.turnCount ?? 0,
        };

        console.log(`[WolfieBrain Single-Agent] Payload: Text=${message?.length || 0}, Audio=${!!audioBase64}, Turn=${config.turnCount}`);

        // ── Auth & Supabase Setup ──
        const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
        const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
        const authHeader = req.headers.get('Authorization');
        const supabaseClient = createClient(supabaseUrl, supabaseAnonKey, { global: { headers: { Authorization: authHeader! } } });

        const geminiKey = (Deno.env.get('GEMINI_API_KEY') ?? '').trim();
        if (!geminiKey) throw new Error("GEMINI_API_KEY is not set.");

        // ── Billing Check ──
        const jwt = authHeader?.replace('Bearer ', '');
        const { data: { user }, error: authError } = await supabaseClient.auth.getUser(jwt);
        if (authError || !user) {
            throw new Error(`Auth Error: ${authError?.message || 'No User'}. Header Exists: ${!!authHeader}`);
        }

        const { data: profile } = await supabaseClient
            .from('profiles')
            .select('full_name, goal, student_profile_json')
            .eq('id', user.id)
            .single();

        const now = new Date();
        const { data: payments } = await supabaseClient
            .from('student_payments')
            .select('due_date')
            .eq('student_id', user.id)
            .neq('status', 'RECEIVED')
            .neq('status', 'CONFIRMED')
            .lt('due_date', now.toISOString());

        if (payments && payments.length > 0) {
            const sorted = payments.sort((a: any, b: any) => new Date(a.due_date).getTime() - new Date(b.due_date).getTime());
            const oldestDue = new Date(sorted[0].due_date);
            const daysLate = Math.ceil(Math.abs(now.getTime() - oldestDue.getTime()) / (1000 * 60 * 60 * 24));
            if (daysLate > 7) {
                return new Response(JSON.stringify({ error: "ACCESS_SUSPENDED", code: "PAYMENT_REQUIRED" }), { status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
            }
        }

        // ── Session Logging ──
        let sessionId = conversationId;
        if (!sessionId) {
            const { data: newSession, error: sessionError } = await supabaseClient
                .from('wolfie_sessions')
                .insert({
                    student_id: user.id,
                    tenant_id: user.user_metadata?.tenant_id || '00000000-0000-0000-0000-000000000000',
                    topic: config.topic,
                    mode: config.mode,
                    student_level: config.studentLevel,
                    config_snapshot: config,
                    started_at: new Date().toISOString()
                })
                .select('id')
                .single();

            if (sessionError) console.error("Error creating session:", sessionError);
            else if (newSession) sessionId = newSession.id;
        }

        if (sessionId && (message || audioBase64)) {
            await supabaseClient.from('wolfie_turns').insert({
                session_id: sessionId,
                speaker: 'student',
                content: message || "[Audio Input]",
                turn_index: config.turnCount * 2
            });
        }

        // ════════════════════════════════════════════
        // MULTI-MODAL PROMPT ASSEMBLY
        // ════════════════════════════════════════════

        const userContentParts: any[] = [];
        if (previousContext) {
            userContentParts.push({ text: `CONVERSATION HISTORY:\n${previousContext}` });
        }

        if (audioBase64) {
            const cleanBase64 = audioBase64.includes(',') ? audioBase64.split(',')[1] : audioBase64;
            if (cleanBase64 && cleanBase64.trim().length > 0) {
                userContentParts.push({ inline_data: { mime_type: "audio/webm", data: cleanBase64 } });
                userContentParts.push({ text: "Listen to the audio natively." });
            }
        }

        if (message) {
            userContentParts.push({ text: `Student says: "${message}"` });
        }

        if (userContentParts.length === 0) {
            userContentParts.push({ text: "Hello Wolfie" });
        }
        
        console.log(`[Agent:SingleGemini] Starting...`);

        const systemPrompt = buildSystemPrompt(config, profile?.full_name, profile?.goal, previousContext);

        const aiRawResult = await callGemini(
            geminiKey,
            systemPrompt,
            userContentParts,
            true // Enable JSON mode
        );

        let parsedResult: any = {};
        try {
            parsedResult = JSON.parse(aiRawResult.trim());
        } catch (err) {
            console.error(`[Agent:SingleGemini] Failed to parse JSON. Raw output: ${aiRawResult}`);
            // Fallback safety
            parsedResult = {
                chatResponse: "I encountered an error understanding that, could you repeat?",
                correction: null,
                translation: null,
                vocabulary: null,
                quiz: null
            };
        }

        console.log(`[Agent:SingleGemini] Done. Response length: ${parsedResult.chatResponse?.length || 0}`);

        // ── Post-Session Logging ──
        if (sessionId && parsedResult.chatResponse) {
            const { data: wolfieTurn } = await supabaseClient.from('wolfie_turns').insert({
                session_id: sessionId,
                speaker: 'wolfie',
                content: parsedResult.chatResponse,
                turn_index: config.turnCount * 2 + 1
            }).select('id').single();

            if (parsedResult.correction) {
                await supabaseClient.from('wolfie_corrections').insert({
                    session_id: sessionId,
                    turn_id: wolfieTurn?.id,
                    wrong_sentence: parsedResult.correction.original,
                    correct_sentence: parsedResult.correction.corrected,
                    explanation_pt: parsedResult.correction.explanation_pt,
                    error_type: 'general'
                }).catch((e: any) => console.error("Error saving correction:", e));
            }
        }

        // ── Build Structured Response ──
        const agentResponse: AgentResponse = {
            chatResponse: parsedResult.chatResponse,
            correction: parsedResult.correction,
            translation: parsedResult.translation,
            vocabulary: parsedResult.vocabulary,
            quiz: parsedResult.quiz,
            conversationId: sessionId,
            configUsed: config,
        };

        return new Response(JSON.stringify({ ...agentResponse, aiText: parsedResult.chatResponse }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });

    } catch (error: any) {
        console.error("Wolfie Brain Fatal Error:", error);
        return new Response(JSON.stringify({ error: error.stack || error.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }
});
