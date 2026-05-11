/**
 * broadcast-opportunity v3 — Direct Send + Outbox Fallback
 *
 * CRITICAL FIX: Sends WhatsApp message DIRECTLY via Evolution API
 * instead of relying on the outbox → pg_net → process-outbox chain
 * which was failing silently.
 *
 * Flow:
 *  1. Auth + profile lookup
 *  2. Create opportunity via RPC
 *  3. Build claim link (JWT or legacy)
 *  4. SEND directly to Evolution API (instant delivery)
 *  5. Update outbox record status to SENT
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.21.0";
import { SignJWT } from "https://deno.land/x/jose@v5.2.0/index.ts";

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-user-token, idempotency-key',
};

// Config — all from environment
const BASE_URL = Deno.env.get('APP_BASE_URL') || "https://system.wisewolflanguage.com.br";
const DEFAULT_GROUP_JID = "120363403699904869@g.us";
const EVOLUTION_API_URL = Deno.env.get('EVOLUTION_API_URL') || "https://api.2b.app.br";
const EVOLUTION_API_KEY = Deno.env.get('EVOLUTION_API_KEY') || "";
const OFFER_JWT_SECRET = Deno.env.get('OFFER_JWT_SECRET') || "";

const DAY_MAP: Record<number, string> = {
    0: 'Domingo', 1: 'Segunda', 2: 'Terça', 3: 'Quarta',
    4: 'Quinta', 5: 'Sexta', 6: 'Sábado'
};

const WEEKDAY_LABELS: Record<string, string> = {
    'monday': 'Segunda', 'tuesday': 'Terça', 'wednesday': 'Quarta',
    'thursday': 'Quinta', 'friday': 'Sexta', 'saturday': 'Sábado', 'sunday': 'Domingo'
};

function log(level: string, msg: string, ctx: Record<string, unknown> = {}) {
    const entry = { ts: new Date().toISOString(), level, msg, ...ctx };
    if (level === 'error') console.error(JSON.stringify(entry));
    else console.log(JSON.stringify(entry));
}

/**
 * Sends a WhatsApp message directly via Evolution API.
 * Returns { success, error? }
 */
async function sendWhatsAppDirect(
    instanceName: string,
    targetNumber: string,
    textMessage: string
): Promise<{ success: boolean; error?: string; status?: number }> {
    const instanceEncoded = encodeURIComponent(instanceName);
    const endpoint = `${EVOLUTION_API_URL}/message/sendText/${instanceEncoded}`;

    log('info', 'Sending WhatsApp directly', { 
        instance: instanceName, 
        target: targetNumber,
        endpoint,
        hasApiKey: !!EVOLUTION_API_KEY 
    });

    try {
        const response = await fetch(endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "apikey": EVOLUTION_API_KEY
            },
            body: JSON.stringify({
                number: targetNumber,
                text: textMessage
            })
        });

        const responseBody = await response.text();

        if (response.ok) {
            log('info', 'WhatsApp sent successfully', { status: response.status });
            return { success: true };
        } else {
            log('error', 'Evolution API error', { 
                status: response.status, 
                body: responseBody.substring(0, 500) 
            });
            return { success: false, error: responseBody, status: response.status };
        }
    } catch (err: any) {
        log('error', 'WhatsApp fetch failed', { error: err.message });
        return { success: false, error: err.message };
    }
}

serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
    }

    const t0 = Date.now();
    let ctx: Record<string, unknown> = {};

    try {
        const supabaseAdmin = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
            { auth: { autoRefreshToken: false, persistSession: false } }
        );

        const { student_name, student_phone, date, time, interests, preferred_slots } = await req.json();

        if (!student_name || !date || !time) {
            return new Response(
                JSON.stringify({ error: "Missing required fields (student_name, date, time)." }),
                { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            );
        }

        // ── AUTH ──────────────────────────────────────────────────────
        const xUserToken = req.headers.get('x-user-token');
        const authHeader = req.headers.get('Authorization');
        const token = xUserToken || authHeader?.replace('Bearer ', '') || '';

        if (!token) {
            return new Response(
                JSON.stringify({ error: "Missing Authorization" }),
                { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            );
        }

        const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
        if (authError || !user) {
            log('error', 'Auth failed', { error: authError?.message });
            return new Response(
                JSON.stringify({ error: "Unauthorized" }),
                { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            );
        }

        ctx = { actor_id: user.id, actor_email: user.email };
        log('info', 'Broadcast request received', ctx);

        // ── PROFILE + INSTANCE LOOKUP ─────────────────────────────────
        const { data: profile } = await supabaseAdmin
            .from('profiles')
            .select('whatsapp_instance, teachers_group_id, tenant_id')
            .eq('id', user.id)
            .single();

        const tenantId = profile?.tenant_id || 'unknown';
        ctx.tenant_id = tenantId;

        let instanceName = profile?.whatsapp_instance;
        if (!instanceName) {
            const { data: wInstance } = await supabaseAdmin
                .from('whatsapp_instances')
                .select('instance_name')
                .eq('user_id', user.id)
                .in('status', ['connected', 'open'])
                .order('updated_at', { ascending: false })
                .limit(1)
                .single();
            instanceName = wInstance?.instance_name;
        }

        if (!instanceName) {
            log('warn', 'No WhatsApp instance found', ctx);
            return new Response(
                JSON.stringify({ error: "⚠️ Nenhuma conexão ativa encontrada. Vá em Automação e conecte seu WhatsApp." }),
                { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            );
        }

        ctx.instance = instanceName;

        // ── DATE FORMATTING ──────────────────────────────────────────
        const dateObj = new Date(date + 'T' + time + ':00');
        const dayOfWeek = dateObj.getDay();
        const dayString = DAY_MAP[dayOfWeek] || "Dia";
        const formattedDate = date.split('-').reverse().join('/');

        // ── BUILD PREFERRED SLOTS TEXT ─────────────────────────────────
        let preferredSlotsText = '';
        if (preferred_slots && Array.isArray(preferred_slots) && preferred_slots.length > 0) {
            const slotLines = preferred_slots.map((s: { weekday: string; time: string }) => {
                const dayLabel = WEEKDAY_LABELS[s.weekday] || s.weekday;
                const timeShort = s.time.replace(':00', 'h').replace(':', 'h');
                return `  ${dayLabel} ${timeShort}`;
            }).join('\n');
            preferredSlotsText = `\n\n📅 *Preferências do aluno:*\n${slotLines}`;
        }

        const destinationGroup = profile?.teachers_group_id || DEFAULT_GROUP_JID;
        const idempotencyKey = req.headers.get('idempotency-key') || null;

        // ── BUILD MESSAGE TEMPLATE ────────────────────────────────────
        const buildMessage = (claimLink: string) => {
            return `🐺⚡ *EXPERIMENTAL — ${formattedDate} (${dayString}) às ${time}*

📋 *Aluno:* ${student_name}
🎯 *Objetivo:* ${interests || 'Não informado'}${preferredSlotsText}

🏆 *Professor(a), essa aula é sua?*
O primeiro a clicar no link abaixo garante a aula experimental!

👇 *Aceitar agora:*
${claimLink}`;
        };

        // ── CALL ATOMIC RPC ──────────────────────────────────────────
        const { data: rpcResult, error: rpcError } = await supabaseAdmin.rpc('create_broadcast', {
            p_student_name: student_name,
            p_student_phone: student_phone || '',
            p_date: date,
            p_time: time,
            p_interests: interests || null,
            p_preferred_slots: preferred_slots || null,
            p_tenant_id: tenantId,
            p_actor_id: user.id,
            p_idempotency_key: idempotencyKey,
            p_message_text: '__PLACEHOLDER__',
            p_destination: destinationGroup,
            p_instance: instanceName,
        });

        if (rpcError) {
            log('error', 'RPC create_broadcast failed', { ...ctx, error: rpcError.message });
            throw new Error(rpcError.message);
        }

        if (!rpcResult.success) {
            log('warn', 'RPC rejected', { ...ctx, rpc_error: rpcResult.error });
            return new Response(
                JSON.stringify({ error: rpcResult.message, code: rpcResult.error }),
                { status: rpcResult.error === 'RATE_LIMITED' ? 429 : 200,
                  headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            );
        }

        const oppId = rpcResult.opportunity_id;
        ctx.opp_id = oppId;

        if (rpcResult.deduplicated) {
            log('info', 'Broadcast deduplicated', { ...ctx, latency_ms: Date.now() - t0 });
            return new Response(
                JSON.stringify({ success: true, id: oppId, deduplicated: true }),
                { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            );
        }

        // ── SIGN JWT FOR CLAIM LINK ──────────────────────────────────
        let claimLink: string;

        if (OFFER_JWT_SECRET) {
            const secret = new TextEncoder().encode(OFFER_JWT_SECRET);
            const jti = crypto.randomUUID();

            const jwt = await new SignJWT({ opp_id: oppId })
                .setProtectedHeader({ alg: 'HS256' })
                .setJti(jti)
                .setExpirationTime('15m')
                .setIssuedAt()
                .sign(secret);

            claimLink = `${BASE_URL}/claim-opportunity?token=${jwt}`;
        } else {
            const params = new URLSearchParams({
                id: oppId,
                date: date,
                time: time,
                studentName: student_name,
                studentPhone: student_phone || ''
            });
            claimLink = `${BASE_URL}/claim-opportunity?${params.toString()}`;
            log('warn', 'OFFER_JWT_SECRET not set, using legacy link', ctx);
        }

        // ── DIRECT SEND via Evolution API ─────────────────────────────
        const finalMessage = buildMessage(claimLink);
        const sendResult = await sendWhatsAppDirect(instanceName, destinationGroup, finalMessage);

        let warning: string | undefined;

        if (sendResult.success) {
            log('info', '✅ WhatsApp sent directly!', { ...ctx, destination: destinationGroup });

            // Mark outbox as SENT (if it exists)
            await supabaseAdmin
                .from('outbox_messages')
                .update({
                    status: 'SENT',
                    processed_at: new Date().toISOString(),
                    payload: {
                        instance: instanceName,
                        text: finalMessage,
                        opportunity_id: oppId
                    }
                })
                .eq('correlation_id', oppId);
        } else {
            warning = sendResult.error || 'Falha ao enviar WhatsApp';
            log('error', '❌ Direct WhatsApp send failed', { 
                ...ctx, 
                error: sendResult.error,
                status: sendResult.status 
            });

            // Update outbox with the real message text so process-outbox can retry later
            await supabaseAdmin
                .from('outbox_messages')
                .update({
                    payload: {
                        instance: instanceName,
                        text: finalMessage,
                        opportunity_id: oppId
                    },
                    last_error: sendResult.error
                })
                .eq('correlation_id', oppId)
                .eq('status', 'PENDING');
        }

        log('info', 'Broadcast completed', {
            ...ctx,
            opp_id: oppId,
            destination: destinationGroup,
            wa_sent: sendResult.success,
            latency_ms: Date.now() - t0
        });

        return new Response(
            JSON.stringify({
                success: true,
                id: oppId,
                instance_used: instanceName,
                destination_group: destinationGroup,
                wa_sent: sendResult.success,
                warning: warning,
                deduplicated: false
            }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );

    } catch (error: any) {
        log('error', 'Broadcast critical error', { ...ctx, error: error.message, latency_ms: Date.now() - t0 });
        return new Response(
            JSON.stringify({ error: error.message }),
            { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
    }
});
