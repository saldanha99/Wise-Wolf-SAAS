import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.23.0";

// ============================================================
// PEDAGOGICAL CONTENT GENERATOR
// ============================================================
// Gerador de conteúdo pedagógico estruturado (JSON puro) para
// trilhas de aprendizado, flashcards, quizzes, drills, etc.
//
// Por que separado do wolfie-brain?
//   → wolfie-brain é o TUTOR conversacional: força toda resposta
//     no schema da persona WOLFIE ({chatResponse, correction...}).
//     Isso quebra qualquer pedido de JSON estruturado (ex: {cards}).
//   → Aqui o system prompt é um gerador de JSON estrito, sem persona,
//     e devolvemos o JSON já parseado (result) + o raw para fallback.
// ============================================================

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Mesma hierarquia do wolfie-brain — Claude Haiku primeiro (JSON confiável),
// depois fallbacks pagos e gratuitos para nunca deixar o professor sem conteúdo.
const PREFERRED_MODELS = [
    'anthropic/claude-3.5-haiku',
    'anthropic/claude-3-haiku',
    'google/gemini-2.0-flash-exp:free',
    'openai/gpt-4o-mini',
    'google/gemini-flash-1.5',
    'meta-llama/llama-3.3-70b-instruct:free',
    'deepseek/deepseek-v4-flash:free',
    'openai/gpt-oss-20b:free',
];

// Extrai JSON limpo do texto do modelo — lida com objeto OU array,
// remove markdown fences e captura só o bloco JSON.
function extractJson(text: string): string {
    let cleaned = text.trim();
    if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    }
    const firstBrace = cleaned.indexOf('{');
    const firstBracket = cleaned.indexOf('[');
    // Decide array vs objeto pelo delimitador que aparece primeiro
    const isArray = firstBracket >= 0 && (firstBrace < 0 || firstBracket < firstBrace);
    if (isArray) {
        const last = cleaned.lastIndexOf(']');
        if (firstBracket >= 0 && last > firstBracket) cleaned = cleaned.slice(firstBracket, last + 1);
    } else {
        const last = cleaned.lastIndexOf('}');
        if (firstBrace >= 0 && last > firstBrace) cleaned = cleaned.slice(firstBrace, last + 1);
    }
    return cleaned;
}

async function callOpenRouter(apiKey: string, systemPrompt: string, userMessage: string): Promise<string> {
    let lastError: any = null;

    for (const model of PREFERRED_MODELS) {
        try {
            const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`,
                    'HTTP-Referer': 'https://app.wisewolf.com.br',
                    'X-Title': 'WiseCore Pedagogical Content',
                },
                body: JSON.stringify({
                    model,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userMessage },
                    ],
                    max_tokens: 2000,
                    temperature: 0.6,
                }),
                signal: AbortSignal.timeout(25000),
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.warn(`[pedagogical-content] ${model} falhou (${response.status}): ${errorText.slice(0, 200)}`);
                lastError = new Error(`${model} → ${response.status}`);
                if (response.status === 401) throw lastError; // chave inválida → aborta
                continue;
            }

            const data = await response.json();
            const text = data.choices?.[0]?.message?.content;
            if (!text || !text.trim()) {
                lastError = new Error(`${model} returned empty response`);
                continue;
            }

            const cleaned = extractJson(text);
            try {
                JSON.parse(cleaned);
            } catch {
                console.warn(`[pedagogical-content] ${model} retornou JSON inválido: ${cleaned.slice(0, 200)}`);
                lastError = new Error(`${model} returned invalid JSON`);
                continue;
            }

            console.log(`[pedagogical-content] ✅ ${model} respondeu (${cleaned.length} chars)`);
            return cleaned;
        } catch (err: any) {
            console.warn(`[pedagogical-content] ${model} exception: ${err.message}`);
            lastError = err;
            continue;
        }
    }

    throw lastError || new Error('Todos os modelos falharam');
}

serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

    try {
        const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
        const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
        const authHeader = req.headers.get('Authorization');
        const supabaseClient = createClient(supabaseUrl, supabaseAnonKey, { global: { headers: { Authorization: authHeader! } } });

        // Exige usuário autenticado (professor/admin chamam pelo painel).
        const jwt = authHeader?.replace('Bearer ', '');
        const { data: { user }, error: authError } = await supabaseClient.auth.getUser(jwt);
        if (authError || !user) throw new Error(`Auth Error: ${authError?.message || 'No User'}`);

        const apiKey = (Deno.env.get('OPENROUTER_API_KEY') ?? '').trim();
        if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set.');

        const body = await req.json();
        const userPrompt: string = body.prompt || '';
        if (!userPrompt.trim()) throw new Error('Missing prompt');

        const systemPrompt = `You are a strict JSON content generator for an English-learning platform (CEFR-aligned; learners are Brazilian Portuguese speakers).
The user's message contains a content brief and an EXACT target schema (it may be a JSON object or a JSON array).
Return ONLY valid, parseable JSON that matches the requested schema EXACTLY.
- NO markdown, NO code fences, NO commentary, NO extra keys.
- Output must be raw JSON only: start with { or [ and end with } or ].
- Keep pedagogical explanations in Brazilian Portuguese when the schema asks for them (fields like "exp", "explanation_pt", "translation", "rule_pt", "instructions_pt").
- English learning content (terms, examples, questions, reading text) stays in natural English appropriate to the requested CEFR level.`;

        const raw = await callOpenRouter(apiKey, systemPrompt, userPrompt);

        let result: any = null;
        try { result = JSON.parse(raw); } catch { /* deixa null; cliente usa raw como fallback */ }

        return new Response(JSON.stringify({ result, raw, aiText: raw }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    } catch (error: any) {
        console.error(`[pedagogical-content] FATAL: ${error.message}`);
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }
});
