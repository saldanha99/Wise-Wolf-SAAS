import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const EVOLUTION_API_BASE = `${(Deno.env.get("EVOLUTION_API_URL") || "https://api.2b.app.br").replace(/\/+$/, "")}/message/sendText`;
const EVOLUTION_API_TOKEN = Deno.env.get("EVOLUTION_API_KEY") || ""; // Using the global key

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
        const { student_id, tenant_id, link_portal } = await req.json();

        // 1. Initialize Supabase Admin Client
        const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
        const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
        const supabase = createClient(supabaseUrl, supabaseKey);

        const bearer = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
        let studentId = '';
        if (supabaseKey && bearer === supabaseKey) {
            studentId = String(student_id || '');
        } else {
            const { data: auth, error: authError } = await supabase.auth.getUser(bearer);
            if (authError || !auth.user) {
                return new Response(JSON.stringify({ error: 'unauthorized' }), {
                    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                    status: 401,
                });
            }
            studentId = auth.user.id;
        }
        if (!studentId) throw new Error('student_id ausente');

        const { data: student } = await supabase.from('profiles')
            .select('id, full_name, email, phone, tenant_id, wa_welcome_sent, is_test_account')
            .eq('id', studentId)
            .maybeSingle();
        if (student?.is_test_account) {
            return new Response(JSON.stringify({ success: true, skipped: 'test_fixture' }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                status: 200,
            });
        }
        if (!student || (tenant_id && student.tenant_id !== tenant_id) || !student.phone || !student.tenant_id) {
            return new Response(JSON.stringify({ error: 'forbidden' }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                status: 403,
            });
        }
        const phone = student.phone;
        const full_name = student.full_name || 'Aluno(a)';
        const email = student.email || '';
        if (student.wa_welcome_sent) {
            return new Response(JSON.stringify({ success: true, skipped: 'already_sent' }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                status: 200,
            });
        }

        // 2. Fetch Director's Instance (PRIMARY: profiles table)
        let instanceName = '';

        const { data: director } = await supabase
            .from('profiles')
            .select('whatsapp_instance')
            .eq('tenant_id', student.tenant_id)
            .in('role', ['SCHOOL_ADMIN', 'SUPER_ADMIN'])
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
                .eq('tenant_id', student.tenant_id)
                .eq('status', 'open')
                .limit(1)
                .maybeSingle();

            if (instanceRow?.instance_name) {
                instanceName = instanceRow.instance_name;
            }
        }

        if (!instanceName) {
            throw new Error('Escola sem WhatsApp central conectado.');
        }

        const { data: claimed, error: claimError } = await supabase.from('profiles')
            .update({ wa_welcome_sent: true, contract_sent_at: new Date().toISOString() })
            .eq('id', student.id)
            .or('wa_welcome_sent.is.null,wa_welcome_sent.eq.false')
            .select('id')
            .maybeSingle();
        if (claimError) throw claimError;
        if (!claimed) {
            return new Response(JSON.stringify({ success: true, skipped: 'already_sent' }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                status: 200,
            });
        }

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
🔑 *Senha:* use a senha que você criou na matrícula

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
            await supabase.from('profiles').update({ wa_welcome_sent: false }).eq('id', student.id);
            console.error("Evolution API Error", { status: response.status });
            throw new Error('Não foi possível enviar a mensagem de boas-vindas.');
        }

        return new Response(JSON.stringify({ success: true, instance: instanceName, result }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 200,
        });

    } catch (error: unknown) {
        console.error("Function Error", {
            type: error instanceof Error ? error.name : 'UnknownError',
        });
        return new Response(JSON.stringify({ error: 'Não foi possível enviar a mensagem de boas-vindas.' }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 400,
        })
    }
})
