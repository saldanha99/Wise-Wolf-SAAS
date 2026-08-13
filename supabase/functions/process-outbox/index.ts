/**
 * process-outbox — Outbox Message Worker
 *
 * Called by pg_cron every 30s via net.http_post.
 * Processes PENDING/FAILED messages with exponential backoff.
 * Uses SELECT ... FOR UPDATE SKIP LOCKED to prevent double-processing.
 *
 * Retry schedule: 30s → 2min → 10min → 1h → DLQ
 */

/// <reference lib="deno.ns" />

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { authorizeRequest, methodNotAllowed } from "../_shared/request-auth.ts";

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const EVOLUTION_API_URL = Deno.env.get('EVOLUTION_API_URL') || "https://api.2b.app.br";
const EVOLUTION_API_KEY = Deno.env.get('EVOLUTION_API_KEY') || "";
const BATCH_SIZE = 10;

// Retry intervals in seconds: 30s, 2min, 10min, 1h
const RETRY_INTERVALS = [30, 120, 600, 3600];

/**
 * VALIDADE DA MENSAGEM — mensagem de fila não envelhece bem.
 *
 * Achado em 13/08/2026: a fila tinha **12 mensagens PENDING desde MAIO**, todas
 * convites de experimental para o grupo dos professores ("EXPERIMENTAL —
 * 02/05/2026 às 19:00", com link de aceite de uma vaga que não existe mais).
 * Não havia cron chamando este worker, e ninguém no código escreve mais nesta
 * fila — ela foi abandonada quando o broadcast passou a enviar direto.
 *
 * O risco não é o passado: é alguém religar o cron um dia e a escola inteira
 * receber convites de três meses atrás. Mensagem vencida não é enviada — vai
 * para a DLQ com o motivo, onde dá para auditar.
 *
 * ⚠️ Se um dia esta fila voltar a ser usada para algo que TOLERA atraso longo,
 * este teto tem de ser revisto junto — não é uma constante inofensiva.
 */
const MAX_AGE_MS = 2 * 3600 * 1000;

function log(level: string, msg: string, ctx: Record<string, unknown> = {}) {
    const entry = { ts: new Date().toISOString(), level, msg, fn: 'process-outbox', ...ctx };
    if (level === 'error') console.error(JSON.stringify(entry));
    else console.log(JSON.stringify(entry));
}

serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
    }
    if (req.method !== 'POST') return methodNotAllowed(corsHeaders);

    const auth = await authorizeRequest(req, { corsHeaders, allowService: true });
    if (auth.ok === false) return auth.response;
    if (!auth.context.isService) {
        return new Response(JSON.stringify({ error: 'Service authentication required' }), {
            status: 403,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }

    const t0 = Date.now();
    let processed = 0;
    let sent = 0;
    let failed = 0;
    let dlq = 0;

    try {
        const supabaseAdmin = auth.context.admin;

        // ── FETCH PENDING MESSAGES ────────────────────────────────────
        // Using raw SQL for FOR UPDATE SKIP LOCKED
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

        // ── PROCESS EACH MESSAGE ─────────────────────────────────────
        for (const msg of messages) {
            processed++;
            const { id, payload, destination, attempt_count, max_attempts, tenant_id, correlation_id, created_at } = msg;
            const msgCtx = { msg_id: id, tenant_id, opp_id: correlation_id, attempt: attempt_count + 1 };

            // Vencida: não envia, arquiva com o motivo. Ver MAX_AGE_MS.
            const idadeMs = created_at ? Date.now() - new Date(created_at).getTime() : 0;
            if (idadeMs > MAX_AGE_MS) {
                const horas = Math.round(idadeMs / 3600000);
                log('warn', 'Mensagem vencida — arquivada sem enviar', { ...msgCtx, idade_horas: horas });
                await markDLQ(supabaseAdmin, id, `Mensagem vencida (${horas}h na fila) — não enviada`);
                dlq++;
                continue;
            }

            try {
                // Send via Evolution API
                const instanceName = payload.instance;
                const textMessage = payload.text;

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
                        number: destination,
                        text: textMessage
                    })
                });

                if (response.ok) {
                    // Mark as SENT
                    await supabaseAdmin
                        .from('outbox_messages')
                        .update({
                            status: 'SENT',
                            processed_at: new Date().toISOString(),
                            attempt_count: attempt_count + 1
                        })
                        .eq('id', id);

                    log('info', 'Message sent successfully', msgCtx);
                    sent++;
                } else {
                    const errorBody = await response.text();
                    throw new Error(`Evolution API ${response.status}: ${errorBody}`);
                }

            } catch (sendError: any) {
                const newAttempt = attempt_count + 1;

                if (newAttempt >= max_attempts) {
                    // Move to DLQ
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
                            status: 'FAILED',
                            attempt_count: newAttempt,
                            next_retry_at: nextRetry,
                            last_error: sendError.message
                        })
                        .eq('id', id);

                    log('warn', `Message retry scheduled`, {
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
            processed_at: new Date().toISOString()
        })
        .eq('id', id);
}
