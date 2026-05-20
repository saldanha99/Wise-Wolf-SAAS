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

const WOLFIE_MOODS = ['bubbly', 'contemplative', 'cheerful', 'playful', 'warm'] as const;
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

function buildSystemPrompt(config: WolfieConfig, studentName?: string, studentGoal?: string, previousContext?: string, memory?: WolfMemory): string {
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

    return `You are WOLFIE (Smart Wolf), an advanced native English Tutor and friendly Conversation Partner from Wise Wolf.
YOUR MOOD THIS SESSION: ${sessionMood}. Let this subtly influence your tone.

STUDENT INFO:
- Name: ${studentName || 'Student'}
- Level: ${studentLevel}
- Goal: ${studentGoal || 'practice speaking fluently'}
${memoryBlock}
${levelGuidance}

CRITICAL INSTRUCTION - STRUCTURED JSON OUTPUT ONLY:
You MUST process the student's input (which may have speech-to-text errors) and ALWAYS return a SINGLE RAW JSON Object.
DO NOT WRAP THE JSON IN MARKDOWN BLOCKS (\`\`\`json). RETURN ONLY THE RAW BRACES { ... }.

EXPECTED JSON FORMAT:
{
  "chatResponse": "Your actual spoken reply to the student. ${chatLangInstruct} Use contractions (I'm, don't). DO NOT include markdown, emojis, asterisks or bullet points here because it will be passed to Text-to-Speech.",

  "transcribedText": "If the input was audio, write what the student ACTUALLY said in English (best transcription). Null if input was text-only.",

  "correction": null | {
    "original": "the exact text the student got wrong, if any major grammar/lexical errors occurred in their English",
    "corrected": "the natural/correct way to say it",
    "explanation_pt": "short explanation in Portuguese about the correction"
  },

  "pronunciation": null | {
    "score": 0-100,
    "level": "POOR" | "FAIR" | "GOOD" | "EXCELLENT",
    "issues": ["concise issue 1 (e.g. 'th' pronounced as 'd'", "vowel /æ/ confused with /e/"],
    "tip_pt": "ONE actionable tip in Portuguese (max 1 sentence)"
  },

  "translation": ${trans},

  "vocabulary": ${vocab},

  "quiz": null
}

RULES:
- Be incredibly smart and contextual. You know how to hold a fascinating conversation about anything.
- If the student made a noticeable English error, provide a 'correction' object. Otherwise, set it to null.
- If 'vocabularyEnabled' is true and you used useful terms, populate 'vocabulary' (up to 2 terms). Otherwise, set to null.
- The 'chatResponse' is text-to-speech, so make it conversational and VERY natural to speak aloud.

LANGUAGE DETECTION RULES (CRITICAL — avoid the "fale em inglês" bug):
- NEVER ask the student to speak in English if they are ALREADY speaking English.
- Look at 'transcribedText' / message content carefully: if it contains English words, sentences, or even broken English, treat them as practicing English.
- Only nudge towards English if the student wrote a FULL sentence in pure Portuguese (with no English mixed in) AND turnCount > 0.
- If the student is speaking English with errors → CORRECT them gently, don't ask them to "speak in English" (they already are).
- If the student switches to Portuguese to ask a meta-question (e.g. "como se diz X?"), answer in Portuguese and then pivot back to English naturally.

PRONUNCIATION RULES (when audio is provided — MANDATORY analysis):
- LISTEN to the actual audio natively. Don't only judge transcription.
- ALWAYS populate the 'pronunciation' object whenever audio with English is sent. Never null when audio is present and the student spoke any English.
- score: holistic 0-100. BE HONEST — most non-native speakers score 50-80. Reserve 90+ for near-native.
- level: POOR (<50), FAIR (50-69), GOOD (70-84), EXCELLENT (85+).
- issues: ALWAYS list at least 1 specific phonetic issue when score < 85 (e.g., "th pronounced as d", "vowel /æ/ in 'cat' too close to /e/", "stress on wrong syllable in 'develop'"). Be specific to what you heard.
- tip_pt: ALWAYS provide one actionable, concrete tip in Portuguese (e.g., "Tente colocar a língua entre os dentes ao falar 'th'."). NUNCA deixe vazio.
- If the student EXPLICITLY asks for pronunciation feedback ("how's my accent?", "como está meu sotaque?") → MUST return a detailed pronunciation object with score, level, issues, and tip_pt — never just say "it's good and let's continue".
- Only set pronunciation to null if the audio contains ZERO English (100% Portuguese or silence).
`;
}

