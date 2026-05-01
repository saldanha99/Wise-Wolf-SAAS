import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.23.0";

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ============================================================
// WOLFIE BRAIN — Groq edition
// Pipeline:
//   1. Groq Whisper Large v3 Turbo  → STT
//   2. Groq Llama 3.3 70B Versatile → Conversational tutor
// Cliente cuida do TTS via SpeechSynthesis nativo (iOS + Android + Desktop).
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
    transcribedText: string | null;
    correction: { original: string; corrected: string; explanation_pt: string; } | null;
    translation: string | null;
    vocabulary: {
        keyTerms: Array<{ term: string; definition: string; level: string; synonyms: string[]; example: string; }>;
        grammarNote: string;
    } | null;
    quiz: { question: string; options: string[]; correctIndex: number; explanation: string; } | null;
    conversationId: string | null;
    configUsed: WolfieConfig;
}

const WOLFIE_MOODS = ['bubbly', 'contemplative', 'cheerful', 'playful', 'warm'] as const;
const sessionMood = WOLFIE_MOODS[Math.floor(Math.random() * WOLFIE_MOODS.length)];

const GROQ_BASE = 'https://api.groq.com/openai/v1';
const GROQ_STT_MODEL = 'whisper-large-v3-turbo';
const GROQ_LLM_MODEL = 'llama-3.3-70b-versatile';

function buildSystemPrompt(config: WolfieConfig, studentName?: string, studentGoal?: string, previousContext?: string): string {
    const isPedagogicalAdvisor = previousContext?.includes('Pedagogical Advisor');
    if (isPedagogicalAdvisor) {
        return `You are a Pedagogical Advisor. You will be asked to suggest a topic.
RETURN ONLY A VALID JSON OBJECT EXACTLY LIKE THIS (NO MARKDOWN WRAPPERS):
{ "chatResponse": "your suggestion here", "correction": null, "translation": null, "vocabulary": null, "quiz": null }`;
    }

    const { studentLevel, turnCount, translationEnabled, vocabularyEnabled } = config;
    const levelGuidance = (studentLevel === 'A1' || studentLevel === 'A2')
        ? `The student is a BEGINNER (${studentLevel}). Use very simple words. Speak clearly and patiently.`
        : (studentLevel === 'B1' || studentLevel === 'B2')
            ? `The student is INTERMEDIATE (${studentLevel}). Use natural everyday English. Ask follow-up questions.`
            : `The student is ADVANCED (${studentLevel}). Speak naturally, use idioms and complex structures. Challenge them.`;

    const chatLangInstruct = turnCount === 0
        ? `First interaction: Greet ${studentName || 'the student'} warmly IN PORTUGUESE. Tell them you are the Smart Wolf (Lobo Inteligente) and ask them what is their goal for today's practice.`
        : `Continue the conversation NATURALLY IN ENGLISH (mostly). If the student speaks Portuguese, you can reply in Portuguese to explain but pivot back to English quickly. Keep it concise, 1-3 sentences max.`;

    const trans = translationEnabled ? `"Natural PT-BR translation of your English chatResponse"` : "null";
    const vocab = vocabularyEnabled ? `null | { "keyTerms": [{ "term": "word", "definition": "meaning", "level": "${studentLevel}", "synonyms": ["syn1"], "example": "example" }], "grammarNote": "short note in PT" }` : "null";

    return `You are WOLFIE (Smart Wolf), an advanced native English Tutor and friendly Conversation Partner from Wise Wolf.
YOUR MOOD THIS SESSION: ${sessionMood}.

STUDENT INFO:
- Name: ${studentName || 'Student'}
- Level: ${studentLevel}
- Goal: ${studentGoal || 'practice speaking fluently'}

${levelGuidance}

CRITICAL — RETURN ONLY A SINGLE RAW JSON OBJECT (no markdown):
{
  "chatResponse": "Your spoken reply. ${chatLangInstruct} Use contractions. NO markdown/emojis/asterisks (it goes to TTS).",
  "correction": null | { "original": "wrong text", "corrected": "natural correct version", "explanation_pt": "short PT explanation" },
  "translation": ${trans},
  "vocabulary": ${vocab},
  "quiz": null
}`;
}

async function groqTranscribe(groqKey: string, audioBase64: string, mimeType: string): Promise<string> {
    const cleanBase64 = audioBase64.includes(',') ? audioBase64.split(',')[1] : audioBase64;
    const binary = Uint8Array.from(atob(cleanBase64), c => c.charCodeAt(0));
    const ext = mimeType.includes('mp4') || mimeType.includes('m4a') ? 'm4a'
        : mimeType.includes('ogg') ? 'ogg'
        : mimeType.includes('wav') ? 'wav'
        : 'webm';
    const file = new File([binary], `audio.${ext}`, { type: mimeType });
    const form = new FormData();
    form.append('file', file);
    form.append('model', GROQ_STT_MODEL);
    form.append('response_format', 'json');

    const res = await fetch(`${GROQ_BASE}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${groqKey}` },
        body: form,
    });
    if (!res.ok) throw new Error(`Groq STT error: ${await res.text()}`);
    const data = await res.json();
    return (data.text || '').trim();
}

