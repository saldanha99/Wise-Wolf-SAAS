import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PathAssignmentModal from './PathAssignmentModal';

const mocks = vi.hoisted(() => ({
    from: vi.fn(),
    rpc: vi.fn(),
}));

vi.mock('../lib/supabase', () => ({
    supabase: {
        from: mocks.from,
        rpc: mocks.rpc,
    },
}));

const student = {
    id: 'student-1',
    full_name: 'Aluno Teste',
    email: 'aluno@example.invalid',
    module: 'A1',
    status: 'Ativo',
    lifecycle_status: 'active',
    offboarding_status: null,
};

const queryFor = (table: string, enrollment?: { pathId: string; status: 'ACTIVE' | 'COMPLETED'; completedAt: string | null }) => {
    const query: any = {};
    query.select = vi.fn(() => query);
    query.eq = vi.fn(() => query);
    query.in = vi.fn(() => query);
    query.order = vi.fn().mockResolvedValue({
        data: table === 'profiles'
            ? [student]
            : table === 'student_path_enrollments' && enrollment
                ? [{
                    student_id: student.id,
                    path_id: enrollment.pathId,
                    status: enrollment.status,
                    completed_at: enrollment.completedAt,
                }]
                : [],
        error: null,
    });
    return query;
};

beforeEach(() => {
    vi.clearAllMocks();
    mocks.from.mockImplementation((table: string) => queryFor(table));
    mocks.rpc.mockResolvedValue({ data: { status: 'ACTIVE' }, error: null });
});

describe('<PathAssignmentModal /> — atribuição autoritativa', () => {
    it('atribui um aluno pelo RPC sem escrever matrícula diretamente', async () => {
        render(
            <PathAssignmentModal
                path={{ id: 'path-new', name: 'Trilha Premium', target_level: 'A1' }}
                user={{ id: 'admin-1', role: 'SCHOOL_ADMIN' }}
                tenantId="tenant-1"
                onClose={vi.fn()}
            />,
        );

        expect(await screen.findByRole('dialog', { name: /trilha premium/i })).toHaveFocus();
        fireEvent.click(screen.getByRole('button', { name: /aluno teste/i }));
        fireEvent.click(screen.getByRole('button', { name: /^atribuir$/i }));

        await waitFor(() => {
            expect(mocks.rpc).toHaveBeenCalledWith('enroll_student_learning_path', {
                p_path_id: 'path-new',
                p_switch_current: false,
                p_reason: null,
                p_student_id: student.id,
            });
        });
        expect(await screen.findByText(/1 aluno recebeu a trilha/i)).toBeInTheDocument();
        expect(mocks.from.mock.calls.map(([table]) => table)).not.toContain('student_activity_progress');
    });

    it('exige motivo auditável antes de trocar uma trilha ativa', async () => {
        mocks.from.mockImplementation((table: string) => queryFor(
            table,
            table === 'student_path_enrollments'
                ? { pathId: 'path-old', status: 'ACTIVE', completedAt: null }
                : undefined,
        ));

        render(
            <PathAssignmentModal
                path={{ id: 'path-new', name: 'Nova Trilha', target_level: 'A2' }}
                user={{ id: 'admin-1', role: 'SCHOOL_ADMIN' }}
                tenantId="tenant-1"
                onClose={vi.fn()}
            />,
        );

        fireEvent.click(await screen.findByRole('button', { name: /aluno teste/i }));
        expect(screen.getByText(/trocará de trilha ativa/i)).toBeInTheDocument();
        const assign = screen.getByRole('button', { name: /^atribuir$/i });
        expect(assign).toBeDisabled();

        fireEvent.change(screen.getByLabelText(/motivo pedagógico da troca/i), {
            target: { value: 'Adequação ao objetivo atual do aluno' },
        });
        expect(assign).toBeEnabled();
        fireEvent.click(assign);

        await waitFor(() => {
            expect(mocks.rpc).toHaveBeenCalledWith('enroll_student_learning_path', {
                p_path_id: 'path-new',
                p_switch_current: true,
                p_reason: 'Adequação ao objetivo atual do aluno',
                p_student_id: student.id,
            });
        });
    });

    it('mantém uma trilha concluída como histórico e não permite reinscrição acidental', async () => {
        mocks.from.mockImplementation((table: string) => queryFor(
            table,
            table === 'student_path_enrollments'
                ? { pathId: 'path-new', status: 'COMPLETED', completedAt: '2026-08-31T12:00:00Z' }
                : undefined,
        ));

        render(
            <PathAssignmentModal
                path={{ id: 'path-new', name: 'Trilha Concluída', target_level: 'A1' }}
                user={{ id: 'admin-1', role: 'SCHOOL_ADMIN' }}
                tenantId="tenant-1"
                onClose={vi.fn()}
            />,
        );

        const completedStudent = await screen.findByRole('button', { name: /aluno teste/i });
        expect(completedStudent).toBeDisabled();
        expect(within(completedStudent).getByText(/^trilha concluída$/i)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /^atribuir$/i })).toBeDisabled();

        fireEvent.click(completedStudent);
        expect(mocks.rpc).not.toHaveBeenCalled();
    });
});
