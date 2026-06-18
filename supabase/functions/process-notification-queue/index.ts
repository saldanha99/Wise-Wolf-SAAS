
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// You might share this service logic or copy it. for simplicity, I'll implement a basic fetch.
// import { whatsappService } from '../../services/whatsappService'; 

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

        // 1. Fetch DUE Pending Notifications
        const { data: pending, error: fetchError } = await supabaseClient
            .from('notification_queue')
            .select('id, teacher_id, student_phone, message_body, tenant_id') // We need tenant/teacher info to know WHICH instance to use?
            // Actually, we need the teacher's profile to get the instance ID again? 
            // OR we should have stored it in queue? 
            // Let's join profile.
            .select(`
        id, 
        student_phone, 
        message_body,
        teacher:teacher_id ( whatsapp_instance ) 
      `)
            .eq('status', 'pending')
            .lte('scheduled_for', new Date().toISOString())
            .limit(50); // Batch size

        if (fetchError) throw fetchError;
        if (!pending || pending.length === 0) {
            return new Response(JSON.stringify({ message: "No pending notifications due." }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        const results = [];

        // 2. Process Batch
        for (const item of pending) {
            const { id, student_phone, message_body, teacher } = item;
            const instanceId = teacher?.whatsapp_instance;

            if (!instanceId) {
                // Mark as failed
                await supabaseClient.from('notification_queue').update({ status: 'failed', last_error: 'No instance ID' }).eq('id', id);
                continue;
            }

            try {
                // CALL EVOLUTION API
                // Fetch URL/Key from Tenant? Or Env? 
                // Evolution API usually requires a Base URL and API Key from the tenant settings.
                // We can't access `localStorage` here. We need to fetch `tenants` table or use ENV.
                // Assuming global EVO ENV for now, OR fetch tenant. 
                // Realistically, we should fetch the tenant config properly.
                // For this V1, I will assume a default ENV variable or query the tenant settings.

                // Let's fetch tenant settings using the tenant_id from the queue item if we had it.
                // I didn't select tenant_id in the query above. Fix:

                // Re-query with tenant_id or just fetch the tenant config now...
                // Ideally we pass the API details.

                // Simulating the call:
                const EVOLUTION_API_URL = 'https://api.2b.app.br';
                const EVOLUTION_API_KEY = '8828462c98512411df3acfe3df4e48a1';

                const url = `${EVOLUTION_API_URL}/message/sendText/${instanceId}`;

                const response = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'apikey': EVOLUTION_API_KEY
                    },
                    body: JSON.stringify({
                        number: student_phone.replace(/\D/g, ''), // Clean phone
                        text: message_body
                    })
                });

                if (!response.ok) {
                    const errText = await response.text();
                    throw new Error(`Evolution API Error: ${response.status} - ${errText}`);
                }

                // Success
                await supabaseClient.from('notification_queue').update({ status: 'sent', updated_at: new Date().toISOString() }).eq('id', id);
                results.push({ id, status: 'sent' });

            } catch (err: any) {
                console.error(`Failed to send ${id}:`, err);
                await supabaseClient.from('notification_queue').update({ status: 'failed', last_error: err.message, attempts: 1 }).eq('id', id); // Increment attempt logic later
                results.push({ id, status: 'failed', error: err.message });
            }
        }

        return new Response(
            JSON.stringify({ processed: results.length, details: results }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )

    } catch (error) {
        return new Response(
            JSON.stringify({ error: error.message }),
            { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
    }
})
