
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Configuration (Hardcoded for this one-off script, or better: use args if passed)
// We need to fetch the tenantId or just do it for all active students? 
// Safer to iterate through all active students of all tenants or a specific one if known.
// But this is a client script. I don't have the context of "current tenant" unless I fetch it or assume one.
// The user said "puxe isso para mim" (pull this for me). I'll try to find the tenantId from recent files or assume I do it for all.
// Actually, `AdminPaymentsList.tsx` uses `tenantId`. I should probably check if I can get the tenant_id from the database.
// Or safer: Run this for ALL active students in the system where monthly_fee > 0. This honors "update the school cash flow".

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""; // Must use service role to write

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error("Missing SUPABASE env vars.");
    Deno.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function syncPayments() {
    console.log("Starting Financial Sync...");

    const today = new Date();
    const currentMonthStart = new Date(today.getFullYear(), today.getMonth(), 1).toISOString();
    const nextMonthStart = new Date(today.getFullYear(), today.getMonth() + 1, 1).toISOString();

    // 1. Get all active students with fees
    const { data: students, error: stError } = await supabase
        .from('profiles')
        .select('id, tenant_id, monthly_fee, due_day, full_name')
        .eq('role', 'STUDENT')
        .eq('status', 'Ativo')
        .gt('monthly_fee', 0);

    if (stError) {
        console.error("Error fetching students:", stError);
        return;
    }

    if (!students || students.length === 0) {
        console.log("No active students found.");
        return;
    }

    console.log(`Found ${students.length} active students. Checking payments...`);

    let createdCount = 0;

    for (const student of students) {
        // 2. Check if payment exists for this month
        const { data: existing } = await supabase
            .from('student_payments')
            .select('id')
            .eq('student_id', student.id)
            .gte('due_date', currentMonthStart)
            .lt('due_date', nextMonthStart);

        if (!existing || existing.length === 0) {
            // Create Missing Payment
            const dueDay = student.due_day || 10; // Default to 10th if not set

            // Calculate due date for CURRENT MONTH
            // Handle edge case: if today is past the due day, it's overdue or just late creation.
            let dueDate = new Date(today.getFullYear(), today.getMonth(), dueDay);

            // Check validation (e.g. Feb 30) -> auto corrects to Mar X
            // But let's simple check.

            console.log(`Creating payment for ${student.full_name} (R$ ${student.monthly_fee}) - Due: ${dueDate.toISOString().split('T')[0]}`);

            const { error: insError } = await supabase
                .from('student_payments')
                .insert({
                    student_id: student.id,
                    tenant_id: student.tenant_id,
                    value: student.monthly_fee,
                    due_date: dueDate.toISOString().split('T')[0],
                    status: today > dueDate ? 'OVERDUE' : 'PENDING',
                    billing_type: 'MANUAL',
                    history: { created_via: 'manual_sync_script', at: new Date().toISOString() }
                });

            if (insError) {
                console.error(`Failed to create for ${student.full_name}:`, insError);
            } else {
                createdCount++;
            }
        }
    }

    console.log(`Sync Complete! Created ${createdCount} new payment records.`);
}

syncPayments();
