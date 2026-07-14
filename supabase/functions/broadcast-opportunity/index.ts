
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.21.0";

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-user-token',
};

// CONFIGURATION
const API_URL = "https://api.2b.app.br";
// Chave via env (rotação sem redeploy) com fallback na chave atual — mesma estratégia do whatsapp-inbound.
const API_KEYS = Array.from(new Set([
    (Deno.env.get("EVOLUTION_API_KEY") || "").trim(),
    "8828462c98512411df3acfe3df4e48a1",
].filter(Boolean)));
const BASE_URL = "https://system.wisewolflanguage.com.br/claim-opportunity";

const DAY_MAP: { [key: number]: string } = {
    1: 'Segunda', 2: 'Terça', 3: 'Quarta', 4: 'Quinta', 5: 'Sexta', 6: 'Sábado', 0: 'Domingo'
};

// Map weekday name to short label for display
const WEEKDAY_LABELS: { [key: string]: string } = {
    'monday': 'Segunda', 'tuesday': 'Terça', 'wednesday': 'Quarta',
    'thursday': 'Quinta', 'friday': 'Sexta', 'saturday': 'Sábado', 'sunday': 'Domingo'
};

// Professor inativo (suspenso/desligado) NUNCA recebe convite — mesma regra do
// helper is_teacher_notifiable. lifecycle_status é a fonte de verdade; status
// (decorativo) também barra valores explicitamente inativos por segurança.
const INACTIVE_STATUS = ['Inativo', 'INACTIVE', 'Inactive', 'Arquivado', 'Cancelado', 'Trancado'];
function cleanTeacherPhone(raw: string): string | null {
    let p = (raw || '').replace(/\D/g, '');
    if (p.length === 10 || p.length === 11) p = '55' + p;
    return p.length >= 12 ? p : null;
}

