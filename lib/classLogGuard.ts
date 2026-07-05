import type { SupabaseClient } from '@supabase/supabase-js';

// Guarda anti-duplicata de lançamento de aula (origem CRUZADA).
// As travas de unicidade do banco cobrem a mesma origem (booking_id+data, reschedule_id,
// appointment_id), mas não impedem a mesma aula de ser lançada uma vez como regular
// (booking) e de novo como reposição (reschedule) — foi esse padrão que duplicou a
// folha de junho/2026. Aqui barramos qualquer entrada cujo (aluno, data) já tenha
// aula no banco. Duas aulas legítimas do mesmo aluno no mesmo dia (2 horários)
// continuam passando quando salvas no mesmo lote; fora do lote, o admin lança manualmente.
export interface ClassLogEntryLike {
    student_id: string | null;
    class_date: string | null;
    [key: string]: unknown;
}

export async function splitAlreadyLogged<T extends ClassLogEntryLike>(
    supabase: SupabaseClient,
    teacherId: string,
    entries: T[]
): Promise<{ allowed: T[]; blocked: T[] }> {
    const candidates = entries.filter(e => e.student_id && e.class_date);
    if (candidates.length === 0) return { allowed: entries, blocked: [] };

    const dates = [...new Set(candidates.map(e => e.class_date as string))];
    const { data: existing, error } = await supabase
        .from('class_logs')
        .select('student_id, class_date')
        .eq('teacher_id', teacherId)
        .in('class_date', dates);

    // fail-open: se a consulta falhar, as travas de unicidade do banco ainda seguram a mesma origem
    if (error || !existing) return { allowed: entries, blocked: [] };

    const seen = new Set(existing.map(l => `${l.student_id}|${l.class_date}`));
    const allowed: T[] = [];
    const blocked: T[] = [];
    for (const e of entries) {
        if (e.student_id && e.class_date && seen.has(`${e.student_id}|${e.class_date}`)) {
            blocked.push(e);
        } else {
            allowed.push(e);
        }
    }
    return { allowed, blocked };
}
