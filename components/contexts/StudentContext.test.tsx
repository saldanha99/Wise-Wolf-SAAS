import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StudentProvider } from './StudentContext';

const mocks = vi.hoisted(() => ({
    invoke: vi.fn(),
    getSchoolInfo: vi.fn(),
}));

vi.mock('../../lib/supabase', () => ({
    supabase: { functions: { invoke: mocks.invoke } },
}));

vi.mock('../../lib/schoolInfo', () => ({
    getSchoolInfo: mocks.getSchoolInfo,
}));

vi.mock('../../lib/supportContact', () => ({
    buildSchoolSupportContact: () => ({
        href: 'https://support.example.invalid',
        label: 'Falar com o suporte',
    }),
}));

vi.mock('../StudentBilling', () => ({
    default: ({ user }: { user: { id: string; tenantId: string } }) => (
        <div>Financeiro seguro de {user.id} em {user.tenantId}</div>
    ),
}));

vi.mock('../ContractView', () => ({
    default: ({ userId }: { userId: string }) => <div>Contrato seguro de {userId}</div>,
}));

const context = (overrides: Record<string, unknown> = {}) => ({
    profile: { id: 'student-1', role: 'STUDENT', tenant_id: 'tenant-1' },
    gamification: { xp: 0, level: 1, streak: 0, nextLevelProgress: 0 },
    billing: { status: 'OK', oldestDue: null },
    access: { status: 'ACTIVE', enrollmentState: 'COMPLETED' },
    nextClass: null,
    ...overrides,
});

const renderProvider = (onLogout = vi.fn()) => render(
    <StudentProvider
        userId="student-1"
        tenantId="tenant-1"
        onLogout={onLogout}
    >
        <div>Conteúdo pedagógico</div>
    </StudentProvider>,
);

beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSchoolInfo.mockResolvedValue({ name: 'Escola Teste' });
});

describe('restrição segura do portal do aluno', () => {
    it('mantém financeiro, contrato, suporte e logout na suspensão financeira', async () => {
        const onLogout = vi.fn();
        mocks.invoke.mockResolvedValue({
            data: context({ billing: { status: 'SUSPENDED', oldestDue: '2026-08-20' } }),
            error: null,
        });

        renderProvider(onLogout);

        expect(await screen.findByRole('heading', { name: /acesso pedagógico temporariamente suspenso/i })).toBeInTheDocument();
        expect(await screen.findByText(/financeiro seguro de student-1/i)).toBeInTheDocument();
        expect(screen.queryByText('Conteúdo pedagógico')).not.toBeInTheDocument();
        expect(await screen.findByRole('link', { name: /falar com o suporte/i })).toHaveAttribute('href', 'https://support.example.invalid');

        fireEvent.click(screen.getByRole('button', { name: 'Contrato' }));
        expect(await screen.findByText(/contrato seguro de student-1/i)).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Sair' }));
        expect(onLogout).toHaveBeenCalledOnce();
    });

    it('bloqueia pedagogia enquanto a matrícula autoritativa aguarda pagamento', async () => {
        mocks.invoke.mockResolvedValue({
            data: context({
                access: { status: 'PENDING_ACTIVATION', enrollmentState: 'AWAITING_PAYMENT' },
            }),
            error: null,
        });

        renderProvider();

        expect(await screen.findByRole('heading', { name: /conclua o pagamento para liberar seus estudos/i })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /verificar pagamento/i })).toBeInTheDocument();
        expect(await screen.findByText(/financeiro seguro de student-1/i)).toBeInTheDocument();
        expect(screen.queryByText('Conteúdo pedagógico')).not.toBeInTheDocument();
    });

    it('mostra erro explícito se o logout falhar no modo restrito', async () => {
        const onLogout = vi.fn().mockRejectedValue(new Error('logout unavailable'));
        mocks.invoke.mockResolvedValue({
            data: context({ billing: { status: 'SUSPENDED', oldestDue: '2026-08-20' } }),
            error: null,
        });

        renderProvider(onLogout);

        fireEvent.click(await screen.findByRole('button', { name: 'Sair' }));
        expect(await screen.findByRole('alert')).toHaveTextContent(/não foi possível encerrar a sessão/i);
    });

    it('mostra erro explícito e não libera conteúdo quando o contexto falha', async () => {
        mocks.invoke.mockResolvedValue({ data: null, error: new Error('offline') });

        renderProvider();

        expect(await screen.findByRole('heading', { name: /não foi possível validar seu acesso/i })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /tentar novamente/i })).toBeInTheDocument();
        expect(screen.queryByText('Conteúdo pedagógico')).not.toBeInTheDocument();
    });
});
