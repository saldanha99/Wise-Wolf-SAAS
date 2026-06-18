import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const EVOLUTION_API_BASE = "https://api.2b.app.br/message/sendText";
const EVOLUTION_API_TOKEN = "8828462c98512411df3acfe3df4e48a1"; // Using the global key

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS, PUT, DELETE',
}

serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders })
    }

    try {
        const { phone, full_name, email, password, tenant_id, link_portal } = await req.json();

        if (!phone || !full_name || !tenant_id) {
            throw new Error("Missing required fields: phone, full_name, tenant_id");
        }

        // 1. Initialize Supabase Admin Client
        const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
        const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
        const supabase = createClient(supabaseUrl, supabaseKey);

        // 2. Fetch Director's Instance (PRIMARY: profiles table)
        let instanceName = '';

        const { data: director } = await supabase
            .from('profiles')
            .select('whatsapp_instance')
            .eq('tenant_id', tenant_id)
            .in('role', ['SCHOOL_ADMIN', 'DIRECTOR', 'SUDO'])
            .not('whatsapp_instance', 'is', null)
            .neq('whatsapp_instance', '')
            .limit(1)
            .maybeSingle();

        if (director?.whatsapp_instance) {
            instanceName = director.whatsapp_instance;
        }

        // FALLBACK: Check whatsapp_instances table
        if (!instanceName) {
            const { data: instanceRow } = await supabase
                .from('whatsapp_instances')
                .select('instance_name')
                .eq('tenant_id', tenant_id)
                .eq('status', 'open')
                .limit(1)
                .maybeSingle();

            if (instanceRow?.instance_name) {
                instanceName = instanceRow.instance_name;
            }
        }

        // LAST RESORT: use tenant_id-based default
        if (!instanceName) {
            instanceName = 'wise-wolf';
            console.warn(`[Welcome] No WhatsApp instance found for tenant ${tenant_id}, using fallback: ${instanceName}`);
        }

        console.log(`Using instance: ${instanceName} for tenant ${tenant_id}`);

        // 3. Format Phone
        let cleanPhone = phone.replace(/\D/g, "");
        // If it starts with 55 and is long enough, keep it. If not, add it.
        if (cleanPhone.length >= 10 && cleanPhone.length <= 11) {
            cleanPhone = "55" + cleanPhone;
        } else if (cleanPhone.length > 11 && !cleanPhone.startsWith("55")) {
            // Weird case, but ensures we don't double add if not needed, or add if missing
            cleanPhone = "55" + cleanPhone;
        }
        // If it already starts with 55, we assume it's good.

        // 4. Construct Message
        const message = `🐺 *Bem-vindo(a) à Wise Wolf!*

Olá *${full_name}*, sua matrícula foi realizada com sucesso! 🚀

Aqui estão seus dados de acesso ao portal do aluno:

📧 *Login:* ${email}
🔑 *Senha:* ${password}

🔗 *Acesse agora:* ${link_portal || 'https://system.wisewolflanguage.com.br'}

_Guarde essas informações com segurança!_`;

        // 5. Send via Evolution API
        const response = await fetch(`${EVOLUTION_API_BASE}/${instanceName}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "apikey": EVOLUTION_API_TOKEN
            },
            body: JSON.stringify({
                number: cleanPhone,
                options: {
                    delay: 1200,
                    presence: "composing",
                    linkPreview: true
                },
                textMessage: {
                    text: message
                },
                text: message // Added top-level property for compatibility
            })
        });

        const result = await response.json();

        if (!response.ok) {
            // Log but don't fail hard if it's just WhatsApp error, maybe fallback?
            console.error("Evolution API Error:", result);
            throw new Error(`WhatsApp API Error: ${result.message || JSON.stringify(result)}`);
        }

        return new Response(JSON.stringify({ success: true, instance: instanceName, result }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 200,
        });

    } catch (error: any) {
        console.error("Function Error:", error.message);
        return new Response(JSON.stringify({ error: error.message }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 400,
        })
    }
})
