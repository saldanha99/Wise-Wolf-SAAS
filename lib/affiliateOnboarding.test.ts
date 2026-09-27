import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    contrastWithWhite,
    copyTextToClipboard,
    firstName,
    functionErrorText,
    resolveAffiliateBrand,
    schoolMonogram,
    validateAffiliateSignup,
    vendorRegistrationErrorMessage,
} from './affiliateOnboarding';
import {
    affiliateGuideSteps,
    affiliateJourney,
    affiliateProgramRules,
} from './affiliateProgram';

describe('marca da escola na página do convite', () => {
    it('usa a cor da escola quando o texto branco fica legível (AA)', () => {
        const brand = resolveAffiliateBrand({
            brandPrimary: '#06142D',
            brandSecondary: '#320606',
            schoolLogoUrl: 'https://api.example.test/logo.png',
        });
        expect(brand).toEqual({
            primary: '#06142D',
            primaryRgb: '6 20 45',
            secondary: '#320606',
            logoUrl: 'https://api.example.test/logo.png',
        });
    });

    it('cor clara demais para texto branco cai no padrão do app', () => {
        expect(contrastWithWhite('#FACC15')).toBeLessThan(4.5);
        const brand = resolveAffiliateBrand({ brandPrimary: '#FACC15', brandSecondary: '#FDE68A' });
        expect(brand.primary).toBe('#002366');
        expect(brand.secondary).toBeNull();
    });

    it('sem marca, com valor fora do formato ou logo sem https: padrão, sem logo', () => {
        expect(resolveAffiliateBrand(null)).toEqual({ primary: '#002366', primaryRgb: '0 35 102', secondary: null, logoUrl: null });
        const brand = resolveAffiliateBrand({ brandPrimary: 'navy', schoolLogoUrl: 'http://x.test/logo.png' });
        expect(brand.primary).toBe('#002366');
        expect(brand.logoUrl).toBeNull();
    });

    it('iniciais da escola e primeiro nome da pessoa', () => {
        expect(schoolMonogram('Wise Wolf Languages')).toBe('WW');
        expect(schoolMonogram('  ')).toBe('');
        expect(firstName('Gabriela Rodrigues Lopes')).toBe('Gabriela');
        expect(firstName(null)).toBe('');
    });
});

describe('validação do cadastro (espelha o register-vendor)', () => {
    const valid = { name: 'Gabriela Souza', email: 'gabi@example.com', password: 'senha-forte-1', phone: '', acceptedTerms: true };

    it('aceita o cadastro completo; WhatsApp é opcional', () => {
        expect(validateAffiliateSignup(valid)).toBeNull();
        expect(validateAffiliateSignup({ ...valid, phone: '(11) 99999-9999' })).toBeNull();
    });

    it('aponta o primeiro campo obrigatório vazio', () => {
        expect(validateAffiliateSignup({ ...valid, name: '  ' })).toEqual({ field: 'name', message: 'Preencha todos os campos obrigatórios.' });
        expect(validateAffiliateSignup({ ...valid, email: '' })?.field).toBe('email');
        expect(validateAffiliateSignup({ ...valid, password: '' })?.field).toBe('password');
    });

    it('recusa e-mail incompleto, senha curta e WhatsApp sem DDD', () => {
        expect(validateAffiliateSignup({ ...valid, email: 'gabi@example' })?.field).toBe('email');
        expect(validateAffiliateSignup({ ...valid, password: '1234567' })).toEqual({
            field: 'password',
            message: 'A senha precisa ter pelo menos 8 caracteres.',
        });
        expect(validateAffiliateSignup({ ...valid, phone: '99999-9999' })?.field).toBe('phone');
    });

    it('sem o aceite das regras, não envia', () => {
        expect(validateAffiliateSignup({ ...valid, acceptedTerms: false })).toEqual({
            field: 'terms',
            message: 'Para continuar, confirme que leu e concorda com as regras do programa.',
        });
    });
});

