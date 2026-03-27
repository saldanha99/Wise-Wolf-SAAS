
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3"

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
            // Supabase API URL - Env Var automatically set by Supabase Functions
            Deno.env.get('SUPABASE_URL') ?? '',
            // Supabase API ANON KEY - Env Var automatically set by Supabase Functions
            Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
            {
                auth: {
                    autoRefreshToken: false,
                    persistSession: false
                }
            }
        )

        const { name, email, phone, professorId, tenantId, monthlyFee, dueDay } = await req.json()

        // Validation
        if (!email || !name || !tenantId) {
            return new Response(
                JSON.stringify({ error: 'Name, Email and Tenant ID are required' }),
                { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
            )
        }

        // 1. Create Auth User
        console.log(`Creating student auth user for ${email} in tenant ${tenantId}...`);
        const { data: authData, error: authError } = await supabaseClient.auth.admin.createUser({
            email: email,
            password: '123456', // Hardcoded default password as requested for initial setup
            email_confirm: true,
            user_metadata: { full_name: name, role: 'STUDENT', tenant_id: tenantId }
        })

        if (authError) {
            console.error('Auth Create Error:', authError);
            return new Response(
                JSON.stringify({ error: authError.message }),
                { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
            )
        }

        const userId = authData.user.id;

        // 2. Upsert Profile
        console.log(`Upserting student profile for ${userId}...`);
        const { error: profileError } = await supabaseClient.from('profiles').upsert({
            id: userId,
            full_name: name,
            email: email,
            role: 'STUDENT',
            tenant_id: tenantId,
            professor_id: professorId || null,
            phone: phone,
            monthly_fee: monthlyFee ? parseFloat(monthlyFee) : 0,
            due_day: dueDay ? parseInt(dueDay) : 10,
            status_financial: 'ACTIVE',
            created_at: new Date().toISOString()
        })

        if (profileError) {
            console.error('Profile Upsert Error:', profileError);
            return new Response(
                JSON.stringify({ error: 'Failed to create profile: ' + profileError.message }),
                { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
            )
        }

        return new Response(
            JSON.stringify({
                user: authData.user,
                message: 'Student account created successfully'
            }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
        )

    } catch (error) {
        return new Response(
            JSON.stringify({ error: error.message }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
        )
    }
})
