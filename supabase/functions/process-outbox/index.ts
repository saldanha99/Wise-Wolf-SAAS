/**
 * process-outbox v2 — Event-Driven Outbox Worker
 *
 * Triggered by:
 *  1. pg_net AFTER INSERT trigger (sub-second, first attempt)
 *  2. GitHub Actions cron every 5min (retries + stale recovery)
 *
 * Auth: validates x-trigger-secret OR Authorization Bearer.
 * Uses SELECT ... FOR UPDATE SKIP LOCKED via RPC.
 * Retry schedule: immediate → 2min → 10min → 30min → DLQ
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.21.0";

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-trigger-secret, x-cron-secret',
};

const EVOLUTION_API_URL = Deno.env.get('EVOLUTION_API_URL') || "https://api.2b.app.br";
const EVOLUTION_API_KEY = Deno.env.get('EVOLUTION_API_KEY') || "";
const PG_NET_TRIGGER_SECRET = Deno.env.get('PG_NET_TRIGGER_SECRET') || "";
const CRON_TRIGGER_SECRET = Deno.env.get('CRON_TRIGGER_SECRET') || "";
const BATCH_SIZE = 10;

// Retry intervals in seconds: immediate, 2min, 10min, 30min
const RETRY_INTERVALS = [0, 120, 600, 1800];

function log(level: string, msg: string, ctx: Record<string, unknown> = {}) {
    const entry = { ts: new Date().toISOString(), level, msg, fn: 'process-outbox', ...ctx };
    if (level === 'error') console.error(JSON.stringify(entry));
    else console.log(JSON.stringify(entry));
}

/**
 * Validates the request source. Accepts:
 *  - x-trigger-secret header (pg_net trigger)
 *  - x-cron-secret header (GitHub Actions cron)
 *  - Authorization Bearer (service_role key)
 */
function validateAuth(req: Request): boolean {
    // pg_net trigger
    const triggerSecret = req.headers.get('x-trigger-secret');
    if (PG_NET_TRIGGER_SECRET && triggerSecret === PG_NET_TRIGGER_SECRET) return true;

    // GH Actions cron
    const cronSecret = req.headers.get('x-cron-secret');
    if (CRON_TRIGGER_SECRET && cronSecret === CRON_TRIGGER_SECRET) return true;

    // Service role bearer (fallback)
    const authHeader = req.headers.get('Authorization');
    if (authHeader?.startsWith('Bearer ')) return true;

    return false;
}

serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
    }

    const t0 = Date.now();
    let processed = 0;
    let sent = 0;
    let failed = 0;
    let dlq = 0;

    try {
        // Auth check
        if (!validateAuth(req)) {
            log('warn', 'Unauthorized outbox trigger attempt');
            return new Response(
                JSON.stringify({ error: 'Unauthorized' }),
                { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            );
        }

        const supabaseAdmin = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
            { auth: { autoRefreshToken: false, persistSession: false } }
        );

        // Parse optional body (pg_net sends trigger context)
        let triggerMsgId: string | null = null;
        try {
            const body = await req.json();
            triggerMsgId = body?.msg_id || null;
        } catch {
            // No body or invalid JSON — that's fine for cron calls
        }

        // If triggered by pg_net for a specific message, check if it's still PENDING
        // before fetching a full batch
        if (triggerMsgId) {
            log('info', 'Triggered by pg_net', { msg_id: triggerMsgId });
        }

        // ── SWEEP STALE FIRST (if called by cron) ─────────────────────
        const isCronCall = !!req.headers.get('x-cron-secret');
        if (isCronCall) {
            const { data: sweepResult } = await supabaseAdmin.rpc('sweep_stale_outbox');
            if (sweepResult) {
                log('info', 'Stale sweep completed', sweepResult);
            }
        }

        // ── FETCH PENDING/RETRY MESSAGES ──────────────────────────────
        const { data: messages, error: fetchError } = await supabaseAdmin
            .rpc('fetch_outbox_batch', { p_batch_size: BATCH_SIZE });

        if (fetchError) {
            log('error', 'Failed to fetch outbox batch', { error: fetchError.message });
            throw fetchError;
        }

        if (!messages || messages.length === 0) {
            return new Response(
                JSON.stringify({ processed: 0, sent: 0, failed: 0, dlq: 0, latency_ms: Date.now() - t0 }),
                { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            );
        }

        log('info', `Processing ${messages.length} outbox messages`);

        // ── PROCESS EACH MESSAGE ──────────────────────────────────────
        for (const msg of messages) {
            processed++;
            const { id, payload, destination, attempt_count, max_attempts, tenant_id, correlation_id, channel, event_type } = msg;
            const msgCtx = { msg_id: id, tenant_id, opp_id: correlation_id, attempt: attempt_count + 1, channel, event_type };

            try {
                if (channel === 'whatsapp' || !channel) {
                    // ── WhatsApp via Evolution API ─────────────────────
                    let instanceName = payload.instance;
                    let textMessage = payload.text;
                    let targetNumber = destination;

                    // PR7: Format OTP message dynamically and find tenant instance
                    if (event_type === 'OTP_REQUESTED') {
                        targetNumber = payload.phone;
                        textMessage = `🐺 *Verificação de Segurança*\n\nOlá ${payload.name?.split(' ')[0] || ''}!\nSeu código de verificação é: *${payload.code}*\n\nEste código expira em 10 minutos. Se você não solicitou, ignore esta mensagem.`;
                        
                        // Busca instância do tenant
                        const { data: tenantInstances } = await supabaseAdmin
                            .from('whatsapp_instances')
                            .select(`instance_name, user:profiles!inner(tenant_id, role)`)
                            .eq('user.tenant_id', payload.tenant_id)
                            .eq('user.role', 'SCHOOL_ADMIN')
                            .in('status', ['connected', 'open'])
                            .order('updated_at', { ascending: false })
                            .limit(1);

                        if (tenantInstances && tenantInstances.length > 0) {
                            instanceName = tenantInstances[0].instance_name;
                        }
                    }

                    if (!instanceName || !textMessage) {
                        log('error', 'Invalid outbox payload — missing instance or text', msgCtx);
                        await markDLQ(supabaseAdmin, id, 'Invalid payload: missing instance or text');
                        dlq++;
                        continue;
                    }

                    const instanceEncoded = encodeURIComponent(instanceName);
                    const endpoint = `${EVOLUTION_API_URL}/message/sendText/${instanceEncoded}`;

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

                    if (response.ok) {
                        await supabaseAdmin
                            .from('outbox_messages')
                            .update({
                                status: 'SENT',
                                processed_at: new Date().toISOString(),
                                attempt_count: attempt_count + 1,
                                last_attempt_at: new Date().toISOString()
                            })
                            .eq('id', id);

                        log('info', 'Message sent successfully', msgCtx);
                        sent++;
                    } else {
                        const errorBody = await response.text();
                        throw new Error(`Evolution API ${response.status}: ${errorBody}`);
                    }
                } else if (channel === 'email') {
                    // ── Email channel (placeholder for OTP) ───────────
                    // TODO: Implement email sending via Resend/SMTP
                    log('warn', 'Email channel not yet implemented, moving to DLQ', msgCtx);
                    await markDLQ(supabaseAdmin, id, 'Email channel not implemented');
                    dlq++;
                } else {
                    log('error', `Unknown channel: ${channel}`, msgCtx);
                    await markDLQ(supabaseAdmin, id, `Unknown channel: ${channel}`);
                    dlq++;
                }
            } catch (sendError: any) {
                const newAttempt = attempt_count + 1;

                if (newAttempt >= max_attempts) {
                    await markDLQ(supabaseAdmin, id, sendError.message);
                    log('error', 'Message moved to DLQ after max retries', { ...msgCtx, error: sendError.message });
                    dlq++;
                } else {
                    // Schedule retry with exponential backoff
                    const retryIndex = Math.min(newAttempt - 1, RETRY_INTERVALS.length - 1);
                    const retryDelay = RETRY_INTERVALS[retryIndex];
                    const nextRetry = new Date(Date.now() + retryDelay * 1000).toISOString();

                    await supabaseAdmin
                        .from('outbox_messages')
                        .update({
                            status: 'RETRY',
                            attempt_count: newAttempt,
                            next_retry_at: nextRetry,
                            last_attempt_at: new Date().toISOString(),
                            last_error: sendError.message
                        })
                        .eq('id', id);

                    log('warn', `Message scheduled for retry`, {
                        ...msgCtx,
                        next_retry_at: nextRetry,
                        retry_delay_s: retryDelay,
                        error: sendError.message
                    });
                    failed++;
                }
            }
        }

        const result = { processed, sent, failed, dlq, latency_ms: Date.now() - t0 };
        log('info', 'Outbox processing complete', result);

        return new Response(
            JSON.stringify(result),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );

    } catch (error: any) {
        log('error', 'Critical outbox error', { error: error.message, latency_ms: Date.now() - t0 });
        return new Response(
            JSON.stringify({ error: error.message }),
            { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
    }
});

async function markDLQ(supabase: any, id: string, reason: string) {
    await supabase
        .from('outbox_messages')
        .update({
            status: 'DLQ',
            last_error: reason,
            processed_at: new Date().toISOString(),
            last_attempt_at: new Date().toISOString()
        })
        .eq('id', id);
}
