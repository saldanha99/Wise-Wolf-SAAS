import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const EVOLUTION_API_BASE = "https://api.2b.app.br/message/sendText";
const EVOLUTION_API_TOKEN = Deno.env.get('EVOLUTION_API_KEY') || "";
const DEFAULT_GROUP_JID = "120363403699904869@g.us"; // Fallback group

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
        const { whatsapp, name, tenant_id, resume_url } = await req.json();

        if (!whatsapp || !name || !tenant_id) {
            throw new Error("Missing required fields: whatsapp, name, tenant_id");
        }

        // 1. Initialize Supabase Admin Client
        const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
        const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
        const supabase = createClient(supabaseUrl, supabaseKey);

        // 2. Fetch Director's WhatsApp Instance + Group Config
        let instanceName = '';
        let hrGroupId = '';

        // PRIMARY: profiles table (director's linked instance)
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

        // HR Group: prefer hr_group_id, fallback to teachers_group_id
        if (director?.hr_group_id) {
            hrGroupId = director.hr_group_id;
        } else if (director?.teachers_group_id) {
            hrGroupId = director.teachers_group_id;
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

        // Group fallback
        if (!hrGroupId) {
            hrGroupId = DEFAULT_GROUP_JID;
            console.warn(`[HR Welcome] No HR group configured for tenant ${tenant_id}, using default group.`);
        }

        console.log(`[HR Welcome] Using instance: ${instanceName}, group: ${hrGroupId}`);

        // 3. Format Phone
        let cleanPhone = whatsapp.replace(/\D/g, "");
        if (cleanPhone.length >= 10 && cleanPhone.length <= 11) {
            cleanPhone = "55" + cleanPhone;
        } else if (cleanPhone.length > 11 && !cleanPhone.startsWith("55")) {
            cleanPhone = "55" + cleanPhone;
        }

        // 4. Construct Welcome Message for CANDIDATE
        const candidateMessage = `🐺 *Wise Wolf Language - Processo Seletivo*

Olá *${name}*! 👋

Recebemos seu currículo com sucesso! ✅

Nossa equipe de RH irá analisar suas informações e entraremos em contato em breve com os próximos passos.

Agradecemos o interesse em fazer parte do nosso time! 🚀

_Atenciosamente, Equipe Wise Wolf_ 🐾`;

        // 5. Send to CANDIDATE via Evolution API
        const candidateResponse = await fetch(`${EVOLUTION_API_BASE}/${instanceName}`, {
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
                    text: candidateMessage
                },
                text: candidateMessage
            })
        });

        const candidateResult = await candidateResponse.json();

        if (!candidateResponse.ok) {
            console.error("[HR Welcome] Evolution API Error (candidate):", candidateResult);
            // Don't throw - still try to send group notification
        } else {
            console.log(`[HR Welcome] ✅ Candidate message sent to ${cleanPhone}`);
        }

        // 6. Construct GROUP Notification with ALL candidate info
        const now = new Date();
        const dateStr = now.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
        const timeStr = now.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });

        const groupMessage = `📋 *NOVO CURRÍCULO RECEBIDO* 📋

👤 *Nome:* ${name}
📱 *WhatsApp:* ${whatsapp}
${resume_url ? `📄 *Currículo:* ${resume_url}` : ''}
📅 *Data:* ${dateStr} às ${timeStr}

_Candidatura recebida via Trabalhe Conosco_ 🐺`;

        // 7. Send to GROUP via Evolution API
        const groupResponse = await fetch(`${EVOLUTION_API_BASE}/${instanceName}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "apikey": EVOLUTION_API_TOKEN
            },
            body: JSON.stringify({
                number: hrGroupId,
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
            console.error("[HR Welcome] Evolution API Error (group):", groupResult);
        } else {
            console.log(`[HR Welcome] ✅ Group notification sent to ${hrGroupId}`);
        }

        return new Response(JSON.stringify({
            success: true,
            instance: instanceName,
            candidate_sent: candidateResponse.ok,
            group_sent: groupResponse.ok,
            group_jid: hrGroupId
        }), {
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
