/// <reference lib="deno.ns" />
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.93.3'
import { authorizeAutomation } from '../_shared/automation-auth.ts'

// Processa a fila de notificações (lembretes de aula, avisos) e envia via WhatsApp.
//
// Resolução de instância (em ordem):
//   1. Instância do professor (teacher.whatsapp_instance), se preenchida E conectada;
//   2. Fallback: instância CENTRAL da escola (WhatsApp do admin do tenant).
// A maioria dos professores não tem instância própria conectada — por isso o fallback
// central é essencial para os lembretes realmente saírem.

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const EVOLUTION_API_URL = (Deno.env.get('EVOLUTION_API_URL') || '')
    .trim()
    .replace(/\/+$/, '');
// Chave via env para permitir rotação sem novo deploy.
const EVOLUTION_API_KEYS = Array.from(new Set([
    (Deno.env.get('EVOLUTION_API_KEY') || '').trim(),
].filter(Boolean)));
const MAX_ATTEMPTS = 3;
const PROCESSING_LEASE_MS = 5 * 60 * 1000;

type QueueRelation<T> = T | T[] | null;

type TeacherRelation = {
    whatsapp_instance: string | null;
    tenant_id: string | null;
};

type StudentRelation = {
    is_test_account: boolean | null;
    tenant_id: string | null;
};

type QueueItem = {
    id: string;
    student_phone: string;
    message_body: string;
    tenant_id: string | null;
    attempts: number | null;
    notification_kind: string | null;
    source_id: string | null;
    teacher: QueueRelation<TeacherRelation>;
    student: QueueRelation<StudentRelation>;
};

function relationOne<T>(value: QueueRelation<T>): T | null {
    return Array.isArray(value) ? value[0] ?? null : value;
}

// Normaliza telefone BR ou JID de grupo para o formato aceito pela Evolution.
function normalizeDestination(raw: string): string | null {
    const destination = (raw || '').trim();
    // Grupos da Evolution usam JID (ex.: 1203...@g.us). A fila também atende
    // telefones comuns, então preservamos somente o formato estrito de grupo.
    if (/^\d{10,25}@g\.us$/.test(destination)) return destination;

    let phone = destination.replace(/\D/g, '');
    if (phone.length === 10 || phone.length === 11) phone = '55' + phone;
    if (phone.length < 12) return null;
    return phone;
}

// Resolve a instância central da escola (admin do tenant com WhatsApp conectado).
async function resolveCentralInstance(supabase: SupabaseClient, tenantId: string | null, cache: Record<string, string | null>): Promise<string | null> {
    const key = tenantId || '_';
    if (key in cache) return cache[key];
    if (!tenantId) { cache[key] = null; return null; }
    const { data, error } = await supabase
        .from('profiles')
        .select('whatsapp_instance')
        .eq('tenant_id', tenantId)
        .in('role', ['SCHOOL_ADMIN', 'SUPER_ADMIN'])
        .not('whatsapp_instance', 'is', null)
        .neq('whatsapp_instance', '')
        .limit(1)
        .maybeSingle();
    if (error) throw error;
    cache[key] = data?.whatsapp_instance || null;
    return cache[key];
}

async function markClaim(
    supabase: SupabaseClient,
    id: string,
    status: 'pending' | 'sent' | 'failed' | 'skipped',
    lastError: string | null,
): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const { data, error } = await supabase
            .from('notification_queue')
            .update({
                status,
                last_error: lastError,
                updated_at: new Date().toISOString(),
            })
            .eq('id', id)
            .eq('status', 'processing')
            .select('id')
            .maybeSingle();
        if (!error) return Boolean(data);
    }
    return false;
}

serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders })
    }
    const authError = await authorizeAutomation(req, corsHeaders);
    if (authError) return authError;

    try {
        const supabaseClient = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
        )
        if (!EVOLUTION_API_URL || EVOLUTION_API_KEYS.length === 0) {
            return new Response(
                JSON.stringify({ error: 'notification_provider_unavailable' }),
                { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
            );
        }

        // Recupera claims abandonados por timeout/restart do worker.
        const staleBefore = new Date(Date.now() - PROCESSING_LEASE_MS).toISOString();
        const { data: staleClaims, error: staleClaimsError } = await supabaseClient
            .from('notification_queue')
            .select('id, attempts')
            .eq('status', 'processing')
            .lt('updated_at', staleBefore)
            .limit(100);
        if (staleClaimsError) throw staleClaimsError;
        for (const stale of (staleClaims || [])) {
            const { error: staleRecoveryError } = await supabaseClient
                .from('notification_queue')
                .update({
                    status: (stale.attempts || 0) >= MAX_ATTEMPTS ? 'failed' : 'pending',
                    last_error: 'worker_lease_expired',
                    updated_at: new Date().toISOString(),
                })
                .eq('id', stale.id)
                .eq('status', 'processing');
            if (staleRecoveryError) throw staleRecoveryError;
        }

        // 1. Busca notificações pendentes e vencidas
        const { data: pending, error: fetchError } = await supabaseClient
            .from('notification_queue')
            .select(`
                id,
                student_phone,
                message_body,
                tenant_id,
                attempts,
                notification_kind,
                source_id,
                teacher:teacher_id ( whatsapp_instance, tenant_id ),
                student:student_id ( is_test_account, tenant_id )
            `)
            .eq('status', 'pending')
            .lte('scheduled_for', new Date().toISOString())
            .limit(50);

        if (fetchError) throw fetchError;
        if (!pending || pending.length === 0) {
            return new Response(JSON.stringify({ message: "No pending notifications due." }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        const queueItems = pending as unknown as QueueItem[];
        const results: Array<Record<string, unknown>> = [];
        const centralCache: Record<string, string | null> = {};
        let persistenceFailed = false;

        // 2. Processa o lote
        for (const item of queueItems) {
            const { id, student_phone, message_body, tenant_id, attempts } = item;
            const teacher = relationOne(item.teacher);
            const student = relationOne(item.student);
            const nextAttempts = (attempts || 0) + 1;
            const { data: claim, error: claimError } = await supabaseClient
                .from('notification_queue')
                .update({
                    status: 'processing',
                    attempts: nextAttempts,
                    updated_at: new Date().toISOString(),
                })
                .eq('id', id)
                .eq('status', 'pending')
                .select('id')
                .maybeSingle();
            if (claimError || !claim) {
                results.push({ id, status: 'skipped' });
                continue;
            }

            if (student?.is_test_account === true) {
                const marked = await markClaim(
                    supabaseClient,
                    id,
                    'skipped',
                    'test_fixture_suppressed',
                );
                persistenceFailed ||= !marked;
                results.push({
                    id,
                    status: marked ? 'skipped' : 'marker_failed',
                });
                continue;
            }
            if (student?.tenant_id && student.tenant_id !== tenant_id) {
                const marked = await markClaim(
                    supabaseClient,
                    id,
                    'failed',
                    'student_tenant_mismatch',
                );
                persistenceFailed ||= !marked;
                results.push({
                    id,
                    status: marked ? 'failed' : 'marker_failed',
                    error: 'tenant_mismatch',
                });
                continue;
            }

            // Aviso em grupo sempre sai da conexão central, que é a participante
            // configurada no grupo da escola. Mensagem individual mantém o fluxo
            // professor → fallback central.
            const isGroupNotification = item.notification_kind === 'SCHEDULE_CHANGE_GROUP';
            let instanceId: string | null = !isGroupNotification && teacher?.tenant_id === tenant_id
                ? teacher?.whatsapp_instance || null
                : null;
            if (!instanceId) {
                instanceId = await resolveCentralInstance(supabaseClient, tenant_id, centralCache);
            }

            if (!instanceId) {
                const marked = await markClaim(
                    supabaseClient,
                    id,
                    'failed',
                    'no_whatsapp_instance',
                );
                persistenceFailed ||= !marked;
                results.push({
                    id,
                    status: marked ? 'failed' : 'marker_failed',
                    error: 'no_instance',
                });
                continue;
            }

            const destination = normalizeDestination(student_phone);
            if (!destination) {
                const marked = await markClaim(
                    supabaseClient,
                    id,
                    'failed',
                    'invalid_phone',
                );
                persistenceFailed ||= !marked;
                results.push({
                    id,
                    status: marked ? 'failed' : 'marker_failed',
                    error: 'invalid_phone',
                });
                continue;
            }

            try {
                const url = `${EVOLUTION_API_URL}/message/sendText/${encodeURIComponent(instanceId)}`;
                let response: Response | null = null;
                for (const key of EVOLUTION_API_KEYS) {
                    response = await fetch(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'apikey': key },
                        body: JSON.stringify({ number: destination, text: message_body, delay: 1000 }),
                        signal: AbortSignal.timeout(15_000),
                    });
                    if (response.status !== 401) break; // 401 = chave rotacionada → tenta a próxima
                }

                if (!response || !response.ok) {
                    throw new Error(`provider_http_${response?.status ?? 'unavailable'}`);
                }

                const marked = await markClaim(
                    supabaseClient,
                    id,
                    'sent',
                    null,
                );
                if (!marked) {
                    persistenceFailed = true;
                    console.error('Notification delivery marker failed', { id });
                }
                results.push({ id, status: marked ? 'sent' : 'marker_failed' });

            } catch (err: unknown) {
                const safeReason = err instanceof DOMException &&
                    (err.name === 'TimeoutError' || err.name === 'AbortError')
                    ? 'provider_timeout'
                    : err instanceof Error && /^provider_http_[a-z0-9_-]+$/i.test(err.message)
                        ? err.message
                        : 'provider_network_error';
                console.error('Notification queue delivery failed', {
                    id,
                    reason: safeReason,
                });
                // Mantém 'pending' para re-tentar até MAX_ATTEMPTS; depois marca 'failed'.
                const finalStatus = nextAttempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
                const marked = await markClaim(
                    supabaseClient,
                    id,
                    finalStatus,
                    safeReason,
                );
                persistenceFailed ||= !marked;
                results.push({
                    id,
                    status: marked ? finalStatus : 'marker_failed',
                    error: safeReason,
                });
            }
        }

        return new Response(
            JSON.stringify({ processed: results.length, details: results }),
            {
                status: persistenceFailed ? 500 : 200,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            }
        )

    } catch (error: unknown) {
        console.error('Notification queue worker failed', {
            type: error instanceof Error ? error.name : 'UnknownError',
        });
        return new Response(
            JSON.stringify({ error: 'notification_queue_processing_failed' }),
            { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
    }
})
