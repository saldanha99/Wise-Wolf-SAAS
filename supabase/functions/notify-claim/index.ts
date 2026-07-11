import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-user-token',
}

const DEFAULT_API_URL = "https://api.2b.app.br";
const DEFAULT_API_KEY = "8828462c98512411df3acfe3df4e48a1";

// META CAPI — mede evento "Schedule" (aula experimental confirmada) server-side.
// FB_CAPI_TOKEN ainda não configurado → no-op silencioso até o secret existir.
const FB_PIXEL_ID = "1475651934149356";
const FB_CAPI_TOKEN = (Deno.env.get("FB_CAPI_TOKEN") || "").trim();
async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input.trim().toLowerCase()));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function sendMetaCapiEvent(opts: { eventName: string; phone?: string | null }): Promise<void> {
  if (!FB_CAPI_TOKEN) return;
  try {
    const userData: Record<string, unknown> = {};
    if (opts.phone) {
      const digits = opts.phone.replace(/\D/g, "");
      userData.ph = [await sha256Hex(digits.startsWith("55") ? digits : `55${digits}`)];
    }
    const body = {
      data: [{
        event_name: opts.eventName,
        event_time: Math.floor(Date.now() / 1000),
        action_source: "system_generated",
        event_source_url: "https://system.wisewolflanguage.com.br",
        user_data: userData,
      }],
    };
    await fetch(`https://graph.facebook.com/v20.0/${FB_PIXEL_ID}/events?access_token=${FB_CAPI_TOKEN}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
    }).catch(() => {});
  } catch { /* CAPI nunca pode quebrar o fluxo principal */ }
}

serve(async (req) => {
    // Handle CORS
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders })
    }

    try {
        // 1. CLIENTE SUPABASE ADMIN (Bypass RLS)
        const supabaseAdmin = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
            {
                auth: {
                    autoRefreshToken: false,
                    persistSession: false
                }
            }
        )

        // 2. INPUTS
        const { professorName, studentName, dateFormatted, directorGroupId, opportunityId } = await req.json()

        if (!opportunityId) {
            return new Response(
                JSON.stringify({ error: 'Missing opportunityId' }),
                { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
            )
        }

        // 3. BUSCA DO DONO (User ID) + FALTA DO TENANT (Fallback)
        // Buscamos user_id E tenant_id
        const { data: opp, error: oppError } = await supabaseAdmin
            .from('opportunities')
            .select('user_id, tenant_id, student_phone')
            .eq('id', opportunityId)
            .single();

        if (oppError || !opp) {
            throw new Error(`Erro ao buscar Opportunity: ${oppError?.message || 'Not found'}`);
        }

        const ownerId = opp.user_id;
        const tenantId = opp.tenant_id;

        // Aula experimental confirmada — dispara o evento de conversão.
        if (opp.student_phone) sendMetaCapiEvent({ eventName: 'Schedule', phone: opp.student_phone });

        // 4. ESTRATEGIA HIBRIDA DE BUSCA DE INSTÂNCIA
        let senderInstanceName = null;
        let foundOwner = false;

        // TENTATIVA 1: O Dono da vaga tem WhatsApp?
        if (ownerId) {
            const { data: ownerInstance } = await supabaseAdmin
                .from('whatsapp_instances')
                .select('instance_name')
                .eq('user_id', ownerId)
                .in('status', ['connected', 'open']) // Aceita open também
                .order('updated_at', { ascending: false })
                .limit(1)
                .single();

            if (ownerInstance) {
                senderInstanceName = ownerInstance.instance_name;
                foundOwner = true;
                console.log(`[Notify] Found owner instance: ${senderInstanceName}`);
            }
        }

        // TENTATIVA 2: Se falhou e temos tenant_id, busque ALGUÉM do tenant
        if (!senderInstanceName && tenantId) {
            console.log(`[Notify] Owner disconnected. Fallback to Tenant ${tenantId} search...`);

            // Busca instâncias de QUALQUER Admin deste tenant
            const { data: tenantInstances } = await supabaseAdmin
                .from('whatsapp_instances')
                .select(`
                    instance_name, 
                    user:profiles!inner (
                        tenant_id, 
                        role
                    )
                `)
                .eq('user.tenant_id', tenantId)
                .eq('user.role', 'SCHOOL_ADMIN')
                .in('status', ['connected', 'open'])
                .order('updated_at', { ascending: false })
                .limit(1);

            if (tenantInstances && tenantInstances.length > 0) {
                senderInstanceName = tenantInstances[0].instance_name;
                console.log(`[Notify] Found fallback tenant instance: ${senderInstanceName}`);
            }
        }

        // 5. VALIDAÇÃO FINAL
        if (!senderInstanceName) {
            console.log(`[Notify] No instance found for User ${ownerId} OR Tenant ${tenantId}.`);
            return new Response(
                JSON.stringify({ error: `Nenhuma instância de WhatsApp encontrada. O dono (${ownerId}) e a escola estão desconectados.` }),
                { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
            )
        }

        // 6. ENVIO (Evolution API)
        const messageText = `🔔 *AULA EXPERIMENTAL ACEITA!*

👨🏫 *Professor:* ${professorName}
🎓 *Aluno:* ${studentName}
📅 *Data:* ${dateFormatted}

🚀 *Status:* Agendado e Confirmado!`;

        const apiUrl = Deno.env.get('EVOLUTION_API_URL') || DEFAULT_API_URL;
        const apiKey = Deno.env.get('EVOLUTION_API_KEY') || DEFAULT_API_KEY;

        const response = await fetch(`${apiUrl}/message/sendText/${senderInstanceName}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'apikey': apiKey
            },
            body: JSON.stringify({
                number: directorGroupId, // Grupo recebido do front (ou poderia buscar do profile)
                text: messageText,
                linkPreview: false
            })
        });

        const result = await response.json();

        if (!response.ok) {
            return new Response(
                JSON.stringify({ error: 'Failed to send message via Evolution API', details: result }),
                { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 502 }
            )
        }

        return new Response(
            JSON.stringify({ success: true, data: result }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
        )

    } catch (err: any) {
        return new Response(
            JSON.stringify({ error: err.message }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
        )
    }
})
