/**
 * complete-enrollment — Converts a Prospect into a Student Auth Profile
 *
 * 1. Validates Prospect exists and is not promoted.
 * 2. Creates an `auth.users` account via Admin API.
 * 3. Calls `promote_prospect_to_student` RPC to map schemas and compute affiliate rewards.
 * 4. Pushes Welcome Message to `outbox_messages`.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.21.0";

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-webhook-secret',
};

const WEBHOOK_SECRET = Deno.env.get('ASAAS_WEBHOOK_TOKEN');

serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
    }

    try {
        const supabaseAdmin = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
            { auth: { autoRefreshToken: false, persistSession: false } }
        );

        // Allow explicit frontend call (JWT) OR internal Webhook trigger (x-webhook-secret)
        let isAuthorized = false;
        
        const authHeader = req.headers.get('Authorization');
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const { data: { user } } = await supabaseAdmin.auth.getUser(authHeader.split(' ')[1]);
            if (user) isAuthorized = true;
        }

        const webhookSecret = req.headers.get('x-webhook-secret');
        if (WEBHOOK_SECRET && webhookSecret === WEBHOOK_SECRET) {
            isAuthorized = true;
        }

        if (!isAuthorized) {
            return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
        }

        const { prospect_id, payment_id } = await req.json();

        if (!prospect_id) {
            return new Response(JSON.stringify({ error: 'Missing prospect_id' }), { status: 400, headers: corsHeaders });
        }

        // 1. Fetch Prospect
        const { data: prospect, error: prospectErr } = await supabaseAdmin
            .from('prospects')
            .select('*')
            .eq('id', prospect_id)
            .single();

        if (prospectErr || !prospect) {
            return new Response(JSON.stringify({ error: 'Prospect not found' }), { status: 404, headers: corsHeaders });
        }

        if (prospect.promoted_at) {
            return new Response(JSON.stringify({ success: true, already_promoted: true, profile_id: prospect.promoted_to_id }), { headers: corsHeaders });
        }

        // 2. Create Auth User
        const randomPassword = Math.random().toString(36).slice(-8) + 'A1!'; // Basic strong password
        
        const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
            email: prospect.email,
            password: randomPassword,
            email_confirm: true,
            user_metadata: {
                full_name: prospect.full_name,
                role: 'STUDENT',
                tenant_id: prospect.tenant_id
            }
        });

        if (authError) {
            console.error("Auth User Creation Error:", authError);
            throw new Error(`Failed to create Auth User: ${authError.message}`);
        }

        const authUserId = authData.user.id;

        // 3. Call RPC to map structures (profiles, enrollments, affiliate credits)
        const { data: rpcResult, error: rpcError } = await supabaseAdmin.rpc('promote_prospect_to_student', {
            p_prospect_id: prospect_id,
            p_payment_id: payment_id || null,
            p_auth_user_id: authUserId
        });

        if (rpcError) {
            console.error("RPC Error:", rpcError);
            throw new Error(`RPC Failed: ${rpcError.message}`);
        }

        if (!rpcResult.success && !rpcResult.already_promoted) {
            throw new Error(`Promotion Failed: ${rpcResult.error}`);
        }

        // 4. Fire Welcome Email & WhatsApp via Outbox
        await supabaseAdmin.from('outbox_messages').insert([
            {
                event_type: 'STUDENT_WELCOME',
                channel: 'whatsapp',
                destination: prospect.phone,
                tenant_id: prospect.tenant_id,
                correlation_id: authUserId,
                payload: {
                    name: prospect.full_name,
                    email: prospect.email,
                    password: randomPassword,
                    type: 'WELCOME_WHATSAPP'
                }
            },
            {
                event_type: 'STUDENT_WELCOME',
                channel: 'email',
                destination: prospect.email,
                tenant_id: prospect.tenant_id,
                correlation_id: authUserId,
                payload: {
                    name: prospect.full_name,
                    email: prospect.email,
                    password: randomPassword,
                    type: 'WELCOME_EMAIL'
                }
            }
        ]);

        return new Response(JSON.stringify({ success: true, profile_id: authUserId, rpc: rpcResult }), { headers: corsHeaders });

    } catch (err: any) {
        console.error("Complete Enrollment Error:", err);
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
    }
});
