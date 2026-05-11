
const { createClient } = require('@supabase/supabase-js');

// Config
const SUPABASE_URL = 'https://dvalxbtngopxopzcbfdm.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR2YWx4YnRuZ29weG9wemNiZmRtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY5ODkwMTksImV4cCI6MjA4MjU2NTAxOX0.rrq_vbAub4GGIcZc9cpS-QxGFYQ3B0aeka2p4xiYKiE';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function inspect() {
    console.log("--- Payment Sync Verification ---");

    // 1. Get Active Students
    const { data: students, error } = await supabase
        .from('profiles')
        .select(`id, full_name, monthly_fee, monthly_tuition, due_day, tenant_id`)
        .eq('role', 'STUDENT')
        .eq('status', 'Ativo');

    if (error) { console.error("Error fetching students:", error); return; }

    console.log(`Total Active Students: ${students.length}`);

    // 2. Get Payments for Feb 2026
    const start = '2026-02-01';
    const end = '2026-03-01';

    const { data: payments, error: payError } = await supabase
        .from('student_payments')
        .select('*')
        .gte('due_date', start)
        .lt('due_date', end);

    if (payError) { console.error("Error fetching payments:", payError); return; }

    console.log(`Total Payments for Feb: ${payments.length}`);

    // 3. Map Payments to Students
    const paymentMap = {};
    payments.forEach(p => {
        if (!paymentMap[p.student_id]) paymentMap[p.student_id] = [];
        paymentMap[p.student_id].push(p);
    });

    // 4. Analyze Coverage
    console.log("\n--- Student Status ---");
    let missingCount = 0;

    students.forEach(s => {
        const fee = Number(s.monthly_tuition) > 0 ? Number(s.monthly_tuition) : Number(s.monthly_fee);
        const hasPayment = paymentMap[s.id] && paymentMap[s.id].length > 0;

        if (fee <= 0) {
            console.log(`[SKIP] ${s.full_name}: No tuition/fee configured (Fee: ${s.monthly_fee}, Tuition: ${s.monthly_tuition})`);
            return;
        }

        if (hasPayment) {
            const p = paymentMap[s.id][0];
            console.log(`[OK] ${s.full_name}: Payment R$ ${p.value} (${p.status})`);
        } else {
            console.log(`[MISSING] ${s.full_name}: Expected R$ ${fee}`);
            missingCount++;
        }
    });

    console.log(`\nMissing Payments: ${missingCount}`);
}

inspect();