// ============================================================
// OPENROUTER CALL HELPER — Dynamic model discovery + fallback
// ============================================================
// Em vez de lista fixa, buscamos TODOS os modelos gratuitos (:free) em tempo
// real via /api/v1/models. Se o endpoint falhar, caímos na lista estática abaixo.
// Importante: NUNCA usar response_format: json_object — ele agrava o rate-limit
// no DeepSeek free. Confiamos na instrução no prompt + sanitização + JSON.parse validation.

// Lista estática usada apenas se a API de modelos do OpenRouter estiver indisponível
const FREE_MODELS_FALLBACK = [
    'openai/gpt-oss-120b:free',
    'nvidia/nemotron-3-super-120b-a12b:free',
    'z-ai/glm-4.5-air:free',
    'minimax/minimax-m2.5:free',
    'openai/gpt-oss-20b:free',
    'google/gemma-4-31b-it:free',
    'google/gemma-4-26b-a4b-it:free',
    'deepseek/deepseek-v4-flash:free',
    'meta-llama/llama-3.3-70b-instruct:free',
    'nousresearch/hermes-3-llama-3.1-405b:free',
];

// Modelos que tendem a ter problemas persistentes — excluídos da lista dinâmica
const BLOCKLIST_PATTERNS = [
    'vision',  // modelos de visão consomem mais cota
];

/**
 * Busca os modelos :free disponíveis no OpenRouter em tempo real.
 * Se a chamada falhar por qualquer motivo, retorna a lista estática.
 * Isso garante que quando um modelo gratuito é removido/desativado,
 * o sistema automaticamente descobre os novos sem precisar de redeploy.
 */
