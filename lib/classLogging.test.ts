import { beforeEach, describe, expect, it, vi } from 'vitest';
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('./supabase', () => ({ supabase: { rpc } }));
import { logTeacherClasses } from './classLogging';

beforeEach(() => rpc.mockReset());
describe('mixed class command results', () => {
    it('uses one command for regular and advanced lessons and retains partial results', async () => {
        rpc.mockResolvedValue({ error: null, data: { inserted: 1, skipped: 1, delta_amount: 8, month_amount: 80,
            entries: [{ ref: 'regular', id: 'saved', status: 'lancada', amount: 8, paid: true },
                { ref: 'advanced', status: 'ignorada', reason: 'registro_pedagogico_incompleto' }] } });
        const result = await logTeacherClasses([
            { ref: 'regular', bookingId: 'book', classDate: '2026-09-11', presence: 'COMPLETED', contentCovered: 'Prática real', lessonObjective: 'Entrevista', studentDifficulties: 'Verbos', homeworkAssigned: 'Sem tarefa', recommendedNextStep: 'Simular entrevista', lateLoggingReason: 'Regularização' },
            { ref: 'advanced', lessonAdvanceId: 'advance', classDate: '2026-09-11', presence: 'COMPLETED' },
        ]);
        expect(rpc).toHaveBeenCalledTimes(1);
        expect(rpc.mock.calls[0][0]).toBe('log_teacher_classes');
        expect(rpc.mock.calls[0][1].p_entries[0]).toMatchObject({ content_covered: 'Prática real', lesson_objective: 'Entrevista', recommended_next_step: 'Simular entrevista' });
        expect(rpc.mock.calls[0][1].p_entries[1].lesson_advance_id).toBe('advance');
        expect(result).toMatchObject({ inserted: 1, skipped: 1, deltaAmount: 8, monthAmount: 80 });
        expect(result.entries[1].reason).toBe('registro_pedagogico_incompleto');
    });
    it('never claims zero committed rows after an uncertain response', async () => {
        rpc.mockResolvedValue({ data: null, error: { message: 'network error' } });
        await expect(logTeacherClasses([{ ref: 'x', bookingId: 'book', classDate: '2026-09-11', presence: 'TEACHER_ABSENCE' }]))
            .rejects.toThrow('algumas aulas podem ter sido registradas');
    });
});
