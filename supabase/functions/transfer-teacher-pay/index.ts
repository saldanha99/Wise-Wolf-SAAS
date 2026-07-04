import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.7.1"

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
    // Handle CORS preflight request
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders })
    }

    try {
        const url = Deno.env.get('SUPABASE_URL') ?? '';
        const anon = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
        const supabaseClient = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')

        // 1. AUTORIZAÇÃO (v37): operação financeira crítica — só SCHOOL_ADMIN/SUPER_ADMIN.
        // O gateway (verify_jwt=true) já validou a assinatura do JWT; aqui conferimos o PAPEL.
        const authHeader = req.headers.get('Authorization') || '';
        const userClient = createClient(url, anon, { global: { headers: { Authorization: authHeader } } });
        const { data: authData } = await userClient.auth.getUser();
        if (!authData?.user) {
            return new Response(JSON.stringify({ success: false, error: 'Não autenticado.' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 401 });
        }
        const { data: me } = await supabaseClient.from('profiles').select('role').eq('id', authData.user.id).maybeSingle();
        if (!me || !['SCHOOL_ADMIN', 'SUPER_ADMIN'].includes(me.role)) {
            return new Response(JSON.stringify({ success: false, error: 'Sem permissão para disparar repasses.' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 403 });
        }

        const { closingId } = await req.json()

        if (!closingId) {
            throw new Error('Closing ID is required')
        }

        // 2. Fetch Closing and Teacher Data
        const { data: closing, error: closingError } = await supabaseClient
            .from('teacher_closings')
            .select(`
        *,
        teacher:teacher_id (
          id,
          full_name,
          pix_key,
          pix_key_type,
          nf_exempt
        )
      `)
            .eq('id', closingId)
            .single()

        if (closingError || !closing) {
            throw new Error('Closing not found')
        }

        // 2a. ANTI-DOUBLE-PAY (v37): qualquer evidência de pagamento anterior bloqueia.
        if (closing.asaas_transfer_id) {
            throw new Error('Este fechamento já tem uma transferência registrada (anti-pagamento-duplo).')
        }
        if (['PAID_WAITING_NF', 'UNDER_REVIEW', 'COMPLETED', 'PAGO'].includes(closing.status)) {
            throw new Error(`Este fechamento já está com status "${closing.status}" — pagamento bloqueado (anti-pagamento-duplo).`)
        }

        // 2b. TRAVA FISCAL configurável (v37): se o tenant exigir NF antes de novo repasse,
        // bloqueia quando o professor tem fechamento ANTERIOR pago sem NF válida.
        const { data: tenantCfg } = await supabaseClient
            .from('tenants')
            .select('require_nf_for_transfer')
            .eq('id', closing.tenant_id)
            .maybeSingle();
        if (tenantCfg?.require_nf_for_transfer && !closing.teacher?.nf_exempt) {
            const { data: pendentesNf } = await supabaseClient
                .from('teacher_closings')
                .select('id, month_year, status, nf_link, total_amount')
                .eq('teacher_id', closing.teacher_id)
                .neq('id', closingId)
                .in('status', ['PAID_WAITING_NF', 'REJECTED', 'REJEITADO'])
                .gt('total_amount', 0);
            const semNf = (pendentesNf || []).filter((c: any) => !c.nf_link);
            if (semNf.length > 0) {
                const meses = semNf.map((c: any) => c.month_year).join(', ');
                throw new Error(`Trava fiscal: o professor tem fechamento pago sem nota fiscal (${meses}). Peça a NF antes de liberar novo repasse.`)
            }
        }

        const teacher = closing.teacher;
        if (!teacher.pix_key || !teacher.pix_key_type) {
            throw new Error(`Teacher ${teacher.full_name} does not have a Pix key configured.`)
        }

        // 3. Sanitization
        const sanitizePixKey = (key: string, type: string) => {
            // Asaas clean up
            if (['CPF', 'CNPJ', 'PHONE'].includes(type) || type === 'TELEFONE') {
                return key.replace(/[^a-zA-Z0-9]/g, '')
            }
            return key.trim()
        }

        const sanitizedKey = sanitizePixKey(teacher.pix_key, teacher.pix_key_type);

        // 4. Call Asaas API
        const asaasUrl = Deno.env.get('ASAAS_API_URL')
        const asaasKey = Deno.env.get('ASAAS_API_KEY')

        if (!asaasUrl || !asaasKey) {
            throw new Error('Asaas configuration missing on server.')
        }

        // Asaas Transfer payload
        const transferPayload = {
            value: closing.total_amount,
            pixAddressKey: sanitizedKey,
            pixAddressKeyType: teacher.pix_key_type,
            description: `Pagamento Professor - ${teacher.full_name} - Ref: ${closing.month_year}`,
            operationType: 'PIX',
            scheduleDate: null // Instant
        }

        console.log('Sending transfer to Asaas:', { ...transferPayload, pixAddressKey: '***' })

        const asaasResponse = await fetch(`${asaasUrl}/transfers`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'access_token': asaasKey
            },
            body: JSON.stringify(transferPayload)
        })

        const asaasData = await asaasResponse.json()

        if (!asaasResponse.ok) {
            console.error('Asaas Error:', asaasData)
            // Extract error message from Asaas format
            const errorMsg = asaasData.errors?.[0]?.description || 'Unknown Asaas Error'
            throw new Error(`Asaas Transalfer Failed: ${errorMsg}`)
        }

        // 5. Update Database on Success
        const { error: updateError } = await supabaseClient
            .from('teacher_closings')
            .update({
                status: closing.teacher?.nf_exempt ? 'PAGO' : 'PAID_WAITING_NF',
                asaas_transfer_id: asaasData.id,
                transfer_status: asaasData.status,
                paid_at: new Date().toISOString(), // e.g. PENDING, BANK_PROCESSING, DONE
                updated_at: new Date().toISOString()
            })
            .eq('id', closingId)

        if (updateError) {
            // Critical: Transfer made but DB update failed. Log this!
            console.error('CRITICAL: Transfer successful but DB update failed', { closingId, transferId: asaasData.id })
            throw new Error('Transfer successful but failed to update local record.')
        }

        return new Response(
            JSON.stringify({ success: true, transfer: asaasData }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )

    } catch (error) {
        console.error('Edge Function Error:', error)
        return new Response(
            JSON.stringify({ success: false, error: error.message }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
        )
    }
})
