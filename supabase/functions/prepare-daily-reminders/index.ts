
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
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

        // 1. Determine Today's Day of Week (Portuguese)
        const days = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
        // Adjust for UTC-3 (Brazil)
        const now = new Date();
        // Brazil is UTC-3. If server is UTC, subtract 3 hours usually, BUT
        // "Today" implies the morning of the visual day.
        // If this runs at 09:00 UTC (6:00 AM BRT), then `now` is correct.
        // Let's assume the Cron triggers at the correct time.
        const dayOfWeek = days[now.getDay()];

        console.log(`Processing reminders for: ${dayOfWeek}`);

        // 2. Fetch Active Teachers with Automation Enabled & WhatsApp Configured
        const { data: teachers, error: teacherError } = await supabaseClient
            .from('profiles')
            .select('id, full_name, whatsapp_instance, meeting_link, tenant_id')
            .eq('role', 'TEACHER')
            .eq('date_automation_enabled', true)
            .not('whatsapp_instance', 'is', null);

        if (teacherError) throw teacherError;
        if (!teachers || teachers.length === 0) {
            return new Response(JSON.stringify({ message: "No teachers with automation enabled." }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        let queuedCount = 0;

        // 3. Iterate Teachers and Find Bookings
        for (const teacher of teachers) {
            // Get Bookings for Today
            const { data: bookings, error: bookingError } = await supabaseClient
                .from('bookings')
                .select(`
          id, 
          time_slot, 
          student:student_id ( id, full_name, phone, meeting_link )
        `)
                .eq('teacher_id', teacher.id)
                .eq('day_of_week', dayOfWeek);

            if (bookingError) {
                console.error(`Error fetching bookings for ${teacher.full_name}:`, bookingError);
                continue;
            }

            if (!bookings || bookings.length === 0) continue;

            // 4. Queue Messages
            for (const booking of bookings) {
                const student = booking.student;
                if (!student || !student.phone) continue;

                // Message Template
                // "Bom dia, {nome_aluno}! Tudo bem? Aqui é o/a professor(a) {nome_professor}. Segue o link da nossa aula de hoje: {link}. Você vai comparecer?"
                const link = teacher.meeting_link || student.meeting_link || "Link não definido";
                const messageBody = `Bom dia, ${student.full_name.split(' ')[0]}! Tudo bem? \n\nAqui é o/a professor(a) ${teacher.full_name}. \n\nSegue o link da nossa aula de hoje: ${link} \n\nVocê vai comparecer?`;

                // Random Delay (0 to 30 minutes from now)
                // 30 mins = 1800000 ms
                const randomDelayMs = Math.floor(Math.random() * 1800000);
                const scheduledTime = new Date(now.getTime() + randomDelayMs);

                const { error: queueError } = await supabaseClient
                    .from('notification_queue')
                    .insert({
                        tenant_id: teacher.tenant_id,
                        teacher_id: teacher.id,
                        student_id: student.id,
                        student_name: student.full_name,
                        student_phone: student.phone,
                        message_body: messageBody,
                        scheduled_for: scheduledTime.toISOString(),
                        status: 'pending'
                    });

                if (queueError) {
                    console.error("Queue Insert Error:", queueError);
                } else {
                    queuedCount++;
                }
            }
        }

        return new Response(
            JSON.stringify({ message: `Queued ${queuedCount} reminders successfully.` }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )

    } catch (error) {
        return new Response(
            JSON.stringify({ error: error.message }),
            { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
    }
})
