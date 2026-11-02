import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import VendorOnboarding from './VendorOnboarding';

const { invoke, vendorOffer, getUser, signInWithPassword } = vi.hoisted(() => ({
    invoke: vi.fn(), vendorOffer: vi.fn(), getUser: vi.fn(), signInWithPassword: vi.fn(),
}));
vi.mock('../lib/supabase', () => ({ supabase: { functions: { invoke }, auth: { getUser, signInWithPassword } } }));
vi.mock('../services/tenantLegalAssetsService', () => ({
    tenantLegalAssetsService: { vendorOffer },
}));

const OFFER_ID = '11111111-2222-4333-8444-555555555555';

beforeEach(() => {
    invoke.mockReset();
    vendorOffer.mockReset();
    getUser.mockReset();
    signInWithPassword.mockReset();
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

describe('convite vinculado a conta de aluno', () => {
    const STUDENT_ID = 'aaaa1111-2222-4333-8444-555555555555';
    beforeEach(() => {
        vendorOffer.mockResolvedValue({
            kind: 'VENDOR_INVITE', commissionRate: 10900, suggestedName: 'Aluna Afiliada',
            affiliateCode: 'ALUNA10', schoolName: 'Wise Wolf', linkedStudentId: STUDENT_ID,
        });
        getUser.mockResolvedValue({ data: { user: { id: STUDENT_ID } }, error: null });
        invoke.mockResolvedValue({ data: { success: true, affiliateCode: 'ALUNA10' }, error: null });
    });

    it('usa o login de aluno sem criar senha nova e exige aceite', async () => {
        render(<VendorOnboarding />);
        expect(await screen.findByText('Vincule sua conta de aluno')).toBeInTheDocument();
        expect(screen.queryByLabelText('Nome completo')).toBeNull();
        expect(screen.queryByLabelText('WhatsApp')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Vincular minha conta de aluno' }));
        expect(invoke).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('checkbox'));
        fireEvent.click(screen.getByRole('button', { name: 'Vincular minha conta de aluno' }));
        await waitFor(() => expect(invoke).toHaveBeenCalledWith('register-vendor', {
            body: { offerPayload: OFFER_ID, acceptedTerms: true },
        }));
        expect(signInWithPassword).not.toHaveBeenCalled();
        expect(await screen.findByText(/Acesse Indicações na sua conta de aluno/)).toBeInTheDocument();
    });

    it('não aceita sessão de outro aluno', async () => {
        getUser.mockResolvedValue({ data: { user: { id: 'bbbb1111-2222-4333-8444-555555555555' } }, error: null });
        signInWithPassword.mockResolvedValue({ data: { user: { id: 'bbbb1111-2222-4333-8444-555555555555' } }, error: null });
        render(<VendorOnboarding />);
        await screen.findByText('Vincule sua conta de aluno');
        fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'outra@example.com' } });
        fireEvent.change(screen.getByLabelText('Senha'), { target: { value: 'segredo123' } });
        fireEvent.click(screen.getByRole('checkbox'));
        fireEvent.click(screen.getByRole('button', { name: 'Vincular minha conta de aluno' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('outra conta de aluno');
        expect(invoke).not.toHaveBeenCalled();
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

    const registerAndFinish = async () => {
        await screen.findByText('Programa de afiliados');
        fillAndAccept();
        fireEvent.click(screen.getByRole('button', { name: /Criar minha conta de afiliado/ }));
        await screen.findByText('Cadastro concluído!');
    };

    it('antes do cadastro o cupom aparece reservado, sem copiar: ele só vale quando a conta existe', async () => {
        render(<VendorOnboarding />);
        await screen.findByText('Programa de afiliados');

        expect(screen.getByText('Reservado para você')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Copiar/ })).toBeNull();
        // No cupom, a isenção vem com a condição; a promessa sem condição não aparece antes da conta.
        const ticket = within(screen.getByRole('group', { name: 'Seu cupom' }));
        expect(ticket.getByText(/^Vale assim que você criar sua conta/)).toBeInTheDocument();
        expect(ticket.queryByText('Quem se matricula com ele não paga a taxa de matrícula.')).toBeNull();
        expect(document.getElementById('aff-coupon-code')).not.toHaveClass('select-all');
    });

    it('depois do cadastro, copia o cupom que o servidor confirmou; se o navegador recusar, diz e deixa o código selecionado', async () => {
        invoke.mockResolvedValue({ data: { success: true, affiliateCode: 'AFILIADA10' }, error: null });
        const writeText = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
        render(<VendorOnboarding />);
        await registerAndFinish();

        expect(screen.getByText('Quem se matricula com ele não paga a taxa de matrícula.')).toBeInTheDocument();
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

    it('cupom trocado no cadastro: a conclusão mostra o que ficou na conta, não o do convite', async () => {
        invoke.mockResolvedValue({ data: { success: true, affiliateCode: 'GABRIELA7K2' }, error: null });
        render(<VendorOnboarding />);
        await registerAndFinish();

        expect(screen.getAllByText('GABRIELA7K2').length).toBeGreaterThan(0);
        expect(screen.queryByText('AFILIADA10')).toBeNull();
    });

    it('servidor sem o cupom na resposta: a conclusão não oferece copiar nem cita o cupom do convite', async () => {
        invoke.mockResolvedValue({ data: { success: true }, error: null });
        render(<VendorOnboarding />);
        await registerAndFinish();

        expect(screen.queryByRole('button', { name: /Copiar/ })).toBeNull();
        expect(screen.queryByText('AFILIADA10')).toBeNull();
        expect(screen.getByText(/o seu cupom, as suas indicações/)).toBeInTheDocument();
    });

    it('copiar pelo teclado quando a API de clipboard falha: o foco continua no botão', async () => {
        invoke.mockResolvedValue({ data: { success: true, affiliateCode: 'AFILIADA10' }, error: null });
        Object.defineProperty(navigator, 'clipboard', {
            value: { writeText: vi.fn().mockRejectedValue(new Error('NotAllowedError')) },
            configurable: true,
        });
        Object.defineProperty(document, 'execCommand', { value: vi.fn().mockReturnValue(true), configurable: true });
        // No navegador, select() leva o foco ao textarea escondido do caminho antigo.
        const select = vi.spyOn(HTMLTextAreaElement.prototype, 'select').mockImplementation(function (this: HTMLTextAreaElement) {
            this.focus();
        });
        render(<VendorOnboarding />);
        await registerAndFinish();

        const copy = screen.getByRole('button', { name: 'Copiar' });
        copy.focus();
        fireEvent.click(copy);
        expect(await screen.findByText('Cupom copiado. É só colar na conversa.')).toBeInTheDocument();
        expect(select).toHaveBeenCalled();
        expect(document.activeElement).toBe(screen.getByRole('button', { name: /Copiado/ }));
        select.mockRestore();
    });

    it('o código do cupom nunca quebra no meio', async () => {
        render(<VendorOnboarding />);
        await screen.findByText('Programa de afiliados');
        const code = document.getElementById('aff-coupon-code');
        expect(code).toHaveTextContent('AFILIADA10');
        expect(code).toHaveClass('whitespace-nowrap');
        expect(code?.className).not.toMatch(/break-all/);
        expect(code?.dataset.size).toBe('xl');
    });

    it('sobre a cor da escola só há texto branco sólido (a trava de contraste mede isso)', async () => {
        vendorOffer.mockResolvedValue({
            kind: 'VENDOR_INVITE',
            commissionRate: 10900,
            suggestedName: 'Gabriela Rodrigues Lopes',
            affiliateCode: 'AFILIADA10',
            schoolName: 'Future Sights',
            brandPrimary: '#2563EB',
        });
        const { container } = render(<VendorOnboarding />);
        await screen.findByText('Programa de afiliados');

        expect(container.querySelector('main')?.style.getPropertyValue('--aff-rgb')).toBe('37 99 235');
        const onBrand = [container.querySelector('header'), screen.getByRole('group', { name: 'Seu cupom' })];
        for (const region of onBrand) {
            const translucent = Array.from(region?.querySelectorAll('*') ?? [])
                .filter(element => /(^|\s)text-white\/|(^|\s)bg-white\/\d/.test(element.getAttribute('class') || ''));
            expect(translucent.map(element => element.textContent)).toEqual([]);
        }
    });

    it('a nota dos prazos, fora de cartão, não usa o cinza que reprova no fundo da página', async () => {
        render(<VendorOnboarding />);
        await screen.findByText('Programa de afiliados');
        const note = screen.getByText('No cartão, o painel mostra a data prevista quando o pagamento é aprovado.');
        expect(note).not.toHaveClass('text-slate-500');
        expect(note).toHaveClass('text-slate-600');
    });

    it('o formulário só fica fixo na rolagem no computador com janela alta (senão o botão some abaixo da dobra)', async () => {
        render(<VendorOnboarding />);
        await screen.findByText('Programa de afiliados');
        const form = document.querySelector('section[aria-labelledby="aff-form-title"]');
        const classes = (form?.getAttribute('class') || '').split(/\s+/);
        expect(classes).not.toContain('lg:sticky');
        expect(classes).toContain('[@media(min-width:1024px)_and_(min-height:840px)]:sticky');
        expect(classes).toContain('[@media(min-width:1024px)_and_(min-height:840px)]:overflow-y-auto');
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
