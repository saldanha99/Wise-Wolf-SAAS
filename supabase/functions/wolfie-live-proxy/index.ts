import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.21.0";

// ============================================================
// wolfie-live-proxy — Secure WebSocket bridge
// Browser <-> This proxy <-> Gemini Live API
// API key never leaves the server.
// ============================================================

const GEMINI_LIVE_URL =
    "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

serve(async (req) => {
    // Only accept WebSocket upgrades
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response("WebSocket upgrade required", { status: 426 });
    }

    const url = new URL(req.url);
    const token = url.searchParams.get("token") ?? "";

    if (!token) {
        return new Response("Missing auth token", { status: 401 });
    }

    // ── Auth: validate Supabase JWT ──
    const supabaseAnon = createClient(
        Deno.env.get("SUPABASE_URL") ?? "",
        Deno.env.get("SUPABASE_ANON_KEY") ?? ""
    );
    const { data: { user }, error: authError } = await supabaseAnon.auth.getUser(token);
    if (authError || !user) {
        return new Response("Unauthorized", { status: 401 });
    }

    const supabase = createClient(
        Deno.env.get("SUPABASE_URL") ?? "",
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    // ── Payment check (block if > 7 days overdue) ──
    const now = new Date();
    const { data: overduePayments } = await supabase
        .from("student_payments")
        .select("due_date")
        .eq("student_id", user.id)
        .not("status", "in", "(RECEIVED,CONFIRMED)")
        .lt("due_date", now.toISOString());

    if (overduePayments && overduePayments.length > 0) {
        const oldest = overduePayments.sort(
            (a: any, b: any) => new Date(a.due_date).getTime() - new Date(b.due_date).getTime()
        )[0];
        const daysLate = Math.ceil(
            Math.abs(now.getTime() - new Date(oldest.due_date).getTime()) / 86_400_000
        );
        if (daysLate > 7) {
            return new Response(JSON.stringify({ error: "PAYMENT_REQUIRED" }), { status: 402 });
        }
    }

    // ── Fetch student context from DB ──
    const studentLevel = url.searchParams.get("level") ?? "B1";
    const topic = url.searchParams.get("topic") ?? "Free Conversation";
    const mode = url.searchParams.get("mode") ?? "fluency";

    const [profileRes, wolfIntelRes] = await Promise.all([
        supabase
            .from("profiles")
            .select("full_name, goal, english_for, short_term_goal, preferred_topics, avoided_topics")
            .eq("id", user.id)
            .single(),
        supabase
            .from("wolf_intelligence")
            .select("accumulated_context, weak_points, strong_points, recommended_approach")
            .eq("student_id", user.id)
            .maybeSingle(),
    ]);

    const profile = profileRes.data;
    const wolfIntel = wolfIntelRes.data;

    // ── Create wolfie_sessions record ──
    const { data: sessionRow } = await supabase
        .from("wolfie_sessions")
        .insert({
            student_id: user.id,
            tenant_id: user.user_metadata?.tenant_id ?? null,
            topic,
            mode,
            student_level: studentLevel,
            started_at: new Date().toISOString(),
        })
        .select("id")
        .single();

    const sessionId = sessionRow?.id ?? null;

    // ── Build Wolfie system prompt ──
    const buildSystemPrompt = (): string => {
        const firstName = (profile?.full_name ?? "Student").split(" ")[0];
        const memLines: string[] = [];

        if (profile?.english_for) memLines.push(`- Learning English for: ${profile.english_for}`);
        if (profile?.short_term_goal) memLines.push(`- Short-term goal: ${profile.short_term_goal}`);
        if (wolfIntel?.strong_points?.length)
            memLines.push(`- Already strong at: ${wolfIntel.strong_points.slice(0, 3).join(", ")}`);
        if (wolfIntel?.weak_points?.length)
            memLines.push(`- Still struggles with: ${wolfIntel.weak_points.slice(0, 3).join(", ")}`);
        if (wolfIntel?.accumulated_context)
            memLines.push(`- Background: ${wolfIntel.accumulated_context}`);
        if (wolfIntel?.recommended_approach)
            memLines.push(`- Teaching approach: ${wolfIntel.recommended_approach}`);

        return `You are WOLFIE, a friendly native English tutor from Wise Wolf Language School. Warm, encouraging, and conversational.

Student name: ${firstName}
Level: ${studentLevel}
Topic today: ${topic}
Student goal: ${profile?.goal ?? "practice conversational English"}
${memLines.length ? `\nStudent memory:\n${memLines.join("\n")}` : ""}

STRICT RULES (voice conversation — keep it natural):
- FIRST message only: greet in Portuguese, say you are the Smart Wolf tutor, ask what they want to practice
- After that: speak entirely in English. Use one sentence of Portuguese ONLY when explaining a grammar rule
- Keep every response SHORT — 2 to 3 sentences maximum. This is a voice call, not a text chat
- Correct errors gently by modeling the right form naturally: "You could say..." or "A more natural way is..."
- End every response with a follow-up question to keep the conversation going
- Be genuinely enthusiastic and encouraging. Celebrate good English moments
- NEVER use markdown, asterisks, bullet points, or any formatting. Speak as if talking aloud`;
    };

    // ── Upgrade to WebSocket ──
    const { socket: clientWs, response } = Deno.upgradeWebSocket(req);

    let geminiWs: WebSocket | null = null;
    let geminiReady = false;
    let turnIndex = 0;

    const geminiKey = (Deno.env.get("GEMINI_API_KEY") ?? "").trim();

    const sendToClient = (msg: object) => {
        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify(msg));
        }
    };

    clientWs.onopen = () => {
        console.log(`[WolfieLive] Client connected: ${user.id}`);

        if (!geminiKey) {
            sendToClient({ type: "error", message: "GEMINI_API_KEY não configurado no servidor." });
            clientWs.close();
            return;
        }

        geminiWs = new WebSocket(`${GEMINI_LIVE_URL}?key=${geminiKey}`);

        geminiWs.onopen = () => {
            console.log("[WolfieLive] Gemini connected, sending setup...");
            geminiWs!.send(JSON.stringify({
                setup: {
                    model: "models/gemini-2.0-flash-live-001",
                    generationConfig: {
                        responseModalities: ["AUDIO"],
                        speechConfig: {
                            voiceConfig: {
                                prebuiltVoiceConfig: { voiceName: "Aoede" },
                            },
                        },
                        inputAudioTranscription: {},
                        outputAudioTranscription: {},
                    },
                    systemInstruction: {
                        parts: [{ text: buildSystemPrompt() }],
                    },
                },
            }));
        };

        geminiWs.onmessage = async (event) => {
            try {
                const msg = JSON.parse(
                    typeof event.data === "string" ? event.data : await event.data.text()
                );

                // ── Setup complete ──
                if (msg.setupComplete !== undefined) {
                    geminiReady = true;
                    console.log("[WolfieLive] Setup complete, session ready");
                    sendToClient({ type: "ready", sessionId });
                    return;
                }

                const sc = msg.serverContent;
                if (!sc) return;

                // ── Audio chunks from Gemini ──
                if (sc.modelTurn?.parts) {
                    for (const part of sc.modelTurn.parts) {
                        if (part.inlineData?.data && part.inlineData.mimeType?.startsWith("audio/pcm")) {
                            sendToClient({
                                type: "audio",
                                data: part.inlineData.data,
                                sampleRate: 24000,
                            });
                        }
                    }
                }

                // ── Transcriptions ──
                if (sc.inputTranscription?.text) {
                    const text = sc.inputTranscription.text.trim();
                    if (text) {
                        sendToClient({ type: "transcript", role: "user", text });
                        if (sessionId) {
                            supabase.from("wolfie_turns").insert({
                                session_id: sessionId,
                                speaker: "student",
                                content: text,
                                turn_index: turnIndex++,
                            }).catch((e: any) => console.error("[WolfieLive] turn save:", e));
                        }
                    }
                }

                if (sc.outputTranscription?.text) {
                    const text = sc.outputTranscription.text.trim();
                    if (text) {
                        sendToClient({ type: "transcript", role: "wolfie", text });
                        if (sessionId) {
                            supabase.from("wolfie_turns").insert({
                                session_id: sessionId,
                                speaker: "wolfie",
                                content: text,
                                turn_index: turnIndex++,
                            }).catch((e: any) => console.error("[WolfieLive] turn save:", e));
                        }
                    }
                }

                // ── Turn complete / interrupted ──
                if (sc.turnComplete) sendToClient({ type: "turn_complete" });
                if (sc.interrupted) sendToClient({ type: "interrupted" });

            } catch (e) {
                console.error("[WolfieLive] Gemini message parse error:", e);
            }
        };

        geminiWs.onclose = (ev) => {
            console.log(`[WolfieLive] Gemini disconnected: ${ev.code} ${ev.reason}`);
            sendToClient({ type: "error", message: "Conexão com a IA foi encerrada." });
            if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
        };

        geminiWs.onerror = (e) => {
            console.error("[WolfieLive] Gemini error:", e);
            sendToClient({ type: "error", message: "Erro na conexão com a IA." });
        };
    };

    // ── Proxy messages from browser → Gemini ──
    clientWs.onmessage = (event) => {
        if (!geminiWs || geminiWs.readyState !== WebSocket.OPEN || !geminiReady) return;
        try {
            const msg = JSON.parse(event.data);

            if (msg.type === "audio" && msg.data) {
                geminiWs.send(JSON.stringify({
                    realtimeInput: {
                        mediaChunks: [{
                            mimeType: "audio/pcm;rate=16000",
                            data: msg.data,
                        }],
                    },
                }));
            } else if (msg.type === "end_turn") {
                geminiWs.send(JSON.stringify({
                    realtimeInput: { activityEnd: {} },
                }));
            } else if (msg.type === "text" && msg.text) {
                // Fallback: send text if mic unavailable
                geminiWs.send(JSON.stringify({
                    clientContent: {
                        turns: [{ role: "user", parts: [{ text: msg.text }] }],
                        turnComplete: true,
                    },
                }));
            }
        } catch (e) {
            console.error("[WolfieLive] Client message parse error:", e);
        }
    };

    clientWs.onclose = async () => {
        console.log(`[WolfieLive] Client disconnected: ${user.id}`);
        if (geminiWs && geminiWs.readyState === WebSocket.OPEN) geminiWs.close();

        if (sessionId) {
            await supabase
                .from("wolfie_sessions")
                .update({ ended_at: new Date().toISOString() })
                .eq("id", sessionId)
                .catch((e: any) => console.error("[WolfieLive] session close error:", e));
        }
    };

    clientWs.onerror = (e) => console.error("[WolfieLive] Client socket error:", e);

    return response;
});
