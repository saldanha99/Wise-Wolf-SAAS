
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
        const supabase = auth.context.admin;

        console.log("Starting Sync...");

        // A escola tem de ser DITA, não deduzida.
        //
        // ⚠️ Esta função varria os alunos de TODAS as escolas de uma vez e criava
        // cobrança para todas. Só o SUPER_ADMIN chama, mas "sou super admin" não
        // é o mesmo que "quis faturar a rede inteira" — e a função não tem cron
        // nem confirmação: um clique gerava mensalidade em toda a base. Nunca
        // rodou (medido: 0 pagamentos `MANUAL_` em 273), então exigir o tenant
        // não quebra chamada existente.
        const body = await req.json().catch(() => ({})) as { tenant_id?: unknown };
        const tenantId = typeof body?.tenant_id === 'string' ? body.tenant_id.trim() : '';
        if (!tenantId) {
            return new Response(
                JSON.stringify({ error: 'tenant_id_obrigatorio', detalhe: 'Informe a escola para a qual gerar as mensalidades.' }),
                { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 },
            );
        }

        const today = new Date();
        const currentMonthStart = new Date(today.getFullYear(), today.getMonth(), 1).toISOString();
        const nextMonthStart = new Date(today.getFullYear(), today.getMonth() + 1, 1).toISOString();

        // 1. Get active students
        const { data: students, error: stError } = await supabase
            .from('profiles')
            .select('id, tenant_id, monthly_fee, due_day, full_name')
            .eq('role', 'STUDENT')
            .eq('status', 'Ativo')
            .eq('tenant_id', tenantId);

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

                // Sem fallback chumbado. O `|| 'school-wise-wolf'` que estava aqui
                // faturava aluno sem escola definida em nome da Wise Wolf — é a
                // mesma raiz dos 38 pagamentos órfãos (R$ 11.466,74) que hoje
                // aparecem como receita dela. O filtro por tenant acima já
                // garante o valor; esta guarda existe para o caso de o filtro
                // mudar um dia.
                if (student.tenant_id !== tenantId) {
                    logs.push(`Ignorado ${student.full_name}: escola divergente`);
                    continue;
                }

                const { error: insError } = await supabase
                    .from('student_payments')
                    .insert({
                        student_id: student.id,
                        tenant_id: tenantId,
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
