import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { User, UserRole } from '../types';
import ProtectedRoute, { isUserAccessInactive } from './ProtectedRoute';

const activeTeacher: User = {
    id: 'teacher-1',
    tenantId: 'school-1',
    name: 'Professora Teste',
    email: 'teacher@example.invalid',
    role: UserRole.TEACHER,
    status: 'Ativo',
    lifecycleStatus: 'active',
};

describe('ProtectedRoute administrative access guard', () => {
    it('renders the protected content for an active user', () => {
        render(
            <ProtectedRoute user={activeTeacher} onLogout={vi.fn()}>
                <div>conteúdo privado</div>
            </ProtectedRoute>,
        );

        expect(screen.getByText('conteúdo privado')).toBeInTheDocument();
    });

    it.each([
        [{ status: 'Inativo' }, true],
        [{ status: 'BLOCKED' }, true],
        [{ lifecycleStatus: 'suspended' }, true],
        [{ lifecycleStatus: 'offboarded' }, true],
        [{ status: 'Ativo', lifecycleStatus: 'active' }, false],
    ])('normalizes status and lifecycle values: %o', (state, expected) => {
        expect(isUserAccessInactive({ ...activeTeacher, ...state })).toBe(expected);
    });

    it('blocks an offboarded user and keeps only the logout action', () => {
        const onLogout = vi.fn();
        render(
            <ProtectedRoute
                user={{ ...activeTeacher, lifecycleStatus: 'offboarded' }}
                onLogout={onLogout}
            >
                <div>conteúdo privado</div>
            </ProtectedRoute>,
        );

        expect(screen.queryByText('conteúdo privado')).not.toBeInTheDocument();
        expect(screen.getByRole('heading', { name: 'Acesso Desativado' })).toBeInTheDocument();
        expect(screen.queryByRole('link', { name: /pagar agora/i })).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Sair da Conta' }));
        expect(onLogout).toHaveBeenCalledOnce();
    });
});
