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

        const { user_id, customer, value, dueDay, billingType, planDuration, creditCard, creditCardHolderInfo, startDate, proRata, proRataValue } = body;

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

        const asaasCustomerId = customer || profile?.asaas_customer_id;

        if (!asaasCustomerId) {
            throw new Error('Aluno não possui ID do Asaas. Sincronize o aluno primeiro.');
        }

        // FIX: Idempotência — se o aluno já tem subscription_id, retorna sucesso em vez de travar
        // Isso evita bloqueio em casos de tentativa anterior com falha parcial (assinatura criada
        // no Asaas mas perfil não foi atualizado, ou o aluno tenta de novo).
        if (profile.subscription_id) {
            console.warn(`[Subscription] Aluno já tem assinatura: ${profile.subscription_id} — retornando idempotente`);
            return new Response(
                JSON.stringify({ success: true, subscription_id: profile.subscription_id, id: profile.subscription_id }),
                { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
            );
        }

        // 2. Calculate nextDueDate
        let nextDueDate: string;

        if (startDate) {
            // Use explicit billing start date (pro-rata or deferred billing)
            const [startYear, startMonth] = startDate.split('-').map(Number);
            const dueDateObj = new Date(startYear, startMonth - 1, dueDay);
            nextDueDate = dueDateObj.toISOString().split('T')[0];
        } else {
            const today = new Date();
            let year = today.getFullYear();
            let month = today.getMonth(); // 0-11

            // If today >= dueDay, ensure next payment is next month
            if (today.getDate() >= dueDay) {
                month++;
            }

            const nextDueDateObj = new Date(year, month, dueDay);
            nextDueDate = nextDueDateObj.toISOString().split('T')[0];
        }

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
            customer: asaasCustomerId,
            billingType: billingType,
            value: value,
            nextDueDate: nextDueDate,
            cycle: "MONTHLY",
            maxPayments: maxPayments,
            description: `Mensalidade Wise Wolf School - Plano ${planLabel}`
        };

        // 3.1 Asaas Split: se o tenant tiver wallet, configurar split
        // (a maior parte vai para a escola; plataforma fica com o complemento)
        try {
            const { data: tenant } = await supabase  // FIX: era supabaseAdmin (variável não definida)
                .from('tenants')
                .select('asaas_wallet_id, asaas_split_percentage')
                .eq('id', profile.tenant_id)
                .single();
            if (tenant?.asaas_wallet_id) {
                payload.split = [{
                    walletId: tenant.asaas_wallet_id,
                    percentualValue: tenant.asaas_split_percentage ?? 90.0,
                }];
            }
        } catch (splitErr) {
            console.warn('[asaas split] tenant sem subconta, cobrando direto p/ plataforma:', splitErr);
        }

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

        // 4.5 Create pro-rata one-time charge if requested
        let proRataChargeId: string | null = null;
        if (proRata && proRataValue && proRataValue > 0) {
            try {
                let pathPrefixProRata = '/api/v3';
                if (ASAAS_URL.includes('api-sandbox') || ASAAS_URL.includes('api.asaas.com')) {
                    pathPrefixProRata = '/v3';
                }

                const today = new Date();
                const proRataDueDate = today.toISOString().split('T')[0];

                const proRataPayload: any = {
                    customer: asaasCustomerId,
                    billingType: billingType === 'CREDIT_CARD' ? 'CREDIT_CARD' : 'PIX',
                    value: proRataValue,
                    dueDate: proRataDueDate,
                    description: `Pro-Rata - Wise Wolf School (${proRataValue.toFixed(2)} ref. dias restantes do mês)`,
                };

                if (billingType === 'CREDIT_CARD' && payload.creditCard) {
                    proRataPayload.creditCard = payload.creditCard;
                    proRataPayload.creditCardHolderInfo = payload.creditCardHolderInfo;
                }

                const proRataRes = await fetch(`${ASAAS_URL}${pathPrefixProRata}/payments`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'access_token': ASAAS_API_KEY! },
                    body: JSON.stringify(proRataPayload),
                });

                if (proRataRes.ok) {
                    const proRataData = await proRataRes.json();
                    proRataChargeId = proRataData.id;
                    console.log(`[Subscription] Pro-rata charge created: ${proRataChargeId}`);
                } else {
                    console.warn('[Subscription] Pro-rata charge failed (non-blocking):', await proRataRes.text());
                }
            } catch (proRataErr: any) {
                console.error('[Subscription] Pro-rata error (non-blocking):', proRataErr.message);
            }
        }

        // 5. Build Asaas Payload including Remote IP
        let pathPrefix = '/api/v3';
        if (ASAAS_URL.includes('api-sandbox') || ASAAS_URL.includes('api.asaas.com')) {
            pathPrefix = '/v3';
        }

        // Pass actual user IP for Asaas Anti-Fraud (otherwise it sees Supabase Cloud IP and blocks cards)
        const clientIp = req.headers.get('x-forwarded-for') || '127.0.0.1';
        payload.remoteIp = clientIp.split(',')[0].trim();

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

            // FIX: Removido rollback automático que deletava usuários pré-existentes.
            // Antes, qualquer falha no Asaas deletava o usuário da auth — se o aluno já tinha
            // conta (fluxo de recuperação por login), sua conta era deletada. Catastrófico.
            // O erro é exibido ao aluno que pode corrigir os dados e tentar novamente.
            console.warn(`[Subscription] Falha Asaas para user ${user_id}: ${errorMessage} — sem rollback para preservar conta`);

            return new Response(
                JSON.stringify({
                    success: false,
                    error: errorMessage,
                    asaasErrors: asaasData.errors || []
                }),
                {
                    status: 200,
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
                modality: planDuration
            })
            .eq('id', user_id);

        // 7. Enable WhatsApp notifications for customer
        try {
            const notifUrl = `${ASAAS_URL}${pathPrefix}/customers/${asaasCustomerId}/notifications`;
            console.log(`[Subscription] Fetching notifications: ${notifUrl}`);

            const notifRes = await fetch(notifUrl, {
                method: 'GET',
                headers: { 'access_token': ASAAS_API_KEY! }
            });

            if (notifRes.ok) {
                const notifData = await notifRes.json();
                const notifications = notifData.data || notifData || [];

                for (const notif of notifications) {
                    if (notif.id && !notif.whatsappEnabledForCustomer) {
                        const updateUrl = `${ASAAS_URL}${pathPrefix}/notifications/${notif.id}`;
                        await fetch(updateUrl, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'access_token': ASAAS_API_KEY!
                            },
                            body: JSON.stringify({
                                enabled: true,
                                emailEnabledForCustomer: true,
                                smsEnabledForCustomer: true,
                                whatsappEnabledForCustomer: true
                            })
                        });
                    }
                }
                console.log(`[Subscription] WhatsApp notifications enabled for ${notifications.length} events`);
            } else {
                console.warn('[Subscription] Could not fetch notifications:', notifRes.status);
            }
        } catch (notifErr: any) {
            console.error('[Subscription] WhatsApp notification setup error (non-blocking):', notifErr.message);
        }

        return new Response(
            JSON.stringify({ success: true, subscription_id: subscriptionId, pro_rata_charge_id: proRataChargeId }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
        )

    } catch (error: any) {
        console.error("Error in create-asaas-subscription:", error);
        return new Response(
            JSON.stringify({ success: false, error: error.message }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
        )
    }
})
