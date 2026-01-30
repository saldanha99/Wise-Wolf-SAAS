
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
    // 0. Handle CORS
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders })
    }

    try {
        // 1. SETUP SUPABASE CLIENTS
        // Admin client to create profile with restricted fields (bypass RLS)
        const supabaseAdmin = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
            { auth: { autoRefreshToken: false, persistSession: false } }
        )

        // Anon client for Auth SignUp (standard behavior)
        const supabaseAnon = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_ANON_KEY') ?? '',
            { auth: { autoRefreshToken: false, persistSession: false } }
        )

        // 2. PARSE BODY
        const { email, password, name, phone, pixKey, meetLink, avatar, offerPayload, rg, cpf, address, birthDate, contractAccepted, acceptedAt, userIp } = await req.json()

        if (!email || !password || !name || !offerPayload) {
            return new Response(
                JSON.stringify({ error: 'Dados incompletos.' }),
                { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
            )
        }

        console.log("🚀 Receiving registration for:", email);

        // 3. DECODE OFFER PAYLOAD (SECURITY CHECK)
        let offerData: any = null;
        try {
            // Check if it's already an object or a base64 string
            if (typeof offerPayload === 'string') {
                const jsonStr = atob(offerPayload);
                offerData = JSON.parse(jsonStr);
            } else {
                offerData = offerPayload;
            }

            if (!offerData || !offerData.hourlyRate || !offerData.tenantId) {
                throw new Error("Payload de oferta inválido.");
            }
        } catch (e) {
            return new Response(
                JSON.stringify({ error: 'Convite inválido ou corrompido.' }),
                { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
            )
        }

        console.log("✅ Offer Validated:", offerData);

        // 4. CREATE AUTH USER (using Anon client usually, but Admin allows specific config)
        // Using Admin to ensure we can create users without restrictions if needed, 
        // but normally Anon is fine. Let's use Admin.auth.signUp to be safe but allow email confirmation logic if enabled.
        // Actually, if we want to confirm email later, we use signUp.

        const { data: authData, error: authError } = await supabaseAdmin.auth.signUp({
            email,
            password,
            options: {
                data: {
                    full_name: name,
                    role: 'TEACHER', // Metadata role
                    tenant_id: offerData.tenantId
                }
            }
        });

        if (authError) {
            console.error("Auth Error:", authError);
            return new Response(
                JSON.stringify({ error: authError.message }),
                { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
            )
        }

        if (!authData.user) {
            return new Response(
                JSON.stringify({ error: 'Erro ao criar usuário.' }),
                { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
            )
        }

        const userId = authData.user.id;
        const avatarUrl = avatar || `https://ui-avatars.com/api/?name=${name}&background=random`;

        // 5. CREATE PROFILE (DB) - Using Admin to enforce fields
        // We UPSERT to handle race conditions if a trigger existed (even if we didn't find one)
        // Enforcing: hourly_rate from offer, tenant_id from offer.
        const { error: profileError } = await supabaseAdmin
            .from('profiles')
            .upsert({
                id: userId,
                email: email,
                full_name: name,
                role: 'TEACHER', // Enforced Role
                tenant_id: offerData.tenantId, // Enforced Tenant
                phone: phone,
                module: offerData.subject, // From invite
                hourly_rate: offerData.hourlyRate, // Enforced Rate
                pix_key: pixKey,
                meeting_link: meetLink,
                status: 'Ativo',
                avatar_url: avatarUrl,
                // New Fields
                rg: rg,
                cpf: cpf,
                address: address,
                birth_date: birthDate,
                contract_accepted: contractAccepted,
                accepted_at: acceptedAt
            });

        if (profileError) {
            console.error("Profile Error:", profileError);
            // Rollback auth user? It's hard in Edge Functions without transactions.
            // We just return error.
            return new Response(
                JSON.stringify({ error: 'Usuário criado, mas erro ao configurar perfil: ' + profileError.message }),
                { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
            )
        }

        return new Response(
            JSON.stringify({ success: true, userId: userId, message: 'Cadastro realizado com sucesso!' }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
        )

    } catch (err: any) {
        return new Response(
            JSON.stringify({ error: err.message }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
        )
    }
})
