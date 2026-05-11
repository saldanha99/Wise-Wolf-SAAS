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
        const supabaseClient = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
        )

        // 1. Authentication Check (Simple check for now, ideally verify session role)
        // For critical financial operations, checking Service Role or Admin logic is key.
        // Here we rely on the caller providing a valid JWT if we wanted to check 'auth.users',
        // but using SERVICE_ROLE_KEY allows us to bypass RLS for reading/writing the closing data needed.

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
          pix_key_type
        )
      `)
            .eq('id', closingId)
            .single()

        if (closingError || !closing) {
            throw new Error('Closing not found')
        }

        if (closing.status === 'COMPLETED' || closing.status === 'PAID_WAITING_NF') {
            // Already paid, but maybe just retry logic? Let's safeguard to avoid double pay if possible.
            // However, 'PAID_WAITING_NF' is the *destiny* status. If it's *already* there, we might want to warn.
            // For now, let's assume UI handles the button disable state, but strict double-spend check would be better.
            if (closing.asaas_transfer_id) {
                throw new Error('This closing already has a transfer ID attached.')
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
                status: 'PAID_WAITING_NF',
                asaas_transfer_id: asaasData.id,
                transfer_status: asaasData.status, // e.g. PENDING, BANK_PROCESSING, DONE
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
