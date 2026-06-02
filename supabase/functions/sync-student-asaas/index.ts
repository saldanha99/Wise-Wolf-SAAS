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

const rawApiKey = Deno.env.get('ASAAS_API_KEY') || "";
const rawAccessToken = Deno.env.get('ASAAS_ACCESS_TOKEN') || "";
const API_KEY = rawApiKey.trim() || rawAccessToken.trim();
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
        const { user_id, name, email, cpf, phone, mobilePhone, postalCode, address, addressNumber,
            // Extended profile fields (from PublicRegistration enrollment)
            tenant_id, monthly_fee, due_day, class_frequency, professor_id, professor_id_2, classSchedule,
            contract_accepted, documentation_status, signature_ip,
            student_signature_url, signed_document_url, startDate,
            // Matrícula de dependente: cobrança no CPF do responsável financeiro (guardian)
            is_dependent, guardian_name, guardian_cpf, guardian_email, guardian_phone, guardian_id
        } = body;

        // Asaas requires 'mobilePhone'. We accept 'phone' or 'mobilePhone' from frontend.
        const rawPhone = mobilePhone || phone;

        const sanitizedCpf = cpf ? cpf.replace(/\D/g, '') : null;
        const sanitizedGuardianCpf = guardian_cpf ? guardian_cpf.replace(/\D/g, '') : null;
        const sanitizedPhone = rawPhone ? rawPhone.replace(/\D/g, '') : null;

        // CPF usado para a cobrança no Asaas (cpfCnpj do customer):
        // dependente cobra no CPF do responsável; aluno comum cobra no próprio CPF.
        const billingCpf = is_dependent ? sanitizedGuardianCpf : sanitizedCpf;

        if (!user_id) throw new Error('User ID is required');
        if (is_dependent && !sanitizedGuardianCpf) {
            return new Response(
                JSON.stringify({ success: false, error: "CPF do responsável é obrigatório para matrícula de dependente." }),
                { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
            );
        }

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
        // Dependente: NÃO reusa customer pelo CPF — o responsável já tem um customer
        // com este CPF. Forçamos a criação de um novo customer (o Asaas permite
        // múltiplos customers com o mesmo cpfCnpj) → assinatura distinta no mesmo CPF.
        if (billingCpf && !is_dependent) {
            const checkUrl = `${ASAAS_URL}${pathPrefix}/customers?cpfCnpj=${billingCpf}`;
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
                cpfCnpj: billingCpf,
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
            const profileUpdate: Record<string, any> = { asaas_customer_id: asaasCustomerId };

            // Dependente: grava dados do responsável financeiro e NÃO escreve profiles.cpf
            // (evita violar profiles_cpf_tenant_key, já que o CPF é o do responsável).
            if (is_dependent) {
                profileUpdate.guardian_cpf = sanitizedGuardianCpf;
                if (guardian_name) profileUpdate.guardian_name = guardian_name;
                if (guardian_email) profileUpdate.guardian_email = guardian_email;
                if (guardian_phone) profileUpdate.guardian_phone = guardian_phone.replace(/\D/g, '');
                if (guardian_id) profileUpdate.guardian_id = guardian_id;
            }

            // Add extended profile fields if provided (from enrollment flow)
            if (cpf && !is_dependent) profileUpdate.cpf = sanitizedCpf;
            if (phone || mobilePhone) profileUpdate.phone = sanitizedPhone;
            if (postalCode) profileUpdate.postal_code = postalCode;
            if (address) profileUpdate.address = address;
            if (addressNumber) profileUpdate.address_number = addressNumber;
            if (tenant_id) profileUpdate.tenant_id = tenant_id;
            if (monthly_fee) profileUpdate.monthly_fee = monthly_fee;
            if (due_day) profileUpdate.due_day = due_day;
            if (class_frequency) profileUpdate.class_frequency = class_frequency;
            if (professor_id) profileUpdate.professor_id = professor_id;
            if (name) profileUpdate.full_name = name;
            if (contract_accepted !== undefined) profileUpdate.contract_accepted = contract_accepted;
            if (documentation_status) profileUpdate.documentation_status = documentation_status;
            if (signature_ip) profileUpdate.signature_ip = signature_ip;
            if (student_signature_url) profileUpdate.student_signature_url = student_signature_url;
            if (signed_document_url) profileUpdate.signed_document_url = signed_document_url;
            if (contract_accepted) {
                profileUpdate.status_financial = 'PENDING';
                profileUpdate.accepted_at = new Date().toISOString();
                profileUpdate.role = 'STUDENT'; // Force role to STUDENT on enrollment
            }

            console.log(`[Sync] Updating profile with fields:`, Object.keys(profileUpdate));

            const { error: updateError } = await supabase
                .from('profiles')
                .update(profileUpdate)
                .eq('id', user_id);

            if (updateError) {
                console.error("[Sync] Failed to update profile:", updateError);
            }

            // Create bookings if classSchedule is provided
            if (classSchedule && Array.isArray(classSchedule) && classSchedule.length > 0 && professor_id) {
                const dayMap: Record<string, string> = {
                    'monday': 'Segunda', 'tuesday': 'Terça', 'wednesday': 'Quarta',
                    'thursday': 'Quinta', 'friday': 'Sexta', 'saturday': 'Sábado', 'sunday': 'Domingo'
                };

                const bookingsPayload = classSchedule.map((slot: any) => {
                    const rawDay = slot.weekday || slot.day || '';
                    const translatedDay = dayMap[String(rawDay).toLowerCase()] || rawDay;
                    
                    return {
                        tenant_id: tenant_id || 'school-wise-wolf',
                        teacher_id: professor_id,
                        student_id: user_id,
                        day_of_week: translatedDay,
                        time_slot: slot.time,
                        start_date: startDate || new Date().toISOString().split('T')[0]
                    };
                });

                console.log(`[Sync] Creating ${bookingsPayload.length} bookings`);
                const { error: bookingError } = await supabase.from('bookings').insert(bookingsPayload);
                if (bookingError) {
                    console.error("[Sync] Failed to create bookings:", bookingError);
                } else {
                    console.log(`[Sync] ✅ ${bookingsPayload.length} bookings created`);
                }
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
