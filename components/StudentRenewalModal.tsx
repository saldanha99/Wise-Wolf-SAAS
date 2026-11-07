import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, Copy, ExternalLink, FileSignature, Loader2, RefreshCw, X } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { APP_BASE_URL } from '../constants';
import {
    addDaysIso, isRenewalContext, renewalBillingError, renewalCatalogPrice, renewalDateLabel, renewalError,
    renewalFeeCents, renewalMoney, renewalMonthLabel, renewalOfferStatus, renewalPreview, renewalSourceLabel,
    renewalToday, type RenewalContext, type RenewalOffer, type RenewalPlan, type RenewalTerm,
} from '../lib/studentRenewal';

interface Props {
    studentId: string;
    onClose: () => void;
    onChanged?: () => void;
}

const fieldClass = 'mt-1 w-full rounded-xl border border-brand-border bg-brand-surface-2 px-3 py-2.5 text-sm text-brand-text outline-hidden focus:ring-2 focus:ring-brand-accent disabled:opacity-50';
const labelClass = 'block text-[10px] font-black uppercase tracking-widest text-brand-muted';
const toneClass: Record<string, string> = {
    ok: 'bg-emerald-500/10 text-emerald-600',
    wait: 'bg-amber-500/10 text-amber-600',
    bad: 'bg-red-500/10 text-red-600',
    off: 'bg-brand-surface-2 text-brand-muted',
};

const PLAN_OPTIONS: Array<{ id: RenewalPlan; title: string; text: string }> = [
    { id: 'UPFRONT_CHARGE', title: 'Pagamento integral: cobrar no Asaas', text: 'O aluno assina primeiro. Depois sai uma cobrança só, pelo valor total, e os meses ficam cobertos quando o dinheiro entra.' },
    { id: 'UPFRONT_EXTERNAL', title: 'Pagamento integral: já recebido por fora', text: 'Não gera cobrança, não entra no caixa nem no rateio. Só cobre os meses depois da assinatura.' },
    { id: 'INSTALLMENTS', title: 'Parcelado', text: 'Cobrança mensal recorrente no Asaas, uma parcela por mês.' },
];

