import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Configuration with Fallback
let ASAAS_URL = Deno.env.get('ASAAS_API_URL') || 'https://api-sandbox.asaas.com';

// Sanitize URL
ASAAS_URL = ASAAS_URL.replace(/\/+$/, "")
    .replace(/\/v3$/, "")
    .replace(/\/api\/v3$/, "")
    .replace(/\/api$/, "");

const ASAAS_API_KEY = Deno.env.get('ASAAS_API_KEY') || Deno.env.get('ASAAS_ACCESS_TOKEN');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS, PUT, DELETE',
}

serve(async (req) => {
    // 0. Handle CORS preflight
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders })
    }

    try {
        console.log(`[Subscription] Connecting to Asaas Base: ${ASAAS_URL}`);

        const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!)
        const body = await req.json().catch(e => {
            throw new Error("Invalid Request Body: Failed to parse JSON");
        });

        const { user_id, value, dueDay, billingType, planDuration, creditCard, creditCardHolderInfo } = body;

        if (!user_id || !value || !dueDay || !billingType) {
            return new Response(
                JSON.stringify({ success: false, error: 'Campos obrigatórios: user_id, value, dueDay, billingType' }),
                { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
            );
        }

        // 1. Fetch Profile
        const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('*') // Get all fields to fill holder info if needed
            .eq('id', user_id)
            .single();

        if (profileError || !profile) {
            throw new Error('Perfil do aluno não encontrado.');
        }

        if (!profile.asaas_customer_id) {
            throw new Error('Aluno não possui ID do Asaas. Sincronize o aluno primeiro.');
        }

        if (profile.subscription_id) {
            console.warn(`Student already has subscription: ${profile.subscription_id}`);
            throw new Error(`Aluno já possui uma assinatura ativa (ID: ${profile.subscription_id})`);
        }

        // 2. Calculate nextDueDate
        const today = new Date();
        let year = today.getFullYear();
        let month = today.getMonth(); // 0-11

        // If today > dueDay, ensure next payment is next month
        if (today.getDate() > dueDay) {
            month++;
        }

        const nextDueDateObj = new Date(year, month, dueDay);
        const nextDueDate = nextDueDateObj.toISOString().split('T')[0];

        let maxPayments = null;
        let planLabel = "Recorrente";

        if (planDuration === 'SEMESTER') {
            maxPayments = 6;
            planLabel = "Semestral (6 Meses)";
        } else if (planDuration === 'ANNUAL') {
            maxPayments = 12;
            planLabel = "Anual (12 Meses)";
        }

        // 3. Prepare Payload
        const payload: any = {
            customer: profile.asaas_customer_id,
            billingType: billingType,
            value: value,
            nextDueDate: nextDueDate,
            cycle: "MONTHLY",
            maxPayments: maxPayments,
            description: `Mensalidade Wise Wolf School - Plano ${planLabel}`
        };

        // 4. Handle Credit Card Specifics
        if (billingType === 'CREDIT_CARD') {
            if (!creditCard) throw new Error("Dados do cartão de crédito obrigatórios para este meio de pagamento.");

            payload.creditCard = {
                holderName: creditCard.holderName,
                number: creditCard.number,
                expiryMonth: creditCard.expiryMonth,
                expiryYear: creditCard.expiryYear,
                ccv: creditCard.ccv
            };

            // Parse Holder Info (Use passed info or Profile fallback)
            // Asaas requires: name, email, cpfCnpj, postalCode, addressNumber, phone
            const holderInfo = creditCardHolderInfo || {};

            payload.creditCardHolderInfo = {
                name: holderInfo.name || profile.full_name,
                email: holderInfo.email || profile.email,
                cpfCnpj: holderInfo.cpfCnpj || profile.cpf,
                postalCode: holderInfo.postalCode || profile.postal_code || '00000-000', // Fallback or Error? Asaas verifies this.
                addressNumber: holderInfo.addressNumber || profile.address_number || 'SN',
                phone: holderInfo.phone || profile.phone,
                mobilePhone: holderInfo.phone || profile.phone
            };

            // Validate essential holder fields
            if (!payload.creditCardHolderInfo.cpfCnpj) throw new Error("CPF do titular do cartão é obrigatório.");
            if (!payload.creditCardHolderInfo.phone) throw new Error("Telefone do titular do cartão é obrigatório.");
        }

        // 5. Send to Asaas
        let pathPrefix = '/api/v3';
        if (ASAAS_URL.includes('api-sandbox') || ASAAS_URL.includes('api.asaas.com')) {
            pathPrefix = '/v3';
        }

        const targetUrl = `${ASAAS_URL}${pathPrefix}/subscriptions`;
        console.log(`[Subscription] Creating at: ${targetUrl}`, { ...payload, creditCard: '***' });

        const asaasResponse = await fetch(targetUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'access_token': ASAAS_API_KEY!
            },
            body: JSON.stringify(payload)
        });

        let asaasData;
        const resText = await asaasResponse.text();
        try {
            asaasData = JSON.parse(resText);
        } catch (e) {
            throw new Error(`Erro Asaas (Status ${asaasResponse.status}): ${resText}`);
        }

        if (!asaasResponse.ok) {
            console.error("Erro Asaas:", asaasData);
            const errorMessage = asaasData.errors?.[0]?.description || "Erro ao processar pagamento.";

            // ROLLBACK: Delete auth user so they can try again
            if (user_id) {
                console.log(`[Rollback] Deleting user ${user_id} due to payment failure...`);
                const { error: deleteError } = await supabase.auth.admin.deleteUser(user_id);
                if (deleteError) {
                    console.error("[Rollback] Failed to delete user:", deleteError);
                } else {
                    console.log("[Rollback] User deleted successfully.");
                }
            }

            return new Response(
                JSON.stringify({ error: errorMessage }),
                {
                    status: 400,
                    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
                }
            );
        }

        const subscriptionId = asaasData.id;
        console.log("Subscription created:", subscriptionId);

        // 6. Update Supabase
        await supabase
            .from('profiles')
            .update({
                subscription_id: subscriptionId,
                monthly_fee: value,
                due_day: dueDay,
                status_financial: 'ACTIVE',
                modality: planDuration // Store plan duration if relevant, or separate field
            })
            .eq('id', user_id);

        return new Response(
            JSON.stringify({ success: true, subscription_id: subscriptionId }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
        )

    } catch (error: any) {
        console.error("Error in create-asaas-subscription:", error);
        return new Response(
            JSON.stringify({ success: false, error: error.message }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
        )
    }
})
