import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const ASAAS_URL = (Deno.env.get('ASAAS_API_URL') || 'https://api.asaas.com').replace(/\/+$/, '').replace(/\/v3$/, '');
const ASAAS_TOKEN = (Deno.env.get('ASAAS_ACCESS_TOKEN') || Deno.env.get('ASAAS_API_KEY') || '').trim();

/**
 * Checkout SaaS: Cliente preenche dados da escola e contrata um plano.
 * 1. Cria saas_leads
 * 2. Cria customer no Asaas
 * 3. Cria subscription mensal/anual
 * 4. Cria tenant em TRIAL (14d) - upgrade automatico no webhook quando pagar
 * 5. Retorna invoice URL / pix code
 *
 * Body: { school_name, owner_name, owner_email, owner_cpf_cnpj, owner_phone,
 *         plan_id, billing_cycle: 'MONTHLY'|'YEARLY', billing_type: 'PIX'|'BOLETO'|'CREDIT_CARD',
 *         creditCard?, address?, addressNumber?, postalCode? }
 */
serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

    try {
        if (!ASAAS_TOKEN) throw new Error('ASAAS_ACCESS_TOKEN not configured');
        const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
        const body = await req.json();

        const {
            school_name, owner_name, owner_email, owner_cpf_cnpj, owner_phone,
            plan_id, billing_cycle, billing_type,
            creditCard, address, addressNumber, postalCode, province
        } = body;

        if (!school_name || !owner_name || !owner_email || !owner_cpf_cnpj || !plan_id) {
            return new Response(JSON.stringify({ error: 'Dados obrigatórios faltando' }), { status: 400, headers: corsHeaders });
        }

        // 1. Buscar plano
        const { data: plan, error: planErr } = await supabase.from('saas_plans').select('*').eq('id', plan_id).single();
        if (planErr || !plan) return new Response(JSON.stringify({ error: 'Plano inválido' }), { status: 400, headers: corsHeaders });

        const price = billing_cycle === 'YEARLY' ? Number(plan.price_yearly || plan.price * 12) : Number(plan.price);
        const cycle = billing_cycle === 'YEARLY' ? 'YEARLY' : 'MONTHLY';

        // 2. Criar saas_lead
        const { data: lead } = await supabase.from('saas_leads').insert({
            school_name, owner_name, owner_email,
            owner_phone: owner_phone?.replace(/\D/g, ''),
            owner_cpf_cnpj: owner_cpf_cnpj?.replace(/\D/g, ''),
            source: 'public_checkout',
            status: 'TRIAL',
            notes: `Plano: ${plan.name} · Ciclo: ${cycle}`,
        }).select('id').single();

        // 3. Criar customer Asaas
        const customerRes = await fetch(`${ASAAS_URL}/v3/customers`, {
            method: 'POST',
            headers: { 'access_token': ASAAS_TOKEN, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: school_name,
                email: owner_email,
                cpfCnpj: owner_cpf_cnpj.replace(/\D/g, ''),
                mobilePhone: owner_phone?.replace(/\D/g, ''),
                address: address || 'A definir',
                addressNumber: addressNumber || 'SN',
                province: province || 'Centro',
                postalCode: (postalCode || '01000000').replace(/\D/g, ''),
            })
        });
        if (!customerRes.ok) {
            const errText = await customerRes.text();
            return new Response(JSON.stringify({ error: 'Falha Asaas customer', detail: errText }), { status: 500, headers: corsHeaders });
        }
        const customer = await customerRes.json();

        // 4. Provisionar tenant TRIAL imediatamente (acesso garantido durante trial 14d)
        const tenantSlug = (school_name as string).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) + '-' + crypto.randomUUID().slice(0, 6);
        const tenantId = tenantSlug;
        await supabase.from('tenants').insert({
            id: tenantId,
            name: school_name,
            slug: tenantSlug,
            owner_email,
            owner_phone: owner_phone?.replace(/\D/g, ''),
            owner_cpf_cnpj: owner_cpf_cnpj?.replace(/\D/g, ''),
            saas_status: 'TRIAL',
            plan_id: plan.id,
            trial_ends_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
            branding: { primaryColor: '#7c3aed' },
            student_limit: plan.max_students,
            teacher_limit: plan.max_users,
        });

        // 5. Criar subscription Asaas
        const nextDue = new Date();
        nextDue.setDate(nextDue.getDate() + 1); // amanha (cobra durante o trial pra ja garantir o pagamento)

        const subPayload: any = {
            customer: customer.id,
            billingType: billing_type || 'PIX',
            value: price,
            nextDueDate: nextDue.toISOString().split('T')[0],
            cycle,
            description: `Assinatura Wise Wolf - Plano ${plan.name} (${cycle})`,
            externalReference: tenantId,
        };
        if (billing_type === 'CREDIT_CARD' && creditCard) {
            subPayload.creditCard = creditCard;
            subPayload.creditCardHolderInfo = {
                name: owner_name, email: owner_email,
                cpfCnpj: owner_cpf_cnpj.replace(/\D/g, ''),
                postalCode: (postalCode || '01000000').replace(/\D/g, ''),
                addressNumber: addressNumber || 'SN',
                phone: owner_phone?.replace(/\D/g, ''),
            };
        }

        const subRes = await fetch(`${ASAAS_URL}/v3/subscriptions`, {
            method: 'POST',
            headers: { 'access_token': ASAAS_TOKEN, 'Content-Type': 'application/json' },
            body: JSON.stringify(subPayload),
        });
        if (!subRes.ok) {
            const errText = await subRes.text();
            return new Response(JSON.stringify({ error: 'Falha Asaas subscription', detail: errText }), { status: 500, headers: corsHeaders });
        }
        const subscription = await subRes.json();

        // 6. Buscar primeira cobrança gerada
        const paymentsRes = await fetch(`${ASAAS_URL}/v3/subscriptions/${subscription.id}/payments`, {
            headers: { 'access_token': ASAAS_TOKEN }
        });
        const paymentsData = paymentsRes.ok ? await paymentsRes.json() : { data: [] };
        const firstPayment = paymentsData.data?.[0];

        // 7. Buscar pix QR se for PIX
        let pixData = null;
        if (firstPayment && billing_type === 'PIX') {
            const pixRes = await fetch(`${ASAAS_URL}/v3/payments/${firstPayment.id}/pixQrCode`, {
                headers: { 'access_token': ASAAS_TOKEN }
            });
            if (pixRes.ok) pixData = await pixRes.json();
        }

        // 8. Salvar invoice em saas_invoices
        if (firstPayment) {
            await supabase.from('saas_invoices').insert({
                tenant_id: tenantId,
                amount: price,
                status: 'PENDING',
                due_date: firstPayment.dueDate,
                asaas_payment_id: firstPayment.id,
                invoice_number: 'WW-' + new Date().toISOString().slice(0,7).replace('-','') + '-' + tenantId.slice(0,8),
                plan_snapshot: plan,
                billing_period_start: new Date().toISOString().split('T')[0],
                billing_period_end: new Date(Date.now() + 30*24*60*60*1000).toISOString().split('T')[0],
            });
        }

        return new Response(JSON.stringify({
            success: true,
            lead_id: lead?.id,
            tenant_id: tenantId,
            subscription_id: subscription.id,
            payment_id: firstPayment?.id,
            invoice_url: firstPayment?.invoiceUrl,
            bank_slip_url: firstPayment?.bankSlipUrl,
            pix: pixData ? { qr_code: pixData.encodedImage, copy_paste: pixData.payload } : null,
            trial_ends_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
            value: price,
            cycle,
            plan_name: plan.name,
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    } catch (err: any) {
        console.error('Checkout error:', err);
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
    }
});
