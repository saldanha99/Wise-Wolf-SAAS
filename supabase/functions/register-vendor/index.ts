import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

/**
 * Register Vendor (SALESPERSON role)
 * - Decodifica payload assinado/base64 do link de convite
 * - Valida tenantId, commissionRate, exp
 * - Cria auth user + profile com role=SALESPERSON
 * - Captura IP server-side para auditoria
 */
serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

    try {
        const supabaseAdmin = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
        );

        const { email, password, name, phone, offerPayload } = await req.json();

        if (!email || !password || !name || !offerPayload) {
            return new Response(JSON.stringify({ error: 'Dados incompletos.' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        // Decode + validate offer
        let offerData: any = null;
        try {
            const jsonStr = decodeURIComponent(escape(atob(offerPayload)));
            offerData = JSON.parse(jsonStr);
        } catch (e) {
            return new Response(JSON.stringify({ error: 'Convite inválido.' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        if (offerData.kind !== 'VENDOR_INVITE' || !offerData.tenantId || !offerData.commissionRate) {
            return new Response(JSON.stringify({ error: 'Payload inválido.' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        if (offerData.exp && Date.now() > offerData.exp) {
            return new Response(JSON.stringify({ error: 'Link de convite expirou.' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        // IP server-side
        const trustedIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
            || req.headers.get('cf-connecting-ip')
            || 'unknown';
        const trustedAcceptedAt = new Date().toISOString();

        // Create auth user
        const { data: authData, error: authError } = await supabaseAdmin.auth.signUp({
            email,
            password,
            options: {
                data: {
                    full_name: name,
                    role: 'SALESPERSON',
                    tenant_id: offerData.tenantId,
                }
            }
        });

        if (authError) {
            return new Response(JSON.stringify({ error: authError.message }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        if (!authData.user) {
            return new Response(JSON.stringify({ error: 'Falha ao criar usuário.' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        const userId = authData.user.id;

        // Create profile
        const { error: profileError } = await supabaseAdmin
            .from('profiles')
            .upsert({
                id: userId,
                email,
                full_name: name,
                role: 'SALESPERSON',
                tenant_id: offerData.tenantId,
                phone: phone || null,
                commission_rate: offerData.commissionRate, // em centavos
                status: 'Ativo',
                avatar_url: `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=random`,
                user_ip: trustedIp,
                accepted_at: trustedAcceptedAt,
                contract_accepted: true,
            });

        if (profileError) {
            return new Response(JSON.stringify({ error: profileError.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        return new Response(JSON.stringify({
            success: true,
            userId,
            role: 'SALESPERSON',
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    } catch (error: any) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
});
