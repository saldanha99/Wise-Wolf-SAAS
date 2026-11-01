import React, { useMemo } from 'react';
import { AlertTriangle, BotOff, GraduationCap, Hourglass, TrendingUp, Users } from 'lucide-react';
import {
    crmPulse,
    funnelReach,
    leadsPerDay,
    sourceBreakdown,
    stageAging,
    type CrmInsightLead,
} from '../lib/crmInsights';

// Relatórios visuais do CRM (lib/crmInsights). Só leem os leads que a tela já carregou.

export const STAGE_LABEL: Record<string, string> = {
    NEW: 'Novos',
    CONTACTED: 'Em contato',
    SCHEDULED: 'Aula agendada',
    TRIAL_DONE: 'Pós-aula',
    WON: 'Matriculados',
};

// Cores fora da paleta remapeada para a marca (índigo/violeta viram azul-marinho).
export const STAGE_BAR: Record<string, string> = {
    NEW: 'bg-blue-500',
    CONTACTED: 'bg-amber-500',
    SCHEDULED: 'bg-cyan-500',
    TRIAL_DONE: 'bg-orange-500',
    WON: 'bg-emerald-500',
};

const pct = (value: number) => `${Math.round(value)}%`;
const brl = (value: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', notation: 'compact' }).format(value);
const shortDay = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

/** Minigráfico de barras (leads por dia). */
const Sparkbars: React.FC<{ values: number[]; className?: string }> = ({ values, className = 'bg-brand-accent/60' }) => {
    const max = Math.max(1, ...values);
    return (
        <span className="mt-2 flex h-6 w-full items-end gap-px" aria-hidden>
            {values.map((value, index) => (
                <span
                    key={index}
                    className={`flex-1 rounded-sm ${value === 0 ? 'bg-brand-border' : className}`}
                    style={{ height: `${value === 0 ? 8 : Math.max(18, (value / max) * 100)}%` }}
                />
            ))}
        </span>
    );
};

interface PulseProps {
    leads: CrmInsightLead[];
    now: Date;
    staleFilterOn: boolean;
    onShowStale: () => void;
}

/** Faixa do topo do quadro: o que está acontecendo, num olhar. */
export const CrmPulseStrip: React.FC<PulseProps> = ({ leads, now, staleFilterOn, onShowStale }) => {
    const pulse = useMemo(() => crmPulse(leads, now), [leads, now]);
    const perDay = useMemo(() => leadsPerDay(leads, now, 30), [leads, now]);
    const tiles = [
        { key: 'last30', label: 'Leads 30 dias', value: String(pulse.last30), icon: TrendingUp, extra: <Sparkbars values={perDay.map(d => d.count)} /> },
        { key: 'active', label: 'Em andamento', value: String(pulse.active), icon: Users, hint: pulse.pipelineValue > 0 ? `${brl(pulse.pipelineValue)} no funil` : undefined },
        { key: 'won', label: 'Matrículas', value: String(pulse.won), icon: GraduationCap, hint: `${pulse.wonLast30} em 30 dias` },
        { key: 'conv', label: 'Conversão', value: pct(pulse.conversion), icon: TrendingUp, hint: `${pct(pulse.winRate)} dos que decidiram` },
    ];
    return (
        <section data-tour="crm-pulse" aria-label="Resumo do CRM" className="-mx-4 flex snap-x gap-2 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:grid sm:grid-cols-3 sm:overflow-visible sm:px-0 lg:grid-cols-6 [&::-webkit-scrollbar]:hidden">
            {tiles.map(tile => (
                <div key={tile.key} className="flex min-w-[150px] shrink-0 snap-start flex-col rounded-2xl sm:min-w-0 border border-brand-border bg-brand-surface px-4 py-3">
                    <div className="min-w-0">
                        <p className="flex items-center gap-1.5 truncate text-[11px] font-bold uppercase tracking-wider text-brand-muted">
                            <tile.icon size={13} /> {tile.label}
                        </p>
                        <p className="mt-1 text-2xl font-black leading-none text-brand-text">{tile.value}</p>
                        {tile.hint && <p className="mt-1 truncate text-[11px] font-medium text-brand-muted">{tile.hint}</p>}
                    </div>
                    {tile.extra}
                </div>
            ))}
            <button
                type="button"
                onClick={onShowStale}
                aria-pressed={staleFilterOn}
                className={`min-w-[150px] shrink-0 snap-start rounded-2xl border px-4 py-3 text-left transition-colors sm:min-w-0 ${staleFilterOn
                    ? 'border-amber-500 bg-amber-500/15'
                    : pulse.stale > 0
                        ? 'border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/15'
                        : 'border-brand-border bg-brand-surface'
                    }`}
            >
                <p className="flex items-center gap-1.5 truncate text-[11px] font-bold uppercase tracking-wider text-amber-700 dark:text-amber-300">
                    <AlertTriangle size={13} /> Parados
                </p>
                <p className="mt-1 text-2xl font-black leading-none text-brand-text">{pulse.stale}</p>
                <p className="mt-1 truncate text-[11px] font-medium text-brand-muted">{staleFilterOn ? 'filtrando o quadro' : 'há mais de 3 dias'}</p>
            </button>
            <div className="min-w-[150px] shrink-0 snap-start rounded-2xl border border-brand-border bg-brand-surface px-4 py-3 sm:min-w-0">
                <p className="flex items-center gap-1.5 truncate text-[11px] font-bold uppercase tracking-wider text-brand-muted">
                    <BotOff size={13} /> Com a equipe
                </p>
                <p className="mt-1 text-2xl font-black leading-none text-brand-text">{pulse.humanHandoff}</p>
                <p className="mt-1 truncate text-[11px] font-medium text-brand-muted">Bia pausada por 72 h</p>
            </div>
        </section>
    );
};

const Card: React.FC<{ title: string; subtitle?: string; children: React.ReactNode; className?: string }> = ({ title, subtitle, children, className = '' }) => (
    <section className={`rounded-3xl border border-brand-border bg-brand-surface p-5 sm:p-6 ${className}`}>
        <h3 className="text-base font-black text-brand-text">{title}</h3>
        {subtitle && <p className="mt-0.5 text-xs text-brand-muted">{subtitle}</p>}
        <div className="mt-4">{children}</div>
    </section>
);

/** Aba Relatórios: funil, leads por dia, origem e tempo parado por etapa. */
export const CrmReports: React.FC<{ leads: CrmInsightLead[]; now: Date }> = ({ leads, now }) => {
    const funnel = useMemo(() => funnelReach(leads), [leads]);
    const perDay = useMemo(() => leadsPerDay(leads, now, 30), [leads, now]);
    const sources = useMemo(() => sourceBreakdown(leads), [leads]);
    const aging = useMemo(() => stageAging(leads, now), [leads, now]);
    const pulse = useMemo(() => crmPulse(leads, now), [leads, now]);
    const maxReach = Math.max(1, funnel[0]?.reached || 0);
    const maxDay = Math.max(1, ...perDay.map(d => d.count));
    const maxSource = Math.max(1, ...sources.map(s => s.total));
    const totalLast30 = perDay.reduce((acc, d) => acc + d.count, 0);
    const bestDay = perDay.reduce((best, d) => (d.count > best.count ? d : best), perDay[0] || { day: '', count: 0, won: 0 });

    if (leads.length === 0) {
        return (
            <div className="rounded-3xl border border-dashed border-brand-border p-12 text-center text-sm text-brand-muted">
                Ainda não há leads para montar os relatórios.
            </div>
        );
    }

    return (
        <div data-tour="crm-reports" className="grid gap-4 lg:grid-cols-2">
            <Card title="Funil de conversão" subtitle="Quantos leads chegaram pelo menos até cada etapa (perdidos ficam de fora)">
                <ol className="space-y-2.5">
                    {funnel.map(step => (
                        <li key={step.stage}>
                            <div className="mb-1 flex items-baseline justify-between gap-2 text-sm">
                                <span className="font-bold text-brand-text">{STAGE_LABEL[step.stage]}</span>
                                <span className="text-xs text-brand-muted">
                                    <strong className="text-sm text-brand-text">{step.reached}</strong>
                                    {step.fromPrevious !== null && <> · {pct(step.fromPrevious)} da etapa anterior</>}
                                </span>
                            </div>
                            <div className="h-3 overflow-hidden rounded-full bg-brand-surface-2">
                                <div className={`h-full rounded-full ${STAGE_BAR[step.stage]}`} style={{ width: `${Math.max(step.reached > 0 ? 3 : 0, (step.reached / maxReach) * 100)}%` }} />
                            </div>
                        </li>
                    ))}
                </ol>
                <p className="mt-4 rounded-xl bg-brand-surface-2 px-3 py-2 text-xs text-brand-muted">
                    <strong className="text-brand-text">{pulse.lost}</strong> lead(s) marcados como perdidos ·{' '}
                    <strong className="text-brand-text">{pct(pulse.winRate)}</strong> dos leads com desfecho viraram aluno
                </p>
            </Card>

            <Card title="Leads por dia" subtitle={`Últimos 30 dias · ${totalLast30} leads${bestDay.count > 0 ? ` · pico em ${shortDay(bestDay.day)} (${bestDay.count})` : ''}`}>
                <div className="flex h-40 items-end gap-1" role="img" aria-label={`Leads por dia nos últimos 30 dias: ${totalLast30} no total`}>
                    {perDay.map(d => (
                        <div key={d.day} className="group relative flex h-full flex-1 flex-col justify-end" title={`${shortDay(d.day)}: ${d.count} lead(s)${d.won ? `, ${d.won} matriculado(s)` : ''}`}>
                            <div
                                className={`w-full rounded-t ${d.count === 0 ? 'bg-brand-surface-2' : 'bg-brand-accent/70 group-hover:bg-brand-accent'}`}
                                style={{ height: `${d.count === 0 ? 3 : Math.max(6, (d.count / maxDay) * 100)}%` }}
                            />
                            {d.won > 0 && <span className="absolute -top-2 left-1/2 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-emerald-500" aria-hidden />}
                        </div>
                    ))}
                </div>
                <div className="mt-2 flex justify-between text-[11px] font-semibold text-brand-muted">
                    <span>{perDay[0] ? shortDay(perDay[0].day) : ''}</span>
                    <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> dia com lead que virou aluno</span>
                    <span>hoje</span>
                </div>
            </Card>

            <Card title="De onde vêm os leads" subtitle="Volume e conversão por origem">
                <ul className="space-y-3">
                    {sources.slice(0, 8).map(row => (
                        <li key={row.source} className="grid grid-cols-[minmax(0,7rem)_1fr_auto] items-center gap-3 text-sm">
                            <span className="truncate font-bold text-brand-text" title={row.source}>{row.source}</span>
                            <span className="relative h-3 overflow-hidden rounded-full bg-brand-surface-2">
                                <span className="absolute inset-y-0 left-0 rounded-full bg-brand-accent/40" style={{ width: `${(row.total / maxSource) * 100}%` }} />
                                <span className="absolute inset-y-0 left-0 rounded-full bg-emerald-500" style={{ width: `${(row.won / maxSource) * 100}%` }} />
                            </span>
                            <span className="w-24 text-right text-xs text-brand-muted">
                                <strong className="text-brand-text">{row.total}</strong> · {pct(row.conversion)} conv.
                            </span>
                        </li>
                    ))}
                </ul>
                <p className="mt-4 flex items-center gap-3 text-[11px] font-semibold text-brand-muted">
                    <span className="flex items-center gap-1"><span className="h-2 w-3 rounded-full bg-brand-accent/40" /> leads</span>
                    <span className="flex items-center gap-1"><span className="h-2 w-3 rounded-full bg-emerald-500" /> matriculados</span>
                </p>
            </Card>

            <Card title="Onde os leads estão parando" subtitle="Leads em andamento em cada etapa e há quanto tempo estão nela">
                <ul className="space-y-2">
                    {aging.map(row => (
                        <li key={row.stage} className="flex items-center gap-3 rounded-2xl bg-brand-surface-2 px-4 py-3">
                            <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${STAGE_BAR[row.stage]}`} aria-hidden />
                            <span className="min-w-0 flex-1">
                                <span className="block text-sm font-bold text-brand-text">{STAGE_LABEL[row.stage]}</span>
                                <span className="block text-xs text-brand-muted">
                                    {row.count} lead(s){row.count > 0 ? ` · metade está há ${row.medianDays} dia(s) ou menos` : ''}
                                </span>
                            </span>
                            {row.stale > 0 ? (
                                <span className="flex shrink-0 items-center gap-1 rounded-full bg-amber-500/15 px-2.5 py-1 text-xs font-bold text-amber-700 dark:text-amber-300">
                                    <Hourglass size={12} /> {row.stale} parado(s)
                                </span>
                            ) : (
                                <span className="shrink-0 text-xs font-semibold text-emerald-600 dark:text-emerald-400">em dia</span>
                            )}
                        </li>
                    ))}
                </ul>
            </Card>
        </div>
    );
};
