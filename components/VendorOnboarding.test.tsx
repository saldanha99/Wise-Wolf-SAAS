import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import VendorOnboarding from './VendorOnboarding';

const { invoke, vendorOffer } = vi.hoisted(() => ({ invoke: vi.fn(), vendorOffer: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { functions: { invoke } } }));
vi.mock('../services/tenantLegalAssetsService', () => ({
    tenantLegalAssetsService: { vendorOffer },
}));

const OFFER_ID = '11111111-2222-4333-8444-555555555555';

beforeEach(() => {
    invoke.mockReset();
    vendorOffer.mockReset();
    window.history.pushState({}, '', `/vendor-onboarding?offer=${OFFER_ID}`);
    vendorOffer.mockResolvedValue({
        kind: 'VENDOR_INVITE',
        commissionRate: 4900,
        suggestedName: 'Gabriela Souza',
        affiliateCode: 'AFILIADA10',
        schoolName: 'Wise Wolf',
        tenantId: 'school-wise-wolf',
        _offerId: OFFER_ID,
    });
});

afterEach(() => {
    window.history.pushState({}, '', '/');
});

describe('cadastro do afiliado pelo convite', () => {
    it('explica o programa com o cupom, a comissão e a liquidação antes do formulário', async () => {
        render(<VendorOnboarding />);

        expect(await screen.findByText('Programa de afiliados')).toBeInTheDocument();
        expect(screen.getAllByText('AFILIADA10').length).toBeGreaterThan(0);
        expect(screen.getByText('Como funciona')).toBeInTheDocument();
        expect(screen.getByText(/A comissão é liberada na liquidação da 1ª mensalidade/)).toBeInTheDocument();
        expect(screen.getByText(/até cerca de 30 dias depois da aprovação/)).toBeInTheDocument();
        expect(screen.getByDisplayValue('Gabriela Souza')).toBeInTheDocument();
    });

    it('não cria a conta sem o aceite das regras', async () => {
        render(<VendorOnboarding />);
        await screen.findByText('Programa de afiliados');

        fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'gabi@example.com' } });
        fireEvent.change(screen.getByLabelText('Senha'), { target: { value: 'senha-forte-1' } });
        fireEvent.click(screen.getByRole('button', { name: /Criar minha conta de afiliado/ }));

        expect(await screen.findByRole('alert')).toHaveTextContent('confirme que leu e concorda');
        expect(invoke).not.toHaveBeenCalled();
    });

    it('com o aceite, envia o cadastro com acceptedTerms e mostra o próximo passo', async () => {
        invoke.mockResolvedValue({ data: { success: true }, error: null });
        render(<VendorOnboarding />);
        await screen.findByText('Programa de afiliados');

        fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'gabi@example.com' } });
        fireEvent.change(screen.getByLabelText('Senha'), { target: { value: 'senha-forte-1' } });
        fireEvent.click(screen.getByRole('checkbox'));
        fireEvent.click(screen.getByRole('button', { name: /Criar minha conta de afiliado/ }));

        await waitFor(() => expect(invoke).toHaveBeenCalledWith('register-vendor', {
            body: expect.objectContaining({
                email: 'gabi@example.com',
                name: 'Gabriela Souza',
                offerPayload: OFFER_ID,
                acceptedTerms: true,
            }),
        }));
        expect(await screen.findByText('Cadastro concluído!')).toBeInTheDocument();
    });
});
