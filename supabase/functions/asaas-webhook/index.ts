import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Environment Variables
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
const ASAAS_ACCESS_TOKEN = (Deno.env.get('ASAAS_ACCESS_TOKEN') || Deno.env.get('ASAAS_API_KEY') || '').trim();
const ASAAS_WEBHOOK_TOKEN = (Deno.env.get('ASAAS_WEBHOOK_TOKEN') || '').trim();

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, asaas-access-token',
}

serve(async (req) => {
    // 0. CORS preflight
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders })
    }

    try {
        const reqText = await req.text();
        if (!reqText) {
            return new Response(JSON.stringify({ error: 'Empty body' }), { headers: corsHeaders, status: 400 });
        }

        const body = JSON.parse(reqText);

        // Validate webhook token (uses dedicated ASAAS_WEBHOOK_TOKEN secret)
        const requestToken = req.headers.get('asaas-access-token');
        if (ASAAS_WEBHOOK_TOKEN && requestToken !== ASAAS_WEBHOOK_TOKEN) {
            console.warn(`[Webhook] Token Mismatch! Received: '${requestToken}' | Expected: '${ASAAS_WEBHOOK_TOKEN}'`);
            return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
        }

        const { event, payment } = body;

        if (!event || !payment) {
            console.warn("[Webhook] Ignored: Missing event or payment data.", body);
            return new Response(JSON.stringify({ ignored: true }), { headers: corsHeaders, status: 200 });
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
            console.warn(`⚠️ Invalid UUID in externalReference: '${payment.externalReference}'. Ignoring to prevent 500 Error.`);
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
                        const asaasRes = await fetch(`https://api.asaas.com/v3/customers/${payment.customer}`, {
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
                // Don't throw 500 if DB fails, just log it. Asaas retries on 500, but maybe we want that?
                throw payError;
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
                        const evoRes = await fetch(`https://api.2b.app.br/message/sendText/${encodeURIComponent(sendInstance)}`, {
                            method: 'POST',
                            headers: {
                                'apikey': 'd037768b3d06382756a0d9edecf3e40e',
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify({
                                number: cleanPhone,
                                text: confirmationMessage,
                                delay: 1200,
                                linkPreview: false
                            })
                        });

                        if (evoRes.ok) {
                            console.log('✅ Payment Confirmation WhatsApp Sent!');
                        } else {
                            console.error('❌ Failed to send payment confirmation WhatsApp:', await evoRes.text());
                        }
                    } catch (whatsappErr) {
                        console.error('❌ Error in Payment Confirmation WhatsApp flow:', whatsappErr);
                    }
                }
                // -----------------------------

                // DIRECT LEDGER INSERTION (Restored for Real-Time Sync)
                if (event === 'PAYMENT_CONFIRMED' || event === 'PAYMENT_RECEIVED') {
                    console.log(`ℹ️ [Webhook] Inserting Ledger Entry for ${payment.id}...`);

                    // 1. Check if Transaction Exists
                    const { data: existingTrans } = await supabase
                        .from('financial_transactions')
                        .select('id')
                        .eq('reference_id', studentId) // Check by student + description + date? or by unique ID?
                        // Ideally we should have a unique constraint or column for source_id.
                        // We will use a check on description containing the ID or just rely on 'student_payments.ledger_entry_created' if we updated it.
                        // But wait, we haven't updated 'ledger_entry_created' yet essentially.
                        // Let's check by 'student_payment_id' if we have it? No, we just upserted it.
                        // We can fetch the student_payment first.
                        .eq('description', `Mensalidade - Ref: ${payment.id}`) // Weak check
                        .maybeSingle();

                    if (!existingTrans) {
                        const amountCents = Math.round((payment.value || 0) * 100);

                        const { error: insertError } = await supabase
                            .from('financial_transactions')
                            .insert({
                                tenant_id: paymentData.tenant_id,
                                type: 'ENTRADA',
                                category: 'student_tuition',
                                amount: payment.value,
                                amount_cents: amountCents, // Critical for views
                                description: `Mensalidade - Ref: ${payment.id}`,
                                reference_id: studentId,
                                occurred_at: payment.paymentDate || new Date().toISOString(),
                                created_at: new Date().toISOString()
                            });

                        if (insertError) {
                            console.error("❌ Failed to insert Ledger Entry:", insertError);
                        } else {
                            console.log("✅ Ledger Entry Created via Webhook");
                            // Update student_payment to marked as reconciled
                            await supabase
                                .from('student_payments')
                                .update({ ledger_entry_created: true })
                                .eq('asaas_payment_id', payment.id);
                        }
                    } else {
                        console.log("ℹ️ Ledger Entry already exists.");
                    }
                }
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

        return new Response(JSON.stringify({ received: true }), { headers: corsHeaders, status: 200 });

    } catch (err: any) {
        console.error('❌ CRITICAL WEBHOOK ERROR:', err);
        // Returns 500 so Asaas retries.
        return new Response(JSON.stringify({ error: err.message }), { headers: corsHeaders, status: 500 });
    }
});
