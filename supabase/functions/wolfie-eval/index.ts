import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { authorizeRequest, methodNotAllowed } from "../_shared/request-auth.ts";

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
    }
    if (req.method !== 'POST') return methodNotAllowed(corsHeaders);

    const auth = await authorizeRequest(req, {
        corsHeaders,
        allowService: true,
        allowedRoles: ['STUDENT', 'TEACHER', 'COORDINATOR', 'SCHOOL_ADMIN', 'SUPER_ADMIN'],
    });
    if (!auth.ok) return auth.response;

    try {
        const { sessionId } = await req.json();

        if (typeof sessionId !== 'string' || !sessionId.trim()) {
            return new Response(JSON.stringify({ error: 'Missing sessionId' }), {
                status: 400,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        // 1. Setup Client
        const supabaseClient = auth.context.admin;

        const geminiKey = Deno.env.get('GEMINI_API_KEY') ?? '';

        // 2. Fetch Session Data
        const { data: session, error: sessionError } = await supabaseClient
            .from('wolfie_sessions')
            .select(`
            *,
            wolfie_turns (
                speaker,
                content,
                turn_index
            ),
            wolfie_corrections (
                wrong_sentence,
                correct_sentence,
                explanation_pt
            )
        `)
            .eq('id', sessionId)
            .single();

        if (sessionError || !session) {
            return new Response(JSON.stringify({ error: 'Session not found' }), {
                status: 404,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        if (!auth.context.isService) {
            const caller = auth.context.profile!;
            let canEvaluate = caller.role === 'SUPER_ADMIN'
                || (caller.role === 'STUDENT' && caller.id === session.student_id)
                || (['COORDINATOR', 'SCHOOL_ADMIN'].includes(caller.role)
                    && caller.tenant_id === session.tenant_id);

            if (!canEvaluate && caller.role === 'TEACHER' && caller.tenant_id === session.tenant_id) {
                const { data: student } = await supabaseClient
                    .from('profiles')
                    .select('professor_id, professor_id2')
                    .eq('id', session.student_id)
                    .maybeSingle();
                canEvaluate = student?.professor_id === caller.id || student?.professor_id2 === caller.id;
            }

            if (!canEvaluate) {
                return new Response(JSON.stringify({ error: 'Insufficient permissions for this session' }), {
                    status: 403,
                    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                });
            }
        }

        // 3. Prepare Transcript for LLM
        const turns = session.wolfie_turns.sort((a: any, b: any) => a.turn_index - b.turn_index);
        const transcript = turns.map((t: any) => `${t.speaker.toUpperCase()}: ${t.content}`).join('\n');

        // 4. Build Evaluation Prompt
        const prompt = `
YOU ARE A PEDAGOGICAL SUPERVISOR for an English AI Tutor named "Wolfie".
Your job is to evaluate the quality of the following tutoring session.

SESSION METADATA:
- Student Level: ${session.student_level}
- Topic: ${session.topic}
- Mode: ${session.mode}
- Config: ${JSON.stringify(session.config_snapshot)}

TRANSCRIPT:
${transcript}

EVALUATION RUBRIC (1-5 Scale, 5 is best):
1. Adequacy to Level: Did the AI adapt vocabulary and speed to ${session.student_level}?
2. Clarity of Corrections: Were corrections clear, helpful, and not overwhelming?
3. Encouragement: Was the tone supportive?
4. Question Quality: Did the AI ask open-ended questions that forced the student to produce language?
5. Target Language Use: Did the AI stick to English (unless explaining in PT)?
6. Focus on Student: Did the student talk more than the AI? (Look at length of turns)

OUTPUT FORMAT:
Return ONLY a valid JSON object matching this TypeScript interface:

interface WolfieEval {
  adequacyToLevel: number;
  clarityOfCorrections: number;
  encouragementAndTone: number;
  questionQuality: number;
  targetLanguageUse: number;
  focusOnStudentProduction: number;
  overallScore: number; // Average of above
  textualFeedbackPt: string; // Summary for the teacher in Portuguese
}
`;

        // 5. Call Gemini
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`;
        const geminiRes = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { response_mime_type: "application/json" } // Enforce JSON mode !
            })
        });

        const geminiData = await geminiRes.json();
        const evalJsonText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!evalJsonText) throw new Error("Empty response from Evaluator");

        const result = JSON.parse(evalJsonText);

        // 6. Save Evaluation
        await supabaseClient.from('wolfie_evaluations').insert({
            session_id: sessionId,
            adequacy_to_level: result.adequacyToLevel,
            clarity_of_corrections: result.clarityOfCorrections,
            encouragement_and_tone: result.encouragementAndTone,
            question_quality: result.questionQuality,
            target_language_use: result.targetLanguageUse,
            focus_on_student_production: result.focusOnStudentProduction,
            overall_score: result.overallScore,
            textual_feedback_pt: result.textualFeedbackPt,
            evaluator_model: 'gemini-2.0-flash'
        });

        // 7. Update Session Summary
        await supabaseClient.from('wolfie_sessions').update({
            overall_score: result.overallScore,
            summary: result.textualFeedbackPt.substring(0, 200) + '...'
        }).eq('id', sessionId);

        return new Response(JSON.stringify(result), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });

    } catch (error: any) {
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }
});