describe('erros do cadastro em português de gente', () => {
    it('traduz as respostas do register-vendor', () => {
        expect(vendorRegistrationErrorMessage('Revise os dados obrigatorios do cadastro.')).toMatch(/^Revise os dados/);
        expect(vendorRegistrationErrorMessage('Convite invalido, expirado ou em processamento.')).toMatch(/Peça um novo link à escola/);
        expect(vendorRegistrationErrorMessage('Nao foi possivel concluir o cadastro.')).toMatch(/entre pelo login/);
        expect(vendorRegistrationErrorMessage('User already registered')).toBe('Este e-mail já está cadastrado.');
    });

    it('a mensagem técnica do supabase-js não chega na tela', () => {
        expect(vendorRegistrationErrorMessage('Edge Function returned a non-2xx status code'))
            .toBe('Não foi possível criar a sua conta agora. Tente de novo em instantes.');
        expect(vendorRegistrationErrorMessage('')).toMatch(/^Não foi possível criar/);
    });

    it('lê o corpo do erro não-2xx e cai na mensagem quando não há corpo', async () => {
        const withBody = { message: 'Edge Function returned a non-2xx status code', context: new Response(JSON.stringify({ error: 'Convite invalido, expirado ou em processamento.' }), { status: 400 }) };
        await expect(functionErrorText(withBody)).resolves.toBe('Convite invalido, expirado ou em processamento.');
        const htmlBody = { message: 'falhou', context: new Response('<html>502</html>', { status: 502 }) };
        await expect(functionErrorText(htmlBody)).resolves.toBe('falhou');
        await expect(functionErrorText(new Error('rede'))).resolves.toBe('rede');
    });
});

describe('copiar o cupom', () => {
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    afterEach(() => {
        if (original) Object.defineProperty(navigator, 'clipboard', original);
        else delete (navigator as { clipboard?: unknown }).clipboard;
        Reflect.deleteProperty(document, 'execCommand');
        vi.restoreAllMocks();
    });

    it('usa a API de clipboard quando ela existe', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
        await expect(copyTextToClipboard('AFILIADA10')).resolves.toBe(true);
        expect(writeText).toHaveBeenCalledWith('AFILIADA10');
    });

    it('permissão negada: tenta o caminho antigo e diz se não deu', async () => {
        Object.defineProperty(navigator, 'clipboard', {
            value: { writeText: vi.fn().mockRejectedValue(new Error('NotAllowedError')) },
            configurable: true,
        });
        const execCommand = vi.fn().mockReturnValue(false);
        Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true });
        await expect(copyTextToClipboard('AFILIADA10')).resolves.toBe(false);
        expect(execCommand).toHaveBeenCalledWith('copy');
        expect(document.querySelector('textarea')).toBeNull();
    });
});

describe('texto do programa: uma fonte só', () => {
    it('a linha do tempo cobre os cinco passos do guia, na ordem, sem reescrever nenhum', () => {
        const steps = affiliateGuideSteps(10900, 'AFILIADA10');
        const journey = affiliateJourney(10900, 'AFILIADA10');
        expect(journey.map(stage => stage.id)).toEqual(['INDICAR', 'MATRICULA', 'LIQUIDACAO', 'SAQUE']);
        expect(journey.flatMap(stage => stage.details)).toEqual(steps);
        expect(journey.find(stage => stage.id === 'LIQUIDACAO')?.showsSettlement).toBe(true);
    });

    it('comissão e cupom do convite entram no texto', () => {
        const [cupom, , reserva] = affiliateGuideSteps(10900, 'AFILIADA10');
        expect(cupom.text).toContain('o seu é AFILIADA10');
        expect(reserva.text).toMatch(/R\$\s109,00/);
        expect(affiliateProgramRules(10900)[0]).toMatch(/^Comissão fixa de R\$\s109,00 por matrícula/);
        expect(affiliateGuideSteps(null, null)[0].text).toContain('SEU CUPOM');
    });
});
