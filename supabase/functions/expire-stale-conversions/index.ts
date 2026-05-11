/**
 * expire-stale-conversions — Daily Affiliate Expiry
 *
 * Called by GitHub Actions cron daily at 03:00 BRT.
 * Wraps the RPC expire_stale_conversions() which handles
 * the 30-day trial-to-signup window.
 *
 * Auth: x-cron-secret header
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.21.0";

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
};

const CRON_TRIGGER_SECRET = Deno.env.get('CRON_TRIGGER_SECRET') || "";

function log(level: string, msg: string, ctx: Record<string, unknown> = {}) {
    const entry = { ts: new Date().toISOString(), level, msg, fn: 'expire-stale-conversions', ...ctx };
    if (level === 'error') console.error(JSON.stringify(entry));
    else console.log(JSON.stringify(entry));
}

serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
    }

    const t0 = Date.now();

    try {
        // Auth
        const cronSecret = req.headers.get('x-cron-secret');
        const authHeader = req.headers.get('Authorization');
        if (CRON_TRIGGER_SECRET && cronSecret !== CRON_TRIGGER_SECRET && !authHeader?.startsWith('Bearer ')) {
            return new Response(JSON.stringify({ error: 'Unauthorized' }), {
                status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        const supabaseAdmin = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
            { auth: { autoRefreshToken: false, persistSession: false } }
        );

        const { data: result, error } = await supabaseAdmin.rpc('expire_stale_conversions');

        if (error) {
            log('error', 'RPC expire_stale_conversions failed', { error: error.message });
            throw error;
        }

        log('info', 'Conversion expiry complete', { ...result, latency_ms: Date.now() - t0 });

        return new Response(
            JSON.stringify({ ...result, latency_ms: Date.now() - t0 }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );

    } catch (error: any) {
        log('error', 'Critical expiry error', { error: error.message, latency_ms: Date.now() - t0 });
        return new Response(
            JSON.stringify({ error: error.message }),
            { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
    }
});
