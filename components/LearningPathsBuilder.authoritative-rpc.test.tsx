import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LearningPathsBuilder from './LearningPathsBuilder';

const mocks = vi.hoisted(() => ({
    from: vi.fn(),
    rpc: vi.fn(),
    directDelete: vi.fn(),
    directUpdate: vi.fn(),
}));

vi.mock('../lib/supabase', () => ({
    supabase: {
        from: mocks.from,
        rpc: mocks.rpc,
    },
}));

vi.mock('../services/geminiService', () => ({
    generateUnitActivityContent: vi.fn(),
}));

vi.mock('./PathAssignmentModal', () => ({
    default: () => null,
}));

const path = {
    id: 'path-1',
    tenant_id: 'tenant-1',
    name: 'Trilha editável',
    description: 'Trilha sem matrículas, própria para edição.',
    target_level: 'B1',
    category: 'GENERAL',
    estimated_hours: 6,
    active: true,
    created_at: '2026-08-31T12:00:00Z',
};

const units = [
    {
        id: 'unit-1',
        path_id: path.id,
        order_index: 1,
        title: 'Unidade Um',
        description: 'Primeira unidade',
        estimated_minutes: 30,
        skill_focus: ['grammar'],
    },
    {
        id: 'unit-2',
        path_id: path.id,
        order_index: 2,
        title: 'Unidade Dois',
        description: 'Segunda unidade',
        estimated_minutes: 30,
        skill_focus: ['speaking'],
    },
];

const activities = [
    {
        id: 'activity-1',
        unit_id: units[0].id,
        order_index: 1,
        type: 'quiz',
        title: 'Atividade Um',
        description: 'Primeira atividade',
        content: { questions: [] },
        xp_reward: 40,
        estimated_minutes: 5,
    },
    {
        id: 'activity-2',
        unit_id: units[0].id,
        order_index: 2,
        type: 'reading',
        title: 'Atividade Dois',
        description: 'Segunda atividade',
        content: { text: 'Read me' },
        xp_reward: 25,
        estimated_minutes: 8,
    },
];

const responseFor = (
    table: string,
    selectedColumns: string,
    filters: Record<string, unknown>,
    single: boolean,
) => {
    if (table === 'learning_paths') {
        return { data: single ? path : [path], error: null };
    }

    if (table === 'learning_units') {
        const selectedUnit = units.find((unit) => unit.id === filters.id) || units[0];
        return {
            data: single
                ? selectedColumns.includes('learning_paths')
                    ? { ...selectedUnit, learning_paths: path }
                    : selectedUnit
                : units,
            error: null,
        };
    }

    if (table === 'unit_activities') {
        const selectedActivity = activities.find((activity) => activity.id === filters.id) || activities[0];
        return {
            data: single
                ? selectedColumns.includes('learning_units')
                    ? {
                        ...selectedActivity,
                        learning_units: { ...units[0], learning_paths: path },
                    }
                    : selectedActivity
                : activities,
            error: null,
        };
    }

    if (table === 'student_path_enrollments') {
        return { data: [], error: null };
    }

    return { data: single ? null : [], error: null };
};

const queryFor = (table: string) => {
    let selectedColumns = '';
    const filters: Record<string, unknown> = {};
    const query: any = {};

    query.select = vi.fn((columns = '*') => {
        selectedColumns = columns;
        return query;
    });
    query.eq = vi.fn((column: string, value: unknown) => {
        filters[column] = value;
        return query;
    });
    query.or = vi.fn(() => query);
    query.order = vi.fn(() => Promise.resolve(responseFor(table, selectedColumns, filters, false)));
    query.limit = vi.fn(() => Promise.resolve(responseFor(table, selectedColumns, filters, false)));
    query.single = vi.fn(() => Promise.resolve(responseFor(table, selectedColumns, filters, true)));
    query.delete = vi.fn(() => {
        mocks.directDelete(table);
        return query;
    });
    query.update = vi.fn((payload: unknown) => {
        mocks.directUpdate(table, payload);
        return query;
    });

    return query;
};

const draggableCard = (title: string) => {
    const card = screen.getByText(title).closest('[draggable]');
    expect(card).not.toBeNull();
    return card as HTMLElement;
};

const lastButtonWithin = (element: HTMLElement) => {
    const buttons = within(element).getAllByRole('button');
    return buttons[buttons.length - 1];
};

