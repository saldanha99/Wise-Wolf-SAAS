import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.21.0";

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const EVOLUTION_API_URL = "https://api.2b.app.br";
const EVOLUTION_API_KEY = "8828462c98512411df3acfe3df4e48a1";

serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

    try {
        const { invitee_name, invitee_phone, referrer_id } = await req.json();

        if (!invitee_phone || !referrer_id) {
            return new Response(JSON.stringify({ error: "Missing required fields" }), {
                status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
        }

        const supabase = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
        );

        // Busca nome do referrer e instância WhatsApp dele (ou do admin do tenant)
        const { data: referrer } = await supabase
            .from('profiles')
            .select('full_name, whatsapp_instance, tenant_id')
            .eq('id', referrer_id)
            .single();

        if (!referrer) {
            return new Response(JSON.stringify({ error: "Referrer not found" }), {
                status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
        }

        // Procura instância ativa: primeiro a do referrer, depois do admin do tenant
        let instanceName = referrer.whatsapp_instance;

        if (!instanceName && referrer.tenant_id) {
            const { data: adminProfile } = await supabase
                .from('profiles')
                .select('whatsapp_instance')
                .eq('tenant_id', referrer.tenant_id)
                .in('role', ['SCHOOL_ADMIN', 'SUPER_ADMIN'])
                .not('whatsapp_instance', 'is', null)
                .limit(1)
                .single();

            instanceName = adminProfile?.whatsapp_instance ?? null;
        }

        // Se ainda não achou, busca qualquer instância conectada
        if (!instanceName) {
            const { data: anyInstance } = await supabase
                .from('whatsapp_instances')
                .select('instance_name')
                .in('status', ['connected', 'open'])
                .order('updated_at', { ascending: false })
                .limit(1)
                .single();

            instanceName = anyInstance?.instance_name ?? null;
        }

        if (!instanceName) {
            console.warn("No WhatsApp instance available for referral welcome");
            return new Response(JSON.stringify({ success: false, warning: "No WhatsApp instance available" }), {
                headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
        }

        // Formata o número (remove formatação, garante código do país)
        const cleanPhone = invitee_phone.replace(/\D/g, '');
        const phoneWithCountry = cleanPhone.startsWith('55') ? cleanPhone : `55${cleanPhone}`;

        const referrerFirstName = (referrer.full_name || 'seu amigo').split(' ')[0];
        const inviteeName = (invitee_name || 'Olá').split(' ')[0];

        const message = `Oi ${inviteeName}! 🐺\n\n*${referrer.full_name || referrerFirstName}* te indicou para aprender inglês na *Wise Wolf Language School*!\n\nVocê acabou de dar o primeiro passo para falar inglês de verdade. Nossa equipe vai entrar em contato em breve para apresentar os planos e agendar sua aula experimental *gratuita*! 🎯\n\nFique de olho no seu WhatsApp 👀\n\n_Wise Wolf Language School_`;

        const endpoint = `${EVOLUTION_API_URL}/message/sendText/${encodeURIComponent(instanceName)}`;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        let sent = false;
        try {
            const res = await fetch(endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json", "apikey": EVOLUTION_API_KEY },
                body: JSON.stringify({ number: phoneWithCountry, text: message }),
                signal: controller.signal,
            });
            clearTimeout(timeoutId);
            sent = res.ok;
            if (!res.ok) {
                const errText = await res.text();
                console.error("Evolution API error:", errText);
            }
        } catch (fetchErr: any) {
            clearTimeout(timeoutId);
            console.error("Evolution fetch error:", fetchErr?.message);
        }

        return new Response(JSON.stringify({ success: true, whatsapp_sent: sent, instance: instanceName }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }
        });

    } catch (err: any) {
        console.error("referral-welcome error:", err);
        return new Response(JSON.stringify({ error: err.message }), {
            status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
    }
});
