import React, { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import {
    AlertTriangle, ArrowUpRight, CalendarClock, CalendarX, Check, CheckCircle2, Copy,
    FileWarning, Loader2, MessageSquare, RefreshCw, UserMinus, UserX, Wallet,
} from 'lucide-react';
import { User } from '../types';

// Reconciliação financeira — estados que ninguém vigia.
//
// Não é mais um relatório de números: é a lista do que está PARADO. Cada bloco
// existe porque o dinheiro correspondente não aparecia em painel nenhum — nem
// em inadimplência, nem no DRE, nem no fluxo de caixa.
//
// A tela REPORTA e leva à tela de ação. Ela não emite cobrança nem cancela
// contrato: isso é decisão comercial, e um botão que cobra sozinho criaria
// fatura para aluno que talvez tenha um acordo verbal com a direção.

interface FinancialReconciliationProps {
    user: User;
    tenantId?: string;
    /** Navega para a tela onde a pendência é resolvida. */
    onNavigate?: (tab: string) => void;
}

const brl = (v: number) => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

interface BlocoProps {
    icone: React.ReactNode;
    titulo: string;
    porque: string;
    qtd: number;
    valor?: number;
    valorRotulo?: string;
    tom: 'critico' | 'atencao' | 'neutro';
    acao?: { label: string; tab: string };
    onNavigate?: (tab: string) => void;
    children: React.ReactNode;
}

const TONS = {
    critico: 'border-red-500/40 bg-red-500/5',
    atencao: 'border-amber-500/40 bg-amber-500/5',
    neutro: 'border-brand-border bg-brand-surface-2/40',
};

const Bloco: React.FC<BlocoProps> = ({
    icone, titulo, porque, qtd, valor, valorRotulo, tom, acao, onNavigate, children,
}) => {
    if (qtd === 0) return null;
    return (
        <section className={`rounded-3xl border p-5 sm:p-6 ${TONS[tom]}`}>
            <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                    <h3 className="flex items-center gap-2 text-sm font-black tracking-tight text-brand-text">
                        {icone} {titulo}
                        <span className="rounded-full bg-brand-surface px-2.5 py-0.5 text-[10px] font-black text-brand-muted">
                            {qtd}
                        </span>
                    </h3>
                    <p className="mt-1 text-xs text-brand-muted">{porque}</p>
                </div>
                {valor !== undefined && valor > 0 && (
                    <div className="text-right">
                        <p className="text-lg font-black tracking-tight text-brand-text">{brl(valor)}</p>
                        {valorRotulo && (
                            <p className="text-[9px] font-black uppercase tracking-widest text-brand-muted">{valorRotulo}</p>
                        )}
                    </div>
                )}
            </header>

            <div className="overflow-x-auto">{children}</div>

            {acao && onNavigate && (
                <button
                    type="button"
                    onClick={() => onNavigate(acao.tab)}
                    className="mt-4 inline-flex items-center gap-1.5 rounded-xl border border-brand-border bg-brand-surface px-3.5 py-2 text-[10px] font-black uppercase tracking-widest text-brand-muted transition-all hover:text-brand-text"
                >
                    {acao.label} <ArrowUpRight size={13} />
                </button>
            )}
        </section>
    );
};

const Tabela: React.FC<{ colunas: string[]; linhas: (string | number)[][] }> = ({ colunas, linhas }) => (
    <table className="w-full min-w-[520px] text-left text-xs">
        <thead>
            <tr className="border-b border-brand-border">
                {colunas.map(c => (
                    <th key={c} className="pb-2 text-[9px] font-black uppercase tracking-widest text-brand-muted">{c}</th>
                ))}
            </tr>
        </thead>
        <tbody>
            {linhas.map((l, i) => (
                <tr key={i} className="border-b border-brand-border/50 last:border-0">
                    {l.map((celula, j) => (
                        <td key={j} className={`py-2.5 ${j === 0 ? 'font-bold text-brand-text' : 'text-brand-muted'}`}>
                            {celula}
                        </td>
                    ))}
                </tr>
            ))}
        </tbody>
    </table>
);

type RenewalStatus =
    | 'PENDING_CONTACT'
    | 'AWAITING_REPLY'
    | 'FOLLOW_UP_SCHEDULED'
    | 'INTEREST_RECORDED'
    | 'FORMALIZATION_PENDING'
    | 'NOT_CONTINUING_RECORDED';

interface RenewalCase {
    id?: string;
    student_id: string;
    student_name?: string | null;
    service_end_date: string;
    status: RenewalStatus;
    last_contact_at: string | null;
    last_channel: string | null;
    next_action_at: string | null;
    interest_term_months: 6 | 12 | null;
    version: number;
    source_subscription_synced_at?: string | null;
    monthly_fee_snapshot?: number | null;
    cycle_current?: boolean;
    latest_note?: string | null;
    updated_at?: string | null;
    updated_by_name?: string | null;
    event_count?: number;
}

interface RenewalOffer {
    student_id: string;
    aluno: string;
    termina: string;
    dias: number;
    paga_hoje: number;
    p12?: number | null;
    mensagem?: string | null;
}

type RenewalAction =
    | 'CONTACTED'
    | 'SCHEDULE_FOLLOW_UP'
    | 'RECORD_INTEREST'
    | 'AWAIT_FORMALIZATION'
    | 'RECORD_NOT_CONTINUING'
    | 'REOPEN';

interface RenewalActionPayload {
    action: RenewalAction;
    channel?: string | null;
    nextActionAt?: string | null;
    interestTermMonths?: 6 | 12 | null;
    note?: string | null;
}

interface PendingRenewalRequest {
    intent: string;
    args: Record<string, unknown>;
}

const renewalKey = (studentId: string, serviceEndDate: string) =>
    `${studentId}:${serviceEndDate}`;

const RENEWAL_STATUS: Record<RenewalStatus, { label: string; color: string }> = {
    PENDING_CONTACT: {
        label: 'Sem contato',
        color: 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-200',
    },
    AWAITING_REPLY: {
        label: 'Aguardando resposta',
        color: 'border-blue-300 bg-blue-50 text-blue-800 dark:border-blue-900/50 dark:bg-blue-950/20 dark:text-blue-200',
    },
    FOLLOW_UP_SCHEDULED: {
        label: 'Retorno agendado',
        color: 'border-violet-300 bg-violet-50 text-violet-800 dark:border-violet-900/50 dark:bg-violet-950/20 dark:text-violet-200',
    },
    INTEREST_RECORDED: {
        label: 'Interesse informado',
        color: 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-950/20 dark:text-emerald-200',
    },
    FORMALIZATION_PENDING: {
        label: 'Aguardando formalização',
        color: 'border-indigo-300 bg-indigo-50 text-indigo-800 dark:border-indigo-900/50 dark:bg-indigo-950/20 dark:text-indigo-200',
    },
    NOT_CONTINUING_RECORDED: {
        label: 'Não pretende continuar',
        color: 'border-slate-300 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200',
    },
};

const formatDateTime = (value?: string | null) => {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return new Intl.DateTimeFormat('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    }).format(date);
};

const renewalMilestone = (days: number) => {
    if (days < 0) return `Encerrado há ${Math.abs(days)} ${Math.abs(days) === 1 ? 'dia' : 'dias'}`;
    if (days === 0) return 'Encerra hoje';
    if (days <= 7) return 'D-7 · urgente';
    if (days <= 15) return 'D-15 · fazer contato';
    if (days <= 30) return 'D-30 · preparar proposta';
    return 'D-90 · acompanhar';
};

interface RenewalTrackingCardProps {
    offer: RenewalOffer;
    renewalCase?: RenewalCase;
    trackingAvailable: boolean;
    busy: boolean;
    copied: boolean;
    onCopy: () => void;
    onAction: (payload: RenewalActionPayload) => Promise<boolean>;
}

const RenewalTrackingCard: React.FC<RenewalTrackingCardProps> = ({
    offer,
    renewalCase,
    trackingAvailable,
    busy,
    copied,
    onCopy,
    onAction,
}) => {
    const current: RenewalCase = renewalCase || {
        student_id: offer.student_id,
        service_end_date: offer.termina,
        status: 'PENDING_CONTACT',
        last_contact_at: null,
        last_channel: null,
        next_action_at: null,
        interest_term_months: null,
        version: 0,
        cycle_current: true,
    };
    const status = RENEWAL_STATUS[current.status];
    const [editor, setEditor] = useState<'CONTACT' | 'FOLLOW_UP' | 'NOT_CONTINUING' | null>(null);
    const [channel, setChannel] = useState('WHATSAPP');
    const [nextActionAt, setNextActionAt] = useState('');
    const [note, setNote] = useState('');
    const [editorError, setEditorError] = useState('');
    const nextActionLabel = formatDateTime(current.next_action_at);
    const lastContactLabel = formatDateTime(current.last_contact_at);
    const updatedLabel = formatDateTime(current.updated_at);
    const followUpOverdue = Boolean(
        current.next_action_at && new Date(current.next_action_at).getTime() < Date.now(),
    );
    const cycleCurrent = current.cycle_current === true;
    const hasDraft = Boolean(offer.mensagem);
    const now = new Date();
    const maxFollowUp = new Date(now.getTime() + 365 * 86_400_000);
    const toLocalDateTime = (date: Date) => {
        const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
        return local.toISOString().slice(0, 16);
    };
    const minFollowUpValue = toLocalDateTime(new Date(now.getTime() + 60_000));
    const maxFollowUpValue = toLocalDateTime(maxFollowUp);

    const closeEditor = () => {
        setEditor(null);
        setNextActionAt('');
        setNote('');
        setEditorError('');
    };

    const openEditor = (nextEditor: 'CONTACT' | 'FOLLOW_UP' | 'NOT_CONTINUING') => {
        setEditor(nextEditor);
        setNextActionAt('');
        setNote('');
        setEditorError('');
    };

    const submitEditor = async () => {
        const nextDate = nextActionAt ? new Date(nextActionAt) : null;
        if (nextDate && (
            Number.isNaN(nextDate.getTime())
            || nextDate.getTime() <= Date.now()
            || nextDate.getTime() > maxFollowUp.getTime()
        )) {
            setEditorError('Escolha um retorno futuro dentro dos próximos 365 dias.');
            return;
        }
        const nextIso = nextDate ? nextDate.toISOString() : null;
        const payload: RenewalActionPayload = editor === 'CONTACT'
            ? { action: 'CONTACTED', channel, nextActionAt: nextIso, note }
            : editor === 'FOLLOW_UP'
                ? { action: 'SCHEDULE_FOLLOW_UP', nextActionAt: nextIso, note }
                : { action: 'RECORD_NOT_CONTINUING', note };
        const saved = await onAction(payload);
        if (saved) {
            closeEditor();
        }
    };

    return (
        <article className="rounded-2xl border border-brand-border bg-brand-surface p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-black text-brand-text">{offer.aluno}</p>
                        <span className={`rounded-full border px-2.5 py-1 text-[9px] font-black uppercase tracking-widest ${trackingAvailable ? status.color : 'border-slate-300 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200'}`}>
                            {trackingAvailable ? status.label : 'Acompanhamento indisponível'}
                        </span>
                        <span className="rounded-full bg-brand-surface-2 px-2.5 py-1 text-[9px] font-black uppercase tracking-widest text-brand-muted">
                            {renewalMilestone(Number(offer.dias))}
                        </span>
                        {!cycleCurrent && (
                            <span className="rounded-full border border-slate-300 bg-slate-100 px-2.5 py-1 text-[9px] font-black uppercase tracking-widest text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
                                Ciclo anterior
                            </span>
                        )}
                    </div>
                    <p className="mt-1 text-xs font-bold text-brand-muted">
                        {cycleCurrent ? 'Vigência atual' : 'Ciclo acompanhado'} até {offer.termina}
                        {offer.dias >= 0 ? ` · ${offer.dias} dias` : ''}
                        {current.interest_term_months ? ` · interesse em ${current.interest_term_months} meses` : ''}
                    </p>
                    {(lastContactLabel || nextActionLabel) && (
                        <p className={`mt-1 text-[10px] font-bold ${followUpOverdue ? 'text-red-600' : 'text-brand-muted'}`}>
                            {lastContactLabel ? `Último contato: ${lastContactLabel}` : ''}
                            {lastContactLabel && nextActionLabel ? ' · ' : ''}
                            {nextActionLabel ? `${followUpOverdue ? 'Retorno vencido' : 'Próximo retorno'}: ${nextActionLabel}` : ''}
                        </p>
                    )}
                    {current.updated_by_name && (
                        <p className="mt-1 text-[10px] font-bold text-brand-muted">
                            Última atualização{updatedLabel ? ` em ${updatedLabel}` : ''} por {current.updated_by_name}
                        </p>
                    )}
                    {current.latest_note && (
                        <p className="mt-2 max-w-3xl rounded-xl border border-brand-border bg-brand-surface-2 px-3 py-2 text-xs font-medium text-brand-muted">
                            <span className="font-black text-brand-text">Última observação:</span> {current.latest_note}
                        </p>
                    )}
                </div>
                {hasDraft && (
                    <button
                        type="button"
                        onClick={onCopy}
                        className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-[10px] font-black uppercase tracking-widest transition-all ${
                            copied
                                ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-600'
                                : 'border-brand-border bg-brand-surface-2 text-brand-muted hover:text-brand-text'
                        }`}
                    >
                        {copied ? <Check size={12} /> : <Copy size={12} />}
                        {copied ? 'Copiado' : 'Copiar mensagem'}
                    </button>
                )}
            </div>

            {hasDraft ? (
                <pre className="mt-3 whitespace-pre-wrap break-words rounded-xl bg-brand-surface-2 p-3 font-sans text-xs leading-relaxed text-brand-muted">
                    {offer.mensagem}
                </pre>
            ) : (
                <p className="mt-3 rounded-xl border border-amber-300/60 bg-amber-50 p-3 text-xs font-bold text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-200">
                    Este acompanhamento saiu do radar comercial atual, mas continua visível para não perder retornos ou formalizações pendentes.
                    Confira a situação da aluna antes de um novo contato.
                </p>
            )}

            {!cycleCurrent && (
                <p className="mt-3 rounded-xl border border-slate-300 bg-slate-100 p-3 text-xs font-bold text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
                    A assinatura ou o vínculo da aluna mudou desde este registro. Este ciclo ficou somente para consulta; abra o ciclo atual pelo radar.
                </p>
            )}

            {cycleCurrent && trackingAvailable && <div className="mt-3 flex flex-wrap gap-2">
                {current.status !== 'NOT_CONTINUING_RECORDED' && (
                    <button
                        type="button"
                        disabled={busy}
                        onClick={() => openEditor('CONTACT')}
                        className="rounded-xl border border-brand-border px-3 py-2 text-[10px] font-black uppercase tracking-widest text-brand-text disabled:opacity-50"
                    >
                        Registrar contato
                    </button>
                )}
                {['AWAITING_REPLY', 'FOLLOW_UP_SCHEDULED', 'INTEREST_RECORDED', 'FORMALIZATION_PENDING'].includes(current.status) && (
                    <button
                        type="button"
                        disabled={busy}
                        onClick={() => openEditor('FOLLOW_UP')}
                        className="rounded-xl border border-brand-border px-3 py-2 text-[10px] font-black uppercase tracking-widest text-brand-muted disabled:opacity-50"
                    >
                        Agendar retorno
                    </button>
                )}
                {['AWAITING_REPLY', 'FOLLOW_UP_SCHEDULED', 'INTEREST_RECORDED'].includes(current.status) && (
                    <>
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => void onAction({ action: 'RECORD_INTEREST', interestTermMonths: 6 })}
                            className="rounded-xl bg-emerald-600 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-white disabled:opacity-50"
                        >
                            Interesse 6 meses
                        </button>
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => void onAction({ action: 'RECORD_INTEREST', interestTermMonths: 12 })}
                            className="rounded-xl bg-emerald-600 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-white disabled:opacity-50"
                        >
                            Interesse 12 meses
                        </button>
                    </>
                )}
                {current.status === 'INTEREST_RECORDED' && (
                    <button
                        type="button"
                        disabled={busy}
                        onClick={() => void onAction({ action: 'AWAIT_FORMALIZATION' })}
                        className="rounded-xl bg-indigo-600 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-white disabled:opacity-50"
                    >
                        Aguardar formalização
                    </button>
                )}
                {!['NOT_CONTINUING_RECORDED'].includes(current.status) && (
                    <button
                        type="button"
                        disabled={busy}
                        onClick={() => openEditor('NOT_CONTINUING')}
                        className="rounded-xl border border-slate-300 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-brand-muted disabled:opacity-50"
                    >
                        Registrar que não seguirá
                    </button>
                )}
                {['NOT_CONTINUING_RECORDED', 'FORMALIZATION_PENDING'].includes(current.status) && (
                    <button
                        type="button"
                        disabled={busy}
                        onClick={() => void onAction({ action: 'REOPEN' })}
                        className="rounded-xl border border-brand-border px-3 py-2 text-[10px] font-black uppercase tracking-widest text-brand-muted disabled:opacity-50"
                    >
                        Reabrir acompanhamento
                    </button>
                )}
            </div>}

            {cycleCurrent && trackingAvailable && editor && (
                <div className="mt-3 grid gap-3 rounded-2xl border border-brand-border bg-brand-surface-2 p-4 sm:grid-cols-2">
                    {editor === 'CONTACT' && (
                        <label className="space-y-1 text-[10px] font-black uppercase tracking-widest text-brand-muted">
                            Canal
                            <select
                                value={channel}
                                onChange={event => setChannel(event.target.value)}
                                className="mt-1 w-full rounded-xl border border-brand-border bg-brand-surface px-3 py-2 text-sm font-bold normal-case tracking-normal text-brand-text"
                            >
                                <option value="WHATSAPP">WhatsApp</option>
                                <option value="PHONE">Ligação</option>
                                <option value="EMAIL">E-mail</option>
                                <option value="OTHER">Outro</option>
                            </select>
                        </label>
                    )}
                    {editor !== 'NOT_CONTINUING' && (
                        <label className="space-y-1 text-[10px] font-black uppercase tracking-widest text-brand-muted">
                            Próximo retorno {editor === 'FOLLOW_UP' ? '(obrigatório)' : '(opcional)'}
                            <input
                                type="datetime-local"
                                value={nextActionAt}
                                min={minFollowUpValue}
                                max={maxFollowUpValue}
                                onChange={event => {
                                    setNextActionAt(event.target.value);
                                    setEditorError('');
                                }}
                                className="mt-1 w-full rounded-xl border border-brand-border bg-brand-surface px-3 py-2 text-sm font-bold normal-case tracking-normal text-brand-text"
                            />
                        </label>
                    )}
                    <label className="space-y-1 text-[10px] font-black uppercase tracking-widest text-brand-muted sm:col-span-2">
                        Observação interna (opcional)
                        <textarea
                            value={note}
                            maxLength={500}
                            onChange={event => setNote(event.target.value)}
                            placeholder="Não registre cartão, CPF ou outros dados sensíveis."
                            className="mt-1 min-h-20 w-full rounded-xl border border-brand-border bg-brand-surface px-3 py-2 text-sm font-medium normal-case tracking-normal text-brand-text"
                        />
                    </label>
                    {editorError && (
                        <p role="alert" className="text-xs font-bold text-red-600 sm:col-span-2">
                            {editorError}
                        </p>
                    )}
                    <div className="flex flex-wrap gap-2 sm:col-span-2">
                        <button
                            type="button"
                            disabled={busy || (editor === 'FOLLOW_UP' && !nextActionAt)}
                            onClick={() => void submitEditor()}
                            className="rounded-xl bg-tenant-primary px-4 py-2 text-[10px] font-black uppercase tracking-widest text-white disabled:opacity-50"
                        >
                            {busy ? 'Salvando…' : 'Salvar registro interno'}
                        </button>
                        <button
                            type="button"
                            disabled={busy}
                            onClick={closeEditor}
                            className="rounded-xl border border-brand-border px-4 py-2 text-[10px] font-black uppercase tracking-widest text-brand-muted disabled:opacity-50"
                        >
                            Cancelar
                        </button>
                    </div>
                </div>
            )}
        </article>
    );
};

const FinancialReconciliation: React.FC<FinancialReconciliationProps> = ({ tenantId, onNavigate }) => {
    const [dados, setDados] = useState<any>(null);
    const [renovacao, setRenovacao] = useState<any>(null);
    const [ofertas, setOfertas] = useState<any>(null);
    const [renewalCases, setRenewalCases] = useState<Record<string, RenewalCase>>({});
    const [renewalTrackingLoaded, setRenewalTrackingLoaded] = useState(false);
    const [renewalLoadWarning, setRenewalLoadWarning] = useState('');
    const [renewalActionError, setRenewalActionError] = useState('');
    const [renewalBusyKey, setRenewalBusyKey] = useState<string | null>(null);
    const [renewalFilter, setRenewalFilter] = useState<'ALL' | 'PENDING' | 'OVERDUE' | 'INTEREST' | 'FORMALIZATION'>('ALL');
    const [asaas, setAsaas] = useState<any>(null);
    const [asaasErro, setAsaasErro] = useState('');
    const [copiado, setCopiado] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [financialWarning, setFinancialWarning] = useState('');
    const requestSequence = useRef(0);
    const renewalMutationSequence = useRef(0);
    const renewalMutationInFlight = useRef(false);
    const currentTenantId = useRef(tenantId);
    currentTenantId.current = tenantId;
    const pendingRenewalRequests = useRef<Record<string, PendingRenewalRequest>>({});

    const receiveRenewalCases = (payload: any) => {
        if (!payload || payload.ok !== true || !Array.isArray(payload.items)) return false;
        const next: Record<string, RenewalCase> = {};
        payload.items.forEach((item: RenewalCase) => {
            if (item?.student_id && item?.service_end_date) {
                next[renewalKey(item.student_id, item.service_end_date)] = item;
            }
        });
        setRenewalCases(next);
        setRenewalTrackingLoaded(true);
        return true;
    };

    const reloadRenewalCases = async () => {
        const expectedTenant = tenantId;
        const expectedLoadSequence = requestSequence.current;
        const result = await supabase.rpc('list_student_renewal_cases', {
            p_tenant: tenantId ?? null,
        });
        if (
            currentTenantId.current !== expectedTenant
            || requestSequence.current !== expectedLoadSequence
        ) return false;
        if (result.error || !receiveRenewalCases(result.data)) {
            setRenewalActionError('Não foi possível atualizar o acompanhamento de rematrículas.');
            return false;
        }
        setRenewalActionError('');
        return true;
    };

    const carregar = async (allowMutationInvalidation = false) => {
        if (renewalMutationInFlight.current && !allowMutationInvalidation) {
            setRenewalActionError('Aguarde a confirmação do registro em andamento antes de atualizar a tela.');
            return;
        }
        const sequence = ++requestSequence.current;
        renewalMutationSequence.current += 1;
        renewalMutationInFlight.current = false;
        setRenewalBusyKey(null);
        setLoading(true);
        setFinancialWarning('');
        setAsaasErro('');
        setRenewalLoadWarning('');
        setRenewalActionError('');
        setDados(null);
        setRenovacao(null);
        setOfertas(null);
        setAsaas(null);
        setRenewalCases({});
        setRenewalTrackingLoaded(false);
        const [recon, renov, ofer, asaasAttention, renewalTracking] = await Promise.all([
            supabase.rpc('financial_reconciliation', { p_tenant: tenantId ?? null }),
            supabase.rpc('contratos_para_renovar', { p_tenant: tenantId ?? null }),
            // Janela ampla aqui: a tela mostra tudo que vence em 90 dias para o
            // diretor se organizar. O envio automático usa `dias_antes`.
            supabase.rpc('ofertas_de_renovacao', { p_tenant: tenantId ?? null, p_dias: 90 }),
            supabase.rpc('asaas_reconciliation_attention'),
            supabase.rpc('list_student_renewal_cases', { p_tenant: tenantId ?? null }),
        ]);
        if (sequence !== requestSequence.current) return;
        const renewalWarnings: string[] = [];
        if (!ofer.error && !ofer.data?.error) setOfertas(ofer.data);
        else renewalWarnings.push('A lista de novos contratos não pôde ser carregada; acompanhamentos já abertos continuam visíveis.');
        if (recon.error || recon.data?.error) {
            setFinancialWarning(
                recon.data?.error === 'sem_permissao'
                    ? 'Seu acesso não permite conferir as pendências financeiras desta escola.'
                    : 'Não foi possível conferir as pendências financeiras agora. As rematrículas carregadas continuam disponíveis abaixo.',
            );
        }
        else setDados(recon.data);
        // Renovação é independente da reconciliação financeira, mas uma falha
        // não pode ser confundida com ausência de contratos vencendo.
        if (!renov.error && !renov.data?.error) setRenovacao(renov.data);
        else renewalWarnings.push('O radar de contratos vencendo não pôde ser carregado.');
        if (renewalTracking.error || !receiveRenewalCases(renewalTracking.data)) {
            renewalWarnings.push('O acompanhamento interno não pôde ser carregado.');
        }
        setRenewalLoadWarning(renewalWarnings.join(' '));
        if (asaasAttention.error || asaasAttention.data?.error) {
            setAsaasErro('Não foi possível conferir o Asaas agora. Tente novamente.');
        } else if (asaasAttention.data?.audit_available !== true) {
            setAsaas(asaasAttention.data);
            setAsaasErro('A auditoria operacional do Asaas ainda não foi concluída. Os pagamentos sem aluno continuam visíveis abaixo.');
        } else {
            setAsaas(asaasAttention.data);
        }
        setLoading(false);
    };

    const recordRenewalAction = async (
        offer: RenewalOffer,
        payload: RenewalActionPayload,
    ) => {
        const key = renewalKey(offer.student_id, offer.termina);
        if (!renewalTrackingLoaded) {
            setRenewalActionError('O acompanhamento ainda não foi carregado. Atualize a tela antes de registrar uma ação.');
            return false;
        }
        if (renewalMutationInFlight.current) {
            setRenewalActionError('Aguarde a confirmação do registro em andamento.');
            return false;
        }
        const current = renewalCases[key];
        const normalizedIntent = {
            action: payload.action,
            channel: payload.channel || null,
            nextActionAt: payload.nextActionAt || null,
            interestTermMonths: payload.interestTermMonths || null,
            note: payload.note?.trim() || null,
        };
        const intent = JSON.stringify(normalizedIntent);
        const pendingKey = `${tenantId || ''}:${key}`;
        const pending = pendingRenewalRequests.current[pendingKey];
        if (pending && pending.intent !== intent) {
            setRenewalActionError('Há uma tentativa anterior sem confirmação. Repita exatamente a mesma ação para confirmá-la antes de registrar outra.');
            return false;
        }
        const args = pending?.args || {
            p_student_id: offer.student_id,
            p_service_end_date: offer.termina,
            p_action: payload.action,
            p_expected_version: current?.version || 0,
            p_request_id: crypto.randomUUID(),
            p_channel: normalizedIntent.channel,
            p_contact_at: payload.action === 'CONTACTED' ? new Date().toISOString() : null,
            p_next_action_at: normalizedIntent.nextActionAt,
            p_interest_term_months: normalizedIntent.interestTermMonths,
            p_note: normalizedIntent.note,
        };
        pendingRenewalRequests.current[pendingKey] = { intent, args };
        const mutationSequence = ++renewalMutationSequence.current;
        const mutationTenant = tenantId;
        renewalMutationInFlight.current = true;
        setRenewalBusyKey(key);
        setRenewalActionError('');

        let result: Awaited<ReturnType<typeof supabase.rpc>>;
        try {
            result = await supabase.rpc('record_student_renewal_action', args);
        } catch {
            result = { data: null, error: { message: 'network_error' } } as typeof result;
        }

        if (
            mutationSequence !== renewalMutationSequence.current
            || currentTenantId.current !== mutationTenant
        ) return false;
        renewalMutationInFlight.current = false;
        setRenewalBusyKey(null);
        if (result.error) {
            // Resultado de rede desconhecido: preserve request_id para a
            // próxima tentativa consultar a mesma ação, sem duplicá-la.
            setRenewalActionError('Não foi possível confirmar o registro. Tente novamente; a mesma ação não será duplicada.');
            return false;
        }

        delete pendingRenewalRequests.current[pendingKey];
        const data = result.data as any;
        if (data?.ok !== true) {
            const messages: Record<string, string> = {
                version_conflict: 'Este acompanhamento mudou em outra tela. Os dados foram atualizados; confira antes de tentar de novo.',
                renewal_cycle_changed: 'A data do contrato mudou. O radar foi atualizado para evitar registrar a ação no ciclo errado.',
                renewal_source_changed: 'A assinatura vinculada mudou e precisa de conferência antes de continuar.',
                invalid_transition: 'Essa ação não combina mais com a etapa atual da rematrícula.',
                invalid_contact_timing: 'Confira a data do contato e do próximo retorno.',
                request_id_conflict: 'A confirmação recebida não corresponde aos dados desta tentativa. O acompanhamento foi atualizado para conferência.',
                forbidden: 'Seu acesso não permite alterar este acompanhamento.',
                tenant_mismatch: 'A aluna não pertence à escola selecionada.',
            };
            const actionErrorMessage = messages[data?.error] || 'Não foi possível registrar esta ação.';
            if (['renewal_cycle_changed', 'renewal_source_changed'].includes(data?.error)) {
                await carregar();
            } else if (['version_conflict', 'request_id_conflict'].includes(data?.error)) {
                await reloadRenewalCases();
            }
            setRenewalActionError(actionErrorMessage);
            return false;
        }

        if (data.replayed === true) {
            await reloadRenewalCases();
            return true;
        }

        setRenewalCases(previous => ({
            ...previous,
            [key]: {
                ...(previous[key] || {
                    student_id: offer.student_id,
                    service_end_date: offer.termina,
                    source_subscription_synced_at: null,
                    updated_by_name: null,
                    event_count: 0,
                }),
                id: data.case_id,
                status: data.status,
                version: Number(data.version),
                last_contact_at: data.last_contact_at || null,
                last_channel: data.last_channel || previous[key]?.last_channel || null,
                next_action_at: data.next_action_at || null,
                interest_term_months: data.interest_term_months || null,
                latest_note: normalizedIntent.note || previous[key]?.latest_note || null,
                cycle_current: true,
                updated_at: data.updated_at || new Date().toISOString(),
                updated_by_name: data.updated_by_name || null,
                event_count: Number(previous[key]?.event_count || 0) + (data.replayed ? 0 : 1),
            },
        }));
        return true;
    };

    useEffect(() => {
        void carregar(true);
        return () => {
            requestSequence.current += 1;
            renewalMutationSequence.current += 1;
            renewalMutationInFlight.current = false;
        };
    }, [tenantId]);

    if (loading) {
        return (
            <div className="flex items-center gap-2 p-10 text-brand-muted">
                <Loader2 size={16} className="animate-spin" /> Reconciliando…
            </div>
        );
    }

    const b = (k: string) => dados?.[k] || { itens: [], qtd: 0, total: 0 };
    const semCobertura = b('sem_cobertura');
    const semEstudar = b('cobrado_sem_estudar');
    const arquivado = b('arquivado_com_fatura');
    const semNf = b('pago_sem_nf');
    const paradoNf = b('parado_com_nf');
    const naoLancada = b('aula_nao_lancada');
    const divergenciasAsaas = asaas || { itens: [], qtd: 0, total: 0 };

    const r = (k: string) => renovacao?.[k] || { itens: [], qtd: 0, mensal: 0 };
    const vencendo = r('vencendo');
    const encerrado = r('encerrado');

    const totalPendencias = [semCobertura, semEstudar, arquivado, semNf, paradoNf, naoLancada, vencendo, encerrado, divergenciasAsaas]
        .reduce((s, x) => s + (x.qtd || 0), 0) + (asaasErro ? 1 : 0);
    const renewalOffers = ((ofertas?.itens || []) as RenewalOffer[]);
    const offerKeys = new Set(renewalOffers.map(offer => renewalKey(offer.student_id, offer.termina)));
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const trackedOnlyOffers = (Object.values(renewalCases) as RenewalCase[])
        .filter(item => !offerKeys.has(renewalKey(item.student_id, item.service_end_date)))
        .filter(item => {
            if (item.cycle_current !== true) return false;
            if (item.status !== 'NOT_CONTINUING_RECORDED') return true;
            const endDate = new Date(`${item.service_end_date}T00:00:00`);
            if (Number.isNaN(endDate.getTime())) return false;
            const days = Math.round((endDate.getTime() - today.getTime()) / 86_400_000);
            return days >= -30;
        })
        .map((item): RenewalOffer => {
            const endDate = new Date(`${item.service_end_date}T00:00:00`);
            const days = Number.isNaN(endDate.getTime())
                ? 0
                : Math.round((endDate.getTime() - today.getTime()) / 86_400_000);
            return {
                student_id: item.student_id,
                aluno: item.student_name?.trim() || 'Aluna em acompanhamento',
                termina: item.service_end_date,
                dias: days,
                paga_hoje: Number(item.monthly_fee_snapshot || 0),
                mensagem: null,
            };
        });
    const renewalWorkItems = [...renewalOffers, ...trackedOnlyOffers]
        .sort((left, right) => left.termina.localeCompare(right.termina));
    const visibleRenewalOffers = renewalWorkItems.filter(offer => {
        const item = renewalCases[renewalKey(offer.student_id, offer.termina)];
        if (renewalFilter === 'ALL') return true;
        if (renewalFilter === 'PENDING') return !item || item.status === 'PENDING_CONTACT';
        if (renewalFilter === 'OVERDUE') {
            return Boolean(item?.next_action_at && new Date(item.next_action_at).getTime() < Date.now());
        }
        if (renewalFilter === 'INTEREST') return item?.status === 'INTEREST_RECORDED';
        return item?.status === 'FORMALIZATION_PENDING';
    });
    const hasRenewalWarning = Boolean(renewalLoadWarning || renewalActionError);
    const hasAnyWork = totalPendencias > 0
        || renewalWorkItems.length > 0
        || hasRenewalWarning
        || Boolean(financialWarning);

    return (
        <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
            <header className="flex flex-wrap items-start justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-black tracking-tight text-brand-text sm:text-3xl">Reconciliação Financeira</h1>
                    <p className="mt-1 text-sm font-medium text-brand-muted">
                        Dinheiro parado em estados que não aparecem em inadimplência, DRE nem fluxo de caixa.
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() => void carregar()}
                    disabled={Boolean(renewalBusyKey)}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-brand-border bg-brand-surface-2 px-3.5 py-2 text-[10px] font-black uppercase tracking-widest text-brand-muted hover:text-brand-text disabled:cursor-not-allowed disabled:opacity-50"
                >
                    <RefreshCw size={13} /> Recalcular
                </button>
            </header>

            {(renewalWorkItems.length > 0 || hasRenewalWarning) && (
                <a
                    href="#renewal-tracking"
                    className="flex items-center justify-between gap-3 rounded-2xl border border-tenant-primary/30 bg-tenant-primary/5 px-4 py-3 text-sm font-black text-brand-text transition-colors hover:bg-tenant-primary/10"
                >
                    <span>Ir para acompanhamento de rematrículas</span>
                    <span className="rounded-full bg-tenant-primary px-2.5 py-1 text-xs text-white">
                        {renewalWorkItems.length}
                    </span>
                </a>
            )}

            {financialWarning && (
                <div role="alert" className="flex items-start gap-3 rounded-3xl border border-amber-500/40 bg-amber-500/5 p-5 text-sm font-bold text-brand-text">
                    <AlertTriangle size={20} className="mt-0.5 shrink-0 text-amber-500" />
                    <div>
                        <p>{financialWarning}</p>
                        <button
                            type="button"
                            onClick={() => void carregar()}
                            disabled={Boolean(renewalBusyKey)}
                            className="mt-3 rounded-xl border border-brand-border bg-brand-surface px-3 py-2 text-[10px] font-black uppercase tracking-widest text-brand-muted hover:text-brand-text disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            Tentar novamente
                        </button>
                    </div>
                </div>
            )}

            {asaasErro && (
                <div role="alert" className="flex items-start gap-3 rounded-3xl border border-red-500/40 bg-red-500/5 p-5 text-sm font-bold text-brand-text">
                    <AlertTriangle size={20} className="mt-0.5 shrink-0 text-red-500" />
                    <div>
                        <p>{asaasErro}</p>
                        <button
                            type="button"
                            onClick={() => void carregar()}
                            disabled={Boolean(renewalBusyKey)}
                            className="mt-3 rounded-xl border border-brand-border bg-brand-surface px-3 py-2 text-[10px] font-black uppercase tracking-widest text-brand-muted hover:text-brand-text disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            Tentar novamente
                        </button>
                    </div>
                </div>
            )}

            {!hasAnyWork ? (
                <div className="flex items-center gap-3 rounded-3xl border border-emerald-500/40 bg-emerald-500/5 p-6">
                    <CheckCircle2 size={20} className="text-emerald-500" />
                    <p className="text-sm font-bold text-brand-text">Nenhuma pendência de reconciliação. Tudo conferido.</p>
                </div>
            ) : (
                <>
                    <Bloco
                        icone={<AlertTriangle size={15} className="text-red-500" />}
                        titulo="Asaas e plataforma precisam de conferência"
                        porque="A auditoria automática mostra somente as divergências atuais. Pagamentos sem aluno ficam separados para ninguém atribuir receita ou dívida à pessoa errada."
                        qtd={Number(divergenciasAsaas.qtd || 0)}
                        valor={Number(divergenciasAsaas.total || 0)}
                        valorRotulo="sob conferência"
                        tom="critico"
                    >
                        <Tabela
                            colunas={['Aluno', 'Referência', 'Situação', 'Vencimento', 'Valor', 'Problema']}
                            linhas={(divergenciasAsaas.itens || []).map((i: any) => [
                                i.aluno || 'Sem aluno vinculado', i.referencia || '—', i.status || '—',
                                i.vencimento || '—', brl(i.valor || 0), i.problema || 'Revisão necessária',
                            ])}
                        />
                    </Bloco>

                    <Bloco
                        icone={<Wallet size={15} className="text-red-500" />}
                        titulo="Aula entregue além do que foi pago"
                        porque="Meses de aula dados menos meses pagos. Quem pagou o ano à vista não aparece aqui — a conta é dinheiro recebido, não número de boletos."
                        qtd={semCobertura.qtd}
                        valor={Number(semCobertura.total || 0)}
                        valorRotulo="estimado"
                        tom="critico"
                        acao={{ label: 'Ir para Mensalidades', tab: 'student-payments' }}
                        onNavigate={onNavigate}
                    >
                        <Tabela
                            colunas={['Aluno', 'Mensalidade', 'Meses de aula', 'Meses pagos', 'Déficit', 'Recebido', 'Estimado']}
                            linhas={(semCobertura.itens || []).map((i: any) => [
                                i.aluno, brl(i.mensalidade), i.meses_servico, i.meses_pagos,
                                `${i.deficit_meses} ${Number(i.deficit_meses) === 1 ? 'mês' : 'meses'}`,
                                brl(i.total_recebido), brl(i.valor_estimado),
                            ])}
                        />
                        <p className="mt-3 text-[10px] text-brand-muted">
                            "Estimado" é déficit × mensalidade atual — serve para dimensionar o buraco, não para emitir boleto.
                        </p>
                    </Bloco>

                    <Bloco
                        icone={<CalendarX size={15} className="text-red-500" />}
                        titulo="Aula sendo dada sem pagamento"
                        porque="O último mês pago já passou e o aluno continua tendo aula. Aqui não é risco futuro — é prejuízo acontecendo agora."
                        qtd={encerrado.qtd}
                        valor={Number(encerrado.mensal || 0)}
                        valorRotulo="por mês em risco"
                        tom="critico"
                        acao={{ label: 'Ir para Alunos', tab: 'students' }}
                        onNavigate={onNavigate}
                    >
                        <Tabela
                            colunas={['Aluno', 'Última aula paga', 'Dias sem pagar', 'Aulas 60d', 'Mensalidade']}
                            linhas={(encerrado.itens || []).map((i: any) => [
                                i.aluno, i.termina || '—', i.dias_de_graca ?? '—', i.aulas_60d, brl(i.mensalidade),
                            ])}
                        />
                    </Bloco>

                    {/* Funil operacional. O registro é deliberadamente interno:
                        não envia mensagem, não assina e não altera o Asaas. */}
                    {(renewalWorkItems.length > 0 || hasRenewalWarning) && (
                        <section id="renewal-tracking" className="scroll-mt-4 rounded-3xl border border-brand-border bg-brand-surface-2/40 p-5 sm:p-6">
                            <header className="mb-5 space-y-4">
                                <div className="flex flex-wrap items-start justify-between gap-3">
                                    <div>
                                        <h3 className="flex items-center gap-2 text-sm font-black tracking-tight text-brand-text">
                                            <MessageSquare size={15} className="text-tenant-primary" />
                                            Acompanhamento de rematrículas
                                            <span className="rounded-full bg-brand-surface px-2.5 py-0.5 text-[10px] font-black text-brand-muted">
                                                {renewalWorkItems.length}
                                            </span>
                                        </h3>
                                        <p className="mt-1 max-w-3xl text-xs text-brand-muted">
                                            Organiza contato, retorno e interesse em 6 ou 12 meses. É um <strong>registro interno</strong>:
                                            não representa aceite, não envia mensagem, não renova contrato e não altera cobrança.
                                        </p>
                                    </div>
                                    <label className="text-[9px] font-black uppercase tracking-widest text-brand-muted">
                                        Mostrar
                                        <select
                                            value={renewalFilter}
                                            onChange={event => setRenewalFilter(event.target.value as typeof renewalFilter)}
                                            className="ml-2 rounded-xl border border-brand-border bg-brand-surface px-3 py-2 text-xs font-bold normal-case tracking-normal text-brand-text"
                                        >
                                            <option value="ALL">Todos</option>
                                            <option value="PENDING">Sem contato</option>
                                            <option value="OVERDUE">Retorno vencido</option>
                                            <option value="INTEREST">Interesse informado</option>
                                            <option value="FORMALIZATION">Aguardando formalização</option>
                                        </select>
                                    </label>
                                </div>

                                <div className="grid gap-2 sm:grid-cols-4" aria-label="Etapas da rematrícula">
                                    {[
                                        ['D-90', 'Entrar no radar'],
                                        ['D-30', 'Conferir plano e agenda'],
                                        ['D-15', 'Fazer contato'],
                                        ['D-7', 'Tratar como urgente'],
                                    ].map(([mark, label]) => (
                                        <div key={mark} className="rounded-xl border border-brand-border bg-brand-surface px-3 py-2">
                                            <p className="text-[10px] font-black text-tenant-primary">{mark}</p>
                                            <p className="text-[10px] font-bold text-brand-muted">{label}</p>
                                        </div>
                                    ))}
                                </div>

                                <div className="rounded-2xl border border-amber-300/60 bg-amber-50 p-3 text-xs font-bold text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-200">
                                    A mensagem abaixo é somente um rascunho. Confira datas e valores antes de enviar.
                                    Copiar não envia nem registra contato; depois do envio, use “Registrar contato”.
                                </div>

                                {hasRenewalWarning && (
                                    <div role="alert" className="flex items-center justify-between gap-3 rounded-2xl border border-red-400/50 bg-red-50 p-3 text-xs font-bold text-red-800 dark:bg-red-950/20 dark:text-red-200">
                                        <div className="space-y-1">
                                            {renewalLoadWarning && <p>{renewalLoadWarning}</p>}
                                            {renewalActionError && <p>{renewalActionError}</p>}
                                        </div>
                                        <button
                                            type="button"
                                            onClick={() => void carregar()}
                                            disabled={Boolean(renewalBusyKey)}
                                            className="shrink-0 rounded-xl border border-red-400/40 px-3 py-2 text-[9px] font-black uppercase tracking-widest disabled:cursor-not-allowed disabled:opacity-50"
                                        >
                                            Atualizar
                                        </button>
                                    </div>
                                )}
                            </header>

                            <div className="space-y-3">
                                {visibleRenewalOffers.map(offer => {
                                    const key = renewalKey(offer.student_id, offer.termina);
                                    return (
                                        <RenewalTrackingCard
                                            key={key}
                                            offer={offer}
                                            renewalCase={renewalCases[key]}
                                            trackingAvailable={renewalTrackingLoaded}
                                            busy={Boolean(renewalBusyKey)}
                                            copied={copiado === key}
                                            onCopy={async () => {
                                                try {
                                                    await navigator.clipboard.writeText(offer.mensagem || '');
                                                    setCopiado(key);
                                                    setTimeout(() => setCopiado(null), 2000);
                                                } catch {
                                                    setRenewalActionError('Não foi possível copiar automaticamente. O texto continua visível para seleção manual.');
                                                }
                                            }}
                                            onAction={payload => recordRenewalAction(offer, payload)}
                                        />
                                    );
                                })}
                                {visibleRenewalOffers.length === 0 && (
                                    <p className="rounded-2xl border border-brand-border bg-brand-surface p-4 text-center text-xs font-bold text-brand-muted">
                                        Nenhuma rematrícula neste filtro.
                                    </p>
                                )}
                            </div>

                            <div className="mt-4 space-y-1 text-[10px] text-brand-muted">
                                <p>Aluno mensal não aparece aqui de propósito — quem escolheu mensal segue mensal até pedir para parar.</p>
                                <p>“Não pretende continuar” é apenas um relato interno; não cancela aulas, contrato ou cobrança.</p>
                                <p>A formalização deve ser feita pelo próprio aluno em um fluxo contratual separado.</p>
                            </div>
                        </section>
                    )}

                    <Bloco
                        icone={<CalendarClock size={15} className="text-amber-500" />}
                        titulo="Contrato vencendo em até 90 dias"
                        porque="Momento de conversar sobre renovação. O professor e os horários aparecem porque é isso que a pessoa não quer perder — não o preço."
                        qtd={vencendo.qtd}
                        valor={Number(vencendo.mensal || 0)}
                        valorRotulo="por mês em jogo"
                        tom="atencao"
                        acao={{ label: 'Ir para Alunos', tab: 'students' }}
                        onNavigate={onNavigate}
                    >
                        <Tabela
                            colunas={['Aluno', 'Última aula paga', 'Em', 'Cobrança', 'Professor', 'Horários que perde']}
                            linhas={(vencendo.itens || []).map((i: any) => [
                                i.aluno, i.termina, `${i.dias} dias`,
                                // Cobrança parada = a Asaas não gera mais fatura. Renovar aqui
                                // não é só vender de novo, é religar o faturamento.
                                i.cobranca_parada ? '⚠️ já parou' : 'ativa',
                                i.professor || '—', i.horarios || '—',
                            ])}
                        />
                    </Bloco>

                    <Bloco
                        icone={<UserX size={15} className="text-amber-500" />}
                        titulo="Cobrado sem estudar"
                        porque="Fatura correndo para quem não tem agenda nem aula há 90 dias. Ou encerra, ou cobra de verdade."
                        qtd={semEstudar.qtd}
                        valor={Number(semEstudar.total || 0)}
                        valorRotulo="em aberto"
                        tom="atencao"
                        acao={{ label: 'Ir para Alunos', tab: 'students' }}
                        onNavigate={onNavigate}
                    >
                        <Tabela
                            colunas={['Aluno', 'Faturas abertas', 'Em aberto']}
                            linhas={(semEstudar.itens || []).map((i: any) => [
                                i.aluno, i.faturas_abertas, brl(i.em_aberto),
                            ])}
                        />
                    </Bloco>

                    <Bloco
                        icone={<UserMinus size={15} className="text-amber-500" />}
                        titulo="Arquivado com fatura em aberto"
                        porque="O aluno já foi arquivado, mas as faturas ficaram de pé — ninguém as cobra e mesmo assim elas inflam o total de inadimplência."
                        qtd={arquivado.qtd}
                        valor={Number(arquivado.total || 0)}
                        valorRotulo="a cancelar ou cobrar"
                        tom="atencao"
                        acao={{ label: 'Ir para Mensalidades', tab: 'student-payments' }}
                        onNavigate={onNavigate}
                    >
                        <Tabela
                            colunas={['Aluno', 'Situação', 'Faturas abertas', 'Em aberto']}
                            linhas={(arquivado.itens || []).map((i: any) => [
                                i.aluno, i.status, i.faturas_abertas, brl(i.em_aberto),
                            ])}
                        />
                    </Bloco>

                    <Bloco
                        icone={<FileWarning size={15} className="text-amber-500" />}
                        titulo="Pago sem nota fiscal"
                        porque="O repasse saiu e a nota não entrou há mais de 30 dias. Risco fiscal."
                        qtd={semNf.qtd}
                        valor={Number(semNf.total || 0)}
                        valorRotulo="sem NF"
                        tom="atencao"
                        acao={{ label: 'Ir para Notas Fiscais', tab: 'invoices' }}
                        onNavigate={onNavigate}
                    >
                        <Tabela
                            colunas={['Professor', 'Mês', 'Situação', 'Valor', 'Pago em']}
                            linhas={(semNf.itens || []).map((i: any) => [
                                i.professor, i.month_year, i.status, brl(i.valor), i.pago_em,
                            ])}
                        />
                    </Bloco>

                    <Bloco
                        icone={<AlertTriangle size={15} className="text-amber-500" />}
                        titulo="Fechamento parado esperando aprovação"
                        porque="O professor anexou a nota há mais de 7 dias e ninguém aprovou. Cada dia aqui é um dia que ele não recebe."
                        qtd={paradoNf.qtd}
                        valor={Number(paradoNf.total || 0)}
                        valorRotulo="a aprovar"
                        tom="critico"
                        acao={{ label: 'Ir para Repasse a profs', tab: 'payments' }}
                        onNavigate={onNavigate}
                    >
                        <Tabela
                            colunas={['Professor', 'Mês', 'Valor', 'Dias parado']}
                            linhas={(paradoNf.itens || []).map((i: any) => [
                                i.professor, i.month_year, brl(i.valor), i.dias_parado,
                            ])}
                        />
                    </Bloco>

                    <Bloco
                        icone={<AlertTriangle size={15} className="text-amber-500" />}
                        titulo="Aula confirmada e nunca lançada"
                        porque="O aluno confirmou que a aula aconteceu e não existe lançamento. O professor não vai receber por ela."
                        qtd={naoLancada.qtd}
                        tom="atencao"
                        acao={{ label: 'Ir para Verificar Presença', tab: 'attendance-disputes' }}
                        onNavigate={onNavigate}
                    >
                        <Tabela
                            colunas={['Professor', 'Aluno', 'Data', 'Dias']}
                            linhas={(naoLancada.itens || []).map((i: any) => [
                                i.professor, i.aluno, i.data, i.dias,
                            ])}
                        />
                    </Bloco>
                </>
            )}

            <p className="pb-4 text-[10px] text-brand-muted">
                Esta tela não emite cobrança nem cancela contrato — ela mostra e leva à tela onde a decisão é tomada.
            </p>
        </div>
    );
};

export default FinancialReconciliation;
