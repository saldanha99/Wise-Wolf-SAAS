import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import StudentBilling from './StudentBilling';

const mocks = vi.hoisted(() => ({
    from: vi.fn(),
    getSchoolInfo: vi.fn(),
}));

vi.mock('../lib/supabase', () => ({
    supabase: { from: mocks.from },
}));

vi.mock('../lib/schoolInfo', () => ({
    getSchoolInfo: mocks.getSchoolInfo,
}));

vi.mock('../lib/supportContact', () => ({
    buildSchoolSupportContact: () => null,
}));

vi.mock('./contexts/StudentContext', () => ({
    useStudentContext: () => ({
        data: {
            profile: { tenant_id: 'tenant-1', status_financial: 'SUSPENDED' },
            billing: { status: 'SUSPENDED', oldestDue: null },
        },
        loading: false,
    }),
}));

vi.mock('./BillingMethodManager', () => ({
    default: () => <div>Gestão da forma de pagamento</div>,
}));

const failedPaymentQuery = () => {
    const query = {
        select: vi.fn(),
        eq: vi.fn(),
        order: vi.fn(),
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.order.mockResolvedValue({
        data: null,
        error: new Error('billing unavailable'),
    });
    return query;
};

const successfulPaymentQuery = (data: any[]) => {
    const query = {
        select: vi.fn(),
        eq: vi.fn(),
        order: vi.fn(),
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.order.mockResolvedValue({ data, error: null });
    return query;
};

beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.getSchoolInfo.mockResolvedValue({ name: 'Escola Teste' });
});

afterEach(() => vi.restoreAllMocks());

describe('erro do financeiro do aluno', () => {
    it('não confunde falha de consulta com ausência de cobranças e permite tentar novamente', async () => {
        mocks.from.mockImplementation(() => failedPaymentQuery());

        render(<StudentBilling user={{ id: 'student-1', tenantId: 'tenant-1' }} />);

        expect(await screen.findByRole('alert')).toHaveTextContent(/cobranças indisponíveis/i);
        expect(screen.getAllByText(/histórico temporariamente indisponível/i)).not.toHaveLength(0);
        expect(screen.queryByText(/nenhum pagamento registrado no histórico/i)).not.toBeInTheDocument();
        expect(screen.getByText(/gestão da forma de pagamento/i)).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: /tentar novamente/i }));
        await waitFor(() => expect(mocks.from).toHaveBeenCalledTimes(2));
    });

    it('distingue CONFIRMED de pago e mantém a ação correta no cartão mobile', async () => {
        mocks.from.mockImplementation(() => successfulPaymentQuery([{
            id: 'payment-1',
            asaas_payment_id: 'pay_1',
            value: 169,
            status: 'CONFIRMED',
            due_date: '2026-08-30',
            payment_date: '2026-08-29',
            billing_type: 'PIX',
        }]));

        render(<StudentBilling user={{ id: 'student-1', tenantId: 'tenant-1' }} />);

        const badges = await screen.findAllByText('Aguardando crédito');
        expect(badges.some((badge) => badge.className.includes('text-sky-600'))).toBe(true);
        expect(screen.getByText('Confirmado · aguardando crédito')).toBeInTheDocument();
        expect(screen.queryByText('Nenhuma ação disponível.')).not.toBeInTheDocument();
    });
});
