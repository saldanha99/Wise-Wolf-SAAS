import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

    try {
        const supabaseClient = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
        );

        const geminiKey = (Deno.env.get('GEMINI_API_KEY') ?? '').trim();
        if (!geminiKey) {
            throw new Error("GEMINI_API_KEY is not set");
        }

        const { student_id } = await req.json();

        const { data: logs } = await supabaseClient
            .from('class_logs')
            .select('content, performance_notes, created_at')
            .eq('student_id', student_id)
            .order('created_at', { ascending: false })
            .limit(10);

        const logsText = logs?.map(l => `- ${l.content}: ${l.performance_notes}`).join('\n') || "No logs yet.";
        const prompt = `Analyze these logs and give a short motivational insight in Portuguese. Logs: ${logsText}`;

        // FIX: Using gemini-2.0-flash because debug logs confirmed it is available for this key.
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`;

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }]
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Gemini Error (${response.status}): ${errorText}`);
        }

        const data = await response.json();
        const insightContent = data.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!insightContent) throw new Error("No insight generated.");

        await supabaseClient.from('student_insights').insert({
            student_id,
            content: insightContent,
            valid_until: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
        });

        return new Response(JSON.stringify({ insight: { content: insightContent } }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });

    } catch (error: any) {
        console.error("Generate Insights Error:", error);
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }
});
