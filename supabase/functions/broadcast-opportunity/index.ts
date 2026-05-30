
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.21.0";

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-user-token',
};

// CONFIGURATION
const API_URL = "https://api.2b.app.br";
const API_KEY = "d037768b3d06382756a0d9edecf3e40e";
const GROUP_JID = "120363403699904869@g.us";
const BASE_URL = "https://system.wisewolflanguage.com.br/claim-opportunity";

const DAY_MAP: { [key: number]: string } = {
    1: 'Segunda', 2: 'Terça', 3: 'Quarta', 4: 'Quinta', 5: 'Sexta', 6: 'Sábado', 0: 'Domingo'
};

// Map weekday name to short label for display
const WEEKDAY_LABELS: { [key: string]: string } = {
    'monday': 'Segunda', 'tuesday': 'Terça', 'wednesday': 'Quarta',
    'thursday': 'Quinta', 'friday': 'Sexta', 'saturday': 'Sábado', 'sunday': 'Domingo'
};

serve(async (req) => {
    // Check CORS
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
    }

    try {
        console.log("Broadcast Function Hit");
        // opportunity_id (opcional): quando presente, REAPROVEITA a oportunidade existente
        // (reagendamento de experimental com falta) em vez de criar uma nova.
        const { student_name, student_phone, date, time, interests, preferred_slots, opportunity_id } = await req.json();

        // VALIDATION: Date is now required (YYYY-MM-DD)
        if (!student_name || !date || !time) {
            throw new Error("Missing required fields (student_name, date, time).");
        }

        const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
        const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

        // Admin Client (Used for both AUTH VERIFICATION and DB ACCESS)
        const supabaseAdmin = createClient(supabaseUrl, supabaseKey);

        // 1. AUTH CHECK (Robust Mode)
        // Try 'x-user-token' first (Bypass Gateway Check Strategy)
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

        // 2. REAL LINK LOOKUP (Smart Linking V3 - Profile Priority)

        let activeInstanceName = null;

        // A. PRIMARY: Check 'profiles' table
        const { data: profile } = await supabaseAdmin
            .from('profiles')
            .select('whatsapp_instance, teachers_group_id, tenant_id') // Added tenant_id
            .eq('id', user.id)
            .single();

        if (profile?.whatsapp_instance) {
            console.log(`[Broadcast] ✅ Using Profile-Linked Instance: ${profile.whatsapp_instance}`);
            activeInstanceName = profile.whatsapp_instance;
        }

        // B. SECONDARY: Fallback to 'whatsapp_instances'
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

        // Final Decision
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

        // Date Logic (Backwards compatibility logic removed as we want strict date)
        // Convert YYYY-MM-DD to "27/01/2026 (Terça-feira)" approximately for display
        const dateObj = new Date(date + 'T' + time + ':00');
        const dayOfWeek = dateObj.getDay();
        const dayString = DAY_MAP[dayOfWeek] || "Dia";

        const formattedDate = date.split('-').reverse().join('/'); // 2026-01-27 -> 27/01/2026

        // 3. Create Opportunity
        // Note: slots_proposed is JSON. We can store detailed info or just basic day/time.
        // We will store the exact date in the slot for reference, though new system relies on URL params.
        const createdSlot = {
            day: dayOfWeek, // Legacy support
            time: time,
            date: date,
            formatted: `${formattedDate} (${dayString})`
        };

        let oppData: { id: string };

        if (opportunity_id) {
            // REAGENDAMENTO: reabre a MESMA oportunidade para ser reaceita
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
                })
                .select('id')
                .single();
            if (oppError) throw new Error("DB Error: " + oppError.message);
            oppData = inserted;
        }

        // 4. Construct URL with Params
        // http://localhost:3000/claim-opportunity?id=...&date=...&time=...
        const params = new URLSearchParams({
            id: oppData.id,
            date: date,
            time: time,
            studentName: student_name,
            studentPhone: student_phone || ''
        });

        const claimLink = `${BASE_URL}?${params.toString()}`;

        // 5. Message Destination (Dynamic Group -> Fallback)
        let destinationGroup = profile?.teachers_group_id;

        if (!destinationGroup) {
            console.warn(`[Broadcast] ⚠️ User ID ${user.id} has NO GROUP configured in 'profiles'. Falling back to DEFAULT.`);
            destinationGroup = GROUP_JID;
        } else {
            console.log(`[Broadcast] 🎯 Sending to Configured Group: ${destinationGroup}`);
        }

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

        const textMessage = `🐺⚡ *EXPERIMENTAL — ${formattedDate} (${dayString}) às ${time}*

📋 *Aluno:* ${student_name}
🎯 *Objetivo:* ${interests || 'Não informado'}${preferredSlotsText}

🏆 *Professor(a), essa aula é sua?*
O primeiro a clicar no link abaixo garante a aula experimental!

👇 *Aceitar agora:*
${claimLink}`;

        // 6. Send to Evolution
        const payload = {
            number: destinationGroup,
            text: textMessage
        };

        const instanceEncoded = encodeURIComponent(INSTANCE);
        const endpoint = `${API_URL}/message/sendText/${instanceEncoded}`;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);

        let response: Response;
        try {
            response = await fetch(endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json", "apikey": API_KEY },
                body: JSON.stringify(payload),
                signal: controller.signal
            });
        } catch (fetchErr: any) {
            clearTimeout(timeoutId);
            const isTimeout = fetchErr?.name === 'AbortError';
            console.error(isTimeout ? "Evolution API timeout after 15s" : "Evolution fetch error:", fetchErr?.message);
            return new Response(JSON.stringify({
                success: true,
                warning: isTimeout ? "WhatsApp API timeout — oportunidade criada mas mensagem pode não ter sido enviada." : fetchErr?.message,
                id: oppData.id,
                instance_used: INSTANCE,
                destination_group: destinationGroup
            }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        clearTimeout(timeoutId);

        const apiData = await response.json();

        if (!response.ok) {
            console.error("Evolution Error:", apiData);
            return new Response(JSON.stringify({
                success: true,
                warning: JSON.stringify(apiData),
                id: oppData.id,
                instance_used: INSTANCE,
                destination_group: destinationGroup // Debug info
            }), {
                headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
        }

        return new Response(
            JSON.stringify({
                success: true,
                id: oppData.id,
                instance_used: INSTANCE,
                destination_group: destinationGroup // Debug info
            }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );

    } catch (error: any) {
        console.error("Critical Error", error);
        return new Response(JSON.stringify({ error: error.message }), {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }
});
