import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const updates: Record<string, unknown>[] = [];
const updateFilters: Array<[string, unknown]> = [];

function resolvedQuery(result: Record<string, unknown>, filters?: Array<[string, unknown]>) {
    const query: any = {
        eq: vi.fn((column: string, value: unknown) => {
            filters?.push([column, value]);
            return query;
        }),
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => (
            Promise.resolve(result).then(resolve, reject)
        ),
    };
    return query;
}

vi.mock('../lib/supabase', () => ({
    supabase: {
        from: vi.fn(() => ({
            select: vi.fn(() => resolvedQuery({
                data: [{
                    id: 'booking-1',
                    day_of_week: 'Segunda',
                    time_slot: '05:00:00',
                    teacher_id: 'teacher-1',
                    teacher: { full_name: 'Laís' },
                }],
                error: null,
            })),
            update: vi.fn((payload: Record<string, unknown>) => {
                updates.push(payload);
                return resolvedQuery({ data: null, error: null }, updateFilters);
            }),
            insert: vi.fn(() => resolvedQuery({ data: null, error: null })),
            delete: vi.fn(() => resolvedQuery({ data: null, error: null })),
        })),
    },
}));

import StudentScheduleManager from './StudentScheduleManager';

const props = {
    studentId: 'student-1',
    tenantId: 'school-wise-wolf',
    teachers: [{ id: 'teacher-1', name: 'Laís' }] as any,
};

describe('StudentScheduleManager', () => {
    beforeEach(() => {
        updates.length = 0;
        updateFilters.length = 0;
        vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    });

    it('mantém a edição local até o diretor clicar em Salvar', async () => {
        render(<StudentScheduleManager {...props} />);

        const time = await screen.findByDisplayValue('05:00');
        fireEvent.change(time, { target: { value: '17:30' } });
        expect(updates).toHaveLength(0);

        fireEvent.click(screen.getByRole('button', { name: /^salvar$/i }));

        await waitFor(() => expect(updates).toContainEqual({
            day_of_week: 'Segunda',
            time_slot: '17:30',
            teacher_id: 'teacher-1',
        }));
        expect(updateFilters).toEqual(expect.arrayContaining([
            ['id', 'booking-1'],
            ['student_id', 'student-1'],
            ['tenant_id', 'school-wise-wolf'],
            ['status', 'SCHEDULED'],
        ]));
    });

    it('permite aplicar um horário a todas as aulas do aluno em uma operação', async () => {
        render(<StudentScheduleManager {...props} />);

        await screen.findByDisplayValue('05:00');
        const bulk = screen.getByLabelText(/mesmo horário para todas as aulas/i);
        fireEvent.change(bulk, { target: { value: '17:30' } });
        fireEvent.change(screen.getByLabelText(/professor para todas as aulas/i), {
            target: { value: 'teacher-1' },
        });
        fireEvent.click(screen.getByRole('button', { name: /aplicar a todas/i }));

        await waitFor(() => expect(updates).toContainEqual({
            time_slot: '17:30',
            teacher_id: 'teacher-1',
        }));
        expect(updateFilters).toEqual(expect.arrayContaining([
            ['student_id', 'student-1'],
            ['tenant_id', 'school-wise-wolf'],
            ['status', 'SCHEDULED'],
        ]));
    });
});
