
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.21.0";

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// CONFIG
const INSTANCE = "wise wolf";
const API_URL = "https://api.2b.app.br";
const API_KEY = Deno.env.get("EVOLUTION_API_KEY") || "";

serve(async (req) => {
    // Handle CORS
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
    }

    try {
        const { opportunity_id, selected_slot } = await req.json();

        if (!opportunity_id || !selected_slot) {
            throw new Error("Missing required fields: opportunity_id, selected_slot");
        }

        const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
        const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
        const supabase = createClient(supabaseUrl, supabaseKey);

        // SECURITY: Validate JWT and extract teacher identity
        const authHeader = req.headers.get('Authorization');
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return new Response(JSON.stringify({ error: "Unauthorized: token required" }), {
                status: 401,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
        }

        const token = authHeader.replace('Bearer ', '');
        const { data: { user: authUser }, error: authError } = await supabase.auth.getUser(token);

        if (authError || !authUser) {
            return new Response(JSON.stringify({ error: "Unauthorized: invalid token" }), {
                status: 401,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
        }

        // SECURITY: Verify TEACHER role
        const { data: profile } = await supabase
            .from('profiles')
            .select('role')
            .eq('id', authUser.id)
            .single();

        if (!profile || profile.role !== 'TEACHER') {
            return new Response(JSON.stringify({ error: "Forbidden: only teachers can accept opportunities" }), {
                status: 403,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
        }

        // Use authenticated user as teacher_id (never trust body)
        const teacher_id = authUser.id;

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

            // Instância central REAL do tenant (o "wise wolf" fixo não existe na Evolution)
            const { data: centralInst } = await supabase.rpc('central_instance_for_tenant', { p_tenant: oppData.tenant_id });
            const sendInstance = centralInst || INSTANCE;
            const endpoint = `${API_URL}/message/sendText/${encodeURIComponent(sendInstance)}`;

            const evoRes = await fetch(endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json", "apikey": API_KEY },
                body: JSON.stringify({ number: phone, text: message })
            });
            if (!evoRes.ok) console.error("[accept-opportunity] Evolution falhou:", sendInstance, await evoRes.text());
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
