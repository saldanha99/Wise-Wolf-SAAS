
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
        const { email, password, name, phone, pixKey, meetLink, avatar, offerPayload, rg, cpf, address, birthDate, contractAccepted, contractPdfBase64 } = await req.json()

        // Auditoria server-side: IP e timestamp capturados aqui (nao confia no frontend)
        const trustedIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
            || req.headers.get('cf-connecting-ip')
            || req.headers.get('x-real-ip')
            || 'unknown';
        const trustedAcceptedAt = new Date().toISOString();

        if (!email || !password || !name || !offerPayload) {
            return new Response(
                JSON.stringify({ error: 'Dados incompletos.' }),
                { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
            )
        }

        console.log("🚀 Receiving registration for:", email);

        // 3. DECODE OFFER PAYLOAD (SECURITY CHECK)
        // Caminho seguro: offerPayload é um UUID (offer_id) → a taxa AUTORITATIVA vem
        // do banco (offers), não do cliente. Caminho legado: base64 (links antigos).
        let offerData: any = null;
        let offerRowId: string | null = null;
        const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        try {
            if (typeof offerPayload === 'string' && UUID_RE.test(offerPayload.trim())) {
                const { data: offerRow } = await supabaseAdmin
                    .from('offers')
                    .select('id, payload, kind, consumed_at, revoked_at, expires_at')
                    .eq('id', offerPayload.trim())
                    .maybeSingle();
                if (!offerRow || offerRow.kind !== 'TEACHER_INVITE') throw new Error('invite');
                if (offerRow.consumed_at) throw new Error('consumed');
                if (offerRow.revoked_at) throw new Error('revoked');
                if (offerRow.expires_at && new Date(offerRow.expires_at) < new Date()) throw new Error('expired');
                offerData = offerRow.payload;
                offerRowId = offerRow.id;
            } else if (typeof offerPayload === 'string') {
                offerData = JSON.parse(atob(offerPayload)); // legado base64
            } else {
                offerData = offerPayload;
            }

            if (!offerData || !offerData.hourlyRate || !offerData.tenantId) {
                throw new Error("Payload de oferta inválido.");
            }
        } catch (e) {
            return new Response(
                JSON.stringify({ error: 'Convite inválido, expirado ou já utilizado.' }),
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
                accepted_at: trustedAcceptedAt,
                user_ip: trustedIp
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

        // ARQUIVO JURÍDICO (v34): grava o PDF do contrato aceito no bucket privado 'contracts'.
        // Snapshot imutável do texto assinado — o template do contrato pode evoluir depois,
        // mas o que o professor assinou fica preservado (com IP/data já no próprio documento).
        if (contractPdfBase64 && typeof contractPdfBase64 === 'string' && contractPdfBase64.length < 8_000_000) {
            try {
                const bytes = Uint8Array.from(atob(contractPdfBase64), (c) => c.charCodeAt(0));
                const path = `${offerData.tenantId}/${userId}/contrato-prestacao-servicos-${Date.now()}.pdf`;
                const { error: upErr } = await supabaseAdmin.storage
                    .from('contracts')
                    .upload(path, bytes, { contentType: 'application/pdf', upsert: false });
                if (upErr) {
                    console.warn('⚠️ Falha ao arquivar PDF do contrato:', upErr.message);
                } else {
                    await supabaseAdmin.from('profiles').update({ signed_document_url: path }).eq('id', userId);
                    console.log('📄 Contrato arquivado em', path);
                }
            } catch (e) {
                console.warn('⚠️ PDF do contrato não arquivado (cadastro segue):', (e as Error).message);
            }
        }

        // Convite de uso único: marca o offer como consumido após sucesso.
        if (offerRowId) {
            await supabaseAdmin.from('offers').update({ consumed_at: new Date().toISOString() }).eq('id', offerRowId);
        }

        // 6. AUTOMATION: Send Welcome WhatsApp with Access Data
        try {
            const EVOLUTION_API_KEY = Deno.env.get('EVOLUTION_API_KEY') || "";
            const EVOLUTION_API_URL = Deno.env.get('EVOLUTION_API_URL') || "https://api.2b.app.br";

            // Get instance name for the tenant
            const { data: instanceRow } = await supabaseAdmin
                .from('whatsapp_instances')
                .select('instance_name')
                .eq('tenant_id', offerData.tenantId)
                .in('status', ['connected', 'open'])
                .order('updated_at', { ascending: false })
                .limit(1)
                .maybeSingle();

            const targetInstance = instanceRow?.instance_name || "wise-wolf";

            const contractUrl = `https://system.wisewolflanguage.com.br/view-contract?id=${userId}`;
            const msg = `Olá ${name.split(' ')[0]}! Seja bem-vindo(a) à equipe! 🐺🚀

*Seus dados de acesso:*
📧 Login: ${email}
🔑 Senha: ${password}

📜 *Seu Contrato Assinado:* ${contractUrl}

Acesse o portal para completar seu perfil: https://system.wisewolflanguage.com.br`;

            let cleanPhone = phone.replace(/[^0-9]/g, '');
            if (!cleanPhone.startsWith('55') && cleanPhone.length > 10) {
                cleanPhone = '55' + cleanPhone;
            }

            console.log(`[Reg Teacher] Sending welcome via ${targetInstance} to ${cleanPhone}`);

            await fetch(`${EVOLUTION_API_URL}/message/sendText/${targetInstance}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': EVOLUTION_API_KEY
                },
                body: JSON.stringify({
                    number: cleanPhone,
                    text: msg,
                    options: { delay: 1200, presence: "composing" }
                })
            });

        } catch (waErr) {
            console.error("[Reg Teacher] WhatsApp Automation Error (non-blocking):", waErr);
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
