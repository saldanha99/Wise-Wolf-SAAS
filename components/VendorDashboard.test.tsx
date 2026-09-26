import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import VendorDashboard from './VendorDashboard';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));

// Painel como o servidor devolve: uma indicação esperando a 1ª mensalidade,
// uma com cartão aprovado (em liquidação) e uma já liberada.
const panel = (overrides: Record<string, unknown> = {}) => ({
    ok: true,
    affiliate: {
        full_name: 'Gabriela Souza',
        affiliate_code: 'AFILIADA10',
        commission_cents: 4900,
        active: true,
        pix_key: null,
        pix_key_type: null,
        school_name: 'Wise Wolf',
    },
    totals: {
        referrals: 3, waiting_payment: 1, settling: 1, released: 1,
        pending_cents: 9800, available_cents: 4900, requested_cents: 0, paid_cents: 0,
    },
    referrals: [
        {
            id: 'c1', stage: 'AGUARDANDO_PAGAMENTO', status: 'PENDING', amount_cents: 4900,
            student_display: 'Maria S.', referred_at: '2026-09-25T13:00:00Z',
            confirmed_at: null, paid_at: null, attribution: 'COUPON_STAFF', coupon_code: 'AFILIADA10',
            first_payment: {
                billing_type: 'PIX', status: 'PENDING', due_date: '2026-10-10',
                paid_on: null, estimated_credit_on: null, credited_at: null,
            },
            withdrawal: null,
        },
        {
            id: 'c2', stage: 'EM_LIQUIDACAO', status: 'PENDING', amount_cents: 4900,
            student_display: 'João P.', referred_at: '2026-09-20T13:00:00Z',
            confirmed_at: null, paid_at: null, attribution: 'COUPON', coupon_code: 'AFILIADA10',
            first_payment: {
                billing_type: 'CREDIT_CARD', status: 'CONFIRMED', due_date: '2026-10-10',
                paid_on: '2026-09-21', estimated_credit_on: '2026-10-27', credited_at: null,
            },
            withdrawal: null,
        },
        {
            id: 'c3', stage: 'DISPONIVEL', status: 'CONFIRMED', amount_cents: 4900,
            student_display: 'Ana L.', referred_at: '2026-09-02T13:00:00Z',
            confirmed_at: '2026-09-05T15:00:00Z', paid_at: null, attribution: 'COUPON_STAFF',
            coupon_code: 'AFILIADA10', first_payment: null, withdrawal: null,
        },
    ],
    withdrawals: [],
    ...overrides,
});

beforeEach(() => {
    rpc.mockReset();
});

describe('painel do afiliado', () => {
    it('mostra o cupom, as etapas e quando cada comissão libera', async () => {
        rpc.mockResolvedValue({ data: panel(), error: null });
        render(<VendorDashboard user={{ id: 'u1' } as never} />);

        expect(await screen.findByText('AFILIADA10')).toBeInTheDocument();
        expect(screen.getByText('Aguardando pagamento')).toBeInTheDocument();
        expect(screen.getByText('Em liquidação')).toBeInTheDocument();
        expect(screen.getByText('Disponível para saque', { selector: 'span' })).toBeInTheDocument();
        expect(screen.getByText('Cartão aprovado — libera por volta de 27/10.')).toBeInTheDocument();
        expect(screen.getByText('1ª mensalidade vence em 10/10.')).toBeInTheDocument();
        expect(rpc).toHaveBeenCalledWith('get_my_affiliate_panel');
    });

    it('sem PIX o saque fica bloqueado e o painel pede a chave', async () => {
        rpc.mockResolvedValue({ data: panel(), error: null });
        render(<VendorDashboard user={{ id: 'u1' } as never} />);

        const button = await screen.findByRole('button', { name: /Solicitar R\$\s*49,00/ });
        expect(button).toBeDisabled();
        expect(screen.getByText('Cadastre sua chave PIX para poder sacar.')).toBeInTheDocument();
        expect(screen.getByLabelText('Chave PIX')).toBeInTheDocument();
    });

    it('salva o PIX pela porta do afiliado e recarrega o painel', async () => {
        rpc.mockImplementation(async (name: string) => (
            name === 'set_my_affiliate_pix'
                ? { data: { ok: true, pix_key: '12345678909', pix_key_type: 'CPF' }, error: null }
                : { data: panel(), error: null }
        ));
        render(<VendorDashboard user={{ id: 'u1' } as never} />);

        fireEvent.change(await screen.findByLabelText('Chave PIX'), { target: { value: '123.456.789-09' } });
        fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

        await waitFor(() => expect(rpc).toHaveBeenCalledWith('set_my_affiliate_pix', {
            p_pix_key: '123.456.789-09',
            p_pix_key_type: 'CPF',
        }));
        expect(await screen.findByText('Chave PIX salva.')).toBeInTheDocument();
    });

    it('com PIX e saldo liberado, pede o saque do valor disponível', async () => {
        const withPix = panel({
            affiliate: { ...panel().affiliate, pix_key: 'gabi@example.com', pix_key_type: 'EMAIL' },
        });
        rpc.mockImplementation(async (name: string) => (
            name === 'request_vendor_withdrawal'
                ? { data: { ok: true, amount_cents: 4900 }, error: null }
                : { data: withPix, error: null }
        ));
        render(<VendorDashboard user={{ id: 'u1' } as never} />);

        const button = await screen.findByRole('button', { name: /Solicitar R\$\s*49,00/ });
        expect(button).toBeEnabled();
        fireEvent.click(button);

        await waitFor(() => expect(rpc).toHaveBeenCalledWith('request_vendor_withdrawal'));
        expect(await screen.findByText(/solicitado\. A escola aprova e paga no seu PIX\./)).toBeInTheDocument();
    });

    it('papel errado vê a mensagem, não um painel vazio', async () => {
        rpc.mockResolvedValue({ data: { ok: false, error: 'FORBIDDEN' }, error: null });
        render(<VendorDashboard user={{ id: 'u1' } as never} />);
        expect(await screen.findByText('Esta área é exclusiva de afiliados.')).toBeInTheDocument();
    });
});
