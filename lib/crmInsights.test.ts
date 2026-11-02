import { describe, expect, it } from 'vitest';
import { crmPulse, daysInStage, funnelReach, leadsPerDay, sourceBreakdown, stageAging, type CrmInsightLead } from './crmInsights';

const now = new Date('2026-11-01T15:00:00Z'); // 12:00 em Brasília
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();
const lead = (status: CrmInsightLead['status'], source: string | null, createdDaysAgo: number, stageDaysAgo: number | null = null, extra: Partial<CrmInsightLead> = {}): CrmInsightLead => ({
    status, source, created_at: daysAgo(createdDaysAgo), last_status_change: stageDaysAgo === null ? null : daysAgo(stageDaysAgo), value: 0, ...extra,
});

const leads: CrmInsightLead[] = [
    lead('NEW', 'Instagram', 1),
    lead('NEW', 'Instagram', 10, 10),
    lead('CONTACTED', 'Google', 5, 4),
    lead('TRIAL', 'Instagram', 6, 1),
    lead('TRIAL_DONE', 'Indicação', 8, 2),
    lead('WON', 'Indicação', 20, 3),
    lead('WON', 'Instagram', 40, 30),
    lead('LOST', 'Google', 15, 12),
    lead('CONTACTED', null, 2, 0, { ai_handoff: true, ai_handoff_at: daysAgo(1) }),
    lead('CONTACTED', null, 9, 9, { ai_handoff: true, ai_handoff_at: daysAgo(5) }),
];

describe('pulso do CRM', () => {
    it('conta leads, matrículas, parados e atendimento humano vivo', () => {
        const pulse = crmPulse(leads, now);
        expect(pulse.total).toBe(10);
        expect(pulse.last30).toBe(9);
        expect(pulse.active).toBe(7);
        expect(pulse.won).toBe(2);
        expect(pulse.wonLast30).toBe(1);
        expect(pulse.conversion).toBe(20);
        expect(pulse.winRate).toBeCloseTo(66.7, 1);
        expect(pulse.stale).toBe(3); // 10 dias, 4 dias, 9 dias
        expect(pulse.humanHandoff).toBe(1); // o de 5 dias venceu
    });
    it('dias na etapa caem para a criação quando não houve mudança', () => {
        expect(daysInStage(lead('NEW', null, 6), now)).toBe(6);
    });
});

describe('funil', () => {
    it('conta quem chegou pelo menos até cada etapa, sem os perdidos', () => {
        const funnel = funnelReach(leads);
        expect(funnel.map(step => step.reached)).toEqual([9, 7, 4, 3, 2]);
        expect(funnel[0].fromPrevious).toBeNull();
        expect(funnel[4].fromPrevious).toBeCloseTo(66.7, 1);
        expect(funnel[2].current).toBe(1); // TRIAL conta como agendada
    });
});

describe('origem e tempo por etapa', () => {
    it('agrupa origem com conversão e põe "Sem origem" para o vazio', () => {
        const rows = sourceBreakdown(leads);
        expect(rows[0]).toMatchObject({ source: 'Instagram', total: 4, won: 1, conversion: 25 });
        expect(rows.find(r => r.source === 'Sem origem')?.total).toBe(2);
        expect(rows.find(r => r.source === 'Google')).toMatchObject({ lost: 1, won: 0 });
    });
    it('mediana de dias na etapa dos leads em andamento', () => {
        const aging = stageAging(leads, now);
        expect(aging.find(a => a.stage === 'CONTACTED')).toMatchObject({ count: 3, medianDays: 4, stale: 2 });
        expect(aging.some(a => a.stage === 'WON')).toBe(false);
    });
});

describe('leads por dia', () => {
    it('30 baldes no fuso da escola, terminando hoje', () => {
        const days = leadsPerDay(leads, now);
        expect(days).toHaveLength(30);
        expect(days[29].day).toBe('2026-11-01');
        expect(days[28]).toMatchObject({ day: '2026-10-31', count: 1 });
        expect(days.reduce((acc, d) => acc + d.count, 0)).toBe(9);
    });
});
