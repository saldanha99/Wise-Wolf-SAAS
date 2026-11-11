import { describe, expect, it } from 'vitest';
import {
    formatBrazilPhone,
    relativeTrialLabel,
    trialAttention,
    groupTrialRows,
    matchesTrialSearch,
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

describe('organização da lista de experimentais', () => {
    const row = (action: any, start: string | null, attention: string | null = null, createdAt = '2026-11-01T00:00:00Z') => ({
        action, attention, createdAt, start: start ? new Date(start) : null,
    });

    it('aula feita sem link vem primeiro, depois registrar, remarcar, link enviado, agendadas', () => {
        const groups = groupTrialRows([
            row('AWAIT', '2026-11-20T12:00:00Z'),
            row('RESEND_LINK', '2026-11-05T12:00:00Z'),
            row('GENERATE_LINK', '2026-11-10T12:00:00Z'),
            row('MARK_DONE', '2026-11-11T12:00:00Z'),
            row('RESCHEDULE', '2026-11-09T12:00:00Z'),
        ]);
        expect(groups.map(group => group.action)).toEqual(['GENERATE_LINK', 'MARK_DONE', 'RESCHEDULE', 'RESEND_LINK', 'AWAIT']);
        expect(groups[0].title).toContain('gerar link');
    });

    it('dentro do grupo: parados primeiro, depois a aula mais recente', () => {
        const [group] = groupTrialRows([
            row('GENERATE_LINK', '2026-11-01T12:00:00Z'),
            row('GENERATE_LINK', '2026-11-10T12:00:00Z'),
            row('GENERATE_LINK', '2026-10-01T12:00:00Z', 'Aula feita há 41 dias e sem link'),
        ]);
        expect(group.rows.map(r => r.start?.toISOString().slice(0, 10))).toEqual(['2026-10-01', '2026-11-10', '2026-11-01']);
    });

    it('agendadas: a próxima aula primeiro', () => {
        const [group] = groupTrialRows([
            row('AWAIT', '2026-11-25T12:00:00Z'),
            row('AWAIT', '2026-11-12T12:00:00Z'),
        ]);
        expect(group.rows[0].start?.toISOString().slice(0, 10)).toBe('2026-11-12');
    });

    it('busca por nome sem acento ou por telefone', () => {
        expect(matchesTrialSearch('amanda', 'Amanda Souza', '5511987654321')).toBe(true);
        expect(matchesTrialSearch('LAÍS', 'Lais Ferreira', null)).toBe(true);
        expect(matchesTrialSearch('98765', 'Bia', '5511987654321')).toBe(true);
        expect(matchesTrialSearch('carla', 'Amanda', '5511987654321')).toBe(false);
        expect(matchesTrialSearch('  ', 'Qualquer', null)).toBe(true);
        expect(matchesTrialSearch('11', 'Bia', '5511987654321')).toBe(false);
    });
});
