/**
 * validate-streaks — Hourly Streak Validation
 *
 * Called by GitHub Actions cron every hour.
 * Scans students whose timezone midnight has passed without daily goal completion.
 * Handles streak freeze consumption before breaking streaks.
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
    const entry = { ts: new Date().toISOString(), level, msg, fn: 'validate-streaks', ...ctx };
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

        // Find students with active streaks whose last_activity_date is before yesterday
        // in their timezone
        const { data: staleStreaks, error: fetchErr } = await supabaseAdmin
            .from('student_streaks')
            .select('student_id, tenant_id, current_streak, longest_streak, last_activity_date, freezes_available, freezes_used_this_week, timezone')
            .gt('current_streak', 0)
            .lt('last_activity_date', new Date(Date.now() - 2 * 86400000).toISOString().split('T')[0]); // 2 days ago (safe margin)

        if (fetchErr) {
            log('error', 'Failed to fetch stale streaks', { error: fetchErr.message });
            throw fetchErr;
        }

        let broken = 0;
        let frozen = 0;
        let skipped = 0;

        for (const streak of (staleStreaks || [])) {
            // Calculate yesterday in student's timezone
            const now = new Date();
            const studentNow = new Date(now.toLocaleString('en-US', { timeZone: streak.timezone || 'America/Sao_Paulo' }));
            const studentYesterday = new Date(studentNow);
            studentYesterday.setDate(studentYesterday.getDate() - 1);
            const yesterdayStr = studentYesterday.toISOString().split('T')[0];

            // If last activity is yesterday or today, streak is fine
            if (streak.last_activity_date && streak.last_activity_date >= yesterdayStr) {
                skipped++;
                continue;
            }

            // Check if freeze is available
            if (streak.freezes_available > 0 && streak.freezes_used_this_week < 1) {
                // Use freeze
                await supabaseAdmin
                    .from('student_streaks')
                    .update({
                        freezes_available: streak.freezes_available - 1,
                        freezes_used_this_week: streak.freezes_used_this_week + 1,
                        last_activity_date: yesterdayStr, // Pretend yesterday was active
                        updated_at: now.toISOString()
                    })
                    .eq('student_id', streak.student_id);

                frozen++;
                log('info', 'Streak freeze consumed', {
                    student_id: streak.student_id,
                    streak: streak.current_streak,
                    freezes_left: streak.freezes_available - 1
                });
            } else {
                // Break streak
                await supabaseAdmin
                    .from('student_streaks')
                    .update({
                        current_streak: 0,
                        updated_at: now.toISOString()
                    })
                    .eq('student_id', streak.student_id);

                broken++;
                log('info', 'Streak broken', {
                    student_id: streak.student_id,
                    was: streak.current_streak
                });

                // Optional: send notification via outbox
                if (streak.current_streak >= 7) {
                    await supabaseAdmin
                        .from('outbox_messages')
                        .insert({
                            channel: 'whatsapp',
                            destination: streak.student_id, // Will be resolved by worker
                            payload: {
                                type: 'STREAK_BROKEN',
                                student_id: streak.student_id,
                                was_streak: streak.current_streak,
                                text: `😿 Sua ofensiva de ${streak.current_streak} dias foi quebrada! Volte hoje para recomeçar! 🔥`
                            },
                            status: 'PENDING',
                            tenant_id: streak.tenant_id,
                            correlation_id: streak.student_id
                        });
                }
            }
        }

        // Reset weekly freeze counter on Mondays
        const today = new Date();
        if (today.getDay() === 1) { // Monday
            const { error: resetErr } = await supabaseAdmin
                .from('student_streaks')
                .update({ freezes_used_this_week: 0, updated_at: today.toISOString() })
                .gt('freezes_used_this_week', 0);

            if (resetErr) log('warn', 'Failed to reset weekly freezes', { error: resetErr.message });
            else log('info', 'Weekly freeze counters reset');
        }

        const result = { broken, frozen, skipped, total: staleStreaks?.length || 0, latency_ms: Date.now() - t0 };
        log('info', 'Streak validation complete', result);

        return new Response(
            JSON.stringify(result),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );

    } catch (error: any) {
        log('error', 'Critical streak validation error', { error: error.message, latency_ms: Date.now() - t0 });
        return new Response(
            JSON.stringify({ error: error.message }),
            { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
    }
});
