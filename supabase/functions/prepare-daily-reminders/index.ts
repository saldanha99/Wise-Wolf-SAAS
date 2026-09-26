import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { authorizeAutomation } from '../_shared/automation-auth.ts'
import {
    canonicalLessonReminder,
    DEFAULT_CLASS_REMINDER_TEMPLATE,
    renderReminderTemplate,
} from '../send-class-notification/core.ts'

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// O texto que vai para a fila aqui é só a PRÉVIA: na hora do envio o
// process-notification-queue remonta o lembrete pelo renderizador do banco
// (public.render_lesson_reminder_message) e a cerca confere com ele. A prévia usa
// o mesmo renderizador para a fila mostrar o que o aluno vai receber — inclusive
// a sala oficial da escola — e só cai no renderizador local se o banco falhar.

/**
 * Edge function: roda a cada N minutos via pg_cron.
 * Lógica:
 *   1. Busca aulas em upcoming_classes que comecam entre AGORA+55min e AGORA+65min (janela de 10min)
 *   2. Para cada aula, monta a mensagem usando o template do professor (ou default)
 *   3. Insere em notification_queue com idempotency (UNIQUE em source_id+source_type+class_date+kind)
 *   4. process-notification-queue dispara ao vivo
 */
serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
    const authError = await authorizeAutomation(req, corsHeaders);
    if (authError) return authError;

    try {
        const supabaseClient = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
        );

        const now = new Date();
        // Janela de 30 min antes da aula (25-35 min). O cron roda a cada 5 min;
        // a idempotência (source_id+source_type+class_date+kind) impede duplicar no overlap.
        const windowStart = new Date(now.getTime() + 25 * 60_000).toISOString();
        const windowEnd = new Date(now.getTime() + 35 * 60_000).toISOString();

        console.log(`[Reminders] Window (30min antes): ${windowStart} → ${windowEnd}`);

        // 1. Aulas começando em 25-35 min (≈30 min antes)
        const { data: classes, error: classesErr } = await supabaseClient
            .from('upcoming_classes')
            .select('*')
            .gte('start_at', windowStart)
            .lte('start_at', windowEnd);

        if (classesErr) throw classesErr;
        if (!classes || classes.length === 0) {
            return new Response(JSON.stringify({ queued: 0, message: 'no classes in 60-min window' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        // 2. Hidratar com dados do professor, aluno e tenant
        let queuedCount = 0;
        const skipped: string[] = [];

        for (const cls of classes) {
            try {
                if (String(cls.source_type || '').toLowerCase() === 'appointment') {
                    const { data: appointment, error: appointmentError } = await supabaseClient
                        .from('appointments')
                        .select('status')
                        .eq('id', cls.source_id)
                        .eq('tenant_id', cls.tenant_id)
                        .maybeSingle();
                    if (appointmentError) throw appointmentError;
                    if (String(appointment?.status || '').toLowerCase() !== 'scheduled') {
                        skipped.push(`class ${cls.source_id}: appointment not scheduled`);
                        continue;
                    }
                }

                // Professor
                const { data: teacher } = await supabaseClient
                    .from('profiles')
                    .select('id, full_name, lesson_reminder_template, date_automation_enabled')
                    .eq('id', cls.teacher_id)
                    .single();

                if (!teacher || teacher.date_automation_enabled === false) {
                    skipped.push(`teacher ${cls.teacher_id}: automation off`);
                    continue;
                }

                // Aluno (de profiles ou override do appointment)
                let studentName = cls.student_name_override;
                let studentPhone = cls.student_phone_override;
                let studentId: string | null = null;

                if (cls.student_id) {
                    const { data: student } = await supabaseClient
                    .from('profiles')
                    .select('id, full_name, phone, attendance_phone, lifecycle_status')
                    .eq('id', cls.student_id)
                    .single();
                    // Aluno suspenso/desligado não recebe lembrete (horário fixo pode continuar na grade)
                    if (student?.lifecycle_status === 'suspended' || student?.lifecycle_status === 'offboarded') {
                        skipped.push(`class ${cls.source_id}: student ${student.lifecycle_status}`);
                        continue;
                    }
                    if (student) {
                        studentName = student.full_name;
                        studentPhone = student.attendance_phone || student.phone;
                        studentId = student.id;
                    }
                }

                if (!studentPhone || !studentName) {
                    skipped.push(`class ${cls.source_id}: missing student phone/name`);
                    continue;
                }

                // Tenant (para {tenant_name})
                const { data: tenant } = await supabaseClient
                    .from('tenants')
                    .select('name')
                    .eq('id', cls.tenant_id)
                    .single();

                // Renderizar template (prévia; ver o comentário no topo)
                const classTime = String(cls.time_text || '').slice(0, 5);
                const firstName = (studentName || '').split(' ')[0];
                const canonical = await canonicalLessonReminder(
                    (fn, args) => supabaseClient.rpc(fn, args),
                    {
                        tenantId: cls.tenant_id,
                        sourceType: String(cls.source_type || ''),
                        sourceId: String(cls.source_id || ''),
                        classDate: String(cls.class_date || ''),
                        classTime,
                        studentId,
                        teacherId: cls.teacher_id ? String(cls.teacher_id) : null,
                        template: teacher.lesson_reminder_template ?? null,
                        studentName: firstName,
                        teacherName: teacher.full_name || '',
                        tenantName: tenant?.name || '',
                        // O link pessoal saiu do lembrete (decisão da direção em
                        // 16/09/2026): quem combina a sala é o professor. Só a
                        // sala oficial da escola entra.
                        personalLink: null,
                    },
                );
                const messageBody = canonical.ok
                    ? canonical.message
                    : renderReminderTemplate(
                        teacher.lesson_reminder_template?.trim() || DEFAULT_CLASS_REMINDER_TEMPLATE,
                        {
                            student_name: firstName,
                            class_time: classTime,
                            teacher_name: teacher.full_name || '',
                            tenant_name: tenant?.name || '',
                            class_link: '',
                        },
                    );

                // 3. Enqueue (idempotente)
                const { error: queueErr } = await supabaseClient
                    .from('notification_queue')
                    .insert({
                        tenant_id: cls.tenant_id,
                        teacher_id: teacher.id,
                        student_id: studentId,
                        student_name: studentName,
                        student_phone: studentPhone,
                        message_body: messageBody,
                        scheduled_for: new Date(now.getTime() + 30_000).toISOString(), // 30s pra processar quase imediato
                        status: 'pending',
                        source_id: cls.source_id,
                        source_type: cls.source_type,
                        class_date: cls.class_date,
                        notification_kind: 'LESSON_REMINDER',
                    });

                if (queueErr) {
                    // Code 23505 = unique_violation = ja foi enfileirado pra essa aula (idempotency)
                    if (queueErr.code === '23505') {
                        skipped.push(`class ${cls.source_id}: already queued`);
                    } else {
                        console.error('Queue insert error:', queueErr);
                    }
                } else {
                    queuedCount++;
                }
            } catch (innerErr) {
                console.error(`Error processing class ${cls.source_id}:`, innerErr);
            }
        }

        return new Response(
            JSON.stringify({
                window: { start: windowStart, end: windowEnd },
                queued: queuedCount,
                skipped: skipped.length,
                skipped_reasons: skipped.slice(0, 10),
            }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
    } catch (error: any) {
        console.error('Fatal:', error);
        return new Response(
            JSON.stringify({ error: error.message }),
            { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
    }
});
