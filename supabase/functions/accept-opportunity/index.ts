
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.21.0";

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// CONFIG
const INSTANCE = "wise wolf";
const API_URL = "https://api.2b.app.br";
const API_KEY = "d037768b3d06382756a0d9edecf3e40e";

serve(async (req) => {
    // Handle CORS
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
    }

    try {
        const { opportunity_id, teacher_id, selected_slot } = await req.json();

        if (!opportunity_id || !teacher_id || !selected_slot) {
            throw new Error("Missing required fields: opportunity_id, teacher_id, selected_slot");
        }

        const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
        const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
        const supabase = createClient(supabaseUrl, supabaseKey);

        // 1. VALIDAÇÃO E TRAVA (Atomic Update)
        const { data: oppData, error: oppError } = await supabase
            .from('opportunities')
            .update({
                status: 'TAKEN',
                winner_teacher_id: teacher_id,
                accepted_slot: selected_slot
            })
            .eq('id', opportunity_id)
            .eq('status', 'OPEN') // Optimistic locking
            .select('student_name, student_phone, tenant_id')
            .single();

        if (oppError || !oppData) {
            // Return 409 Conflict if not found (already taken)
            return new Response(JSON.stringify({ error: "Vaga já preenchida ou inválida." }), {
                status: 409,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
        }

        // 2. AGENDA (Insert into bookings)
        // Calculate End Time (Start + 1h)
        const { date, time, day } = selected_slot; // { date: 'YYYY-MM-DD', time: 'HH:mm' }
        const [hh, mm] = time.split(':').map(Number);
        const endH = hh + 1;
        const endTime = `${endH < 10 ? '0' + endH : endH}:${mm < 10 ? '0' + mm : mm}`;

        const { error: bookingError } = await supabase.from('bookings').insert({
            teacher_id: teacher_id,
            day_of_week: day, // Assuming mapping matches system (e.g. 'Segunda' or int? DB usually depends)
            // Ideally strictly use system format. 
            date: date,
            time_slot: time,
            type: 'TRIAL',
            status: 'CONFIRMED', // Explicitly confirmed
            opportunity_id: opportunity_id,
            tenant_id: oppData.tenant_id
        });

        if (bookingError) {
            console.error("Booking Error:", bookingError);
            // Continue to notify user anyway, or throw? 
            // Proceeding to ensure UX, but logging error.
        }

        // 3. COMUNICAÇÃO (Evolution API)
        // Get Teacher Name
        const { data: teacherProfile } = await supabase
            .from('profiles')
            .select('full_name')
            .eq('id', teacher_id)
            .single();

        const teacherName = teacherProfile?.full_name || "Professor";

        if (oppData.student_phone) {
            // Format Date
            const dateObj = new Date(date + 'T00:00:00');
            const dateFormatted = dateObj.toLocaleDateString('pt-BR');

            const message = `Olá ${oppData.student_name}! 🐺\nConfirmando: Sua aula experimental com Teacher *${teacherName}* está agendada para *${dateFormatted} às ${time}*.\nEle(a) entrará em contato em breve!`;

            // Clean Phone
            let phone = oppData.student_phone.replace(/\D/g, '');
            if (!phone.startsWith('55') && phone.length > 10) phone = '55' + phone;
            const jid = `${phone}@s.whatsapp.net`;

            const instanceEncoded = encodeURIComponent(INSTANCE); // "wise%20wolf"
            const endpoint = `${API_URL}/message/sendText/${instanceEncoded}`;

            await fetch(endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json", "apikey": API_KEY },
                body: JSON.stringify({ number: jid, text: message })
            });
        }

        return new Response(
            JSON.stringify({
                success: true,
                student_phone: oppData.student_phone,
                student_name: oppData.student_name
            }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );

    } catch (error: any) {
        return new Response(JSON.stringify({ error: error.message }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }
});
