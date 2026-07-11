import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

let ASAAS_URL = Deno.env.get('ASAAS_API_URL') || 'https://api-sandbox.asaas.com';
ASAAS_URL = ASAAS_URL.replace(/\/+$/, "").replace(/\/v3$/, "").replace(/\/api\/v3$/, "").replace(/\/api$/, "");
const ASAAS_API_KEY = Deno.env.get('ASAAS_API_KEY') || Deno.env.get('ASAAS_ACCESS_TOKEN');

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

    const pathPrefix = (ASAAS_URL.includes('api-sandbox') || ASAAS_URL.includes('api.asaas.com')) ? '/v3' : '/api/v3';
    const body = await req.json();
    const { action, subscriptionId, maxPayments } = body;

    if (action === 'get') {
        const res = await fetch(`${ASAAS_URL}${pathPrefix}/subscriptions/${subscriptionId}`, {
            headers: { 'access_token': ASAAS_API_KEY! }
        });
        const data = await res.json();
        return new Response(JSON.stringify(data), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (action === 'update') {
        const res = await fetch(`${ASAAS_URL}${pathPrefix}/subscriptions/${subscriptionId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'access_token': ASAAS_API_KEY! },
            body: JSON.stringify({ maxPayments })
        });
        const data = await res.json();
        return new Response(JSON.stringify(data), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ error: 'action invalida' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
})
