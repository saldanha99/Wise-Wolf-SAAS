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
    transcribedText?: string | null;
    correction: {
        original: string;
        corrected: string;
        explanation_pt: string;
    } | null;
    pronunciation?: {
        score: number;
        level: 'POOR' | 'FAIR' | 'GOOD' | 'EXCELLENT';
        issues: string[];
        tip_pt: string;
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

const WOLFIE_MOODS = [
    'bubbly and a little chaotic (in a fun way)',
    'low-key excited about everything',
    'chill and funny, drops dry humor',
    'warm and encouraging, hypes the student up',
    'curious and nerdy, goes deep on topics',
    'playful, teases a little (nicely)',
] as const;
const sessionMood = WOLFIE_MOODS[Math.floor(Math.random() * WOLFIE_MOODS.length)];

interface WolfMemory {
    accumulated_context?: string;
    weak_points?: string[];
    strong_points?: string[];
    recommended_approach?: string;
    recent_corrections?: { wrong: string; correct: string; explanation?: string }[];
    short_term_goal?: string;
    english_for?: string;
    preferred_topics?: string[];
    avoided_topics?: string[];
}

function buildSystemPrompt(config: WolfieConfig, studentName?: string, studentGoal?: string, previousContext?: string, memory?: WolfMemory, studentLanguage?: 'pt' | 'en'): string {
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
        ? `First interaction: Greet ${studentName || 'the student'} warmly IN PORTUGUESE with energy and personality — like a friend texting them. Introduce yourself as Wolfie (Lobo Sábio da Wise Wolf). Ask ONE specific question about their goal today: job interview? travel? Netflix shows? Be curious, not generic. Keep it short and punchy.`
        : studentLanguage === 'pt'
            ? `O aluno está falando PORTUGUÊS agora. Responda INTEIRAMENTE EM PORTUGUÊS BRASILEIRO — como um amigo de verdade conversando. Seja natural, divertido, caloroso. Se ele pedir uma palavra ou expressão em inglês, responda normalmente. MAX 2-3 frases curtas. SEM emojis, SEM markdown, SEM bullets. Vai direto para o Text-to-Speech.`
            : `Reply NATURALLY IN ENGLISH like a real conversation. Be direct, warm, a bit spontaneous. React genuinely to what they said before diving into the teaching point. Ask ONE specific follow-up question — not a generic "what do you think?" but something that shows you actually listened. Max 2-3 sentences of chatResponse.`;

    // Sem tradução quando aluno fala PT (resposta já será em PT) ou translationEnabled=false
    const trans = (translationEnabled && studentLanguage !== 'pt')
        ? `"Natural PT-BR translation of your English chatResponse"`
        : "null";
    const vocab = vocabularyEnabled ? `null | {\n    "keyTerms": [\n      { "term": "word", "definition": "meaning", "level": "${studentLevel}", "synonyms": ["syn1"], "example": "example" }\n    ],\n    "grammarNote": "short note in PT if a specific grammatical point is relevant"\n  }` : "null";

    // Memory block: o que sabemos sobre o aluno entre sessoes
    let memoryBlock = '';
    if (memory) {
        const parts: string[] = [];
        if (memory.english_for) parts.push(`- Studying English for: ${memory.english_for}`);
        if (memory.short_term_goal) parts.push(`- Short-term goal: ${memory.short_term_goal}`);
        if (memory.preferred_topics?.length) parts.push(`- Likes to talk about: ${memory.preferred_topics.join(', ')}`);
        if (memory.avoided_topics?.length) parts.push(`- Avoid these topics: ${memory.avoided_topics.join(', ')}`);
        if (memory.accumulated_context) parts.push(`- Background: ${memory.accumulated_context}`);
        if (memory.strong_points?.length) parts.push(`- Already strong at: ${memory.strong_points.slice(0, 4).join(', ')}`);
        if (memory.weak_points?.length) parts.push(`- Still struggles with: ${memory.weak_points.slice(0, 4).join(', ')}`);
        if (memory.recommended_approach) parts.push(`- Recommended teaching approach: ${memory.recommended_approach}`);

        if (memory.recent_corrections?.length) {
            const recent = memory.recent_corrections.slice(0, 3)
                .map(c => `  · said "${c.wrong}" → should be "${c.correct}"`).join('\n');
            parts.push(`- Recent corrections you made (don't repeat the same fix; if they repeat the SAME error, name it explicitly so they notice):\n${recent}`);
        }

        if (parts.length > 0) {
            memoryBlock = `\nSTUDENT MEMORY (from past sessions — use it naturally, never quote it verbatim):\n${parts.join('\n')}\n`;
        }
    }

    return `You are WOLFIE — a real, sharp, funny, deeply human English tutor from Wise Wolf Language School in Brazil. You're basically that one friend who speaks perfect English AND is incredibly good at teaching it without making it feel like a lesson.

YOUR VIBE THIS SESSION: ${sessionMood}. Let this drive HOW you talk — not what you teach.

WHO YOU ARE:
- You use contractions constantly: you're, don't, that's, I'd, wouldn't, it's
- You react genuinely: "Wait, seriously?", "Oh that's actually a great point.", "Hmm, okay so...", "No way, I love that topic!"
- You give opinions: "Honestly I think...", "To be fair...", "I mean, it depends, but..."
- You're funny when it fits — dry humor, light teasing, the occasional "well, this is awkward" moment
- You NEVER say generic things like "Great job!", "That's wonderful!", "Very good!" — be specific
- You sound like a real person texting/talking, not a robot reading a script
- You use simple vocabulary when needed but you don't dumb yourself down — you just rephrase naturally

STUDENT INFO:
- Name: ${studentName || 'Student'}
- Level: ${studentLevel}
- Goal: ${studentGoal || 'practice speaking fluently'}
${memoryBlock}
${levelGuidance}

CONVERSATION STYLE:
- React first, then teach. Don't open with a correction — open with a human response to what they said.
- If they said something interesting, pick a specific detail and run with it.
- End with ONE specific, curious question — not "What do you think?" but "Wait, so when you said X, did you mean...?" or "Have you ever actually tried to...?"
- Max 2-3 sentences in chatResponse. Short, punchy, real.

CORRECTION PHILOSOPHY:
- Small errors (articles, minor prepositions) → weave the correct version naturally into your reply ("Oh yeah, THE meeting, right — what happened?")
- Medium errors → correct once, briefly, with a natural segue ("Just a tiny thing: we'd say 'I went' not 'I go' there — past tense. Anyway, what happened next?")
- Big errors only → use the correction object. Keep explanation_pt short and clear, not condescending.
- NEVER correct more than 1 thing per turn. Pick the most important.

SPEAKING / PRONUNCIATION (CRITICAL — this text goes straight to Text-to-Speech):
- When speaking English, ALWAYS use natural, native-like pronunciation, rhythm, stress and connected speech.
- NEVER spell words out, NEVER separate words into syllables, and NEVER slow down unnaturally — unless the learner explicitly asks for a slower repetition.
- Preserve connected speech, reductions and contractions (I'd, gonna, wanna, "I'd like to" not "I would like to").
- If the user asks for a translation PT→EN or "how do I say this in English?", FIRST say the complete English sentence in one natural, conversational flow, exactly as a fluent native speaker would say it — as a single normal phrase, never word-by-word.
  ❌ WRONG: "I... would... like... to... book... a... hotel..."
  ✅ RIGHT: "I'd like to book a hotel."
- Only AFTER saying the full natural sentence, you may briefly explain it (e.g., "'I'd like to book a hotel' means 'Eu gostaria de reservar um hotel'."). Word-by-word breakdown ONLY if the learner explicitly asks.
- Do NOT insert ellipses (...), dashes between words, or extra spaces/line breaks inside an English phrase — write it as one clean sentence so the TTS reads it naturally.

OUTPUT — RETURN ONLY RAW JSON, NO MARKDOWN WRAPPERS:
{
  "chatResponse": "${chatLangInstruct} NO markdown, NO emojis, NO bullet points. This goes straight to Text-to-Speech.",

  "transcribedText": "Exact transcription of audio if audio was provided. Null for text input.",

  "correction": null | {
    "original": "what the student actually said (verbatim, only if a notable error)",
    "corrected": "the natural correct version",
    "explanation_pt": "one short sentence in PT explaining why. Be chill, not a lecture."
  },

  "pronunciation": null | {
    "score": 0-100,
    "level": "POOR" | "FAIR" | "GOOD" | "EXCELLENT",
    "issues": ["specific phonetic issue observed in THIS audio"],
    "tip_pt": "one concrete, actionable tip in PT. Never leave empty."
  },

  "translation": ${trans},

  "vocabulary": ${vocab},

  "quiz": null
}

LANGUAGE DETECTION (CRITICAL):
- Student speaking English with errors → CORRECT them, do NOT ask them to speak English. They already are.
- Student in pure PT asking a meta question ("como se diz X?") → answer in PT, pivot back to EN naturally.
- Student mixing PT/EN → treat as EN practice, respond mostly in EN.
- NEVER say "fale em inglês" or "please speak in English" unless it's literally the first message and they haven't tried at all.

PRONUNCIATION (when audio provided):
- ALWAYS fill pronunciation object when audio has any English. Never null.
- Be honest: most learners score 55–80. 90+ is near-native only.
- Find ONE specific real issue (e.g., "th → d sound", "final consonant dropped", "stress on wrong syllable in 'comfortable'")
- tip_pt: always concrete. "Coloque a língua entre os dentes no 'th'." Not "practice more."
`;
}

// ============================================================
// OPENROUTER CALL HELPER — Modelo prioritário: Claude Haiku
// ============================================================
// Hierarquia de modelos:
//   1. anthropic/claude-3.5-haiku  → melhor personalidade, JSON confiável, rápido (~$0.001/turno)
//   2. google/gemini-2.0-flash-exp:free → rápido, grátis, segue prompt bem
//   3. openai/gpt-4o-mini          → fallback pago confiável
//   4. modelos free do OpenRouter  → último recurso, para não deixar o usuário sem resposta
//
// Por que não usar só modelos free?
//   → Rate limit 429 frequente → retry em cadeia → "PROCESSANDO..." trava por 10-30s
//   → JSON malformado → resposta genérica de erro ("I didn't catch that")
//   → Personalidade robótica, não seguem bem o system prompt

const PREFERRED_MODELS = [
    'anthropic/claude-3.5-haiku',           // 1º: mais inteligente, mais humano, JSON perfeito
    'anthropic/claude-3-haiku',             // 2º: haiku legado, igualmente bom
    'google/gemini-2.0-flash-exp:free',     // 3º: rápido, grátis, segue bem o prompt
    'openai/gpt-4o-mini',                   // 4º: confiável, barato
    'google/gemini-flash-1.5',              // 5º: fallback google
    'meta-llama/llama-3.3-70b-instruct:free',  // 6º: free, decente
    'deepseek/deepseek-v4-flash:free',      // 7º: free fallback
    'openai/gpt-oss-20b:free',              // 8º: free fallback
    'google/gemma-4-31b-it:free',           // 9º: free fallback
    'nousresearch/hermes-3-llama-3.1-405b:free', // 10º: último recurso
];

function getModelsToTry(): string[] {
    return PREFERRED_MODELS;
}

async function callOpenRouter(
    apiKey: string,
    systemPrompt: string,
    userContent: any[],
    jsonMode: boolean = true
): Promise<string> {
    // Extrai texto e info de áudio dos parts Gemini-style
    const textParts = userContent
        .filter(p => p.text)
        .map(p => p.text)
        .join('\n');

    const hasAudio = userContent.some(p => p.inline_data);

    const userMessage = hasAudio
        ? `[O aluno enviou um áudio — transcreva como se fosse texto]\n${textParts}`
        : textParts;

    // Reforça JSON output sempre no system prompt — não usamos response_format
    // porque ele triplica a chance de 429 no DeepSeek free.
    const finalSystemPrompt = jsonMode
        ? systemPrompt + '\n\nCRITICAL: Return ONLY a valid JSON object starting with { and ending with }. NOTHING before or after. NO markdown wrappers (```json), NO explanations. Just the raw JSON.'
        : systemPrompt;

    // Busca dinamicamente os modelos :free disponíveis no momento
    const modelsToTry = getModelsToTry();

    let lastError: any = null;

    for (const model of modelsToTry) {
        const payload: any = {
            model,
            messages: [
                { role: 'system', content: finalSystemPrompt },
                { role: 'user', content: userMessage },
            ],
            max_tokens: 1200,
            temperature: model.includes('claude') ? 0.85 : 0.75, // Claude responde melhor com temp ligeiramente mais alta
        };

        try {
            const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`,
                    'HTTP-Referer': 'https://app.wisewolf.com.br',
                    'X-Title': 'WiseCore Wolfie',
                },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(25000), // 25s timeout por modelo
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.warn(`[OpenRouter] ${model} falhou (${response.status}): ${errorText.slice(0, 200)}`);
                lastError = new Error(`${model} → ${response.status}: ${errorText.slice(0, 200)}`);
                // 401 = chave API inválida → aborta (não adianta tentar outros modelos)
                if (response.status === 401) throw lastError;
                // Qualquer outro erro (402 sem créditos, 403, 404, 429, 500, etc.) → tenta próximo modelo
                continue;
            }

            const data = await response.json();
            const text = data.choices?.[0]?.message?.content;
            if (!text || !text.trim()) {
                console.warn(`[OpenRouter] ${model} retornou resposta vazia, tentando próximo...`);
                lastError = new Error(`${model} returned empty response`);
                continue;
            }

            // Sanitiza: remove markdown wrappers e captura só o JSON quando aplicável
            let cleaned = text.trim();
            if (cleaned.startsWith('```')) {
                cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
            }
            if (jsonMode) {
                const firstBrace = cleaned.indexOf('{');
                const lastBrace = cleaned.lastIndexOf('}');
                if (firstBrace >= 0 && lastBrace > firstBrace) {
                    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
                }
                // Valida o JSON antes de retornar — se inválido, tenta próximo modelo
                try {
                    JSON.parse(cleaned);
                } catch (parseErr) {
                    console.warn(`[OpenRouter] ${model} retornou JSON inválido, tentando próximo. Raw: ${cleaned.slice(0, 200)}`);
                    lastError = new Error(`${model} returned invalid JSON`);
                    continue;
                }
            }

            console.log(`[OpenRouter] ✅ ${model} respondeu (${cleaned.length} chars)`);
            return cleaned;
        } catch (err: any) {
            console.warn(`[OpenRouter] ${model} exception: ${err.message}`);
            lastError = err;
            continue;
        }
    }

    // Retorna um JSON válido em vez de lançar exceção — evita 500 no cliente
    console.error(`[OpenRouter] Todos os modelos falharam. Último erro: ${lastError?.message}`);
    return JSON.stringify({
        chatResponse: "Hey, I hit a little snag on my end — totally not your fault! Give it another shot in a few seconds?",
        correction: null,
        translation: "Ei, tive um probleminha aqui — tenta de novo em alguns segundos?",
        vocabulary: null,
        quiz: null,
    });
}


