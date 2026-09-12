import { supabase } from './supabase';
import type { ClassLogEntryInput, ClassLogEntryResult, ClassLogResult } from './classLogRules';

// ─────────────────────────────────────────────────────────────────────────────
// LANÇAMENTO DE AULA — cliente da RPC `log_teacher_classes`
//
// Este módulo é a ÚNICA porta do frontend para lançar aula. Antes cada tela
// montava seu próprio `insert` em `class_logs` e as regras divergiram: a aba
// "Pendentes" não gerava reposição quando o PROFESSOR faltava, e gravava a
// reposição sem `fault_type` — o que fazia toda reposição de falta do professor
// valer R$ 0. Agora a regra mora no banco; aqui só traduzimos.
//
// As regras puras (XP, textos dos motivos) vivem em `classLogRules.ts`, que não
// importa o Supabase — é o que permite testar a tela sem variável de ambiente.
// ─────────────────────────────────────────────────────────────────────────────

export * from './classLogRules';

/**
 * Lança as aulas numa transação só. A RPC deriva o subtype da origem real,
 * barra duplicata, cria a reposição com `fault_type` e devolve o valor que
 * cada aula somou ao caixa.
 */
export async function logTeacherClasses(entries: ClassLogEntryInput[]): Promise<ClassLogResult> {
    if (entries.length === 0) {
        return {
            inserted: 0, skipped: 0, reschedulesCreated: 0,
            deltaAmount: 0, deltaLessons: 0, monthAmount: 0, monthLessons: 0,
            turboActive: false, entries: [],
        };
    }

    const toPayload = (e: ClassLogEntryInput) => ({
        ref: e.ref,
        booking_id: e.bookingId || null,
        reschedule_id: e.rescheduleId || null,
        appointment_id: e.appointmentId || null,
        lesson_advance_id: e.lessonAdvanceId || null,
        class_date: e.classDate,
        presence: e.presence,
        absence_reason: e.absenceReason || null,
        content_covered: e.contentCovered || null,
        observations: e.observations || null,
        assessment_level: e.assessmentLevel || null,
        psychological_profile: e.psychologicalProfile || null,
        teacher_verdict: e.teacherVerdict || null,
    });

    const regularEntries = entries.filter(e => !e.lessonAdvanceId);
    const advancedEntries = entries.filter(e => !!e.lessonAdvanceId);

    const calls: PromiseLike<{ data: any; error: any }>[] = [];
    if (regularEntries.length > 0) {
        calls.push(supabase.rpc('log_teacher_classes', { p_entries: regularEntries.map(toPayload) }));
    }
    if (advancedEntries.length > 0) {
        calls.push(supabase.rpc('log_advanced_teacher_classes', { p_entries: advancedEntries.map(toPayload) }));
    }

    const responses = await Promise.all(calls);
    const failed = responses.find(response => response.error);
    if (failed?.error) throw failed.error;

    const raws = responses.map(response => (response.data || {}) as any);
    const raw = raws[raws.length - 1] || {};
    return {
        inserted: raws.reduce((sum, item) => sum + Number(item.inserted || 0), 0),
        skipped: raws.reduce((sum, item) => sum + Number(item.skipped || 0), 0),
        reschedulesCreated: raws.reduce((sum, item) => sum + Number(item.reschedules_created || 0), 0),
        deltaAmount: raws.reduce((sum, item) => sum + Number(item.delta_amount || 0), 0),
        deltaLessons: raws.reduce((sum, item) => sum + Number(item.delta_lessons || 0), 0),
        monthAmount: Number(raw.month_amount || 0),
        monthLessons: Number(raw.month_lessons || 0),
        turboActive: raw.turbo_active === true,
        entries: raws.flatMap(item => item.entries || []).map((e: any): ClassLogEntryResult => ({
            ref: e.ref ?? null,
            id: e.id ?? null,
            status: e.status === 'lancada' ? 'lancada' : 'ignorada',
            reason: e.reason ?? null,
            kind: e.kind ?? null,
            subtype: e.subtype ?? null,
            amount: Number(e.amount || 0),
            paid: e.paid === true,
            unpaidReason: e.unpaid_reason ?? null,
        })),
    };
}
