import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

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

const EVOLUTION_API_URL = 'https://api.2b.app.br';
// Chave via env (rotação sem redeploy) com fallback na chave atual — mesma estratégia do whatsapp-inbound.
const EVOLUTION_API_KEYS = Array.from(new Set([
    (Deno.env.get('EVOLUTION_API_KEY') || '').trim(),
    '8828462c98512411df3acfe3df4e48a1',
].filter(Boolean)));
const MAX_ATTEMPTS = 3;

// Normaliza telefone BR para o formato aceito pela Evolution (55 + DDD + número).
function normalizePhone(raw: string): string | null {
    let phone = (raw || '').replace(/\D/g, '');
    if (phone.length === 10 || phone.length === 11) phone = '55' + phone;
    if (phone.length < 12) return null;
    return phone;
}

// Resolve a instância central da escola (admin do tenant com WhatsApp conectado).
async function resolveCentralInstance(supabase: any, tenantId: string | null, cache: Record<string, string | null>): Promise<string | null> {
    const key = tenantId || '_';
    if (key in cache) return cache[key];
    if (!tenantId) { cache[key] = null; return null; }
    const { data } = await supabase
        .from('profiles')
        .select('whatsapp_instance')
        .eq('tenant_id', tenantId)
        .in('role', ['SCHOOL_ADMIN', 'SUPER_ADMIN'])
        .not('whatsapp_instance', 'is', null)
        .neq('whatsapp_instance', '')
        .limit(1)
        .maybeSingle();
    cache[key] = data?.whatsapp_instance || null;
    return cache[key];
}

serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders })
    }

    try {
        const supabaseClient = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
        )

        // 1. Busca notificações pendentes e vencidas
        const { data: pending, error: fetchError } = await supabaseClient
            .from('notification_queue')
            .select(`
                id,
                student_phone,
                message_body,
                tenant_id,
                attempts,
                teacher:teacher_id ( whatsapp_instance )
            `)
            .eq('status', 'pending')
            .lte('scheduled_for', new Date().toISOString())
            .limit(50);

        if (fetchError) throw fetchError;
        if (!pending || pending.length === 0) {
            return new Response(JSON.stringify({ message: "No pending notifications due." }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        const results: any[] = [];
        const centralCache: Record<string, string | null> = {};

        // 2. Processa o lote
        for (const item of pending) {
            const { id, student_phone, message_body, tenant_id, attempts } = item as any;
            const teacher = (item as any).teacher;
            const nextAttempts = (attempts || 0) + 1;

            // Resolve instância: professor → fallback central
            let instanceId: string | null = teacher?.whatsapp_instance || null;
            if (!instanceId) {
                instanceId = await resolveCentralInstance(supabaseClient, tenant_id, centralCache);
            }

            if (!instanceId) {
                await supabaseClient.from('notification_queue')
                    .update({ status: 'failed', last_error: 'Sem instância (professor e escola sem WhatsApp central)', attempts: nextAttempts })
                    .eq('id', id);
                results.push({ id, status: 'failed', error: 'no_instance' });
                continue;
            }

            const phone = normalizePhone(student_phone);
            if (!phone) {
                await supabaseClient.from('notification_queue')
                    .update({ status: 'failed', last_error: 'Telefone inválido', attempts: nextAttempts })
                    .eq('id', id);
                results.push({ id, status: 'failed', error: 'invalid_phone' });
                continue;
            }

            try {
                const url = `${EVOLUTION_API_URL}/message/sendText/${instanceId}`;
                let response: Response | null = null;
                for (const key of EVOLUTION_API_KEYS) {
                    response = await fetch(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'apikey': key },
                        body: JSON.stringify({ number: phone, text: message_body, delay: 1000 })
                    });
                    if (response.status !== 401) break; // 401 = chave rotacionada → tenta a próxima
                }

                if (!response || !response.ok) {
                    const errText = response ? await response.text() : 'sem resposta';
                    throw new Error(`Evolution API Error: ${response?.status ?? '-'} - ${errText}`);
                }

                await supabaseClient.from('notification_queue')
                    .update({ status: 'sent', updated_at: new Date().toISOString(), attempts: nextAttempts })
                    .eq('id', id);
                results.push({ id, status: 'sent' });

            } catch (err: any) {
                console.error(`Falha ao enviar ${id}:`, err);
                // Mantém 'pending' para re-tentar até MAX_ATTEMPTS; depois marca 'failed'.
                const finalStatus = nextAttempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
                await supabaseClient.from('notification_queue')
                    .update({ status: finalStatus, last_error: err.message, attempts: nextAttempts, updated_at: new Date().toISOString() })
                    .eq('id', id);
                results.push({ id, status: finalStatus, error: err.message });
            }
        }

        return new Response(
            JSON.stringify({ processed: results.length, details: results }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )

    } catch (error: any) {
        return new Response(
            JSON.stringify({ error: error.message }),
            { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
    }
})
