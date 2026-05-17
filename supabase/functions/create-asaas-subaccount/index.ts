import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const ASAAS_BASE = (Deno.env.get('ASAAS_BASE_URL') || 'https://api.asaas.com/v3').replace(/\/+$/, '');
const ASAAS_TOKEN = (Deno.env.get('ASAAS_ACCESS_TOKEN') || Deno.env.get('ASAAS_API_KEY') || '').trim();

/**
 * Provisiona subconta Asaas para um tenant.
 * Body: { tenantId, ownerName, ownerEmail, ownerCpfCnpj, ownerPhone, address, addressNumber, province, postalCode }
 * Asaas API: POST /accounts (cria subconta) → retorna { id, walletId, apiKey }
 */
serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

    try {
        if (!ASAAS_TOKEN) throw new Error('ASAAS_ACCESS_TOKEN not configured');

        const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
        const body = await req.json();
        const { tenantId, ownerName, ownerEmail, ownerCpfCnpj, ownerPhone, address, addressNumber, province, postalCode, splitPercentage } = body;

        if (!tenantId || !ownerName || !ownerEmail || !ownerCpfCnpj) {
            return new Response(JSON.stringify({ error: 'Dados incompletos' }), { status: 400, headers: corsHeaders });
        }

        // Verificar se ja existe
        const { data: existing } = await supabase.from('tenants').select('asaas_subaccount_id').eq('id', tenantId).single();
        if (existing?.asaas_subaccount_id) {
            return new Response(JSON.stringify({ error: 'Subconta ja existe', subaccount_id: existing.asaas_subaccount_id }), { status: 409, headers: corsHeaders });
        }

        // Criar subconta no Asaas
        const asaasRes = await fetch(`${ASAAS_BASE}/accounts`, {
            method: 'POST',
            headers: { 'access_token': ASAAS_TOKEN, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: ownerName,
                email: ownerEmail,
                cpfCnpj: ownerCpfCnpj.replace(/\D/g, ''),
                mobilePhone: ownerPhone?.replace(/\D/g, ''),
                address: address || 'A definir',
                addressNumber: addressNumber || 'SN',
                province: province || 'Centro',
                postalCode: postalCode?.replace(/\D/g, '') || '01000000',
            })
        });

        if (!asaasRes.ok) {
            const errBody = await asaasRes.text();
            console.error('Asaas error:', errBody);
            return new Response(JSON.stringify({ error: 'Falha ao criar subconta', detail: errBody }), { status: 500, headers: corsHeaders });
        }

        const asaasData = await asaasRes.json();

        // Persistir IDs no tenant
        await supabase.from('tenants').update({
            asaas_subaccount_id: asaasData.id,
            asaas_wallet_id: asaasData.walletId,
            asaas_api_key_encrypted: asaasData.apiKey, // TODO: criptografar com pgsodium em prod
            asaas_subaccount_status: 'APPROVED',
            asaas_split_percentage: splitPercentage ?? 90.0,
        }).eq('id', tenantId);

        return new Response(JSON.stringify({
            success: true,
            subaccount_id: asaasData.id,
            wallet_id: asaasData.walletId,
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
    }
});
