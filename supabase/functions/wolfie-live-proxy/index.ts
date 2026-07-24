import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.93.3";

// ============================================================
// wolfie-live-proxy — Secure WebSocket bridge
// Browser <-> This proxy <-> Gemini Live API
// API key never leaves the server.
// ============================================================

const GEMINI_LIVE_URL =
    "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const DEFAULT_GEMINI_LIVE_MODEL = "gemini-3.1-flash-live-preview";
const ALLOWED_LEVELS = new Set(["A1", "A2", "B1", "B2", "C1", "C2"]);
const ALLOWED_TOPICS = new Set([
    "freestyle_chat",
    "airport_survival",
    "tech_job_interview",
    "grammar_workout",
]);
const SETTLED_PAYMENT_STATUSES = new Set([
    "RECEIVED",
    "CONFIRMED",
    "RECEIVED_IN_CASH",
    "PAGO",
    "PAYMENT_RECEIVED",
    "PAYMENT_CONFIRMED",
]);

serve(async (req) => {
    // Only accept WebSocket upgrades
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response("WebSocket upgrade required", { status: 426 });
    }

    const url = new URL(req.url);
    const requestedProtocols = (req.headers.get("sec-websocket-protocol") ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    const token = requestedProtocols[0] === "wolfie-live"
        ? requestedProtocols[1] ?? ""
        : "";

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

    // ── Fetch student context from DB ──
    const requestedLevel = (url.searchParams.get("level") ?? "B1").toUpperCase();
    const requestedTopic = url.searchParams.get("topic") ?? "freestyle_chat";
    const requestedMode = url.searchParams.get("mode") ?? "fluency";
    const studentLevel = ALLOWED_LEVELS.has(requestedLevel) ? requestedLevel : "B1";
    const topic = ALLOWED_TOPICS.has(requestedTopic)
        ? requestedTopic
        : "freestyle_chat";
    const mode = requestedMode === "grammar_focus" ? "grammar_focus" : "fluency";

    const [profileRes, wolfIntelRes] = await Promise.all([
        supabase
            .from("profiles")
            .select("full_name, goal, english_for, short_term_goal, preferred_topics, avoided_topics, tenant_id, role, is_test_account")
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
    if (
        profileRes.error ||
        !profile ||
        profile.role !== "STUDENT" ||
        !profile.tenant_id
    ) {
        return new Response("Student profile required", { status: 403 });
    }
    if (profile.is_test_account === true) {
        return new Response(
            JSON.stringify({
                error: "TEST_FIXTURE_SUPPRESSED",
                skipped: "test_fixture",
            }),
            {
                status: 403,
                headers: { "Content-Type": "application/json" },
            },
        );
    }
    if (wolfIntelRes.error) {
        console.error("[WolfieLive] student context lookup failed", {
            code: wolfIntelRes.error.code,
        });
        return new Response("Could not load student context", { status: 503 });
    }

    // ── Payment check (block if > 7 days overdue) ──
    const now = new Date();
    const { data: overduePayments, error: paymentError } = await supabase
        .from("student_payments")
        .select("due_date, status")
        .eq("student_id", user.id)
        .eq("tenant_id", profile.tenant_id)
        .lt("due_date", now.toISOString());

    if (paymentError) {
        console.error("[WolfieLive] payment check failed", {
            code: paymentError.code,
        });
        return new Response("Could not validate account access", { status: 503 });
    }

    for (const payment of overduePayments ?? []) {
        const status = typeof payment.status === "string"
            ? payment.status.toUpperCase()
            : "";
        if (SETTLED_PAYMENT_STATUSES.has(status)) continue;
        const dueTime = new Date(payment.due_date).getTime();
        if (!Number.isFinite(dueTime)) {
            return new Response("Could not validate account access", { status: 503 });
        }
        if (now.getTime() - dueTime > 7 * 86_400_000) {
            return new Response(
                JSON.stringify({ error: "PAYMENT_REQUIRED" }),
                {
                    status: 402,
                    headers: { "Content-Type": "application/json" },
                },
            );
        }
    }

    // ── Create wolfie_sessions record ──
    const { data: sessionRow, error: sessionError } = await supabase
        .from("wolfie_sessions")
        .insert({
            student_id: user.id,
            tenant_id: profile.tenant_id,
            topic,
            mode,
            student_level: studentLevel,
            started_at: new Date().toISOString(),
        })
        .select("id")
        .single();

    if (sessionError || !sessionRow) {
        console.error("[WolfieLive] session creation failed", {
            code: sessionError?.code,
        });
        return new Response("Could not create Wolfie session", { status: 500 });
    }

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
    const { socket: clientWs, response } = Deno.upgradeWebSocket(req, {
        protocol: "wolfie-live",
    });

    let geminiWs: WebSocket | null = null;
    let geminiReady = false;
    let clientActivityStarted = false;
    let turnIndex = 0;

    const geminiKey = (Deno.env.get("GEMINI_API_KEY") ?? "").trim();
    const requestedModel = (
        Deno.env.get("GEMINI_LIVE_MODEL") ?? DEFAULT_GEMINI_LIVE_MODEL
    ).trim();
    const configuredModel = /^[A-Za-z0-9._/-]+$/.test(requestedModel)
        ? requestedModel
        : DEFAULT_GEMINI_LIVE_MODEL;
    const geminiModel = configuredModel.startsWith("models/")
        ? configuredModel
        : `models/${configuredModel}`;

    const persistTurn = async (
        speaker: "student" | "wolfie",
        content: string,
        index: number,
    ): Promise<void> => {
        if (!sessionId) return;
        const { error } = await supabase.from("wolfie_turns").insert({
            session_id: sessionId,
            speaker,
            content,
            turn_index: index,
        });
        if (error) {
            console.error("[WolfieLive] turn save failed", {
                code: error.code,
                speaker,
            });
        }
    };

    const sendToClient = (msg: object) => {
        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify(msg));
        }
    };

    clientWs.onopen = () => {
        console.log("[WolfieLive] Client connected");

        if (!geminiKey) {
            sendToClient({ type: "error", message: "Serviço de voz indisponível." });
            clientWs.close();
            return;
        }

        geminiWs = new WebSocket(
            `${GEMINI_LIVE_URL}?key=${encodeURIComponent(geminiKey)}`,
        );

        geminiWs.onopen = () => {
            console.log("[WolfieLive] Gemini connected, sending setup...");
            geminiWs!.send(JSON.stringify({
                setup: {
                    model: geminiModel,
                    generationConfig: {
                        responseModalities: ["AUDIO"],
                        speechConfig: {
                            voiceConfig: {
                                prebuiltVoiceConfig: { voiceName: "Aoede" },
                            },
                        },
                    },
                    inputAudioTranscription: {},
                    outputAudioTranscription: {},
                    realtimeInputConfig: {
                        automaticActivityDetection: { disabled: true },
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
                            void persistTurn("student", text, turnIndex++);
                        }
                    }
                }

                if (sc.outputTranscription?.text) {
                    const text = sc.outputTranscription.text.trim();
                    if (text) {
                        sendToClient({ type: "transcript", role: "wolfie", text });
                        if (sessionId) {
                            void persistTurn("wolfie", text, turnIndex++);
                        }
                    }
                }

                // ── Turn complete / interrupted ──
                if (sc.turnComplete) sendToClient({ type: "turn_complete" });
                if (sc.interrupted) sendToClient({ type: "interrupted" });

            } catch (error) {
                console.error("[WolfieLive] Gemini message parse error", {
                    type: error instanceof Error ? error.name : "UnknownError",
                });
            }
        };

        geminiWs.onclose = (ev) => {
            console.log(`[WolfieLive] Gemini disconnected: ${ev.code}`);
            sendToClient({ type: "error", message: "Conexão com a IA foi encerrada." });
            if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
        };

        geminiWs.onerror = () => {
            console.error("[WolfieLive] Gemini websocket error");
            sendToClient({ type: "error", message: "Erro na conexão com a IA." });
        };
    };

    // ── Proxy messages from browser → Gemini ──
    clientWs.onmessage = (event) => {
        if (!geminiWs || geminiWs.readyState !== WebSocket.OPEN || !geminiReady) return;
        try {
            const rawMessage: unknown = JSON.parse(event.data);
            if (
                typeof rawMessage !== "object" ||
                rawMessage === null ||
                Array.isArray(rawMessage)
            ) return;
            const msg = rawMessage as {
                type?: unknown;
                data?: unknown;
                text?: unknown;
            };

            if (
                msg.type === "audio" &&
                typeof msg.data === "string" &&
                msg.data.length > 0 &&
                msg.data.length <= 512_000
            ) {
                if (!clientActivityStarted) {
                    geminiWs.send(JSON.stringify({
                        realtimeInput: { activityStart: {} },
                    }));
                    clientActivityStarted = true;
                }
                geminiWs.send(JSON.stringify({
                    realtimeInput: {
                        audio: {
                            mimeType: "audio/pcm;rate=16000",
                            data: msg.data,
                        },
                    },
                }));
            } else if (msg.type === "end_turn") {
                if (clientActivityStarted) {
                    geminiWs.send(JSON.stringify({
                        realtimeInput: { activityEnd: {} },
                    }));
                    clientActivityStarted = false;
                }
            } else if (
                msg.type === "text" &&
                typeof msg.text === "string" &&
                msg.text.trim().length > 0 &&
                msg.text.length <= 2_000
            ) {
                // Fallback: send text if mic unavailable
                geminiWs.send(JSON.stringify({
                    clientContent: {
                        turns: [{
                            role: "user",
                            parts: [{ text: msg.text.trim() }],
                        }],
                        turnComplete: true,
                    },
                }));
            }
        } catch (error) {
            console.error("[WolfieLive] Client message parse error", {
                type: error instanceof Error ? error.name : "UnknownError",
            });
        }
    };

    clientWs.onclose = async () => {
        console.log("[WolfieLive] Client disconnected");
        if (geminiWs && geminiWs.readyState === WebSocket.OPEN) geminiWs.close();

        if (sessionId) {
            const { error } = await supabase
                .from("wolfie_sessions")
                .update({ finished_at: new Date().toISOString() })
                .eq("id", sessionId);
            if (error) {
                console.error("[WolfieLive] session close failed", {
                    code: error.code,
                });
            }
        }
    };

    clientWs.onerror = () => console.error("[WolfieLive] Client websocket error");

    return response;
});
