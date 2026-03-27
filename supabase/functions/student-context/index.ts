
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.23.0";

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS, PUT, DELETE',
};

serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
    }

    // Fallback response in case everything fails
    const fallbackResponse = {
        profile: {},
        gamification: { xp: 0, level: 1, streak: 0, nextLevelProgress: 0 },
        billing: { status: 'OK', oldestDue: null },
        nextClass: null
    };

    try {
        console.log("[student-context] Step 1: Creating clients...");

        const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
        const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
        const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

        console.log("[student-context] URL exists:", !!supabaseUrl, "Anon exists:", !!anonKey, "Service exists:", !!serviceKey);

        // Client with user's auth token (for getUser only)
        const supabaseClient = createClient(supabaseUrl, anonKey, {
            global: { headers: { Authorization: req.headers.get('Authorization')! } }
        });

        // Admin client (for all DB operations)
        const supabaseAdmin = createClient(supabaseUrl, serviceKey);

        // 1. Get User
        console.log("[student-context] Step 2: Getting user...");
        const { data: { user }, error: userError } = await supabaseClient.auth.getUser();

        if (userError) {
            console.error("[student-context] Auth error:", userError.message);
            throw new Error('Auth failed: ' + userError.message);
        }
        if (!user) {
            throw new Error('User not found');
        }
        console.log("[student-context] User found:", user.id);

        // 2. Fetch Profile
        console.log("[student-context] Step 3: Fetching profile...");
        const { data: profile, error: profileError } = await supabaseAdmin
            .from('profiles')
            .select('*')
            .eq('id', user.id)
            .single();

        if (profileError) {
            console.error("[student-context] Profile error:", JSON.stringify(profileError));
            // Return fallback with user email at least
            return new Response(JSON.stringify({
                ...fallbackResponse,
                profile: { id: user.id, email: user.email, full_name: user.user_metadata?.full_name || '' }
            }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                status: 200,
            });
        }

        console.log("[student-context] Profile found for:", profile.full_name);

        // 3. GAMIFICATION (Non-blocking)
        const now = new Date();
        let newStreak = profile.streak_count || 0;

        try {
            const lastActivity = profile.last_activity ? new Date(profile.last_activity) : null;
            if (lastActivity) {
                const isSameDay = now.getDate() === lastActivity.getDate() &&
                    now.getMonth() === lastActivity.getMonth() &&
                    now.getFullYear() === lastActivity.getFullYear();
                if (!isSameDay) {
                    const midnightNow = new Date(now); midnightNow.setHours(0, 0, 0, 0);
                    const midnightLast = new Date(lastActivity); midnightLast.setHours(0, 0, 0, 0);
                    const daysDiff = Math.floor((midnightNow.getTime() - midnightLast.getTime()) / (1000 * 60 * 60 * 24));
                    newStreak = daysDiff === 1 ? newStreak + 1 : 1;
                }
            } else {
                newStreak = 1;
            }
            await supabaseAdmin.from('profiles').update({
                streak_count: newStreak,
                last_activity: now.toISOString()
            }).eq('id', user.id);
        } catch (e) {
            console.warn("[student-context] Streak update failed (non-blocking):", e);
        }

        // 4. BILLING
        let billingStatus = 'OK';
        let oldestDue = null;
        try {
            const { data: payments } = await supabaseAdmin
                .from('student_payments')
                .select('due_date, status')
                .eq('student_id', user.id)
                .neq('status', 'RECEIVED')
                .neq('status', 'CONFIRMED')
                .lt('due_date', now.toISOString());

            if (payments && payments.length > 0) {
                const sorted = payments.sort((a: any, b: any) => new Date(a.due_date).getTime() - new Date(b.due_date).getTime());
                oldestDue = new Date(sorted[0].due_date);
                const daysLate = Math.ceil(Math.abs(now.getTime() - oldestDue.getTime()) / (1000 * 60 * 60 * 24));
                billingStatus = daysLate > 7 ? 'SUSPENDED' : 'OVERDUE';
            }
        } catch (e) {
            console.warn("[student-context] Billing check failed (non-blocking):", e);
        }

        // 5. NEXT BOOKING
        let nextBooking = null;
        try {
            const { data: nb } = await supabaseAdmin
                .from('bookings')
                .select('*')
                .eq('student_id', user.id)
                .gte('start_time', now.toISOString())
                .order('start_time', { ascending: true })
                .limit(1)
                .maybeSingle();
            nextBooking = nb;
        } catch (e) {
            console.warn("[student-context] Booking fetch failed (non-blocking):", e);
        }

        // 6. Return
        console.log("[student-context] SUCCESS — returning data for", profile.full_name);
        return new Response(
            JSON.stringify({
                profile: { ...profile, streak_count: newStreak, last_activity: now.toISOString() },
                gamification: {
                    xp: profile.xp || 0,
                    level: profile.level || 1,
                    streak: newStreak,
                    nextLevelProgress: ((profile.xp || 0) % 1000) / 10
                },
                billing: { status: billingStatus, oldestDue: oldestDue ? oldestDue.toISOString() : null },
                nextClass: nextBooking
            }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
        );

    } catch (error: any) {
        console.error("[student-context] CRITICAL ERROR:", error.message, error.stack);
        // ALWAYS return 200 with fallback data so the frontend doesn't break
        return new Response(
            JSON.stringify({ ...fallbackResponse, _error: error.message }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
        );
    }
});
