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
        const body = await req.json();
        // Accept both naming conventions (institucional site sends lead_name/lead_phone, SAAS sends name/phone)
        const rawName = body.lead_name || body.name;
        const rawPhone = body.lead_phone || body.phone;
        const rawEmail = body.lead_email || body.email;
        const source = body.source;
        const tenant_id = body.tenant_id;
        const name = rawName;
        const phone = rawPhone;
        const email = rawEmail;

        if (!name || !tenant_id) {
            throw new Error("Missing required fields: name (or lead_name), tenant_id");
        }

        // 1. Initialize Supabase Admin Client
        const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
        const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
        const supabase = createClient(supabaseUrl, supabaseKey);

        // 2. Fetch Director info and instance
        let instanceName = '';
        let directorPhone = '';

        const { data: director } = await supabase
            .from('profiles')
            .select('whatsapp_instance, phone')
            .eq('tenant_id', tenant_id)
            .in('role', ['SCHOOL_ADMIN', 'DIRECTOR', 'SUPER_ADMIN'])
            .not('whatsapp_instance', 'is', null)
            .neq('whatsapp_instance', '')
            .limit(1)
            .maybeSingle();

        if (director) {
            instanceName = director.whatsapp_instance;
            directorPhone = director.phone;
        }

        // FALLBACK: Check whatsapp_instances table for the tenant
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

        // FINAL FALLBACK
        if (!instanceName) {
            instanceName = 'wise-wolf';
        }

        console.log(`[CRM Lead] Processing lead ${name} for tenant ${tenant_id} using instance ${instanceName}`);

        // 3. Format Messages
        const cleanLeadPhone = phone ? phone.replace(/\D/g, "") : "";
        let formattedLeadPhone = cleanLeadPhone;
        if (cleanLeadPhone && cleanLeadPhone.length >= 10 && !cleanLeadPhone.startsWith("55")) {
            formattedLeadPhone = "55" + cleanLeadPhone;
        }

        const internalMsg = `🐺 *Wise Wolf - Novo Lead!*
        
📌 *Nome:* ${name}
📞 *WhatsApp:* ${phone || 'Não informado'}
📧 *E-mail:* ${email || 'Não informado'}
🌍 *Origem:* ${source || 'Direto / Desconhecida'}

Acesse seu CRM para gerenciar este contato! 🚀`;

        const welcomeMsg = `🐺 *Olá ${name.split(' ')[0]}, bem-vindo(a) à Wise Wolf!*
        
Recebemos seu interesse em dominar um novo idioma e ficamos muito felizes! 🚀

Nossa equipe entrará em contato em breve para tirar suas dúvidas e agendar sua *aula experimental gratuita*.

Enquanto isso, sinta-se à vontade para nos chamar aqui se tiver alguma pressa. Até logo! 🐾`;

        // 4. Send Internal Notification to Director
        // Use directorPhone if available, otherwise skip (message goes via instance self)
        const cleanDirectorPhone = directorPhone ? directorPhone.replace(/\D/g, "") : '';
        const finalDirectorPhone = cleanDirectorPhone && cleanDirectorPhone.length >= 10
            ? (cleanDirectorPhone.startsWith('55') ? cleanDirectorPhone : '55' + cleanDirectorPhone)
            : '';

        if (finalDirectorPhone) {
            console.log(`[CRM Lead] Sending internal alert to Director: ${finalDirectorPhone}`);
            await fetch(`${EVOLUTION_API_BASE}/${instanceName}`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "apikey": EVOLUTION_API_TOKEN },
                body: JSON.stringify({
                    number: finalDirectorPhone,
                    text: internalMsg
                })
            });
        } else {
            console.warn(`[CRM Lead] Director phone not set — skipping internal alert for tenant ${tenant_id}`);
        }

        // 5. Send Welcome message to Lead
        if (formattedLeadPhone) {
            console.log(`[CRM Lead] Sending welcome msg to Lead: ${formattedLeadPhone}`);
            await fetch(`${EVOLUTION_API_BASE}/${instanceName}`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "apikey": EVOLUTION_API_TOKEN },
                body: JSON.stringify({
                    number: formattedLeadPhone,
                    text: welcomeMsg
                })
            });
        }

        return new Response(JSON.stringify({ success: true, instance: instanceName }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 200,
        });

    } catch (error: any) {
        console.error("[CRM Lead] Error:", error.message);
        return new Response(JSON.stringify({ error: error.message }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 400,
        })
    }
})
