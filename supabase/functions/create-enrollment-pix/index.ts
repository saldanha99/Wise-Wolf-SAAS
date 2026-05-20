import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

let ASAAS_URL = Deno.env.get('ASAAS_API_URL') || 'https://api-sandbox.asaas.com';
ASAAS_URL = ASAAS_URL.replace(/\/+$/, "").replace(/\/v3$/, "").replace(/\/api\/v3$/, "").replace(/\/api$/, "");

const ASAAS_API_KEY = Deno.env.get('ASAAS_API_KEY') || Deno.env.get('ASAAS_ACCESS_TOKEN');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

    try {
        const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!)
        const body = await req.json();
        const { action, paymentId, amount, customerData } = body;

        // FIX: Suporte a verificação de status de pagamento (botão "Já realizei o pagamento")
        // Antes, este endpoint não tratava action='check' e sempre falhava com erro de validação.
        if (action === 'check' && paymentId) {
            let pathPrefix = '/api/v3';
            if (ASAAS_URL.includes('api-sandbox') || ASAAS_URL.includes('api.asaas.com')) {
                pathPrefix = '/v3';
            }
            const checkRes = await fetch(`${ASAAS_URL}${pathPrefix}/payments/${paymentId}`, {
                headers: { 'access_token': ASAAS_API_KEY! }
            });
            if (!checkRes.ok) {
                return new Response(
                    JSON.stringify({ success: false, status: 'PENDING', error: `Asaas retornou ${checkRes.status}` }),
                    { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
                );
            }
            const paymentStatus = await checkRes.json();
            console.log(`[EnrollmentPix] Check payment ${paymentId}: ${paymentStatus.status}`);
            return new Response(
                JSON.stringify({ success: true, status: paymentStatus.status, payment: paymentStatus }),
                { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
            );
        }

        if (!amount || !customerData) {
            throw new Error('Campos obrigatórios: amount, customerData');
        }

        // 1. Create or Find Customer in Asaas
        // (Assuming customerData has name, email, cpfCnpj)
        const customerSearchRes = await fetch(`${ASAAS_URL}/v3/customers?cpfCnpj=${customerData.cpfCnpj.replace(/\D/g, '')}`, {
            headers: { 'access_token': ASAAS_API_KEY! }
        });
        const customers = await customerSearchRes.json();
        let asaasCustomerId = customers.data?.[0]?.id;

        if (!asaasCustomerId) {
            const createCustomerRes = await fetch(`${ASAAS_URL}/v3/customers`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'access_token': ASAAS_API_KEY! },
                body: JSON.stringify({
                    name: customerData.name,
                    email: customerData.email,
                    cpfCnpj: customerData.cpfCnpj.replace(/\D/g, ''),
                    mobilePhone: customerData.phone,
                })
            });
            const newCustomer = await createCustomerRes.json();
            asaasCustomerId = newCustomer.id;
        }

        if (!asaasCustomerId) throw new Error('Não foi possível criar/encontrar cliente no Asaas.');

        // 2. Create One-time Payment (PIX)
        const paymentPayload = {
            customer: asaasCustomerId,
            billingType: 'PIX',
            value: amount,
            dueDate: new Date().toISOString().split('T')[0],
            description: `Taxa de Matrícula Wise Wolf School`,
            postalService: false
        };

        const paymentRes = await fetch(`${ASAAS_URL}/v3/payments`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'access_token': ASAAS_API_KEY! },
            body: JSON.stringify(paymentPayload)
        });

        const paymentData = await paymentRes.json();
        if (!paymentData.id) throw new Error(paymentData.errors?.[0]?.description || 'Erro ao criar cobrança.');

        // 3. Get PIX QR Code
        const qrCodeRes = await fetch(`${ASAAS_URL}/v3/payments/${paymentData.id}/pixQrCode`, {
            headers: { 'access_token': ASAAS_API_KEY! }
        });
        const qrCodeData = await qrCodeRes.json();

        return new Response(
            JSON.stringify({ 
                success: true, 
                paymentId: paymentData.id, 
                pixCode: qrCodeData.payload, 
                qrCode: qrCodeData.encodedImage 
            }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
        );

    } catch (error: any) {
        return new Response(
            JSON.stringify({ success: false, error: error.message }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
        );
    }
})
