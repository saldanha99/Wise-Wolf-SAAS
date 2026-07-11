import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// EdgeRuntime é injetado pelo runtime do Supabase (não tem tipagem nos types padrão)
declare const EdgeRuntime: { waitUntil: (promise: Promise<unknown>) => void } | undefined;

// Environment Variables
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
const ASAAS_ACCESS_TOKEN = (Deno.env.get('ASAAS_ACCESS_TOKEN') || Deno.env.get('ASAAS_API_KEY') || '').trim();
const ASAAS_WEBHOOK_TOKEN = (Deno.env.get('ASAAS_WEBHOOK_TOKEN') || '').trim();
// Chave via env (rotação sem redeploy) com fallback na chave atual — mesma estratégia das demais.
const EVOLUTION_API_KEYS = Array.from(new Set([
    (Deno.env.get('EVOLUTION_API_KEY') || '').trim(),
    '8828462c98512411df3acfe3df4e48a1',
].filter(Boolean)));

// META CAPI — mede o evento "Purchase" (matrícula paga) server-side. FB_CAPI_TOKEN ainda não
// configurado → no-op silencioso até o secret existir.
const FB_PIXEL_ID = "1475651934149356";
const FB_CAPI_TOKEN = (Deno.env.get("FB_CAPI_TOKEN") || "").trim();
async function sha256Hex(input: string): Promise<string> {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input.trim().toLowerCase()));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function sendMetaCapiEvent(opts: { eventName: string; phone?: string | null; value?: number; currency?: string }): Promise<void> {
    if (!FB_CAPI_TOKEN) return;
    try {
        const userData: Record<string, unknown> = {};
        if (opts.phone) {
            const digits = opts.phone.replace(/\D/g, "");
            userData.ph = [await sha256Hex(digits.startsWith("55") ? digits : `55${digits}`)];
        }
        const body = {
            data: [{
                event_name: opts.eventName,
                event_time: Math.floor(Date.now() / 1000),
                action_source: "system_generated",
                event_source_url: "https://system.wisewolflanguage.com.br",
                user_data: userData,
                ...(opts.value ? { custom_data: { value: opts.value, currency: opts.currency || "BRL" } } : {}),
            }],
        };
        await fetch(`https://graph.facebook.com/v20.0/${FB_PIXEL_ID}/events?access_token=${FB_CAPI_TOKEN}`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
        }).catch(() => {});
    } catch { /* CAPI nunca pode quebrar o fluxo principal */ }
}

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, asaas-access-token',
}

// fetch com timeout (AbortController) — impede que uma API externa lenta
// (ASAAS ou Evolution) pendure o processamento por dezenas de segundos.
async function fetchComTimeout(url: string, init: RequestInit = {}, timeoutMs = 8000): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        return await fetch(url, { ...init, signal: ctrl.signal });
    } finally {
        clearTimeout(timer);
    }
}

