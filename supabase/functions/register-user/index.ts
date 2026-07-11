import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
    // Handle CORS
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders })
    }

    try {
        const supabaseAdmin = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
            { auth: { autoRefreshToken: false, persistSession: false } }
        )

        const { email, password, name, phone, role, tenantId, avatar, metadata } = await req.json()

        if (!email || !password || !name || !role || !tenantId) {
            return new Response(
                JSON.stringify({ error: 'Dados incompletos para registro.' }),
                { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
            )
        }

        console.log(`🚀 Registrando novo usuário: ${email} com papel ${role}`);

        // 1. Criar usuário no Auth (Admin cria direto para pular confirmação se desejar)
        const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
            email,
            password,
            email_confirm: true,
            user_metadata: {
                full_name: name,
                role: role,
                tenant_id: tenantId
            }
        });

        if (authError) {
            console.error("Erro Auth:", authError);
            return new Response(
                JSON.stringify({ error: authError.message }),
                { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
            )
        }

        const userId = authData.user.id;
        const avatarUrl = avatar || `https://ui-avatars.com/api/?name=${name}&background=random`;

        // 2. Criar perfil no banco de dados (public.profiles)
        const { error: profileError } = await supabaseAdmin
            .from('profiles')
            .upsert({
                id: userId,
                email: email,
                full_name: name,
                role: role,
                tenant_id: tenantId,
                phone: phone,
                status: 'Ativo',
                avatar_url: avatarUrl,
                status_financial: 'ACTIVE',
                created_at: new Date().toISOString(),
                ...metadata // Permite passar campos extras como 'department' para comercial
            });

        if (profileError) {
            console.error("Erro Profile:", profileError);
            return new Response(
                JSON.stringify({ error: 'Conta criada, mas erro ao configurar perfil: ' + profileError.message }),
                { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
            )
        }

        return new Response(
            JSON.stringify({
                success: true,
                userId: userId,
                message: 'Cadastro realizado com sucesso!'
            }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
        )

    } catch (err: any) {
        console.error("Erro Geral:", err);
        return new Response(
            JSON.stringify({ error: err.message }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
        )
    }
})
