import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const EVOLUTION_API_BASE = "https://api.2b.app.br/message/sendText";
const EVOLUTION_API_TOKEN = "8828462c98512411df3acfe3df4e48a1";

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
        const { whatsapp, name, tenant_id } = await req.json();

        if (!whatsapp || !name || !tenant_id) {
            throw new Error("Missing required fields: whatsapp, name, tenant_id");
        }

        // 1. Initialize Supabase Admin Client
        const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
        const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
        const supabase = createClient(supabaseUrl, supabaseKey);

        // 2. Fetch Director's WhatsApp Instance (same pattern as other functions)
        let instanceName = '';

        // PRIMARY: profiles table (director's linked instance)
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

        // FALLBACK: whatsapp_instances table
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

        if (!instanceName) {
            instanceName = 'wise-wolf';
            console.warn(`[HR Welcome] No WhatsApp instance found for tenant ${tenant_id}, using fallback: ${instanceName}`);
        }

        console.log(`[HR Welcome] Using instance: ${instanceName} for tenant ${tenant_id}`);

        // 3. Format Phone
        let cleanPhone = whatsapp.replace(/\D/g, "");
        if (cleanPhone.length >= 10 && cleanPhone.length <= 11) {
            cleanPhone = "55" + cleanPhone;
        } else if (cleanPhone.length > 11 && !cleanPhone.startsWith("55")) {
            cleanPhone = "55" + cleanPhone;
        }

        // 3b. Banco de Talentos: convite p/ grupo WhatsApp (se configurado no tenant)
        let groupBlock = '';
        try {
            const { data: t } = await supabase.from('tenants').select('talent_group_link').eq('id', tenant_id).maybeSingle();
            if (t?.talent_group_link) {
                groupBlock = `

🎓 *Enquanto isso, entre no nosso Grupo de Talentos:*
${t.talent_group_link}

É por lá que as vagas abrem primeiro — quem está no grupo sai na frente!`;
            }
        } catch (_e) { /* sem grupo, mensagem segue normal */ }

        // 4. Construct Welcome Message
        const message = `🐺 *Wise Wolf Language - Processo Seletivo*

Olá *${name}*! 👋

Recebemos seu currículo com sucesso! ✅

Nossa equipe de RH irá analisar suas informações e entraremos em contato em breve com os próximos passos.${groupBlock}

Agradecemos o interesse em fazer parte do nosso time! 🚀

_Atenciosamente, Equipe Wise Wolf_ 🐾`;

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
                    linkPreview: false
                },
                textMessage: {
                    text: message
                },
                text: message
            })
        });

        const result = await response.json();

        if (!response.ok) {
            console.error("[HR Welcome] Evolution API Error:", result);
            throw new Error(`WhatsApp API Error: ${result.message || JSON.stringify(result)}`);
        }

        console.log(`[HR Welcome] ✅ Message sent to ${cleanPhone} via ${instanceName}`);

        return new Response(JSON.stringify({ success: true, instance: instanceName, result }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 200,
        });

    } catch (error: any) {
        console.error("[HR Welcome] Function Error:", error.message);
        return new Response(JSON.stringify({ error: error.message }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 400,
        })
    }
})