// Processa o evento do ASAAS. Roda em BACKGROUND (EdgeRuntime.waitUntil),
// depois que o webhook já respondeu 200 — então NUNCA lança erro pro ASAAS,
// apenas registra nos logs.
async function processarPagamento(body: any): Promise<void> {
    try {
        const { event, payment } = body;

        if (!event || !payment) {
            console.warn("[Webhook] Ignorado: faltou event ou payment.", body);
            return;
        }

        console.log(`🔔 WEBHOOK EVENT: ${event} | Payment ID: ${payment.id} | Status: ${payment.status} | Value: ${payment.value}`);
        console.log("Checking Tokens... Asaas Token Configured:", !!ASAAS_ACCESS_TOKEN);

        const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!)

        /*
          STRATEGY:
          1. Try to find the student (Profile) via externalReference (our ID) or customer (Asaas ID).
          2. Update/Insert the Payment in 'student_payments'.
          3. Update the Profile/Subscription status if necessary.
        */

        // 1. Find Student
        let studentId = null;
        // Basic UUID validation
        const isValidUUID = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

        if (payment.externalReference && isValidUUID(payment.externalReference)) {
            studentId = payment.externalReference;
        } else if (payment.externalReference) {
            console.warn(`⚠️ Invalid UUID in externalReference: '${payment.externalReference}'. Ignoring to prevent error.`);
        }

        // If no external ref, lookup by Asaas Customer ID
        if (!studentId) {
            const { data: profile } = await supabase
                .from('profiles')
                .select('id')
                .eq('asaas_customer_id', payment.customer)
                .single();

            if (profile) {
                studentId = profile.id;
                console.log(`✅ Student Identified via Customer ID: ${studentId}`);
            } else {
                console.warn(`⚠️ Student NOT found for Customer ID: ${payment.customer}. Trying fallback by Email...`);

                // Fallback: Fetch Customer from Asaas to get Email
                if (ASAAS_ACCESS_TOKEN) {
                    try {
                        const asaasRes = await fetchComTimeout(`https://api.asaas.com/v3/customers/${payment.customer}`, {
                            headers: { 'access_token': ASAAS_ACCESS_TOKEN }
                        });

                        if (asaasRes.ok) {
                            const asaasCustomer = await asaasRes.json();
                            if (asaasCustomer.email) {
                                console.log(`🔍 Looking for student with email: ${asaasCustomer.email}`);
                                // IMPORTANT: 'profiles' must have 'email' column (added via migration)
                                const { data: profileByEmail } = await supabase.from('profiles').select('id').eq('email', asaasCustomer.email).single();

                                if (profileByEmail) {
                                    studentId = profileByEmail.id;
                                    console.log(`✅ Student Identified via Email Fallback: ${studentId}`);

                                    // Sync ID for future
                                    await supabase.from('profiles').update({ asaas_customer_id: payment.customer }).eq('id', studentId);
                                } else {
                                    console.warn(`❌ No profile found with email: ${asaasCustomer.email}`);
                                }
                            }
                        } else {
                            console.error('❌ Failed to fetch Asaas Customer:', await asaasRes.text());
                        }
                    } catch (errFallback) {
                        console.error('❌ Error in Email Fallback:', errFallback);
                    }
                } else {
                    console.warn('⚠️ ASAAS_ACCESS_TOKEN not configured. Skipping email fallback.');
                }

                if (!studentId) {
                    console.warn(`⚠️ Final: Student could not be identified.`);
                }
            }
        } else {
            console.log(`✅ Student Identified via External Ref: ${studentId}`);
        }

        // 2. Process Events

        // Allow 'PAYMENT_UPDATED' to re-process and potentially link the student if missing
        if (event === 'PAYMENT_RECEIVED' || event === 'PAYMENT_CONFIRMED' || event === 'PAYMENT_UPDATED') {
            console.log(`Processing Payment Event: ${event}`);

            // Check existing payment status to prevent duplicate WhatsApp sends (Idempotency check)
            const { data: existingPayment } = await supabase
                .from('student_payments')
                .select('status')
                .eq('asaas_payment_id', payment.id)
                .maybeSingle();

            const isAlreadyPaid = existingPayment && ['CONFIRMED', 'RECEIVED', 'PAGO', 'PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED'].includes(existingPayment.status);

            // A. Update Payment Record
            // We use upsert to ensure we create it if it was missed during creation
            const desc = (payment.description || '').toLowerCase();
            let paymentType = 'SUBSCRIPTION';
            if (desc.includes('matrícula') || desc.includes('matricula')) paymentType = 'ENROLLMENT';
            else if (desc.includes('pro-rata') || desc.includes('proporcional')) paymentType = 'PRO_RATA';
            else if (desc.includes('reembolso') || desc.includes('refund')) paymentType = 'REFUND';

            const paymentData: any = {
                asaas_payment_id: payment.id,
                value: payment.value,
                status: payment.status, // CONFIRMED or RECEIVED
                due_date: payment.dueDate,
                payment_date: payment.paymentDate || new Date().toISOString(), // Critical for Revenue Calc
                billing_type: payment.billingType,
                invoice_url: payment.bankSlipUrl || payment.invoiceUrl,
                description: payment.description || 'Mensalidade Wise Wolf',
                payment_type: paymentType,
                updated_at: new Date().toISOString()
            };

            // CRITICAL FIX: Only set student_id if it is defined.
            // DO NOT OVERWRITE EXISTING STUDENT_ID WITH NULL.
            if (studentId) {
                paymentData.student_id = studentId;

                // FIX: Fetch tenant_id from profile to link payment to school
                const { data: profileT } = await supabase
                    .from('profiles')
                    .select('tenant_id')
                    .eq('id', studentId)
                    .single();

                if (profileT && profileT.tenant_id) {
                    paymentData.tenant_id = profileT.tenant_id;
                } else {
                    // Fallback default
                    paymentData.tenant_id = 'school-wise-wolf';
                }
            }

            const { data: payData, error: payError } = await supabase
                .from('student_payments')
                .upsert(paymentData, { onConflict: 'asaas_payment_id' })
                .select();

            if (payError) {
                console.error('❌ Error updating student_payments:', payError);
                // Roda em background: apenas registra, não relança (o ASAAS já recebeu 200).
                return;
            } else {
                console.log('✅ Payment Record Updated:', payData?.[0]?.id);
            }

            // B. Update Subscription / Profile Status & Check for Welcome Message
            if (studentId) {
                // Fetch Profile Data needed for Welcome Logic & Cash Flow
                const { data: profileData, error: profileFetchErr } = await supabase
                    .from('profiles')
                    .select('tenant_id, contract_accepted, welcome_sent_at, phone, full_name, signed_document_url, class_frequency')
                    .eq('id', studentId)
                    .single();

                if (profileFetchErr) console.error('❌ Error fetching Profile data:', profileFetchErr);

                // Update Status to ACTIVE
                const { error: profileError } = await supabase
                    .from('profiles')
                    .update({ status_financial: 'ACTIVE' })
                    .eq('id', studentId);

                if (profileError) console.error('❌ Error updating Profile status:', profileError);
                else console.log('✅ Profile Financial Status set to ACTIVE');

                // --- CONFIRMAÇÃO DE PAGAMENTO VIA WHATSAPP ---
                // Envia APENAS uma mensagem simples de confirmação, SEM links.
                // A mensagem de Bem-vindo ao Império é disparada SOMENTE no fluxo de matrícula (PublicRegistration), NUNCA aqui.
                if (profileData && profileData.phone && (event === 'PAYMENT_CONFIRMED' || event === 'PAYMENT_RECEIVED')) {
                    if (isAlreadyPaid) {
                        console.log(`ℹ️ [Webhook] Payment confirmation WhatsApp skipped (already paid): ${payment.id}`);
                    } else {
                        // Primeira confirmação real deste pagamento — dispara o evento de conversão.
                        sendMetaCapiEvent({ eventName: 'Purchase', phone: profileData.phone, value: Number(payment.value) || undefined });
                        try {
                            const studentName = profileData.full_name?.split(' ')[0] || 'Aluno';
                            const studentPhone = profileData.phone;
                            let cleanPhone = studentPhone.replace(/\D/g, "");
                            if (cleanPhone.length === 10 || cleanPhone.length === 11) {
                                cleanPhone = "55" + cleanPhone;
                            }

                            const valorFormatado = payment.value
                                ? `R$ ${Number(payment.value).toFixed(2).replace('.', ',')}`
                                : '';
                            const confirmationMessage = `✅ *Pagamento confirmado${valorFormatado ? `, ${valorFormatado}` : ''}!*\nObrigado, ${studentName}. Seu acesso segue ativo. 🐺`;

                            console.log(`Sending payment confirmation WhatsApp to ${cleanPhone}...`);

                            const { data: centralInst } = await supabase.rpc('central_instance_for_tenant', { p_tenant: profileData.tenant_id });
                            const sendInstance = centralInst || 'wise-wolf';
                            let evoRes: Response | null = null;
                            for (const key of EVOLUTION_API_KEYS) {
                                evoRes = await fetchComTimeout(`https://api.2b.app.br/message/sendText/${encodeURIComponent(sendInstance)}`, {
                                    method: 'POST',
                                    headers: {
                                        'apikey': key,
                                        'Content-Type': 'application/json'
                                    },
                                    body: JSON.stringify({
                                        number: cleanPhone,
                                        text: confirmationMessage,
                                        delay: 1200,
                                        linkPreview: false
                                    })
                                });
                                if (evoRes.status !== 401) break; // 401 = chave rotacionada → tenta a próxima
                            }

                            if (evoRes?.ok) {
                                console.log('✅ Payment Confirmation WhatsApp Sent!');
                            } else {
                                console.error('❌ Failed to send payment confirmation WhatsApp:', await evoRes?.text());
                            }
                        } catch (whatsappErr) {
                            console.error('❌ Error in Payment Confirmation WhatsApp flow:', whatsappErr);
                        }
                    }
                }
                // -----------------------------

                // LEDGER: a inserção no caixa é responsabilidade EXCLUSIVA do trigger
                // ledger_on_payment_received (fonte única, idempotente por student_payment_id
                // + índice único uq_financial_transactions_student_payment). O bloco de
                // inserção direta que existia aqui foi removido em 03/07/2026 — era a origem
                // do "caixa dobrado" (linha 'student_tuition Ref: pay_...' sem vínculo,
                // duplicando a linha MENSALIDADE do trigger). NÃO reintroduzir.
            }

        } else if (event === 'PAYMENT_OVERDUE') {
            console.log('⚠️ PAYMENT OVERDUE! Marking as overdue...');

            const paymentData: any = {
                asaas_payment_id: payment.id,
                status: 'OVERDUE',
                updated_at: new Date().toISOString()
            };

            if (studentId) paymentData.student_id = studentId;

            const { error: payError } = await supabase
                .from('student_payments')
                .update(paymentData)
                .eq('asaas_payment_id', payment.id);

            if (payError) console.error('❌ Error updating payment to OVERDUE:', payError);

            if (studentId) {
                await supabase
                    .from('profiles')
                    .update({ status_financial: 'OVERDUE' })
                    .eq('id', studentId);
                console.log('✅ Profile Financial Status set to OVERDUE');
            }
        }
        // Handle generic updates (Created, etc)
        else {
            console.log(`ℹ️ Generic Event: ${event}. Upserting info...`);

            const paymentData: any = {
                asaas_payment_id: payment.id,
                value: payment.value,
                status: payment.status,
                due_date: payment.dueDate,
                billing_type: payment.billingType,
                invoice_url: payment.bankSlipUrl || payment.invoiceUrl,
                description: payment.description,
                updated_at: new Date().toISOString()
            };

            // CRITICAL FIX: Only set student_id if it is defined.
            if (studentId) {
                paymentData.student_id = studentId;

                // Fetch tenant_id
                const { data: profileT } = await supabase.from('profiles').select('tenant_id').eq('id', studentId).single();
                if (profileT?.tenant_id) paymentData.tenant_id = profileT.tenant_id;
                else paymentData.tenant_id = 'school-wise-wolf';
            }

            const { error: upsertError } = await supabase
                .from('student_payments')
                .upsert(paymentData, { onConflict: 'asaas_payment_id' });

            if (upsertError) console.error("❌ Error generic upsert:", upsertError);
        }

    } catch (err: any) {
        console.error('❌ CRITICAL WEBHOOK ERROR (background):', err);
    }
}