// ============================================================
// MAIN ORCHESTRATOR
// ============================================================
serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

    // Rastreia qual seção está sendo executada — aparece no log do 500 para diagnóstico exato
    let _section = 'init';

    try {
        _section = 'body_parse';
        let body;
        try {
            body = await req.json();
        } catch (e) {
            console.error("[wolfie] JSON Parse Error:", e);
            throw new Error("Invalid JSON body");
        }

        const { message, audioBase64, previousContext, conversationId, studentLanguage } = body;

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

        console.log(`[WolfieBrain v112-pronunciation] Text=${message?.length || 0}, Audio=${!!audioBase64}, Turn=${config.turnCount}, Lang=${studentLanguage || 'auto'}, ConvId=${conversationId ? conversationId.slice(0,8) : 'null'}`);

        _section = 'supabase_setup';
        const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
        const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
        const authHeader = req.headers.get('Authorization');
        const supabaseClient = createClient(supabaseUrl, supabaseAnonKey, { global: { headers: { Authorization: authHeader! } } });

        const openRouterKey = (Deno.env.get('OPENROUTER_API_KEY') ?? '').trim();
        if (!openRouterKey) throw new Error("OPENROUTER_API_KEY is not set.");

        _section = 'auth';
        const jwt = authHeader?.replace('Bearer ', '');
        const { data: { user }, error: authError } = await supabaseClient.auth.getUser(jwt);
        if (authError || !user) {
            throw new Error(`Auth Error: ${authError?.message || 'No User'}. Header: ${!!authHeader}`);
        }

        _section = 'profile_fetch';
        const { data: profile, error: profileErr } = await supabaseClient
            .from('profiles')
            .select('full_name, goal, student_profile_json, english_for, short_term_goal, preferred_topics, avoided_topics, personality, tenant_id')
            .eq('id', user.id)
            .maybeSingle(); // maybeSingle em vez de single — não joga erro se não achar
        if (profileErr) console.warn(`[wolfie] profile fetch warn: ${profileErr.message}`);

        _section = 'wolf_intelligence_fetch';
        const [wolfIntelRes, recentCorrectionsRes] = await Promise.all([
            supabaseClient
                .from('wolf_intelligence')
                .select('accumulated_context, weak_points, strong_points, recommended_approach, total_classes_analyzed')
                .eq('student_id', user.id)
                .maybeSingle(),
            supabaseClient
                .from('wolfie_corrections')
                .select('wrong_sentence, correct_sentence, explanation_pt, created_at, session_id')
                .eq('session_id', conversationId || '00000000-0000-0000-0000-000000000000')
                .order('created_at', { ascending: false })
                .limit(5)
        ]);

        _section = 'historic_corrections_fetch';
        let historicCorrections: any[] = recentCorrectionsRes.data || [];
        if (historicCorrections.length === 0) {
            const { data: sessions } = await supabaseClient
                .from('wolfie_sessions')
                .select('id')
                .eq('student_id', user.id)
                .order('started_at', { ascending: false })
                .limit(5);
            const sessionIds = (sessions || []).map((s: any) => s.id);
            if (sessionIds.length > 0) {
                const { data: corr } = await supabaseClient
                    .from('wolfie_corrections')
                    .select('wrong_sentence, correct_sentence, explanation_pt')
                    .in('session_id', sessionIds)
                    .order('created_at', { ascending: false })
                    .limit(5);
                historicCorrections = corr || [];
            }
        }

        const wolfMemory: WolfMemory = {
            accumulated_context: wolfIntelRes.data?.accumulated_context,
            weak_points: wolfIntelRes.data?.weak_points,
            strong_points: wolfIntelRes.data?.strong_points,
            recommended_approach: wolfIntelRes.data?.recommended_approach,
            short_term_goal: profile?.short_term_goal,
            english_for: profile?.english_for,
            preferred_topics: profile?.preferred_topics,
            avoided_topics: profile?.avoided_topics,
            recent_corrections: historicCorrections.map((c: any) => ({
                wrong: c.wrong_sentence,
                correct: c.correct_sentence,
                explanation: c.explanation_pt,
            })),
        };

        _section = 'billing_check';
        const now = new Date();
        const { data: payments, error: paymentsErr } = await supabaseClient
            .from('student_payments')
            .select('due_date')
            .eq('student_id', user.id)
            .neq('status', 'RECEIVED')
            .neq('status', 'CONFIRMED')
            .lt('due_date', now.toISOString());
        if (paymentsErr) console.warn(`[wolfie] payments fetch warn: ${paymentsErr.message}`);

        if (payments && payments.length > 0) {
            const sorted = payments.sort((a: any, b: any) => new Date(a.due_date).getTime() - new Date(b.due_date).getTime());
            const oldestDue = new Date(sorted[0].due_date);
            const daysLate = Math.ceil(Math.abs(now.getTime() - oldestDue.getTime()) / (1000 * 60 * 60 * 24));
            if (daysLate > 7) {
                return new Response(JSON.stringify({ error: "ACCESS_SUSPENDED", code: "PAYMENT_REQUIRED" }), { status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
            }
        }

        _section = 'session_create';
        let sessionId = conversationId;
        if (!sessionId) {
            const { data: newSession, error: sessionError } = await supabaseClient
                .from('wolfie_sessions')
                .insert({
                    student_id: user.id,
                    tenant_id: user.user_metadata?.tenant_id || profile?.tenant_id || '00000000-0000-0000-0000-000000000000',
                    topic: config.topic,
                    mode: config.mode,
                    student_level: config.studentLevel,
                    config_snapshot: config,
                    started_at: new Date().toISOString()
                })
                .select('id')
                .single();

            if (sessionError) console.error(`[wolfie] session create error: ${sessionError.message}`);
            else if (newSession) sessionId = newSession.id;
        }

        _section = 'student_turn_insert';
        if (sessionId && (message || audioBase64)) {
            const { error: stuTurnErr } = await supabaseClient.from('wolfie_turns').insert({
                session_id: sessionId,
                speaker: 'student',
                content: message || "[Audio Input]",
                turn_index: config.turnCount * 2
            });
            if (stuTurnErr) console.error(`[wolfie] student_turn insert error (non-fatal): ${stuTurnErr.message}`);
        }

        _section = 'prompt_assembly';
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

        _section = 'openrouter_call';
        const systemPrompt = buildSystemPrompt(config, profile?.full_name, profile?.goal, previousContext, wolfMemory, studentLanguage);

        const aiRawResult = await callOpenRouter(
            openRouterKey,
            systemPrompt,
            userContentParts,
            true
        );

        _section = 'json_parse';
        let parsedResult: any = {};
        try {
            parsedResult = JSON.parse(aiRawResult.trim());
        } catch (err) {
            console.error(`[wolfie] JSON parse failed. Raw: ${aiRawResult.slice(0, 300)}`);
            parsedResult = {
                chatResponse: "Hmm, something went sideways on my end — not your fault at all! Can you say that again?",
                correction: null,
                translation: null,
                vocabulary: null,
                quiz: null
            };
        }

        _section = 'wolfie_turn_insert';
        let wolfieTurnId: string | null = null;
        if (sessionId && parsedResult.chatResponse) {
            const { data: wolfieTurnData, error: wolfTurnErr } = await supabaseClient.from('wolfie_turns').insert({
                session_id: sessionId,
                speaker: 'wolfie',
                content: parsedResult.chatResponse,
                turn_index: config.turnCount * 2 + 1
            }).select('id').maybeSingle(); // maybeSingle é mais seguro que single
            if (wolfTurnErr) console.error(`[wolfie] wolfie_turn insert error (non-fatal): ${wolfTurnErr.message}`);
            else wolfieTurnId = wolfieTurnData?.id ?? null;

            _section = 'correction_insert';
            if (parsedResult.correction) {
                const { error: corrErr } = await supabaseClient.from('wolfie_corrections').insert({
                    session_id: sessionId,
                    turn_id: wolfieTurnId,
                    wrong_sentence: parsedResult.correction.original,
                    correct_sentence: parsedResult.correction.corrected,
                    explanation_pt: parsedResult.correction.explanation_pt,
                    error_type: 'general'
                });
                if (corrErr) console.error(`[wolfie] correction insert error (non-fatal): ${corrErr.message}`);

                _section = 'wolf_intelligence_upsert';
                try {
                    const newWeakPoint = (parsedResult.correction.explanation_pt || parsedResult.correction.original || '').slice(0, 140);
                    if (newWeakPoint) {
                        const existingWeaks = wolfMemory.weak_points || [];
                        const isDuplicate = existingWeaks.some((w: string) =>
                            w.toLowerCase().includes(newWeakPoint.toLowerCase().slice(0, 30))
                            || newWeakPoint.toLowerCase().includes(w.toLowerCase().slice(0, 30))
                        );
                        if (!isDuplicate) {
                            const updatedWeaks = [newWeakPoint, ...existingWeaks].slice(0, 10);
                            const { error: wIntelErr } = await supabaseClient.from('wolf_intelligence').upsert({
                                student_id: user.id,
                                tenant_id: user.user_metadata?.tenant_id || profile?.tenant_id || null,
                                weak_points: updatedWeaks,
                                total_classes_analyzed: ((wolfIntelRes.data as any)?.total_classes_analyzed ?? 0) + 1,
                                last_updated_at: new Date().toISOString(),
                            }, { onConflict: 'student_id' });
                            if (wIntelErr) console.error(`[wolfie] wolf_intelligence upsert error (non-fatal): ${wIntelErr.message}`);
                        }
                    }
                } catch (memErr: any) {
                    console.error(`[wolfie] wolf_intelligence block error (non-fatal): ${memErr.message}`);
                }
            }
        }

        _section = 'build_response';
        const agentResponse: AgentResponse = {
            chatResponse: parsedResult.chatResponse,
            transcribedText: parsedResult.transcribedText ?? null,
            correction: parsedResult.correction,
            pronunciation: parsedResult.pronunciation ?? null,
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
        // O nome da seção agora aparece no erro → fácil de debugar nos logs
        console.error(`[wolfie] FATAL at section '${_section}': ${error.message}`, error.stack);
        return new Response(JSON.stringify({ error: `[${_section}] ${error.stack || error.message}` }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }
});
