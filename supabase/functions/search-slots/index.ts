
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.21.0";

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const DAY_MAP: { [key: number]: string } = {
    1: 'Segunda', 2: 'Terça', 3: 'Quarta', 4: 'Quinta', 5: 'Sexta', 6: 'Sábado', 0: 'Domingo'
};

serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
    }

    try {
        const rawBody = await req.text();
        let payload;
        try {
            payload = JSON.parse(rawBody);
        } catch {
            // Allow empty body if needed, but here we expect data
            payload = {};
        }

        // Support both formats just in case (SmartFinder might use target_time or time)
        // But explicit request said frontend sends { day, time }
        const day = payload.day ?? payload.target_day;
        const time = payload.time ?? payload.target_time;

        // console.log(`Search Request: Day ${day}, Time ${time}`);

        if (day === undefined || !time) {
            // Return clear error if missing params, but maybe empty array is safer for UI not to crash?
            // Prompt said "Se não achar ninguém, retorne array vazio". But if params missing?
            // Let's error clearly to help debug.
            throw new Error("Missing parameters: 'day' and 'time' are required.");
        }

        const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
        const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
        const supabaseClient = createClient(supabaseUrl, supabaseKey);

        // 1. QUERY AVAILABILITY (Range Match)
        // Find teachers who have a slot where start_time <= requested_time AND end_time > requested_time
        // Note: end_time is mandatory for this logic. If end_time is null, we can't search range.
        // Assuming schema allows checking.

        const { data: availabilities, error: availError } = await supabaseClient
            .from('teacher_availability')
            .select('teacher_id, start_time, end_time, profiles(full_name, phone)')
            .eq('day_of_week', day)
            .lte('start_time', time)  // Can start before or at the time
            .gt('end_time', time);    // Must end AFTER the time (so it covers it)

        if (availError) {
            throw new Error("Availability DB Error: " + availError.message);
        }

        if (!availabilities || availabilities.length === 0) {
            return new Response(JSON.stringify({ slots: [] }), {
                headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
        }

        // 2. CHECK CONFLICTS (Bookings)
        // We must ensure the teacher doesn't have a booking at this EXACT time.
        // Converting Day Enum to String for Booking table usually
        const dayString = DAY_MAP[day];
        const teacherIds = availabilities.map((a: any) => a.teacher_id);

        // Check for bookings that match day and time_slot (exact start)
        // Limitation: If booking starts at 19:00 and goes to 20:00, and user asks 19:30?
        // Current Booking table model often only has 'start_time' (time_slot). 
        // We will check exact match on time_slot for now as MVP.
        const { data: conflicts, error: conflictError } = await supabaseClient
            .from('bookings')
            .select('teacher_id')
            .in('teacher_id', teacherIds)
            .eq('day_of_week', dayString)
            .eq('time_slot', time);

        if (conflictError) throw new Error("Booking DB Error: " + conflictError.message);

        const busyTeacherIds = new Set(conflicts?.map((c: any) => c.teacher_id));

        // 3. FILTER RESULTS
        const validTeachers = availabilities.filter((a: any) => !busyTeacherIds.has(a.teacher_id));

        // 4. MAP RESPONSE
        const results = validTeachers.map((slot: any) => {
            const profile = Array.isArray(slot.profiles) ? slot.profiles[0] : slot.profiles;
            const name = profile?.full_name || "Professor";

            return {
                teacher_id: slot.teacher_id,
                teacher_name: name,
                teacher_avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=random`,
                teacher_phone: profile?.phone,

                // Return context for the booking
                day: dayString,
                time: time,
                date: getNextDate(day),
                iso_start: `${getNextDate(day)}T${time}`
            };
        });

        return new Response(JSON.stringify({ slots: results }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }
        });

    } catch (error: any) {
        return new Response(JSON.stringify({
            error: error.message,
            slots: [] // Fallback
        }), {
            status: 200, // Return 200 so frontend parses JSON
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }
});

// Helper
function getNextDate(dayIndex: number): string {
    const d = new Date();
    d.setDate(d.getDate() + ((dayIndex + 7 - d.getDay()) % 7 || 7));
    return d.toISOString().split('T')[0];
}