/** A direção conduz a renovação daqui; quem aplica as condições é a assinatura do aluno. */
const StudentRenewalModal: React.FC<Props> = ({ studentId, onClose, onChanged }) => {
    const [context, setContext] = useState<RenewalContext | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState('');
    const [term, setTerm] = useState<RenewalTerm>(12);
    const [fee, setFee] = useState('');
    const [frequency, setFrequency] = useState('');
    const [dueDay, setDueDay] = useState('');
    const [start, setStart] = useState('');
    const [plan, setPlan] = useState<RenewalPlan>('UPFRONT_CHARGE');
    const [billingType, setBillingType] = useState('PIX');
    const [chargeDue, setChargeDue] = useState(addDaysIso(renewalToday(), 3));
    const [receivedOn, setReceivedOn] = useState('');
    const [receivedReference, setReceivedReference] = useState('');
    const [contractReference, setContractReference] = useState('');
    const [note, setNote] = useState('');
    const [sendLink, setSendLink] = useState(true);
    const [confirmed, setConfirmed] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [created, setCreated] = useState<{ token: string | null; linkSent: boolean } | null>(null);
    const [copied, setCopied] = useState(false);
    const [cancelOffer, setCancelOffer] = useState<string | null>(null);
    const [cancelReason, setCancelReason] = useState('');
    const requestId = useRef(crypto.randomUUID());
    const initialized = useRef(false);

    const load = useCallback(async () => {
        setLoading(true);
        setLoadError('');
        const { data, error: rpcError } = await supabase.rpc('get_student_renewal_context', { p_student: studentId });
        if (rpcError || !isRenewalContext(data)) {
            setContext(null);
            setLoadError(renewalError(data?.error));
            setLoading(false);
            return;
        }
        setContext(data);
        if (!initialized.current) {
            initialized.current = true;
            const student = data.student;
            const currentFrequency = Number(String(student.class_frequency || '').match(/\d+/)?.[0]) || student.weekly_lessons || 0;
            setFrequency(currentFrequency ? String(currentFrequency) : '');
            setFee(student.monthly_fee ? Number(student.monthly_fee).toFixed(2).replace('.', ',') : '');
            setStart(data.period.suggested_start);
            setDueDay(String(student.due_day || Math.min(Number(data.period.suggested_start.slice(8, 10)), 28)));
            if (student.subscription_status === 'ACTIVE') setPlan('INSTALLMENTS');
        }
        setLoading(false);
    }, [studentId]);

    useEffect(() => { void load(); }, [load]);

    const invalidate = () => { setConfirmed(false); setError(''); };
    const feeCents = renewalFeeCents(fee);
    const frequencyNumber = Number(frequency);
    const dueDayNumber = Number(dueDay);
    const preview = useMemo(() => renewalPreview(start, dueDayNumber, term, feeCents), [start, dueDayNumber, term, feeCents]);
    const catalogPrice = context && frequencyNumber ? renewalCatalogPrice(context, term, frequencyNumber) : null;
    const offCatalog = feeCents !== null && (catalogPrice === null || Math.round(catalogPrice * 100) !== feeCents);
    const contractMissing = context ? !context.student.contract_accepted : false;
    const openOffer = context?.offers.find(offer => offer.status === 'PENDING_SIGNATURE' && !offer.expired);
    const agendaDiverges = Boolean(context && frequencyNumber && context.student.weekly_lessons !== frequencyNumber);
    const noCustomer = Boolean(context && !context.student.has_asaas_customer);

    const ready = Boolean(context && !openOffer && preview && frequencyNumber >= 1 && frequencyNumber <= 7
        && (!offCatalog || note.trim().length >= 10)
        && (!contractMissing || contractReference.trim().length >= 10)
        && (plan !== 'UPFRONT_EXTERNAL' || (receivedOn && receivedReference.trim().length >= 5))
        && (plan !== 'UPFRONT_CHARGE' || chargeDue)
        && !(plan === 'INSTALLMENTS' && noCustomer));

    const linkFor = (token: string) => `${APP_BASE_URL}/renovar-curso?token=${token}`;
    const copyLink = (token: string) => {
        void navigator.clipboard.writeText(linkFor(token));
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
    };

    const submit = async () => {
        if (!ready || !confirmed || busy) return;
        setBusy(true);
        setError('');
        const { data, error: rpcError } = await supabase.rpc('create_student_renewal_offer', {
            p_student: studentId,
            p_term_months: term,
            p_monthly_fee: feeCents! / 100,
            p_classes_per_week: frequencyNumber,
            p_due_day: dueDayNumber,
            p_contract_start: start,
            p_payment_plan: plan,
            p_billing_type: plan === 'UPFRONT_EXTERNAL' ? null : billingType,
            p_upfront_due_date: plan === 'UPFRONT_CHARGE' ? chargeDue : null,
            p_external_received_on: plan === 'UPFRONT_EXTERNAL' ? receivedOn : null,
            p_external_reference: plan === 'UPFRONT_EXTERNAL' ? receivedReference.trim() : null,
            p_contract_reference: contractMissing ? contractReference.trim() : null,
            p_note: note.trim() || null,
            p_send_link: sendLink,
            p_request_id: requestId.current,
        });
        setBusy(false);
        setConfirmed(false);
        if (rpcError || data?.ok !== true) {
            setError(renewalError(data?.error));
            return;
        }
        setCreated({ token: data.token ?? null, linkSent: data.link_sent === true });
        onChanged?.();
        await load();
    };

    const cancel = async (offer: RenewalOffer) => {
        if (cancelReason.trim().length < 8 || busy) return;
        setBusy(true);
        const { data, error: rpcError } = await supabase.rpc('cancel_student_renewal_offer', { p_offer: offer.id, p_reason: cancelReason.trim() });
        setBusy(false);
        if (rpcError || data?.ok !== true) { setError(renewalError(data?.error)); return; }
        setCancelOffer(null);
        setCancelReason('');
        setCreated(null);
        requestId.current = crypto.randomUUID();
        onChanged?.();
        await load();
    };

    const retryBilling = async (offer: RenewalOffer) => {
        if (busy) return;
        setBusy(true);
        const { data, error: rpcError } = await supabase.rpc('retry_student_renewal_billing', { p_offer: offer.id });
        setBusy(false);
        if (rpcError || data?.ok !== true) { setError(renewalError(data?.error)); return; }
        await load();
    };

    const student = context?.student;

    return (
        <div className="fixed inset-0 z-110 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs" onClick={onClose}>
            <div role="dialog" aria-modal="true" aria-labelledby="student-renewal-title" className="flex max-h-[90dvh] w-full max-w-xl flex-col rounded-3xl border border-brand-border bg-brand-surface shadow-2xl" onClick={event => event.stopPropagation()}>
                <div className="flex items-center justify-between border-b border-brand-border bg-brand-surface-2/50 px-6 py-5">
                    <div className="flex items-center gap-2">
                        <FileSignature size={18} className="text-brand-accent" aria-hidden="true" />
                        <h3 id="student-renewal-title" className="text-base font-black text-brand-text">Renovar contrato</h3>
                    </div>
                    <button type="button" aria-label="Fechar" onClick={onClose} className="rounded-full p-2 text-brand-muted hover:bg-brand-surface-2"><X size={18} /></button>
                </div>

                <div className="custom-scrollbar space-y-5 overflow-y-auto p-6">
                    {loading && !context ? (
                        <div className="flex justify-center py-8"><Loader2 className="animate-spin text-brand-accent" size={24} aria-label="Carregando" /></div>
                    ) : !context || !student ? (
                        <p role="alert" className="text-sm font-bold text-red-500">{loadError}</p>
                    ) : (
                        <>
                            <section aria-label="Situação atual" className="rounded-2xl border border-brand-border bg-brand-surface-2/50 p-4 text-sm text-brand-text">
                                <p className="font-bold">{student.full_name}</p>
                                <p className="mt-1 text-xs text-brand-muted">
                                    {student.monthly_fee ? `${renewalMoney(Math.round(Number(student.monthly_fee) * 100))}/mês` : 'Sem mensalidade'}
                                    {' · '}{student.class_frequency || `${student.weekly_lessons} aula(s) na agenda`}
                                    {' · '}{student.subscription_status === 'ACTIVE' ? `assinatura ativa até ${renewalDateLabel(student.subscription_end_date)}` : 'sem assinatura ativa no Asaas'}
                                </p>
                                <p className="mt-1 text-xs text-brand-muted">
                                    Período atual: <b className="text-brand-text">{context.period.current_end ? `até ${renewalDateLabel(context.period.current_end)}` : 'sem data de fim'}</b> ({renewalSourceLabel(context.period.source)})
                                </p>
                            </section>

                            {context.offers.length > 0 && (
                                <section aria-label="Renovações deste aluno" className="space-y-2">
                                    {context.offers.map(offer => {
                                        const situation = renewalOfferStatus(offer);
                                        return (
                                            <article key={offer.id} className="space-y-2 rounded-2xl border border-brand-border p-3">
                                                <div className="flex flex-wrap items-center justify-between gap-2">
                                                    <p className="text-xs font-bold text-brand-text">{offer.term_months} meses · {renewalMoney(offer.monthly_fee_cents)}/mês · {renewalDateLabel(offer.contract_start)} a {renewalDateLabel(offer.service_end_date)}</p>
                                                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-black ${toneClass[situation.tone]}`}>{situation.label}</span>
                                                </div>
                                                {['UPFRONT_CHARGE', 'UPFRONT_EXTERNAL'].includes(offer.billing_strategy) && (
                                                    <p className="text-[11px] text-brand-muted">Pagamento integral de {renewalMoney(offer.total_cents)}{offer.upfront_due_date ? `, vencimento em ${renewalDateLabel(offer.upfront_due_date)}` : ''}.</p>
                                                )}
                                                {['FAILED', 'REVIEW'].includes(offer.billing_status) && (
                                                    <p role="alert" className="text-[11px] font-bold text-red-500">{renewalBillingError(offer.billing_error)}</p>
                                                )}
                                                <div className="flex flex-wrap gap-2">
                                                    {offer.token && !offer.expired && (
                                                        <button type="button" onClick={() => copyLink(offer.token!)} className="inline-flex items-center gap-1 rounded-lg border border-brand-border px-2 py-1 text-[11px] font-bold text-brand-text">
                                                            {copied ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />} Copiar link
                                                        </button>
                                                    )}
                                                    {offer.invoice_url && !offer.coverage_registered_at && (
                                                        <a href={offer.invoice_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-lg border border-brand-border px-2 py-1 text-[11px] font-bold text-brand-text"><ExternalLink size={12} /> Ver cobrança</a>
                                                    )}
                                                    {offer.billing_strategy === 'UPFRONT_CHARGE' && ['FAILED', 'REVIEW'].includes(offer.billing_status) && (
                                                        <button type="button" disabled={busy} onClick={() => void retryBilling(offer)} className="inline-flex items-center gap-1 rounded-lg border border-brand-border px-2 py-1 text-[11px] font-bold text-brand-text disabled:opacity-50"><RefreshCw size={12} /> Tentar de novo</button>
                                                    )}
                                                    {offer.status === 'PENDING_SIGNATURE' && cancelOffer !== offer.id && (
                                                        <button type="button" onClick={() => { setCancelOffer(offer.id); setCancelReason(''); }} className="rounded-lg border border-brand-border px-2 py-1 text-[11px] font-bold text-brand-muted">Cancelar</button>
                                                    )}
                                                </div>
                                                {cancelOffer === offer.id && (
                                                    <div className="space-y-2 rounded-xl border border-amber-500/40 p-3">
                                                        <label className={labelClass}>Motivo do cancelamento
                                                            <textarea value={cancelReason} rows={2} maxLength={500} onChange={event => setCancelReason(event.target.value)} className={fieldClass} placeholder="Ex.: condição combinada mudou" />
                                                        </label>
                                                        <div className="flex gap-2">
                                                            <button type="button" disabled={busy || cancelReason.trim().length < 8} onClick={() => void cancel(offer)} className="rounded-lg bg-red-500 px-3 py-1.5 text-[11px] font-black text-white disabled:opacity-50">Cancelar renovação</button>
                                                            <button type="button" onClick={() => setCancelOffer(null)} className="rounded-lg border border-brand-border px-3 py-1.5 text-[11px] font-bold text-brand-text">Manter</button>
                                                        </div>
                                                    </div>
                                                )}
                                            </article>
                                        );
                                    })}
                                </section>
                            )}

                            {created ? (
                                <div role="status" className="space-y-3 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-4">
                                    <p className="text-xs font-black uppercase tracking-widest text-emerald-600">Renovação criada</p>
                                    <p className="text-xs text-brand-text">
                                        {created.linkSent ? 'O link vai pelo WhatsApp da escola, entre 6h e 18h. ' : 'Envie o link ao aluno. '}
                                        Nada muda até o aluno assinar.
                                    </p>
                                    {created.token && (
                                        <div className="flex gap-2">
                                            <input readOnly aria-label="Link da renovação" value={linkFor(created.token)} className="flex-1 rounded-xl border border-brand-border bg-brand-surface-2 px-3 py-2.5 text-[11px] text-brand-text" />
                                            <button type="button" aria-label="Copiar link" onClick={() => copyLink(created.token!)} className="rounded-xl border border-brand-border bg-brand-surface-2 px-3 py-2.5 text-brand-muted">
                                                {copied ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
                                            </button>
                                        </div>
                                    )}
                                </div>
                            ) : openOffer ? (
                                <p className="rounded-2xl bg-brand-surface-2 p-3 text-xs text-brand-muted">Já existe uma renovação esperando assinatura. Cancele essa para gerar outra.</p>
                            ) : (
                                <form onSubmit={event => { event.preventDefault(); void submit(); }} className="space-y-4">
                                    <fieldset>
                                        <legend className={labelClass}>Prazo</legend>
                                        <div className="mt-1 flex gap-2">
                                            {([6, 12] as RenewalTerm[]).map(option => (
                                                <button key={option} type="button" aria-pressed={term === option} onClick={() => { setTerm(option); invalidate(); }}
                                                    className={`flex-1 rounded-xl border px-3 py-2.5 text-sm font-black ${term === option ? 'border-transparent bg-brand-accent text-white' : 'border-brand-border bg-brand-surface-2 text-brand-muted'}`}>
                                                    {option} meses
                                                </button>
                                            ))}
                                        </div>
                                    </fieldset>

                                    <div className="grid grid-cols-2 items-end gap-3 sm:grid-cols-4">
                                        <label className={`${labelClass} col-span-2`}>Mensalidade (R$)
                                            <input value={fee} inputMode="decimal" placeholder="0,00" onChange={event => { setFee(event.target.value); invalidate(); }} className={fieldClass} />
                                        </label>
                                        <label className={labelClass}>Aulas por semana
                                            <input value={frequency} inputMode="numeric" onChange={event => { setFrequency(event.target.value.replace(/\D/g, '').slice(0, 1)); invalidate(); }} className={fieldClass} />
                                        </label>
                                        <label className={labelClass}>Dia do vencimento
                                            <input value={dueDay} inputMode="numeric" onChange={event => { setDueDay(event.target.value.replace(/\D/g, '').slice(0, 2)); invalidate(); }} className={fieldClass} />
                                        </label>
                                        <label className={`${labelClass} col-span-2`}>Início do novo período
                                            <input type="date" value={start} onChange={event => { setStart(event.target.value); invalidate(); }} className={fieldClass} />
                                        </label>
                                    </div>

                                    {feeCents !== null && (
                                        <p className={`text-[11px] font-bold ${offCatalog ? 'text-amber-600' : 'text-emerald-600'}`}>
                                            {catalogPrice === null
                                                ? `Sem plano de ${term} meses e ${frequency || '?'}x no catálogo.`
                                                : offCatalog
                                                    ? `Catálogo de ${term} meses e ${frequency}x: ${renewalMoney(Math.round(catalogPrice * 100))}. Este valor fica ${renewalMoney(Math.abs(feeCents - Math.round(catalogPrice * 100)))} ${feeCents < Math.round(catalogPrice * 100) ? 'abaixo' : 'acima'}.`
                                                    : 'Mesmo valor do catálogo.'}
                                        </p>
                                    )}
                                    {agendaDiverges && (
                                        <p className="text-[11px] font-bold text-amber-600">A agenda tem {student.weekly_lessons} horário(s) fixo(s) e a renovação fala em {frequencyNumber}.</p>
                                    )}

                                    <fieldset className="space-y-2">
                                        <legend className={labelClass}>Forma de pagamento</legend>
                                        {PLAN_OPTIONS.map(option => {
                                            const disabled = option.id === 'INSTALLMENTS' && noCustomer;
                                            return (
                                                <label key={option.id} className={`flex items-start gap-3 rounded-2xl border p-3 ${plan === option.id ? 'border-brand-accent bg-brand-accent/5' : 'border-brand-border'} ${disabled ? 'opacity-50' : 'cursor-pointer'}`}>
                                                    <input type="radio" name="renewal-plan" disabled={disabled} checked={plan === option.id} onChange={() => { setPlan(option.id); invalidate(); }} className="mt-1 accent-brand-accent" />
                                                    <span className="text-xs text-brand-text"><b>{option.title}</b>
                                                        <span className="mt-0.5 block text-[11px] text-brand-muted">{disabled ? 'Este aluno não tem cadastro no Asaas.' : option.text}</span>
                                                    </span>
                                                </label>
                                            );
                                        })}
                                    </fieldset>

                                    {plan !== 'UPFRONT_EXTERNAL' && (
                                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                            <label className={labelClass}>Cobrar por
                                                <select value={billingType} onChange={event => { setBillingType(event.target.value); invalidate(); }} className={fieldClass}>
                                                    <option value="PIX">Pix</option>
                                                    <option value="BOLETO">Boleto</option>
                                                    <option value="CREDIT_CARD">Cartão</option>
                                                </select>
                                            </label>
                                            {plan === 'UPFRONT_CHARGE' && (
                                                <label className={labelClass}>Vencimento da cobrança
                                                    <input type="date" value={chargeDue} min={addDaysIso(renewalToday(), 1)} max={addDaysIso(renewalToday(), 60)} onChange={event => { setChargeDue(event.target.value); invalidate(); }} className={fieldClass} />
                                                </label>
                                            )}
                                        </div>
                                    )}
                                    {plan === 'UPFRONT_EXTERNAL' && (
                                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                            <label className={labelClass}>Data do recebimento
                                                <input type="date" value={receivedOn} max={renewalToday()} onChange={event => { setReceivedOn(event.target.value); invalidate(); }} className={fieldClass} />
                                            </label>
                                            <label className={labelClass}>Referência do comprovante
                                                <input value={receivedReference} maxLength={500} placeholder="Ex.: Pix de 05/11, comprovante no Drive" onChange={event => { setReceivedReference(event.target.value); invalidate(); }} className={fieldClass} />
                                            </label>
                                        </div>
                                    )}

                                    {contractMissing && (
                                        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3">
                                            <p className="flex gap-2 text-[11px] font-medium text-brand-text"><AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-500" aria-hidden="true" />
                                                Este aluno não tem contrato assinado no sistema. O aluno vai ler que a renovação prorroga o contrato anterior, então diga qual é. Se não existir documento, a renovação não tem o que prorrogar: ele precisa assinar o contrato completo.
                                            </p>
                                            <label className={`${labelClass} mt-2`}>Documento prorrogado
                                                <input value={contractReference} maxLength={500} placeholder="Ex.: contrato em PDF assinado em 17/02/2026" onChange={event => { setContractReference(event.target.value); invalidate(); }} className={fieldClass} />
                                            </label>
                                        </div>
                                    )}

                                    <label className={labelClass}>{offCatalog ? 'Quem autorizou este valor, e por quê' : 'Observação (opcional)'}
                                        <textarea value={note} rows={2} maxLength={800} onChange={event => { setNote(event.target.value); invalidate(); }} className={fieldClass} placeholder={offCatalog ? 'Ex.: direção manteve o valor do ano anterior por pagar à vista' : ''} />
                                    </label>

                                    {preview && (
                                        <section aria-label="Prévia da renovação" className="rounded-2xl bg-brand-surface-2 p-4 text-xs text-brand-text">
                                            <p className="text-sm font-black">{term} × {renewalMoney(feeCents!)} = {renewalMoney(preview.totalCents)}</p>
                                            <p className="mt-1 text-brand-muted">Vigência: {renewalDateLabel(start)} a {renewalDateLabel(preview.serviceEnd)}</p>
                                            {plan === 'INSTALLMENTS' ? (
                                                <p className="mt-1 text-brand-muted">{term} parcelas de {renewalDateLabel(preview.firstDue)} a {renewalDateLabel(preview.lastDue)}.</p>
                                            ) : (
                                                <p className="mt-1 text-brand-muted">Meses cobertos: {renewalMonthLabel(preview.firstMonth)} a {renewalMonthLabel(preview.lastMonth)}.</p>
                                            )}
                                            {plan === 'UPFRONT_CHARGE' && (
                                                <p className="mt-1 text-brand-muted">A cobrança só é criada depois da assinatura. A cobertura e o rateio por parcela entram quando o pagamento for recebido: a 1ª parcela sai no aviso do recebimento, marcada com o mês dela, e as outras saem mês a mês.</p>
                                            )}
                                            {plan === 'UPFRONT_EXTERNAL' && (
                                                <p className="mt-1 text-brand-muted">A cobertura entra na assinatura. O valor não vai para o caixa nem para o rateio.</p>
                                            )}
                                        </section>
                                    )}

                                    <label className="flex items-start gap-2 text-xs text-brand-text">
                                        <input type="checkbox" checked={sendLink} onChange={event => setSendLink(event.target.checked)} className="mt-0.5 accent-brand-accent" />
                                        Enviar o link pelo WhatsApp da escola. Desmarque para copiar e enviar você.
                                    </label>
                                    <label className="flex items-start gap-2 text-xs text-brand-text">
                                        <input type="checkbox" checked={confirmed} disabled={!ready} onChange={event => setConfirmed(event.target.checked)} className="mt-0.5 accent-brand-accent" />
                                        Conferi prazo, valor, datas e forma de pagamento. O aluno recebe estas condições para assinar.
                                    </label>
                                    {error && <p role="alert" className="text-xs font-bold text-red-500">{error}</p>}
                                    <button type="submit" disabled={!ready || !confirmed || busy} className="flex w-full items-center justify-center gap-2 rounded-2xl bg-brand-accent py-4 text-[11px] font-black uppercase tracking-widest text-white hover:bg-brand-accent-hover disabled:opacity-50">
                                        {busy ? <Loader2 size={14} className="animate-spin" /> : <FileSignature size={14} />} Gerar renovação
                                    </button>
                                </form>
                            )}
                        </>
                    )}
                </div>
            </div>
        </div>
    );
};

export default StudentRenewalModal;
