import { describe, expect, it } from 'vitest';
import {
    formatBrazilPhone,
    relativeTrialLabel,
    trialAttention,
    trialNextAction,
    trialStage,
    whatsappHref,
} from './trialPipeline';

const now = new Date('2026-11-01T17:00:00Z'); // 14:00 em Brasília
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600_000);

describe('etapa do lead no funil', () => {
    it('convertido e perdido vencem o status da aula', () => {
        expect(trialStage({ conversion_status: 'WON', trial_status: 'DONE' }, true)).toBe('WON');
        expect(trialStage({ conversion_status: 'LOST', trial_status: 'SCHEDULED' }, false)).toBe('LOST');
    });
    it('aula feita separa quem já tem link', () => {
        expect(trialStage({ conversion_status: 'OPEN', trial_status: 'DONE' }, false)).toBe('DONE');
        expect(trialStage({ conversion_status: 'OPEN', trial_status: 'DONE' }, true)).toBe('LINK_SENT');
    });
    it('falta e remarcação continuam na etapa agendada', () => {
        expect(trialStage({ conversion_status: 'OPEN', trial_status: 'NO_SHOW_STUDENT' }, false)).toBe('SCHEDULED');
    });
});

describe('uma ação principal por lead', () => {
    const open = (trial_status: string) => ({ conversion_status: 'OPEN', trial_status });
    it('aula futura espera; aula terminada pede o resultado', () => {
        expect(trialNextAction(open('SCHEDULED'), false, new Date(now.getTime() + 3600_000), now)).toBe('AWAIT');
        expect(trialNextAction(open('SCHEDULED'), false, hoursAgo(1), now)).toBe('MARK_DONE');
        // ainda dentro dos 30 minutos: espera
        expect(trialNextAction(open('SCHEDULED'), false, hoursAgo(0.25), now)).toBe('AWAIT');
    });
    it('sem horário conhecido, pede o resultado (a RPC barra se for cedo)', () => {
        expect(trialNextAction(open('SCHEDULED'), false, null, now)).toBe('MARK_DONE');
    });
    it('falta pede remarcação', () => {
        expect(trialNextAction(open('NO_SHOW_TEACHER'), false, hoursAgo(5), now)).toBe('RESCHEDULE');
    });
    it('aula feita pede o link; com link, reenviar', () => {
        expect(trialNextAction(open('DONE'), false, hoursAgo(5), now)).toBe('GENERATE_LINK');
        expect(trialNextAction(open('DONE'), true, hoursAgo(5), now)).toBe('RESEND_LINK');
    });
    it('convertido não tem ação', () => {
        expect(trialNextAction({ conversion_status: 'WON', trial_status: 'DONE' }, false, null, now)).toBe('NONE');
    });
});

describe('lead parado', () => {
    const open = (trial_status: string) => ({ conversion_status: 'OPEN', trial_status });
    it('aula que passou há horas sem resultado', () => {
        expect(trialAttention(open('SCHEDULED'), false, hoursAgo(5), null, now)).toBe('Aula passou há 4 h sem resultado');
        expect(trialAttention(open('SCHEDULED'), false, hoursAgo(1), null, now)).toBeNull();
    });
    it('aula feita há dias sem link', () => {
        expect(trialAttention(open('DONE'), false, hoursAgo(50), null, now)).toBe('Aula feita há 2 dias e sem link');
    });
    it('link parado há 3 dias', () => {
        expect(trialAttention(open('DONE'), true, hoursAgo(100), hoursAgo(80), now)).toBe('Link enviado há 3 dias sem matrícula');
        expect(trialAttention(open('DONE'), true, hoursAgo(100), hoursAgo(10), now)).toBeNull();
    });
    it('falta sempre pede atenção', () => {
        expect(trialAttention(open('NO_SHOW_STUDENT'), false, hoursAgo(1), null, now)).toBe('O aluno faltou — remarque');
    });
});

describe('formatação', () => {
    it('data relativa no fuso da escola', () => {
        expect(relativeTrialLabel(new Date('2026-11-01T12:00:00Z'), now)).toBe('hoje às 09:00');
        expect(relativeTrialLabel(new Date('2026-11-02T00:30:00Z'), now)).toBe('hoje às 21:30');
        expect(relativeTrialLabel(new Date('2026-11-02T12:00:00Z'), now)).toBe('amanhã às 09:00');
        expect(relativeTrialLabel(new Date('2026-10-31T12:00:00Z'), now)).toBe('ontem às 09:00');
        expect(relativeTrialLabel(new Date('2026-11-04T12:00:00Z'), now)).toMatch(/^qua 04\/11 às 09:00$/);
    });
    it('telefone legível e link do WhatsApp', () => {
        expect(formatBrazilPhone('5511987654321')).toBe('+55 (11) 98765-4321');
        expect(formatBrazilPhone('553388887777')).toBe('+55 (33) 8888-7777');
        expect(formatBrazilPhone('abc')).toBe('abc');
        expect(whatsappHref('11987654321')).toBe('https://wa.me/5511987654321');
        expect(whatsappHref('5511987654321')).toBe('https://wa.me/5511987654321');
        expect(whatsappHref('123')).toBeNull();
    });
});
