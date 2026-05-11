import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const EVOLUTION_API_URL = Deno.env.get('EVOLUTION_API_URL') || "https://api.2b.app.br";
const EVOLUTION_API_TOKEN = Deno.env.get('EVOLUTION_API_KEY') || "";
const EVOLUTION_API_BASE = `${EVOLUTION_API_URL}/message/sendText`;
const DEFAULT_GROUP_JID = "120363403699904869@g.us";

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
        const { name, email, phone, source, notes, tenant_id, school_name } = await req.json();

        if (!phone || !name || !tenant_id) {
            throw new Error("Missing required fields: phone, name, tenant_id");
        }

        // 1. Initialize Supabase Admin Client
        const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
        const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
        const supabase = createClient(supabaseUrl, supabaseKey);

        // 2. Fetch Director's WhatsApp Instance + Group Config
        let instanceName = '';
        let notifGroupId = '';

        const { data: director } = await supabase
            .from('profiles')
            .select('whatsapp_instance, hr_group_id, teachers_group_id')
            .eq('tenant_id', tenant_id)
            .in('role', ['SCHOOL_ADMIN', 'DIRECTOR', 'SUDO'])
            .not('whatsapp_instance', 'is', null)
            .neq('whatsapp_instance', '')
            .limit(1)
            .maybeSingle();

        if (director?.whatsapp_instance) {
            instanceName = director.whatsapp_instance;
        }

        // Group: prefer hr_group_id, fallback to teachers_group_id, then default
        if (director?.hr_group_id) {
            notifGroupId = director.hr_group_id;
        } else if (director?.teachers_group_id) {
            notifGroupId = director.teachers_group_id;
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
            console.warn(`[Lead Notif] No instance for tenant ${tenant_id}, using fallback.`);
        }

        if (!notifGroupId) {
            notifGroupId = DEFAULT_GROUP_JID;
            console.warn(`[Lead Notif] No group for tenant ${tenant_id}, using default.`);
        }

        console.log(`[Lead Notif] Instance: ${instanceName}, Group: ${notifGroupId}`);

        // 3. Format Phone
        let cleanPhone = phone.replace(/\D/g, "");
        if (cleanPhone.length >= 10 && cleanPhone.length <= 11) {
            cleanPhone = "55" + cleanPhone;
        } else if (cleanPhone.length > 11 && !cleanPhone.startsWith("55")) {
            cleanPhone = "55" + cleanPhone;
        }

        // 4. Determine source label
        let sourceLabel = 'Landing Page';
        if (source?.includes('saas')) {
            sourceLabel = 'LP SaaS (B2B)';
        } else if (source?.includes('landing_page')) {
            sourceLabel = 'LP Captação de Alunos';
        } else if (source?.includes('hero') || source?.includes('nav') || source?.includes('footer')) {
            sourceLabel = 'LP SaaS (B2B)';
        }

        // 5. Send CONFIRMATION to lead
        const confirmMessage = `🐺 *Wise Wolf Language*

Olá *${name}*! 👋

Recebemos sua solicitação com sucesso! ✅

Nossa equipe entrará em contato pelo WhatsApp em breve para darmos os próximos passos.

Agradecemos o seu interesse! 🚀

_Equipe Wise Wolf_ 🐾`;

        const confirmResponse = await fetch(`${EVOLUTION_API_BASE}/${instanceName}`, {
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
                textMessage: { text: confirmMessage },
                text: confirmMessage
            })
        });

        const confirmResult = await confirmResponse.json();
        if (!confirmResponse.ok) {
            console.error("[Lead Notif] Error sending to lead:", confirmResult);
        } else {
            console.log(`[Lead Notif] ✅ Confirmation sent to ${cleanPhone}`);
        }

        // 6. Send GROUP notification with all lead info
        const now = new Date();
        const dateStr = now.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
        const timeStr = now.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });

        const groupMessage = `🔔 *NOVO LEAD RECEBIDO* 🔔

👤 *Nome:* ${name}
${school_name ? `🏫 *Escola:* ${school_name}` : ''}
📱 *WhatsApp:* ${phone}
${email ? `📧 *Email:* ${email}` : ''}
📌 *Origem:* ${sourceLabel}
${notes ? `📝 *Obs:* ${notes}` : ''}
📅 *Data:* ${dateStr} às ${timeStr}

_Lead capturado automaticamente_ 🐺`;

        const groupResponse = await fetch(`${EVOLUTION_API_BASE}/${instanceName}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "apikey": EVOLUTION_API_TOKEN
            },
            body: JSON.stringify({
                number: notifGroupId,
                options: {
                    delay: 1200,
                    presence: "composing",
                    linkPreview: false
                },
                textMessage: {
                    text: groupMessage
                },
                text: groupMessage
            })
        });

        const groupResult = await groupResponse.json();
        if (!groupResponse.ok) {
            console.error("[Lead Notif] Error sending to group:", groupResult);
        } else {
            console.log(`[Lead Notif] ✅ Group notification sent to ${notifGroupId}`);
        }

        return new Response(JSON.stringify({
            success: true,
            instance: instanceName,
            lead_sent: confirmResponse.ok,
            group_sent: groupResponse.ok,
        }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 200,
        });

    } catch (error: any) {
        console.error("[Lead Notif] Error:", error.message);
        return new Response(JSON.stringify({ error: error.message }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 400,
        })
    }
})
