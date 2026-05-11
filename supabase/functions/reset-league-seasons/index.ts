/**
 * reset-league-seasons — Weekly League Reset
 *
 * Called by GitHub Actions cron every Monday at 00:00 BRT.
 * 1. Calculate rankings for previous week
 * 2. Promote top 3, demote bottom 3 per tier
 * 3. Create new week entries for opted-in students
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

const TIERS = ['BRONZE', 'PRATA', 'OURO', 'SAFIRA', 'RUBI', 'ESMERALDA', 'DIAMANTE'];

function log(level: string, msg: string, ctx: Record<string, unknown> = {}) {
    const entry = { ts: new Date().toISOString(), level, msg, fn: 'reset-league-seasons', ...ctx };
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

        // Calculate previous week's Monday
        const now = new Date();
        const prevMonday = new Date(now);
        prevMonday.setDate(prevMonday.getDate() - 7);
        prevMonday.setHours(0, 0, 0, 0);
        const prevWeekStart = prevMonday.toISOString().split('T')[0];

        const thisMonday = new Date(now);
        thisMonday.setDate(thisMonday.getDate() - thisMonday.getDay() + 1);
        thisMonday.setHours(0, 0, 0, 0);
        const thisWeekStart = thisMonday.toISOString().split('T')[0];

        // Idempotency: check if this week already has entries
        const { count: existingCount } = await supabaseAdmin
            .from('league_seasons')
            .select('*', { count: 'exact', head: true })
            .eq('week_start', thisWeekStart);

        if (existingCount && existingCount > 0) {
            log('info', 'League reset already run for this week', { week: thisWeekStart });
            return new Response(
                JSON.stringify({ success: true, already_processed: true, week: thisWeekStart }),
                { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            );
        }

        // Fetch all entries from previous week
        const { data: prevWeek, error: fetchErr } = await supabaseAdmin
            .from('league_seasons')
            .select('*')
            .eq('week_start', prevWeekStart)
            .order('tenant_id', { ascending: true })
            .order('tier', { ascending: true })
            .order('weekly_xp', { ascending: false });

        if (fetchErr) throw fetchErr;

        let promoted = 0;
        let demoted = 0;
        let newEntries = 0;

        // Group by tenant + tier
        const groups: Record<string, typeof prevWeek> = {};
        for (const entry of (prevWeek || [])) {
            const key = `${entry.tenant_id}::${entry.tier}`;
            if (!groups[key]) groups[key] = [];
            groups[key].push(entry);
        }

        const newWeekInserts: any[] = [];

        for (const [key, entries] of Object.entries(groups)) {
            const [tenantId, tier] = key.split('::');
            const tierIdx = TIERS.indexOf(tier);

            // Rank within group
            entries.sort((a: any, b: any) => (b.weekly_xp || 0) - (a.weekly_xp || 0));

            for (let i = 0; i < entries.length; i++) {
                const entry = entries[i];
                const rank = i + 1;
                let newTier = tier;
                let isPromoted: boolean | null = null;

                // Top 3 promote (if not already at max tier)
                if (rank <= 3 && tierIdx < TIERS.length - 1 && entry.weekly_xp > 0) {
                    newTier = TIERS[tierIdx + 1];
                    isPromoted = true;
                    promoted++;
                }
                // Bottom 3 demote (if not already at min tier)
                else if (rank > entries.length - 3 && tierIdx > 0 && entries.length > 6) {
                    newTier = TIERS[tierIdx - 1];
                    isPromoted = false;
                    demoted++;
                }

                // Update previous week entry with rank
                await supabaseAdmin
                    .from('league_seasons')
                    .update({ rank_position: rank, promoted: isPromoted })
                    .eq('id', entry.id);

                // Create new week entry
                newWeekInserts.push({
                    tenant_id: tenantId,
                    student_id: entry.student_id,
                    tier: newTier,
                    week_start: thisWeekStart,
                    weekly_xp: 0,
                    opted_in: entry.opted_in,
                    display_name: entry.display_name
                });
                newEntries++;
            }
        }

        // Batch insert new week
        if (newWeekInserts.length > 0) {
            const { error: insertErr } = await supabaseAdmin
                .from('league_seasons')
                .insert(newWeekInserts);

            if (insertErr) {
                log('error', 'Failed to insert new week entries', { error: insertErr.message });
                throw insertErr;
            }
        }

        // Achievement: LEAGUE_MASTER for anyone ranked 1-3 last week
        for (const entries of Object.values(groups)) {
            for (let i = 0; i < Math.min(3, entries.length); i++) {
                const entry = entries[i];
                if (entry.weekly_xp > 0) {
                    await supabaseAdmin
                        .from('student_achievements')
                        .insert({
                            student_id: entry.student_id,
                            achievement_code: 'LEAGUE_MASTER'
                        })
                        .select()
                        .maybeSingle(); // Ignore conflict
                }
            }
        }

        const result = { promoted, demoted, newEntries, week: thisWeekStart, latency_ms: Date.now() - t0 };
        log('info', 'League reset complete', result);

        return new Response(
            JSON.stringify(result),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );

    } catch (error: any) {
        log('error', 'Critical league reset error', { error: error.message, latency_ms: Date.now() - t0 });
        return new Response(
            JSON.stringify({ error: error.message }),
            { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
    }
});
