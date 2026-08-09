import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { authorizeRequest, methodNotAllowed } from '../_shared/request-auth.ts'

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders })
    }
    if (req.method !== 'POST') return methodNotAllowed(corsHeaders)

    const auth = await authorizeRequest(req, {
        corsHeaders,
        allowService: true,
        allowedRoles: ['SUPER_ADMIN'],
    })
    if (auth.ok === false) return auth.response

    try {
        const supabase = auth.context.admin

        console.log('🔄 Starting Ledger Reconciliation...');

        // 1. Fetch Unreconciled Payments
        const { data: payments, error: fetchError } = await supabase
            .from('student_payments')
            .select('*')
            .in('status', ['RECEIVED', 'CONFIRMED'])
            .eq('ledger_entry_created', false)
            .limit(100); // Batch size

        if (fetchError) throw fetchError;

        console.log(`📊 Found ${payments?.length || 0} payments to reconcile.`);

        const results = {
            processed: 0,
            success: 0,
            failed: 0,
            skipped: 0
        };

        if (payments && payments.length > 0) {
            for (const payment of payments) {
                results.processed++;

                // Double check if transaction already exists (Idempotency)
                // We check by `student_payment_id`
                const { data: existing, error: checkError } = await supabase
                    .from('financial_transactions')
                    .select('id')
                    .eq('student_payment_id', payment.id)
                    .single();

                if (existing) {
                    console.warn(`⚠️ Transaction already exists for Payment ID ${payment.id}. Marking as reconciled.`);
                    await supabase.from('student_payments').update({ ledger_entry_created: true }).eq('id', payment.id);
                    results.skipped++;
                    continue;
                }

                // Create Transaction
                // Logic: Amount in cents. If missing, convert from value.
                const amountCents = payment.amount_cents || Math.round((payment.value || 0) * 100);

                const { error: insertError } = await supabase
                    .from('financial_transactions')
                    .insert({
                        tenant_id: payment.tenant_id || 'school-wise-wolf',
                        type: 'ENTRADA',
                        category: 'student_tuition',
                        amount_cents: amountCents,
                        description: `Mensalidade - Ref: ${payment.description || 'Asaas'}`,
                        student_payment_id: payment.id,
                        reference_id: payment.student_id, // Legacy field, keeping for now
                        occurred_at: payment.paid_at || payment.payment_date || new Date().toISOString()
                    });

                if (insertError) {
                    console.error(`❌ Failed to create transaction for Payment ${payment.id}:`, insertError);

                    // Log Issue
                    await supabase.from('reconciliation_issues').insert({
                        tenant_id: payment.tenant_id || 'school-wise-wolf',
                        kind: 'LEDGER_INSERT_FAILED',
                        student_payment_id: payment.id,
                        details: { error: insertError }
                    });
                    results.failed++;
                } else {
                    // Mark as Reconciled
                    const { error: updateError } = await supabase
                        .from('student_payments')
                        .update({ ledger_entry_created: true })
                        .eq('id', payment.id);

                    if (updateError) {
                        console.error(`❌ Failed to update Payment status ${payment.id}:`, updateError);
                        // This is bad, we created the transaction but failed to mark it.
                        // Idempotency check in next run should handle it, but still risky.
                        results.failed++;
                    } else {
                        results.success++;
                    }
                }
            }
        }

        return new Response(JSON.stringify({
            message: 'Reconciliation Completed',
            stats: results
        }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 200
        });

    } catch (err: any) {
        console.error('❌ Critical Reconciliation Error:', err);
        return new Response(JSON.stringify({ error: err.message }), { headers: corsHeaders, status: 500 });
    }
});