const renderBuilder = () => render(
    <LearningPathsBuilder
        user={{ id: 'teacher-1', tenantId: 'tenant-1', role: 'TEACHER' }}
        tenantId="tenant-1"
    />,
);

const openPath = async () => {
    renderBuilder();
    fireEvent.click(await screen.findByRole('button', { name: /^editar$/i }));
    await screen.findByRole('button', { name: /nova unit/i });
};

const openUnit = async () => {
    await openPath();
    fireEvent.click(within(draggableCard('Unidade Um')).getByRole('button', { name: /atividades/i }));
    await screen.findByRole('button', { name: /nova atividade/i });
};

const openActivity = async () => {
    await openUnit();
    fireEvent.click(within(draggableCard('Atividade Um')).getByRole('button', { name: /^editar$/i }));
    await screen.findByRole('button', { name: /salvar alterações/i });
};

beforeEach(() => {
    vi.clearAllMocks();
    mocks.from.mockImplementation(queryFor);
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.spyOn(window, 'alert').mockImplementation(() => undefined);
});

afterEach(() => vi.restoreAllMocks());

describe('<LearningPathsBuilder /> — gravações autoritativas', () => {
    it('exclui e reordena unidades pelos RPCs, sem UPDATE ou DELETE direto', async () => {
        await openPath();

        const firstUnit = draggableCard('Unidade Um');
        const secondUnit = draggableCard('Unidade Dois');
        fireEvent.dragStart(firstUnit);
        fireEvent.dragOver(secondUnit);
        fireEvent.drop(secondUnit);

        await waitFor(() => {
            expect(mocks.rpc).toHaveBeenCalledWith('reorder_learning_units', {
                p_path_id: path.id,
                p_unit_ids: ['unit-2', 'unit-1'],
            });
        });

        fireEvent.click(lastButtonWithin(draggableCard('Unidade Dois')));

        await waitFor(() => {
            expect(mocks.rpc).toHaveBeenCalledWith('delete_learning_unit', {
                p_unit_id: 'unit-2',
            });
        });
        expect(mocks.directUpdate).not.toHaveBeenCalled();
        expect(mocks.directDelete).not.toHaveBeenCalled();
    });

    it('exclui e reordena atividades pelos RPCs, sem UPDATE ou DELETE direto', async () => {
        await openUnit();

        const firstActivity = draggableCard('Atividade Um');
        const secondActivity = draggableCard('Atividade Dois');
        fireEvent.dragStart(firstActivity);
        fireEvent.dragOver(secondActivity);
        fireEvent.drop(secondActivity);

        await waitFor(() => {
            expect(mocks.rpc).toHaveBeenCalledWith('reorder_unit_activities', {
                p_unit_id: 'unit-1',
                p_activity_ids: ['activity-2', 'activity-1'],
            });
        });

        fireEvent.click(lastButtonWithin(draggableCard('Atividade Dois')));

        await waitFor(() => {
            expect(mocks.rpc).toHaveBeenCalledWith('delete_unit_activity', {
                p_activity_id: 'activity-2',
            });
        });
        expect(mocks.directUpdate).not.toHaveBeenCalled();
        expect(mocks.directDelete).not.toHaveBeenCalled();
    });

    it('salva a atividade pelo RPC com o payload editado, sem UPDATE direto', async () => {
        await openActivity();

        const [title, description, content] = screen.getAllByRole('textbox');
        const [xpReward, estimatedMinutes] = screen.getAllByRole('spinbutton');
        fireEvent.change(title, { target: { value: 'Atividade revisada' } });
        fireEvent.change(description, { target: { value: 'Descrição revisada' } });
        fireEvent.change(xpReward, { target: { value: '55' } });
        fireEvent.change(estimatedMinutes, { target: { value: '12' } });
        fireEvent.change(content, {
            target: { value: JSON.stringify({ questions: [{ id: 'q1', answer: 'B' }] }) },
        });
        fireEvent.click(screen.getByRole('button', { name: /salvar alterações/i }));

        await waitFor(() => {
            expect(mocks.rpc).toHaveBeenCalledWith('update_unit_activity', {
                p_activity_id: 'activity-1',
                p_payload: {
                    title: 'Atividade revisada',
                    description: 'Descrição revisada',
                    xp_reward: 55,
                    estimated_minutes: 12,
                    content: { questions: [{ id: 'q1', answer: 'B' }] },
                },
            });
        });
        expect(mocks.directUpdate).not.toHaveBeenCalled();
        expect(mocks.directDelete).not.toHaveBeenCalled();
    });
});
