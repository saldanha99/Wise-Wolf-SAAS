import { beforeEach, describe, expect, it } from 'vitest';
import {
    ENROLLMENT_DRAFT_TTL_MS,
    clearEnrollmentDraft,
    loadEnrollmentDraft,
    saveEnrollmentDraft,
    type EnrollmentDraft,
} from './enrollmentDraft';

const draft: EnrollmentDraft = {
    name: 'Aluna Teste',
    email: 'aluna@example.com',
    phone: '(11) 90000-0000',
    cpf: '000.000.000-00',
    postalCode: '01000-000',
    address: 'Rua X',
    addressNumber: '10',
    billingType: 'CREDIT_CARD',
};

describe('rascunho da matrícula', () => {
    beforeEach(() => window.localStorage.clear());

    it('volta depois do F5, por link', () => {
        saveEnrollmentDraft('oferta-1', draft);
        expect(loadEnrollmentDraft('oferta-1')).toEqual(draft);
        expect(loadEnrollmentDraft('oferta-2')).toBeNull();
    });

    it('nunca guarda senha nem cartão', () => {
        saveEnrollmentDraft('oferta-1', { ...draft, password: 'segredo', ccNumber: '4111111111111111', ccCcv: '123' } as EnrollmentDraft);
        const raw = window.localStorage.getItem('wisewolf.enrollmentDraft.oferta-1') || '';
        expect(raw).not.toContain('segredo');
        expect(raw).not.toContain('4111');
        expect(raw).not.toContain('ccCcv');
    });

    it('vence em 7 dias e some ao concluir', () => {
        saveEnrollmentDraft('oferta-1', draft, 0);
        expect(loadEnrollmentDraft('oferta-1', ENROLLMENT_DRAFT_TTL_MS + 1)).toBeNull();
        expect(window.localStorage.getItem('wisewolf.enrollmentDraft.oferta-1')).toBeNull();

        saveEnrollmentDraft('oferta-1', draft);
        clearEnrollmentDraft('oferta-1');
        expect(loadEnrollmentDraft('oferta-1')).toBeNull();
    });

    it('formulário vazio não deixa rastro e lixo é ignorado', () => {
        saveEnrollmentDraft('oferta-1', { ...draft, name: '', email: '', phone: '', cpf: '', postalCode: '', address: '', addressNumber: '' });
        expect(window.localStorage.getItem('wisewolf.enrollmentDraft.oferta-1')).toBeNull();

        window.localStorage.setItem('wisewolf.enrollmentDraft.oferta-1', '{quebrado');
        expect(loadEnrollmentDraft('oferta-1')).toBeNull();
    });
});
