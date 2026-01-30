import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Configuration with Fallback
let ASAAS_URL = Deno.env.get('ASAAS_API_URL') || 'https://api-sandbox.asaas.com';

// Sanitize URL: Remove trailing slash and version paths to get a clean base
// Examples we want to handle:
// https://sandbox.asaas.com/api/v3 -> https://sandbox.asaas.com
// https://api-sandbox.asaas.com/v3 -> https://api-sandbox.asaas.com
// https://api-sandbox.asaas.com -> https://api-sandbox.asaas.com
ASAAS_URL = ASAAS_URL.replace(/\/+$/, "")
    .replace(/\/v3$/, "")
    .replace(/\/api\/v3$/, "")
    .replace(/\/api$/, "");

const API_KEY = Deno.env.get('ASAAS_API_KEY') || Deno.env.get('ASAAS_ACCESS_TOKEN');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS, PUT, DELETE',
}

serve(async (req) => {
    // 0. Handle CORS preflight - Global Check
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders })
    }

    try {
        console.log(`[Sync] Connecting to Asaas Base: ${ASAAS_URL}`);

        if (!API_KEY) {
            throw new Error("Missing Asaas API Key (ASAAS_API_KEY or ASAAS_ACCESS_TOKEN)");
        }

        const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!)

        let body;
        try {
            body = await req.json();
        } catch (e) {
            console.error("[Sync] Failed to parse request body:", e);
            throw new Error("Invalid Request Body: Failed to parse JSON");
        }

        // 1. Smart Field Mapping & Sanitization
        const { user_id, name, email, cpf, phone, mobilePhone, postalCode, address, addressNumber } = body;

        // Asaas requires 'mobilePhone'. We accept 'phone' or 'mobilePhone' from frontend.
        const rawPhone = mobilePhone || phone;

        const sanitizedCpf = cpf ? cpf.replace(/\D/g, '') : null;
        const sanitizedPhone = rawPhone ? rawPhone.replace(/\D/g, '') : null;

        if (!user_id) throw new Error('User ID is required');

        // Validation limits
        if (!sanitizedPhone || !email) {
            console.error("[Sync] Validation Error:", { email, phone: sanitizedPhone });
            return new Response(
                JSON.stringify({
                    success: false,
                    error: "Telefone (Celular) e Email são obrigatórios."
                }),
                // Force 200 OK
                { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
            );
        }

        // Determine correct path prefix
        // api-sandbox.asaas.com uses /v3/customers
        // sandbox.asaas.com uses /api/v3/customers
        let pathPrefix = '/api/v3';
        if (ASAAS_URL.includes('api-sandbox') || ASAAS_URL.includes('api.asaas.com')) {
            pathPrefix = '/v3';
        }

        let asaasCustomerId: string | null = null;

        // 2. CHECK EXISTING (Proactive Recovery)
        if (sanitizedCpf) {
            const checkUrl = `${ASAAS_URL}${pathPrefix}/customers?cpfCnpj=${sanitizedCpf}`;
            console.log(`[Sync] Checking existence by CPF at: ${checkUrl}`);
            const searchRes = await fetch(checkUrl, {
                method: 'GET',
                headers: { 'access_token': API_KEY }
            });

            if (searchRes.ok) {
                const searchData = await searchRes.json();
                if (searchData.data && searchData.data.length > 0) {
                    asaasCustomerId = searchData.data[0].id;
                    console.log(`[Sync] Found existing customer: ${asaasCustomerId}`);
                }
            } else {
                console.warn(`[Sync] Failed to check existence: ${searchRes.status} ${searchRes.statusText}`);
            }
        }

        // 3. CREATE IF NOT FOUND
        if (!asaasCustomerId) {
            const payload = {
                name: name || 'Aluno sem nome',
                cpfCnpj: sanitizedCpf,
                email: email,
                mobilePhone: sanitizedPhone, // Explicitly mapped
                externalReference: user_id,
                notificationDisabled: false,
                postalCode: postalCode,
                address: address,
                addressNumber: addressNumber
            };

            const targetUrl = `${ASAAS_URL}${pathPrefix}/customers`;
            console.log(`[Sync] Creating new customer at: ${targetUrl}`, payload);

            const createRes = await fetch(targetUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'access_token': API_KEY
                },
                body: JSON.stringify(payload)
            });

            // Safe parsing of Asaas response
            let createData;
            const createResText = await createRes.text();
            try {
                createData = JSON.parse(createResText);
            } catch (e) {
                console.error("[Sync] Non-JSON response from Asaas:", createResText);
                throw new Error(`Erro na comunicação com Asaas (Status ${createRes.status}) na URL: ${targetUrl}. Detalhes: ${createResText}`);
            }

            if (createRes.ok && createData.id) {
                asaasCustomerId = createData.id;
                console.log(`[Sync] Customer created: ${asaasCustomerId}`);
            } else {
                console.error("[Sync] Asaas Creation Failed:", createData);

                // CRITICAL: Return explicit error as 200 OK (Soft Error)
                const firstError = createData.errors?.[0];
                const errorMessage = firstError?.description || "Erro desconhecido ao cadastrar no Asaas.";

                return new Response(
                    JSON.stringify({
                        success: false,
                        error: errorMessage,
                        asaasErrors: createData.errors || []
                    }),
                    // Force 200 OK
                    { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
                );
            }
        }

        // 4. UPDATE LOCAL DATABASE
        if (asaasCustomerId) {
            const { error: updateError } = await supabase
                .from('profiles')
                .update({ asaas_customer_id: asaasCustomerId })
                .eq('id', user_id);

            if (updateError) {
                console.error("[Sync] Failed to update profile:", updateError);
            }

            return new Response(
                JSON.stringify({ success: true, asaas_customer_id: asaasCustomerId }),
                { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
            );
        }

        // Fallback error - Force 200 OK
        return new Response(
            JSON.stringify({ success: false, error: "Falha interna: ID do Asaas não obtido." }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
        );

    } catch (error: any) {
        // --- GLOBAL EXCEPTION HANDLER ---
        console.error("[Sync] GLOBAL ERROR:", error);

        // Force 200 OK with success: false (Soft Error) to bypass client strictness
        return new Response(
            JSON.stringify({
                success: false,
                error: `Erro Interno: ${error.message || 'Desconhecido'}`
            }),
            {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                // CRITICAL: Status 200 to prevent browser/client throwing "Bad Request" and hiding the body
                status: 200
            }
        )
    }
})
