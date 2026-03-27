
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders })
    }

    try {
        const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
        const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
        const supabase = createClient(supabaseUrl, supabaseKey);

        console.log("Starting Sync...");

        const today = new Date();
        const currentMonthStart = new Date(today.getFullYear(), today.getMonth(), 1).toISOString();
        const nextMonthStart = new Date(today.getFullYear(), today.getMonth() + 1, 1).toISOString();

        // 1. Get active students
        const { data: students, error: stError } = await supabase
            .from('profiles')
            .select('id, tenant_id, monthly_fee, monthly_tuition, due_day, full_name')
            .eq('role', 'STUDENT')
            .eq('status', 'Ativo');

        if (stError) throw stError;

        let createdCount = 0;
        const logs = [];

        for (const student of students || []) {
            // Determine Fee: Prefer monthly_tuition, fallback to monthly_fee
            const feeValue = Number(student.monthly_tuition) > 0
                ? Number(student.monthly_tuition)
                : Number(student.monthly_fee);

            if (!feeValue || feeValue <= 0) {
                // logs.push(`Skipped ${student.full_name}: No fee defined`);
                continue;
            }

            const { data: existing } = await supabase
                .from('student_payments')
                .select('id')
                .eq('student_id', student.id)
                .gte('due_date', currentMonthStart)
                .lt('due_date', nextMonthStart);

            if (!existing || existing.length === 0) {
                const dueDay = student.due_day || 10;
                const dueDate = new Date(today.getFullYear(), today.getMonth(), dueDay);

                // Default tenant if missing (safety net for legacy profiles)
                const safeTenantId = student.tenant_id || 'school-wise-wolf';

                const { error: insError } = await supabase
                    .from('student_payments')
                    .insert({
                        student_id: student.id,
                        tenant_id: safeTenantId,
                        value: feeValue,
                        due_date: dueDate.toISOString().split('T')[0],
                        status: today > dueDate ? 'OVERDUE' : 'PENDING',
                        billing_type: 'MANUAL',
                        asaas_payment_id: `MANUAL_${Date.now()}_${Math.floor(Math.random() * 1000)}`
                        // history removed as column missing
                    });

                if (insError) logs.push(`Failed ${student.full_name}: ${insError.message}`);
                else {
                    createdCount++;
                    logs.push(`Created for ${student.full_name} (R$ ${feeValue})`);
                }
            }
        }

        return new Response(JSON.stringify({ success: true, created: createdCount, logs }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 200,
        });

    } catch (error: any) {
        return new Response(JSON.stringify({ error: error.message }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 400,
        })
    }
})
