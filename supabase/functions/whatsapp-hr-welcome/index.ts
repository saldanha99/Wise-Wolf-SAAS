import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const EVOLUTION_API_BASE = `${(Deno.env.get("EVOLUTION_API_URL") || "https://api.2b.app.br").replace(/\/+$/, "")}/message/sendText`;
const EVOLUTION_API_TOKENS = [(Deno.env.get("EVOLUTION_API_KEY") || "").trim()].filter(Boolean);

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
        const { whatsapp, name, tenant_id, role } = await req.json();

        if (!whatsapp || !name || !tenant_id) {
            throw new Error("Missing required fields: whatsapp, name, tenant_id");
        }

        // Vaga de professor recebe a triagem por IA (Rita). Vendedor/outros: welcome simples.
        const isTeacher = !role || String(role).toLowerCase() === 'professor';

        const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
        const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
        const supabase = createClient(supabaseUrl, supabaseKey);

        // Instância do diretor (mesma da recepção inbound)
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
        if (director?.whatsapp_instance) instanceName = director.whatsapp_instance;

        if (!instanceName) {
            const { data: instanceRow } = await supabase
                .from('whatsapp_instances')
                .select('instance_name')
                .eq('tenant_id', tenant_id)
                .eq('status', 'open')
                .limit(1)
                .maybeSingle();
            if (instanceRow?.instance_name) instanceName = instanceRow.instance_name;
        }
        if (!instanceName) {
            instanceName = 'wise-wolf';
            console.warn(`[HR Welcome] No WhatsApp instance found for tenant ${tenant_id}, using fallback: ${instanceName}`);
        }

        // Telefone
        let cleanPhone = whatsapp.replace(/\D/g, "");
        if (cleanPhone.length >= 10 && cleanPhone.length <= 11) cleanPhone = "55" + cleanPhone;
        else if (cleanPhone.length > 11 && !cleanPhone.startsWith("55")) cleanPhone = "55" + cleanPhone;

        // Banco de Talentos (opcional)
        let groupBlock = '';
        try {
            const { data: t } = await supabase.from('tenants').select('talent_group_link').eq('id', tenant_id).maybeSingle();
            if (t?.talent_group_link) {
                groupBlock = `\n\n🎓 *Enquanto isso, entre no nosso Grupo de Talentos:*\n${t.talent_group_link}\n\nÉ por lá que as vagas abrem primeiro — quem está no grupo sai na frente!`;
            }
        } catch (_e) { /* sem grupo */ }

        const firstName = String(name).trim().split(/\s+/)[0] || name;

        // Mensagem: professor -> convite pra iniciar a triagem (Rita); demais -> simples
        const message = isTeacher
            ? `🐺 *Wise Wolf Language — Processo Seletivo*\n\nOlá, *${firstName}*! 👋\n\nRecebemos sua candidatura para a vaga de *Professor(a) de Inglês* com sucesso! ✅\n\nPara dar continuidade, é bem rápido (5 a 10 min por aqui mesmo). Para começar sua triagem, responda esta mensagem com um *"Oi"*. 😊${groupBlock}\n\n_Equipe Wise Wolf_ 🐾`
            : `🐺 *Wise Wolf Language — Processo Seletivo*\n\nOlá *${firstName}*! 👋\n\nRecebemos sua candidatura com sucesso! ✅\n\nNossa equipe irá analisar seu perfil e entraremos em contato em breve com os próximos passos.${groupBlock}\n\n_Equipe Wise Wolf_ 🐾`;

        let response: Response | null = null;
        let result: any = null;
        for (const token of EVOLUTION_API_TOKENS) {
            response = await fetch(`${EVOLUTION_API_BASE}/${instanceName}`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "apikey": token },
                body: JSON.stringify({
                    number: cleanPhone,
                    options: { delay: 1200, presence: "composing", linkPreview: false },
                    textMessage: { text: message },
                    text: message
                })
            });
            result = await response.json().catch(() => ({}));
            if (response.status !== 401) break; // 401 = chave rotacionada → tenta a próxima
        }
        if (!response || !response.ok) {
            console.error("[HR Welcome] Evolution API Error:", result);
            throw new Error(`WhatsApp API Error: ${result?.message || JSON.stringify(result)}`);
        }

        // Ativa a triagem por IA (Rita) para a candidatura de professor:
        // a Rita só engaja quem tem preinterview_status != null no whatsapp-inbound.
        if (isTeacher) {
            try {
                const { data: appRow } = await supabase
                    .from('job_applications')
                    .select('id, role')
                    .eq('tenant_id', tenant_id)
                    .eq('whatsapp', whatsapp)
                    .is('preinterview_status', null)
                    .order('created_at', { ascending: false })
                    .limit(1)
                    .maybeSingle();
                if (appRow?.id && (!appRow.role || String(appRow.role).toLowerCase() === 'professor')) {
                    await supabase.from('job_applications')
                        .update({ preinterview_status: 'SENT' })
                        .eq('id', appRow.id);
                }
            } catch (e) { console.warn('[HR Welcome] activate Rita failed (non-blocking):', (e as Error).message); }
        }

        console.log(`[HR Welcome] ✅ Message sent to ${cleanPhone} via ${instanceName} (teacher=${isTeacher})`);
        return new Response(JSON.stringify({ success: true, instance: instanceName, teacher: isTeacher, result }), {
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