async function groqChat(groqKey: string, systemPrompt: string, userPrompt: string): Promise<string> {
    const res = await fetch(`${GROQ_BASE}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: GROQ_LLM_MODEL,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
            response_format: { type: 'json_object' },
            temperature: 0.7,
            max_tokens: 800,
        }),
    });
    if (!res.ok) throw new Error(`Groq LLM error: ${await res.text()}`);
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error('Groq returned empty response');
    return text;
}

serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
    try {
        const body = await req.json();
        const { message, audioBase64, audioMimeType, previousContext, conversationId } = body;

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

        const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
        const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
        const authHeader = req.headers.get('Authorization');
        const supabaseClient = createClient(supabaseUrl, supabaseAnonKey, { global: { headers: { Authorization: authHeader! } } });

        const groqKey = (Deno.env.get('GROQ_API_KEY') ?? '').trim();
        if (!groqKey) throw new Error("GROQ_API_KEY is not set.");

        const jwt = authHeader?.replace('Bearer ', '');
        const { data: { user }, error: authError } = await supabaseClient.auth.getUser(jwt);
        if (authError || !user) throw new Error(`Auth Error: ${authError?.message || 'No User'}`);

        const { data: profile } = await supabaseClient.from('profiles').select('full_name, goal, student_profile_json').eq('id', user.id).single();

        const now = new Date();
        const { data: payments } = await supabaseClient.from('student_payments').select('due_date').eq('student_id', user.id).neq('status', 'RECEIVED').neq('status', 'CONFIRMED').lt('due_date', now.toISOString());
        if (payments && payments.length > 0) {
            const sorted = payments.sort((a: any, b: any) => new Date(a.due_date).getTime() - new Date(b.due_date).getTime());
            const oldestDue = new Date(sorted[0].due_date);
            const daysLate = Math.ceil(Math.abs(now.getTime() - oldestDue.getTime()) / (1000 * 60 * 60 * 24));
            if (daysLate > 7) return new Response(JSON.stringify({ error: "ACCESS_SUSPENDED", code: "PAYMENT_REQUIRED" }), { status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        let sessionId = conversationId;
        if (!sessionId) {
            const { data: newSession } = await supabaseClient.from('wolfie_sessions').insert({
                student_id: user.id,
                tenant_id: user.user_metadata?.tenant_id || '00000000-0000-0000-0000-000000000000',
                topic: config.topic, mode: config.mode, student_level: config.studentLevel,
                config_snapshot: config, started_at: new Date().toISOString()
            }).select('id').single();
            if (newSession) sessionId = newSession.id;
        }

        // STEP 1: STT via Groq Whisper
        let userText = (message || '').trim();
        if (audioBase64) {
            try {
                const transcribed = await groqTranscribe(groqKey, audioBase64, audioMimeType || 'audio/webm');
                userText = transcribed || userText;
            } catch (e) {
                if (!userText) throw new Error(`Could not transcribe audio: ${(e as Error).message}`);
            }
        }

        if (sessionId && userText) {
            await supabaseClient.from('wolfie_turns').insert({
                session_id: sessionId, speaker: 'student', content: userText, turn_index: config.turnCount * 2
            });
        }

        // STEP 2: LLM via Groq Llama
        const systemPrompt = buildSystemPrompt(config, profile?.full_name, profile?.goal, previousContext);
        const userPromptParts: string[] = [];
        if (previousContext) userPromptParts.push(`CONVERSATION HISTORY:\n${previousContext}`);
        if (userText) userPromptParts.push(`Student says: "${userText}"`);
        if (userPromptParts.length === 0) userPromptParts.push('Hello Wolfie');

        const aiRawResult = await groqChat(groqKey, systemPrompt, userPromptParts.join('\n\n'));
        let parsedResult: any = {};
        try {
            parsedResult = JSON.parse(aiRawResult.trim());
        } catch {
            parsedResult = { chatResponse: "I encountered an error understanding that, could you repeat?", correction: null, translation: null, vocabulary: null, quiz: null };
        }

        if (sessionId && parsedResult.chatResponse) {
            const { data: wolfieTurn } = await supabaseClient.from('wolfie_turns').insert({
                session_id: sessionId, speaker: 'wolfie', content: parsedResult.chatResponse, turn_index: config.turnCount * 2 + 1
            }).select('id').single();
            if (parsedResult.correction) {
                await supabaseClient.from('wolfie_corrections').insert({
                    session_id: sessionId, turn_id: wolfieTurn?.id,
                    wrong_sentence: parsedResult.correction.original,
                    correct_sentence: parsedResult.correction.corrected,
                    explanation_pt: parsedResult.correction.explanation_pt,
                    error_type: 'general'
                }).catch((e: any) => console.error("Error saving correction:", e));
            }
        }

        const agentResponse: AgentResponse = {
            chatResponse: parsedResult.chatResponse,
            transcribedText: userText || null,
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
        return new Response(JSON.stringify({ error: error.stack || error.message }), {
            status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }
});
