/**
 * Relatórios visuais do CRM, calculados dos leads que a tela já carregou.
 *
 * Só leitura e apresentação: nenhuma consulta nova ao banco, nenhuma regra de
 * negócio. O lead só guarda a etapa ATUAL, então o funil mostra quantos
 * "chegaram pelo menos até" cada etapa — perdidos ficam de fora porque não se
 * sabe em que etapa saíram.
 */

export type CrmStage = 'NEW' | 'CONTACTED' | 'TRIAL' | 'SCHEDULED' | 'TRIAL_DONE' | 'WON' | 'LOST';

export interface CrmInsightLead {
    status: CrmStage;
    source: string | null;
    created_at: string;
    last_status_change: string | null;
    value: number | null;
    ai_handoff?: boolean | null;
    ai_handoff_at?: string | null;
}

export const FUNNEL_STAGES: Exclude<CrmStage, 'TRIAL' | 'LOST'>[] = ['NEW', 'CONTACTED', 'SCHEDULED', 'TRIAL_DONE', 'WON'];

const DAY = 86_400_000;
/** Mesma régua do card: mais de 3 dias na etapa é lead parado. */
export const STALE_DAYS = 3;
/** Mesma validade do handoff da IA na tela (72 h). */
export const HANDOFF_TTL_MS = 72 * 3600 * 1000;

const stageIndex = (status: CrmStage): number =>
    FUNNEL_STAGES.indexOf(status === 'TRIAL' ? 'SCHEDULED' : status as typeof FUNNEL_STAGES[number]);

export const daysInStage = (lead: Pick<CrmInsightLead, 'last_status_change' | 'created_at'>, now: Date): number => {
    const since = Date.parse(lead.last_status_change || lead.created_at);
    return Number.isFinite(since) ? Math.max(0, Math.floor((now.getTime() - since) / DAY)) : 0;
};

export const isActive = (lead: CrmInsightLead) => lead.status !== 'WON' && lead.status !== 'LOST';

export const handoffActive = (lead: CrmInsightLead, now: Date): boolean => {
    if (lead.ai_handoff !== true || !lead.ai_handoff_at) return false;
    const at = Date.parse(lead.ai_handoff_at);
    return Number.isFinite(at) && now.getTime() - at < HANDOFF_TTL_MS;
};

const SP_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' });
/** Dia (AAAA-MM-DD) no fuso da escola. */
export const spDay = (date: Date): string => SP_DAY.format(date);

/** Leads criados por dia nos últimos `days` dias (o último é hoje), no fuso da escola. */
export function leadsPerDay(leads: CrmInsightLead[], now: Date, days = 30): { day: string; count: number; won: number }[] {
    const buckets = new Map<string, { count: number; won: number }>();
    const list: string[] = [];
    for (let i = days - 1; i >= 0; i -= 1) {
        const key = spDay(new Date(now.getTime() - i * DAY));
        if (!buckets.has(key)) { buckets.set(key, { count: 0, won: 0 }); list.push(key); }
    }
    leads.forEach(lead => {
        const created = new Date(lead.created_at);
        if (!Number.isFinite(created.getTime())) return;
        const bucket = buckets.get(spDay(created));
        if (!bucket) return;
        bucket.count += 1;
        if (lead.status === 'WON') bucket.won += 1;
    });
    return list.map(day => ({ day, ...buckets.get(day)! }));
}

/** Pulso da faixa do topo. */
export function crmPulse(leads: CrmInsightLead[], now: Date) {
    const since30 = now.getTime() - 30 * DAY;
    const recent = leads.filter(lead => Date.parse(lead.created_at) >= since30);
    const won = leads.filter(lead => lead.status === 'WON').length;
    const decided = leads.filter(lead => lead.status === 'WON' || lead.status === 'LOST').length;
    return {
        total: leads.length,
        last30: recent.length,
        active: leads.filter(isActive).length,
        won,
        wonLast30: recent.filter(lead => lead.status === 'WON').length,
        lost: leads.filter(lead => lead.status === 'LOST').length,
        // Conversão = matrículas ÷ todos os leads (a mesma conta que a tela já mostrava).
        conversion: leads.length > 0 ? (won / leads.length) * 100 : 0,
        // Dos leads que já tiveram desfecho, quantos viraram aluno.
        winRate: decided > 0 ? (won / decided) * 100 : 0,
        stale: leads.filter(lead => isActive(lead) && daysInStage(lead, now) > STALE_DAYS).length,
        humanHandoff: leads.filter(lead => isActive(lead) && handoffActive(lead, now)).length,
        pipelineValue: leads.filter(isActive).reduce((acc, lead) => acc + (lead.value || 0), 0),
    };
}

/** Funil: quantos leads (sem os perdidos) chegaram pelo menos até cada etapa. */
export function funnelReach(leads: CrmInsightLead[]): { stage: typeof FUNNEL_STAGES[number]; reached: number; current: number; fromPrevious: number | null }[] {
    const alive = leads.filter(lead => lead.status !== 'LOST');
    return FUNNEL_STAGES.map((stage, index) => {
        const reached = alive.filter(lead => stageIndex(lead.status) >= index).length;
        const current = alive.filter(lead => stageIndex(lead.status) === index).length;
        const previous = index === 0 ? null : alive.filter(lead => stageIndex(lead.status) >= index - 1).length;
        return { stage, reached, current, fromPrevious: previous ? (reached / previous) * 100 : previous === 0 ? 0 : null };
    });
}

/** Origem dos leads com conversão de cada uma, da maior para a menor. */
export function sourceBreakdown(leads: CrmInsightLead[]): { source: string; total: number; won: number; lost: number; conversion: number }[] {
    const map = new Map<string, { total: number; won: number; lost: number }>();
    leads.forEach(lead => {
        const key = lead.source?.trim() || 'Sem origem';
        const entry = map.get(key) || { total: 0, won: 0, lost: 0 };
        entry.total += 1;
        if (lead.status === 'WON') entry.won += 1;
        if (lead.status === 'LOST') entry.lost += 1;
        map.set(key, entry);
    });
    return [...map.entries()]
        .map(([source, entry]) => ({ source, ...entry, conversion: entry.total > 0 ? (entry.won / entry.total) * 100 : 0 }))
        .sort((a, b) => b.total - a.total || a.source.localeCompare(b.source));
}

/** Tempo na etapa atual dos leads em andamento: mediana e quantos estão parados. */
export function stageAging(leads: CrmInsightLead[], now: Date): { stage: typeof FUNNEL_STAGES[number]; count: number; medianDays: number; stale: number }[] {
    return FUNNEL_STAGES.filter(stage => stage !== 'WON').map(stage => {
        const days = leads
            .filter(lead => isActive(lead) && stageIndex(lead.status) === FUNNEL_STAGES.indexOf(stage))
            .map(lead => daysInStage(lead, now))
            .sort((a, b) => a - b);
        const mid = Math.floor(days.length / 2);
        const medianDays = days.length === 0 ? 0 : days.length % 2 ? days[mid] : Math.round((days[mid - 1] + days[mid]) / 2);
        return { stage, count: days.length, medianDays, stale: days.filter(d => d > STALE_DAYS).length };
    });
}