serve(async (req) => {
    // Check CORS
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
    }

    try {
        console.log("Broadcast Function Hit");
        // opportunity_id (opcional): quando presente, REAPROVEITA a oportunidade existente
        // (reagendamento de experimental com falta) em vez de criar uma nova.
        const { student_name, student_phone, date, time, interests, preferred_slots, opportunity_id, kind } = await req.json();
        const oppKind = kind === 'TRAINING' ? 'TRAINING' : 'TRIAL';

        // VALIDATION: Date is now required (YYYY-MM-DD)
        if (!student_name || !date || !time) {
            throw new Error("Missing required fields (student_name, date, time).");
        }

        const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
        const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

        // Admin Client (Used for both AUTH VERIFICATION and DB ACCESS)
        const supabaseAdmin = createClient(supabaseUrl, supabaseKey);

        // 1. AUTH CHECK (Robust Mode)
        const xUserToken = req.headers.get('x-user-token');
        const authHeader = req.headers.get('Authorization');

        let token = '';

        if (xUserToken) {
            token = xUserToken;
            console.log("Using X-User-Token for auth");
        } else if (authHeader) {
            token = authHeader.replace('Bearer ', '');
        } else {
            console.error("Missing Authorization Header");
            return new Response(JSON.stringify({ error: "Missing Authorization Header" }), { status: 200, headers: corsHeaders });
        }

        const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);

        if (authError || !user) {
            console.error("Auth verification failed:", authError);
            return new Response(JSON.stringify({ error: "Unauthorized: Invalid Session (Admin Check Failed)." }), {
                status: 200,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
        }

        console.log(`[Broadcast] User Authenticated: ${user.email} (${user.id})`);

        // 2. INSTÂNCIA DE ENVIO (Profile Priority)
        let activeInstanceName = null;

        const { data: profile } = await supabaseAdmin
            .from('profiles')
            .select('whatsapp_instance, teachers_group_id, tenant_id')
            .eq('id', user.id)
            .single();

        if (profile?.whatsapp_instance) {
            console.log(`[Broadcast] ✅ Using Profile-Linked Instance: ${profile.whatsapp_instance}`);
            activeInstanceName = profile.whatsapp_instance;
        }

        if (!activeInstanceName) {
            console.log("[Broadcast] ⚠️ Profile instance empty. Scanning connected instances...");
            const { data: wInstance, error: dbError } = await supabaseAdmin
                .from('whatsapp_instances')
                .select('instance_name')
                .eq('user_id', user.id)
                .in('status', ['connected', 'open'])
                .order('updated_at', { ascending: false, nullsFirst: false })
                .limit(1)
                .single();

            if (wInstance) {
                console.log(`[Broadcast] Fallback to latest active instance: ${wInstance.instance_name}`);
                activeInstanceName = wInstance.instance_name;
            } else if (dbError) {
                console.warn("DB Error querying whatsapp_instances:", dbError.message);
            }
        }

        const INSTANCE = activeInstanceName;

        if (!INSTANCE) {
            console.error(`[Broadcast] User ${user.email} has no active instance.`);
            return new Response(JSON.stringify({
                error: "⚠️ Nenhuma conexão ativa encontrada para seu usuário. Vá em Automação e conecte seu WhatsApp."
            }), {
                status: 200,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
        }

        console.log(`[Broadcast] 🚀 Disparando pela instância de ${user.email}: ${INSTANCE}`);

        // Date Logic
        const dateObj = new Date(date + 'T' + time + ':00');
        const dayOfWeek = dateObj.getDay();
        const dayString = DAY_MAP[dayOfWeek] || "Dia";
        const formattedDate = date.split('-').reverse().join('/');

        // 3. Create/Reuse Opportunity
        const createdSlot = {
            day: dayOfWeek,
            time: time,
            date: date,
            formatted: `${formattedDate} (${dayString})`
        };

        let oppData: { id: string };

        if (opportunity_id) {
            const { data: updated, error: updErr } = await supabaseAdmin
                .from('opportunities')
                .update({
                    slots_proposed: [createdSlot],
                    status: 'OPEN',
                    winner_teacher_id: null,
                    trial_appointment_id: null,
                    trial_status: null,
                    conversion_status: 'OPEN',
                    interests: interests || null,
                    preferred_slots: preferred_slots || null,
                })
                .eq('id', opportunity_id)
                .select('id')
                .single();
            if (updErr || !updated) throw new Error("DB Error (reagendamento): " + (updErr?.message || 'oportunidade não encontrada'));
            oppData = updated;
            console.log(`[Broadcast] ♻️ Oportunidade ${opportunity_id} reaberta para reagendamento`);
        } else {
            const { data: inserted, error: oppError } = await supabaseAdmin
                .from('opportunities')
                .insert({
                    student_name: student_name,
                    student_phone: student_phone || '',
                    slots_proposed: [createdSlot],
                    status: 'OPEN',
                    tenant_id: profile?.tenant_id || null,
                    interests: interests || null,
                    user_id: user.id,
                    preferred_slots: preferred_slots || null,
                    kind: oppKind,
                })
                .select('id')
                .single();
            if (oppError) throw new Error("DB Error: " + oppError.message);
            oppData = inserted;
        }

        // 4. Construct URL with Params
        const params = new URLSearchParams({
            id: oppData.id,
            date: date,
            time: time,
            studentName: student_name,
            studentPhone: student_phone || '',
            kind: oppKind
        });
        const claimLink = `${BASE_URL}?${params.toString()}`;

        // Build preferred slots text
        let preferredSlotsText = '';
        if (preferred_slots && Array.isArray(preferred_slots) && preferred_slots.length > 0) {
            const slotLines = preferred_slots.map((s: { weekday: string; time: string }) => {
                const dayLabel = WEEKDAY_LABELS[s.weekday] || s.weekday;
                const timeShort = s.time.replace(':00', 'h').replace(':', 'h');
                return `  ${dayLabel} ${timeShort}`;
            }).join('\n');
            preferredSlotsText = `\n\n📅 *Preferências do aluno:*\n${slotLines}`;
        }

        const textMessage = oppKind === 'TRAINING'
            ? `🎓⚡ *TREINAMENTO AO VIVO — ${formattedDate} (${dayString}) às ${time}*\n\n📚 *Tema:* ${student_name}\n🎯 *Foco:* ${interests || 'Capacitação da equipe'}${preferredSlotsText}\n\n🏆 *Professor(a), quer participar deste treinamento?*\nO primeiro a clicar no link abaixo garante a vaga (remunerado como aula)!\n\n👇 *Aceitar agora:*\n${claimLink}`
            : `🐺⚡ *EXPERIMENTAL — ${formattedDate} (${dayString}) às ${time}*\n\n📋 *Aluno:* ${student_name}\n🎯 *Objetivo:* ${interests || 'Não informado'}${preferredSlotsText}\n\n🏆 *Professor(a), essa aula é sua?*\nO primeiro a clicar no link abaixo garante a aula experimental!\n\n👇 *Aceitar agora:*\n${claimLink}`;

        // 5. DESTINATÁRIOS — envio INDIVIDUAL, só para professores ATIVOS do tenant.
        //    Antes ia num broadcast de GRUPO: qualquer um no grupo (inclusive ex-professor
        //    desligado) recebia o convite. Agora o sistema escolhe a lista — desligado/
        //    suspenso NUNCA entra (mesma regra do is_teacher_notifiable). "O primeiro a
        //    clicar garante" continua valendo: o accept-opportunity tem trava atômica.
        const { data: teachers, error: teachersErr } = await supabaseAdmin
            .from('profiles')
            .select('id, full_name, phone, status')
            .eq('tenant_id', profile?.tenant_id)
            .eq('role', 'TEACHER')
            .eq('lifecycle_status', 'active');

        if (teachersErr) throw new Error("DB Error (teachers): " + teachersErr.message);

        const recipients = (teachers || [])
            .filter((t: any) => !INACTIVE_STATUS.includes(t.status || ''))
            .map((t: any) => ({ id: t.id, name: t.full_name, phone: cleanTeacherPhone(t.phone || '') }))
            .filter((t: any) => !!t.phone);

        const endpoint = `${API_URL}/message/sendText/${encodeURIComponent(INSTANCE)}`;
        let sent = 0;
        const failed: string[] = [];

        for (const r of recipients) {
            let ok = false;
            try {
                for (const key of API_KEYS) {
                    const resp = await fetch(endpoint, {
                        method: "POST",
                        headers: { "Content-Type": "application/json", "apikey": key },
                        body: JSON.stringify({ number: r.phone, text: textMessage, delay: 1200, linkPreview: false }),
                        signal: AbortSignal.timeout(15000),
                    });
                    if (resp.status === 401) continue; // chave rotacionada → tenta a próxima
                    ok = resp.ok;
                    break;
                }
            } catch (err: any) {
                console.error(`[Broadcast] Falha ao enviar p/ ${r.name}:`, err?.message);
                ok = false;
            }
            if (ok) sent++; else failed.push(r.name || r.id);
        }

        const warning = sent === 0
            ? (recipients.length === 0
                ? "Nenhum professor ativo com WhatsApp para receber o convite."
                : "Oportunidade criada, mas nenhuma mensagem foi entregue (verifique a conexão do WhatsApp).")
            : undefined;

        return new Response(JSON.stringify({
            success: true,
            id: oppData.id,
            instance_used: INSTANCE,
            recipients: sent,
            total_active_teachers: recipients.length,
            failed: failed.length,
            ...(warning ? { warning } : {}),
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

    } catch (error: any) {
        console.error("Critical Error", error);
        return new Response(JSON.stringify({ error: error.message }), {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }
});
