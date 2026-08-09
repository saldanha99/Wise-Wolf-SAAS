
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
    if (!auth.ok) return auth.response

    try {
        const supabase = auth.context.admin;

        console.log("Starting Sync...");

        const today = new Date();
        const currentMonthStart = new Date(today.getFullYear(), today.getMonth(), 1).toISOString();
        const nextMonthStart = new Date(today.getFullYear(), today.getMonth() + 1, 1).toISOString();

        // 1. Get active students
        const { data: students, error: stError } = await supabase
            .from('profiles')
            .select('id, tenant_id, monthly_fee, due_day, full_name')
            .eq('role', 'STUDENT')
            .eq('status', 'Ativo');

        if (stError) throw stError;

        let createdCount = 0;
        const logs = [];

        for (const student of students || []) {
            // A mensalidade é `monthly_fee` — fonte única.
            //
            // ⚠️ Antes preferia `monthly_tuition` e só caía em `monthly_fee` como
            // reserva. Em 09/08/2026 dois alunos tinham `monthly_fee = 0` (sem
            // mensalidade) com `monthly_tuition` antigo de R$ 169 e R$ 187: este
            // laço estava a um sync de faturar quem não deve nada. Nunca disparou
            // por sorte — as cobranças reais sempre seguiram `monthly_fee`.
            // A coluna virou espelho (trg_mirror_monthly_tuition) e não deve mais
            // ser lida.
            const feeValue = Number(student.monthly_fee);

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
