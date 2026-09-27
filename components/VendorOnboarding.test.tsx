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

describe('página do convite: marca, cupom e estados', () => {
    const fillAndAccept = () => {
        fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'gabi@example.com' } });
        fireEvent.change(screen.getByLabelText('Senha'), { target: { value: 'senha-forte-1' } });
        fireEvent.click(screen.getByRole('checkbox'));
    };

    afterEach(() => {
        Reflect.deleteProperty(navigator, 'clipboard');
        Reflect.deleteProperty(document, 'execCommand');
    });

    it('usa a cor e o logo da escola quando o convite traz a marca', async () => {
        vendorOffer.mockResolvedValue({
            kind: 'VENDOR_INVITE',
            commissionRate: 10900,
            suggestedName: 'Gabriela Rodrigues Lopes',
            affiliateCode: 'AFILIADA10',
            schoolName: 'Wise Wolf Languages',
            brandPrimary: '#06142D',
            schoolLogoUrl: 'https://api.example.test/logo.png',
        });
        const { container } = render(<VendorOnboarding />);

        expect(await screen.findByText('Programa de afiliados')).toBeInTheDocument();
        expect(container.querySelector('main')?.style.getPropertyValue('--aff-rgb')).toBe('6 20 45');
        expect(container.querySelector('img')?.getAttribute('src')).toBe('https://api.example.test/logo.png');
        expect(screen.getByText('Convite pessoal para Gabriela')).toBeInTheDocument();
        expect(screen.getAllByText(/R\$\s109,00/).length).toBeGreaterThan(0);
    });

    it('sem marca no convite, vale a cor padrão do app', async () => {
        const { container } = render(<VendorOnboarding />);
        await screen.findByText('Programa de afiliados');
        expect(container.querySelector('main')?.style.getPropertyValue('--aff-rgb')).toBe('0 35 102');
        expect(container.querySelector('img')).toBeNull();
    });

    it('copia o cupom e avisa; se o navegador recusar, diz e deixa o código selecionado', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
        render(<VendorOnboarding />);
        await screen.findByText('Programa de afiliados');

        fireEvent.click(screen.getByRole('button', { name: 'Copiar' }));
        expect(await screen.findByText('Cupom copiado. É só colar na conversa.')).toBeInTheDocument();
        expect(writeText).toHaveBeenCalledWith('AFILIADA10');

        writeText.mockRejectedValue(new Error('NotAllowedError'));
        Object.defineProperty(document, 'execCommand', { value: vi.fn().mockReturnValue(false), configurable: true });
        fireEvent.click(screen.getByRole('button', { name: /Copia/ }));
        expect(await screen.findByText(/Não deu para copiar automaticamente/)).toBeInTheDocument();
        expect(window.getSelection()?.toString()).toBe('AFILIADA10');
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('mostra o carregando no botão e traduz o erro do servidor', async () => {
        let reject: (reason: unknown) => void = () => undefined;
        invoke.mockReturnValue(new Promise((_, rejectPromise) => { reject = rejectPromise; }));
        render(<VendorOnboarding />);
        await screen.findByText('Programa de afiliados');
        fillAndAccept();
        fireEvent.click(screen.getByRole('button', { name: /Criar minha conta de afiliado/ }));

        const busy = await screen.findByRole('button', { name: /Criando sua conta/ });
        expect(busy).toBeDisabled();

        reject({
            message: 'Edge Function returned a non-2xx status code',
            context: new Response(JSON.stringify({ error: 'Convite invalido, expirado ou em processamento.' }), { status: 400 }),
        });
        expect(await screen.findByRole('alert')).toHaveTextContent('Peça um novo link à escola');
        expect(screen.getByRole('button', { name: /Criar minha conta de afiliado/ })).toBeEnabled();
    });

    it('e-mail incompleto não chega ao servidor e o campo fica marcado', async () => {
        render(<VendorOnboarding />);
        await screen.findByText('Programa de afiliados');
        fillAndAccept();
        fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'gabi@example' } });
        fireEvent.click(screen.getByRole('button', { name: /Criar minha conta de afiliado/ }));

        expect(await screen.findByRole('alert')).toHaveTextContent('Confira o e-mail');
        expect(screen.getByLabelText('E-mail')).toHaveAttribute('aria-invalid', 'true');
        expect(screen.getByLabelText('E-mail')).toHaveFocus();
        expect(invoke).not.toHaveBeenCalled();
    });

    it('convite vencido ou usado: explica e não mostra o formulário', async () => {
        vendorOffer.mockResolvedValue({ error: 'OFFER_EXPIRED' });
        render(<VendorOnboarding />);

        expect(await screen.findByText('Não foi possível abrir o convite')).toBeInTheDocument();
        expect(screen.getByText(/inválido, expirado ou já utilizado/)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Criar minha conta de afiliado/ })).toBeNull();
    });

    it('as regras completas ficam na página e o link leva até elas', async () => {
        render(<VendorOnboarding />);
        await screen.findByText('Programa de afiliados');

        expect(screen.getByText(/Aula avulsa não gera comissão/)).toBeInTheDocument();
        expect(screen.getByText(/vale o primeiro cupom informado/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Ler as regras completas' }));
        expect(document.getElementById('regras-do-programa')).toHaveFocus();
    });
});
