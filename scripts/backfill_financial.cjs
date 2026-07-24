
const { createClient } = require('@supabase/supabase-js');

// Runtime credentials are supplied through environment variables.
const supabaseUrl = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://api.wisewolflanguage.com.br');
const supabaseKey = (process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '');

if (!supabaseUrl || !supabaseKey) {
    console.error("Missing Supabase credentials");
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function backfillTransactions() {
    console.log("🚀 Starting Backfill for Missing Manual Transactions...");

    // 1. Get all RECEIVED payments from this month
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const { data: payments, error: payError } = await supabase
        .from('student_payments')
        .select(`
      id, 
      value, 
      payment_date, 
      student_id, 
      status,
      profiles (
        id,
        full_name,
        tenant_id
      )
    `)
        .eq('status', 'RECEIVED')
        .gte('payment_date', startOfMonth.toISOString());

    if (payError) {
        console.error("Error fetching payments:", payError);
        return;
    }

    console.log(`Checking ${payments.length} received payments for corresponding transactions...`);

    // 2. Get all Transactions from this month
    const { data: transactions, error: transError } = await supabase
        .from('financial_transactions')
        .select('*')
        .gte('created_at', startOfMonth.toISOString())
        .eq('category', 'MENSALIDADE');

    if (transError) {
        console.error("Error fetching transactions:", transError);
        return;
    }

    let fixedCount = 0;

    for (const payment of payments) {
        // Check if a transaction exists for this student + amount
        const hasTransaction = transactions.find(t =>
            t.reference_id === payment.student_id &&
            Math.abs(t.amount - payment.value) < 0.01
        );

        if (!hasTransaction) {
            console.log(`⚠️ Missing transaction for Payment ${payment.id} - ${payment.profiles?.full_name} (${payment.value})`);

            // CREATE IT
            const { error: insertError } = await supabase
                .from('financial_transactions')
                .insert({
                    tenant_id: payment.profiles?.tenant_id,
                    type: 'ENTRADA',
                    category: 'MENSALIDADE',
                    amount: payment.value,
                    description: `Mensalidade (Manual Backfill) - ${payment.profiles?.full_name}`,
                    reference_id: payment.student_id,


                    created_at: payment.payment_date || new Date().toISOString()
                });

            if (insertError) {
                console.error("  ❌ Failed to insert:", insertError.message);
            } else {
                console.log("  ✅ Fixed!");
                fixedCount++;
            }
        }
    }

    console.log(`\n🎉 Done! Created ${fixedCount} missing transactions.`);
}

backfillTransactions();
