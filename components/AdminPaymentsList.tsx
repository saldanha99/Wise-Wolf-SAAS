import React, { lazy, Suspense, useState, useEffect, useMemo, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { formatLocalDateBr, localMonth, localYMD, monthRange } from '../lib/dateUtils';
import { Download, Search, RefreshCw, CheckCircle, AlertCircle, Clock, Wallet, TrendingUp, CreditCard, CalendarClock, Layers } from 'lucide-react';
import { isSettledStudentPayment, isStudentPaymentAwaitingCredit } from '../lib/studentPaymentStatus';
import { billingLabel, dueHint, paymentBucket, summarizePayments, type PaymentBucket } from '../lib/paymentInsights';
import { Kpi3D, PageHero3D, type Tone } from './depth/Depth3D';

const PrepaymentManager = lazy(() => import('./PrepaymentManager'));

const money = (v: number) => `R$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

type StatusFilter = 'ALL' | 'SETTLED' | 'CONFIRMED' | 'PENDING' | 'OVERDUE' | 'CANCELLED';

const BUCKET_TONE: Record<PaymentBucket, Tone> = {
    SETTLED: 'emerald',
    CONFIRMED: 'sky',
    PENDING: 'amber',
    OVERDUE: 'rose',
    CANCELLED: 'slate',
    OTHER: 'slate',
};

const AdminPaymentsList: React.FC<{ tenantId: string }> = ({ tenantId }) => {
    const [payments, setPayments] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    // localMonth (não toISOString): depois das 21h do último dia o mês pularia para o seguinte
    const [month, setMonth] = useState(localMonth());
    const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
    const [search, setSearch] = useState('');
    const [errorMessage, setErrorMessage] = useState('');
    const [showPrepayments, setShowPrepayments] = useState(false);
    const requestSequence = useRef(0);

    // Busca o mês inteiro e filtra o status na tela: os números do topo
    // precisam do mês completo, e trocar de filtro não deve ir ao banco de novo.
    const fetchPayments = async () => {
        const sequence = ++requestSequence.current;
        setLoading(true);
        setErrorMessage('');
        setPayments([]);
        try {
            // Filtro do mês por due_date, janela [dia 1, dia 1 do mês seguinte).
            // O cálculo antigo (new Date(month) + setMonth) escorregava no fuso: escondia
            // as mensalidades que vencem no dia 31 e puxava as do dia 1º do mês seguinte.
            const { start, endExclusive } = monthRange(month);

            const { data, error } = await supabase
                .from('student_payments')
                .select(`
                    *,
                    profiles (
                        full_name,
                        email,
                        tenant_id
                    )
                `)
                .eq('tenant_id', tenantId)
                .gte('due_date', start)
                .lt('due_date', endExclusive)
                .order('due_date', { ascending: false });

            if (error) throw error;
            if (sequence !== requestSequence.current) return;
            setPayments(data || []);

        } catch (error) {
            console.error("Error fetching payments:", error);
            if (sequence === requestSequence.current) {
                setErrorMessage('Não foi possível consultar os pagamentos. Tente novamente.');
            }
        } finally {
            if (sequence === requestSequence.current) setLoading(false);
        }
    };

    useEffect(() => {
        if (tenantId) fetchPayments();
        return () => { requestSequence.current += 1; };
    }, [tenantId, month]);

    const today = localYMD(new Date());
    const summary = useMemo(() => summarizePayments(payments, today), [payments, today]);

    const visible = useMemo(() => {
        const q = search.trim().toLocaleLowerCase('pt-BR');
        return payments.filter(p => {
            const bucket = paymentBucket(p.status);
            if (statusFilter !== 'ALL' && bucket !== statusFilter) return false;
            if (!q) return true;
            return String(p.profiles?.full_name || '').toLocaleLowerCase('pt-BR').includes(q)
                || String(p.profiles?.email || '').toLocaleLowerCase('pt-BR').includes(q);
        });
    }, [payments, statusFilter, search]);

    const getStatusBadge = (status: string) => {
        const pill = 'inline-flex items-center gap-1 px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest border';
        if (isSettledStudentPayment(status)) {
            return <span className={`${pill} bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/25`}><CheckCircle size={12} /> Pago</span>;
        }
        if (isStudentPaymentAwaitingCredit(status)) {
            return <span className={`${pill} bg-sky-500/10 text-sky-700 dark:text-sky-300 border-sky-500/25`}><Clock size={12} /> Confirmado · aguardando crédito</span>;
        }
        switch (status) {
            case 'OVERDUE':
                return <span className={`${pill} bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/25`}><AlertCircle size={12} /> Atrasado</span>;
            case 'PENDING':
                return <span className={`${pill} bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/25`}><Clock size={12} /> Pendente</span>;
            case 'CANCELLED':
                return <span className={`${pill} bg-slate-500/10 text-slate-600 dark:text-slate-300 border-slate-500/25`}><AlertCircle size={12} /> Cancelado</span>;
            default:
                return <span className={`${pill} bg-brand-surface-2 text-brand-muted border-brand-border`}>{status}</span>;
        }
    };

    const chips: { id: StatusFilter; label: string; count: number; tone: Tone }[] = [
        { id: 'ALL', label: 'Todos', count: payments.length, tone: 'brand' },
        { id: 'SETTLED', label: 'Pagos', count: summary.byBucket.SETTLED.count, tone: 'emerald' },
        { id: 'CONFIRMED', label: 'Aguardando crédito', count: summary.byBucket.CONFIRMED.count, tone: 'sky' },
        { id: 'PENDING', label: 'Pendentes', count: summary.byBucket.PENDING.count, tone: 'amber' },
        { id: 'OVERDUE', label: 'Atrasados', count: summary.byBucket.OVERDUE.count, tone: 'rose' },
        { id: 'CANCELLED', label: 'Cancelados', count: summary.byBucket.CANCELLED.count, tone: 'slate' },
    ];

    const initials = (name?: string) => (name || '?').split(' ').filter(Boolean).slice(0, 2).map(p => p[0]).join('').toUpperCase();

    const actionsFor = (p: any) => (
        <>
            {p.invoice_url && (
                <a href={p.invoice_url} target="_blank" rel="noopener noreferrer" className="ww-lift inline-grid h-9 w-9 place-items-center rounded-xl border border-brand-border bg-brand-surface text-brand-muted hover:text-tenant-primary dark:hover:text-brand-accent" title="Ver Recibo/Boleto" aria-label={`Ver recibo ou boleto de ${p.profiles?.full_name || 'aluno'}`}>
                    <Download size={16} />
                </a>
            )}
            {!p.invoice_url && (p.status === 'PENDING' || p.status === 'OVERDUE') && (
                <span className="text-[9px] font-black uppercase tracking-wider text-brand-muted" title="A baixa acontece pela conciliação auditada com o Asaas">
                    Conciliação automática
                </span>
            )}
        </>
    );

    return (
        <div className="ww-stage space-y-5">
            <PageHero3D
                icon={<Wallet size={26} />}
                eyebrow="Dinheiro"
                title="Mensalidades dos Alunos"
                subtitle="Pagamentos completos cobrem vários meses sem duplicar recebimentos."
                tone="emerald"
                actions={
                    <button type="button" aria-expanded={showPrepayments} aria-controls="student-prepayments-panel" onClick={() => setShowPrepayments(value => !value)} className="ww-lift rounded-2xl border border-brand-border bg-brand-surface px-4 py-2.5 text-sm font-bold text-brand-text flex items-center justify-center gap-2 shadow-sm">
                        <Layers size={16} className="text-tenant-primary dark:text-brand-accent" />
                        {showPrepayments ? 'Fechar pagamentos completos' : 'Gerenciar pagamentos completos'}
                    </button>
                }
            />
            {showPrepayments ? <div id="student-prepayments-panel"><Suspense fallback={<p role="status" className="p-4 text-sm text-brand-muted">Carregando pagamentos completos…</p>}><PrepaymentManager key={tenantId} tenantId={tenantId} /></Suspense></div> : null}

            {/* Retrato do mês */}
            <div data-tour="payments-month-portrait" className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
                <Kpi3D
                    icon={<TrendingUp size={20} />}
                    tone="emerald"
                    label="Recebido"
                    value={money(summary.byBucket.SETTLED.total)}
                    hint={`${summary.settledPct}% de ${money(summary.expected.total)} previstos`}
                    ring={summary.settledPct}
                />
                <Kpi3D
                    icon={<CreditCard size={20} />}
                    tone="sky"
                    label="Aguardando crédito"
                    value={money(summary.byBucket.CONFIRMED.total)}
                    hint={`${summary.byBucket.CONFIRMED.count} cartão${summary.byBucket.CONFIRMED.count === 1 ? '' : 'ões'} aprovado${summary.byBucket.CONFIRMED.count === 1 ? '' : 's'}, ainda sem crédito`}
                />
                <Kpi3D
                    icon={<CalendarClock size={20} />}
                    tone="amber"
                    label="A vencer"
                    value={money(summary.byBucket.PENDING.total)}
                    hint={summary.dueThisWeek.count > 0
                        ? `${summary.dueThisWeek.count} vence${summary.dueThisWeek.count === 1 ? '' : 'm'} em até 7 dias (${money(summary.dueThisWeek.total)})`
                        : `${summary.byBucket.PENDING.count} cobrança${summary.byBucket.PENDING.count === 1 ? '' : 's'} em aberto`}
                />
                <Kpi3D
                    icon={<AlertCircle size={20} />}
                    tone="rose"
                    label="Em atraso"
                    value={money(summary.byBucket.OVERDUE.total)}
                    valueClassName={summary.byBucket.OVERDUE.total > 0 ? 'text-rose-600 dark:text-rose-400' : ''}
                    hint={summary.byBucket.OVERDUE.count > 0 ? `${summary.byBucket.OVERDUE.count} aluno${summary.byBucket.OVERDUE.count === 1 ? '' : 's'} com mensalidade vencida` : 'Ninguém em atraso neste mês'}
                />
            </div>

            <div className="ww-slab overflow-hidden">
                <div className="p-5 sm:p-6 border-b border-brand-border/60 space-y-4">
                    <div className="flex flex-col md:flex-row justify-between md:items-center gap-4">
                        <div>
                            <h3 className="font-black text-brand-text text-lg tracking-tight">Fluxo de Caixa Detalhado</h3>
                            <p className="text-sm text-brand-muted font-medium">Baixas confirmadas pelo Asaas; ajustes exigem conciliação auditada.</p>
                        </div>

                        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
                            <div className="relative">
                                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-brand-muted" size={14} />
                                <input
                                    value={search}
                                    onChange={e => setSearch(e.target.value)}
                                    placeholder="Buscar aluno…"
                                    aria-label="Buscar aluno"
                                    className="w-full pl-9 pr-3 py-2 bg-brand-surface-2/70 border border-brand-border rounded-xl text-sm font-bold text-brand-text sm:w-48"
                                />
                            </div>
                            <input
                                type="month"
                                value={month}
                                onChange={e => setMonth(e.target.value)}
                                aria-label="Mês de vencimento"
                                className="w-full px-4 py-2 bg-brand-surface-2/70 border border-brand-border rounded-xl text-sm font-bold text-brand-text sm:w-auto"
                            />
                            <select
                                value={statusFilter}
                                onChange={e => setStatusFilter(e.target.value as StatusFilter)}
                                aria-label="Filtrar por status"
                                className="w-full px-4 py-2 bg-brand-surface-2/70 border border-brand-border rounded-xl text-sm font-bold text-brand-text sm:w-auto"
                            >
                                <option value="ALL">Todos os Status</option>
                                <option value="SETTLED">Pagos</option>
                                <option value="CONFIRMED">Confirmados, aguardando crédito</option>
                                <option value="PENDING">Pendentes</option>
                                <option value="OVERDUE">Atrasados</option>
                                <option value="CANCELLED">Cancelados</option>
                            </select>
                            <button aria-label="Atualizar pagamentos" onClick={fetchPayments} className="ww-lift grid place-items-center p-2.5 bg-brand-surface-2/70 border border-brand-border text-brand-muted rounded-xl hover:text-brand-text">
                                <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
                            </button>
                        </div>
                    </div>

                    {/* Barra empilhada do mês: quanto de cada situação no previsto */}
                    {summary.expected.total > 0 && (
                        <div>
                            <div className="flex h-3 w-full overflow-hidden rounded-full bg-brand-surface-2 shadow-inner">
                                {(['SETTLED', 'CONFIRMED', 'PENDING', 'OVERDUE'] as PaymentBucket[]).map(b => {
                                    const w = (100 * summary.byBucket[b].total) / summary.expected.total;
                                    return w > 0 ? (
                                        <div key={b} className={`tone-${BUCKET_TONE[b]} h-full`} style={{ width: `${w}%`, background: 'linear-gradient(180deg, rgb(var(--tone) / 0.95), rgb(var(--tone) / 0.7))' }} />
                                    ) : null;
                                })}
                            </div>
                        </div>
                    )}

                    <div className="flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Situação das mensalidades">
                        {chips.map(c => {
                            const active = statusFilter === c.id;
                            return (
                                <button
                                    key={c.id}
                                    type="button"
                                    role="tab"
                                    aria-selected={active}
                                    onClick={() => setStatusFilter(c.id)}
                                    className={`shrink-0 rounded-xl px-3 py-1.5 text-[11px] font-black whitespace-nowrap ${active ? `ww-block tone-${c.tone}` : 'border border-brand-border bg-brand-surface text-brand-muted hover:text-brand-text'}`}
                                >
                                    <span className="relative">{c.label} · {c.count}</span>
                                </button>
                            );
                        })}
                    </div>
                </div>

                {errorMessage && (
                    <div role="alert" className="m-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-red-500/40 bg-red-500/5 p-4 text-sm font-bold text-brand-text sm:m-6">
                        <span>{errorMessage}</span>
                        <button type="button" onClick={fetchPayments} className="rounded-xl border border-brand-border bg-brand-surface px-3 py-2 text-[10px] font-black uppercase tracking-widest text-brand-muted">
                            Tentar novamente
                        </button>
                    </div>
                )}

                {loading ? (
                    <div className="py-14 flex items-center justify-center gap-2 text-brand-muted font-bold"><RefreshCw size={18} className="animate-spin" /> Carregando...</div>
                ) : visible.length === 0 ? (
                    <div className="py-14 text-center text-brand-muted font-bold">Nenhum registro encontrado neste período.</div>
                ) : (
                    <>
                        {/* Celular: cartões */}
                        <div className="md:hidden p-3 space-y-2">
                            {visible.map(p => {
                                const bucket = paymentBucket(p.status);
                                const hint = dueHint(p.status, p.due_date, today);
                                return (
                                    <article key={p.id} className="rounded-2xl border border-brand-border bg-brand-surface/70 p-3.5">
                                        <div className="flex items-start gap-3">
                                            <span className={`ww-orb tone-${BUCKET_TONE[bucket]} h-10 w-10 shrink-0 text-xs font-black`}>{initials(p.profiles?.full_name)}</span>
                                            <div className="min-w-0 flex-1">
                                                <p className="text-sm font-bold text-brand-text truncate">{p.profiles?.full_name || 'Sem aluno vinculado'}</p>
                                                <p className="text-[11px] text-brand-muted truncate">{p.profiles?.email || 'Aguardando classificação da gestão'}</p>
                                            </div>
                                            <p className="text-base font-black text-brand-text whitespace-nowrap">{money(Number(p.value))}</p>
                                        </div>
                                        <div className="mt-3 flex flex-wrap items-center gap-2">
                                            {getStatusBadge(p.status)}
                                            <span className="text-[11px] font-bold text-brand-muted">Vence {formatLocalDateBr(p.due_date)}</span>
                                            {hint && <span className={`text-[11px] font-black ${bucket === 'OVERDUE' ? 'text-rose-500' : 'text-amber-600 dark:text-amber-400'}`}>· {hint}</span>}
                                            <span className="ml-auto flex items-center gap-2">{actionsFor(p)}</span>
                                        </div>
                                    </article>
                                );
                            })}
                        </div>

                        {/* Computador: tabela */}
                        <div className="hidden md:block overflow-x-auto">
                            <table className="w-full text-left min-w-[760px]">
                                <thead className="text-[10px] uppercase font-black tracking-[0.14em] text-brand-muted">
                                    <tr>
                                        <th className="px-6 py-3">Aluno</th>
                                        <th className="px-6 py-3">Vencimento</th>
                                        <th className="px-6 py-3">Pagamento</th>
                                        <th className="px-6 py-3">Forma</th>
                                        <th className="px-6 py-3">Status</th>
                                        <th className="px-6 py-3 text-right">Valor</th>
                                        <th className="px-6 py-3 text-center">Ações</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-brand-border/50">
                                    {visible.map((p) => {
                                        const bucket = paymentBucket(p.status);
                                        const hint = dueHint(p.status, p.due_date, today);
                                        return (
                                            <tr key={p.id} className="group hover:bg-brand-surface-2/50 transition-colors">
                                                <td className="px-6 py-3.5">
                                                    <div className="flex items-center gap-3">
                                                        <span className={`ww-orb tone-${BUCKET_TONE[bucket]} h-10 w-10 shrink-0 text-xs font-black transition-transform group-hover:-translate-y-0.5`}>{initials(p.profiles?.full_name)}</span>
                                                        <div className="flex flex-col min-w-0">
                                                            <span className="text-sm font-bold text-brand-text truncate">
                                                                {p.profiles?.full_name || 'Sem aluno vinculado'}
                                                            </span>
                                                            <span className="text-[10px] text-brand-muted font-medium truncate">
                                                                {p.profiles?.email || 'Aguardando classificação da gestão'}
                                                            </span>
                                                        </div>
                                                    </div>
                                                </td>
                                                <td className="px-6 py-3.5">
                                                    <span className="block text-xs font-bold text-brand-text">{formatLocalDateBr(p.due_date)}</span>
                                                    {hint && <span className={`block text-[10px] font-black ${bucket === 'OVERDUE' ? 'text-rose-500' : 'text-amber-600 dark:text-amber-400'}`}>{hint}</span>}
                                                </td>
                                                <td className="px-6 py-3.5 text-xs font-bold text-brand-muted">
                                                    {formatLocalDateBr(p.payment_date, '-')}
                                                </td>
                                                <td className="px-6 py-3.5">
                                                    <span className="inline-flex rounded-lg border border-brand-border bg-brand-surface-2/60 px-2 py-1 text-[10px] font-black uppercase tracking-wider text-brand-muted">
                                                        {billingLabel(p.billing_type)}
                                                    </span>
                                                </td>
                                                <td className="px-6 py-3.5">
                                                    {getStatusBadge(p.status)}
                                                </td>
                                                <td className="px-6 py-3.5 text-right font-black text-brand-text whitespace-nowrap">
                                                    {money(Number(p.value))}
                                                </td>
                                                <td className="px-6 py-3.5">
                                                    <div className="flex items-center justify-center gap-2">{actionsFor(p)}</div>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                        <div className="px-6 py-3 border-t border-brand-border/60 flex justify-between text-xs font-bold text-brand-muted">
                            <span>{visible.length} cobrança{visible.length === 1 ? '' : 's'}</span>
                            <span>Total na lista: <span className="text-brand-text font-black">{money(visible.reduce((s, p) => s + (Number(p.value) || 0), 0))}</span></span>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
};

export default AdminPaymentsList;