serve(async (req) => {
    // 0. CORS preflight
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders })
    }

    // 1. Validação rápida (corpo + token) — tudo que precisa retornar erro HTTP
    //    pro ASAAS acontece AQUI, antes do ACK.
    let body: any;
    try {
        const reqText = await req.text();
        if (!reqText) {
            return new Response(JSON.stringify({ error: 'Empty body' }), { headers: corsHeaders, status: 400 });
        }
        body = JSON.parse(reqText);
    } catch {
        return new Response(JSON.stringify({ error: 'Invalid JSON' }), { headers: corsHeaders, status: 400 });
    }

    // Validate webhook token (uses dedicated ASAAS_WEBHOOK_TOKEN secret)
    const requestToken = req.headers.get('asaas-access-token');
    if (ASAAS_WEBHOOK_TOKEN && requestToken !== ASAAS_WEBHOOK_TOKEN) {
        console.warn(`[Webhook] Token Mismatch! Received: '${requestToken}' | Expected: '${ASAAS_WEBHOOK_TOKEN}'`);
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
    }

    // 2. Processa em BACKGROUND e responde 200 imediatamente.
    //    Isso evita o "Read timed out" do ASAAS: o banco/WhatsApp continuam
    //    rodando depois da resposta, sem segurar a conexão do webhook.
    if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime?.waitUntil) {
        EdgeRuntime.waitUntil(processarPagamento(body));
    } else {
        // Fallback: process in background (non-blocking) to prevent timeouts
        processarPagamento(body).catch(err => console.error("❌ Background processing error:", err));
    }

    return new Response(JSON.stringify({ received: true }), { headers: corsHeaders, status: 200 });
});