async function getAvailableFreeModels(apiKey: string): Promise<string[]> {
    try {
        const res = await fetch('https://openrouter.ai/api/v1/models', {
            headers: { 'Authorization': `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(5000), // máx 5s para não atrasar a resposta
        });

        if (!res.ok) {
            console.warn(`[OpenRouter] Falha ao buscar modelos (${res.status}), usando lista estática`);
            return FREE_MODELS_FALLBACK;
        }

        const data = await res.json();
        const models: string[] = (data?.data || [])
            .filter((m: any) => {
                const id: string = m.id || '';
                if (!id.endsWith(':free')) return false;
                // Exclui modelos problemáticos por padrão
                if (BLOCKLIST_PATTERNS.some(p => id.includes(p))) return false;
                return true;
            })
            .map((m: any) => m.id as string);

        if (models.length === 0) {
            console.warn('[OpenRouter] Nenhum modelo :free encontrado na API, usando lista estática');
            return FREE_MODELS_FALLBACK;
        }

        // Prioriza modelos da lista estática (sabemos que funcionam bem) e depois
        // acrescenta os dinâmicos que não estão na lista. Isso dá preferência a modelos
        // testados enquanto garante que novos modelos sejam tentados se os conhecidos falharem.
        const knownGood = FREE_MODELS_FALLBACK.filter(m => models.includes(m));
        const newModels = models.filter(m => !FREE_MODELS_FALLBACK.includes(m));
        const unknownFallback = FREE_MODELS_FALLBACK.filter(m => !models.includes(m)); // mantém mesmo que sumidos

        const merged = [...knownGood, ...newModels, ...unknownFallback];
        console.log(`[OpenRouter] Modelos disponíveis: ${merged.length} (${knownGood.length} conhecidos + ${newModels.length} novos)`);
        return merged;

    } catch (err: any) {
        console.warn(`[OpenRouter] Erro ao buscar modelos: ${err.message}. Usando lista estática.`);
        return FREE_MODELS_FALLBACK;
    }
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
    const modelsToTry = await getAvailableFreeModels(apiKey);

    let lastError: any = null;

    for (const model of modelsToTry) {
        const payload: any = {
            model,
            messages: [
                { role: 'system', content: finalSystemPrompt },
                { role: 'user', content: userMessage },
            ],
            max_tokens: 1024,
            temperature: 0.7,
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
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.warn(`[OpenRouter] ${model} falhou (${response.status}): ${errorText.slice(0, 200)}`);
                lastError = new Error(`${model} → ${response.status}: ${errorText.slice(0, 200)}`);
                // 429 / 503 / 5xx → tenta próximo modelo
                if (response.status === 429 || response.status === 503 || response.status >= 500 || response.status === 404) continue;
                // Erro permanente (auth, etc) → aborta
                throw lastError;
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

    throw new Error(`Todos os modelos free falharam. Último erro: ${lastError?.message || 'desconhecido'}`);
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

        const openRouterKey = (Deno.env.get('OPENROUTER_API_KEY') ?? '').trim();
        if (!openRouterKey) throw new Error("OPENROUTER_API_KEY is not set.");

        // ── Billing Check ──
        const jwt = authHeader?.replace('Bearer ', '');
        const { data: { user }, error: authError } = await supabaseClient.auth.getUser(jwt);
        if (authError || !user) {
            throw new Error(`Auth Error: ${authError?.message || 'No User'}. Header Exists: ${!!authHeader}`);
        }

        const { data: profile } = await supabaseClient
            .from('profiles')
            .select('full_name, goal, student_profile_json, english_for, short_term_goal, preferred_topics, avoided_topics, personality')
            .eq('id', user.id)
            .single();

        // ── Wolf Intelligence: memoria entre sessoes ──
        const [wolfIntelRes, recentCorrectionsRes] = await Promise.all([
            supabaseClient
                .from('wolf_intelligence')
                .select('accumulated_context, weak_points, strong_points, recommended_approach')
                .eq('student_id', user.id)
                .maybeSingle(),
            supabaseClient
                .from('wolfie_corrections')
                .select('wrong_sentence, correct_sentence, explanation_pt, created_at, session_id')
                .eq('session_id', conversationId || '00000000-0000-0000-0000-000000000000') // dummy se nao houver
                .order('created_at', { ascending: false })
                .limit(5)
        ]);

        // Se nao temos correcoes da sessao atual ainda, busca historicas via sessoes do aluno
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

        const systemPrompt = buildSystemPrompt(config, profile?.full_name, profile?.goal, previousContext, wolfMemory);

        const aiRawResult = await callOpenRouter(
            openRouterKey,
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

                // ── Atualizar wolf_intelligence incrementalmente (non-blocking) ──
                // Extrai um "weak_point" sucinto da explicacao para o feed entre sessoes.
                try {
                    const newWeakPoint = (parsedResult.correction.explanation_pt || parsedResult.correction.original || '').slice(0, 140);
                    if (newWeakPoint) {
                        const existingWeaks = wolfMemory.weak_points || [];
                        // Dedupe simples por substring para evitar lista repetitiva
                        const isDuplicate = existingWeaks.some((w: string) =>
                            w.toLowerCase().includes(newWeakPoint.toLowerCase().slice(0, 30))
                            || newWeakPoint.toLowerCase().includes(w.toLowerCase().slice(0, 30))
                        );
                        if (!isDuplicate) {
                            const updatedWeaks = [newWeakPoint, ...existingWeaks].slice(0, 10);
                            await supabaseClient.from('wolf_intelligence').upsert({
                                student_id: user.id,
                                tenant_id: user.user_metadata?.tenant_id || profile?.tenant_id || null,
                                weak_points: updatedWeaks,
                                total_classes_analyzed: (wolfIntelRes.data as any)?.total_classes_analyzed
                                    ? ((wolfIntelRes.data as any).total_classes_analyzed + 1)
                                    : 1,
                                last_updated_at: new Date().toISOString(),
                            }, { onConflict: 'student_id' });
                        }
                    }
                } catch (memErr) {
                    console.error('Error updating wolf_intelligence:', memErr);
                }
            }
        }

        // ── Build Structured Response ──
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
        console.error("Wolfie Brain Fatal Error:", error);
        return new Response(JSON.stringify({ error: error.stack || error.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }
});
