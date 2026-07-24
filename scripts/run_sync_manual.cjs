
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://api.wisewolflanguage.com.br');
const SUPABASE_KEY = (process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '');
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function sync() {
    console.log("Starting Manual Sync...");
    const today = new Date();
    // For Debug: Ensure we are looking at Feb 2026
    const currentMonthStart = '2026-02-01';
    const nextMonthStart = '2026-03-01';

    // 1. Get active students
    const { data: students, error: stError } = await supabase
        .from('profiles')
        .select('id, tenant_id, monthly_fee, monthly_tuition, due_day, full_name')
        .eq('role', 'STUDENT')
        .eq('status', 'Ativo');

    if (stError) { console.error(stError); return; }
    console.log(`Found ${students.length} active students.`);

    for (const student of students) {
        // Fee Logic
        const feeValue = Number(student.monthly_tuition) > 0
            ? Number(student.monthly_tuition)
            : Number(student.monthly_fee);

        if (!feeValue || feeValue <= 0) {
            console.log(`[SKIP] ${student.full_name}: No fee/tuition.`);
            continue;
        }

        // Check Existing
        const { data: existing } = await supabase
            .from('student_payments')
            .select('id')
            .eq('student_id', student.id)
            .gte('due_date', currentMonthStart)
            .lt('due_date', nextMonthStart);

        if (existing && existing.length > 0) {
            console.log(`[EXISTS] ${student.full_name}: ID ${existing[0].id}`);
            continue;
        }

        // Create
        const dueDay = student.due_day || 10;
        // Construct Date: Feb 2026
        const dueDate = new Date(2026, 1, dueDay); // Month is 0-indexed: 1 = Feb

        const safeTenantId = student.tenant_id || 'school-wise-wolf'; // Default to known tenant

        const payload = {
            student_id: student.id,
            tenant_id: safeTenantId,
            value: feeValue,
            due_date: dueDate.toISOString().split('T')[0],
            status: today > dueDate ? 'OVERDUE' : 'PENDING',
            billing_type: 'MANUAL',
            asaas_payment_id: `MANUAL_${Date.now()}_${Math.floor(Math.random() * 1000)}`
            // history: { created_via: 'manual_script', at: new Date().toISOString() } -- Column does not exist
        };

        const { data: inserted, error: insError } = await supabase
            .from('student_payments')
            .insert(payload)
            .select();

        if (insError) {
            console.error(`[FAIL] ${student.full_name}: ${insError.message}`);
        } else {
            console.log(`[CREATED] ${student.full_name}: R$ ${feeValue} (ID: ${inserted[0]?.id})`);
        }
    }
}

sync();
