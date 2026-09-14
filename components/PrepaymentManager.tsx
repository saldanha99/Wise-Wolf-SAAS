import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle, Loader2, RefreshCw, Search } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { formatLocalDateBr } from '../lib/dateUtils';
import PrepaidInvoiceCancellation from './PrepaidInvoiceCancellation';
import {
    isPrepaymentContext, prepaymentCents, prepaymentError, prepaymentMonthLabel,
    prepaymentPreview, prepaymentReviewReason, prepaymentToday, validPrepaymentReceiptDate,
    type PrepaymentAllocation, type PrepaymentContext, type PrepaymentMode,
} from '../lib/prepayments';

const money = (cents: number) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fieldClass = 'mt-1 w-full rounded-xl border border-brand-border bg-brand-surface-2 px-3 py-2 text-sm text-brand-text disabled:opacity-50';
const buttonClass = 'rounded-xl border border-brand-border px-4 py-2 text-sm font-bold text-brand-text disabled:cursor-not-allowed disabled:opacity-50';
const auditTime = (value: string) => {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : 'Data não informada';
};

interface Props { tenantId: string }

/** All mutations go through active-director, tenant-scoped RPCs. No client ledger writes. */
export default function PrepaymentManager({ tenantId }: Props) {
    const [context, setContext] = useState<PrepaymentContext | null>(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [success, setSuccess] = useState('');
    const [search, setSearch] = useState('');
    const [appliedSearch, setAppliedSearch] = useState('');
    const [studentId, setStudentId] = useState('');
    const [source, setSource] = useState<'ASAAS' | 'EXTERNO'>('ASAAS');
    const [paymentId, setPaymentId] = useState('');
    const [mode, setMode] = useState<PrepaymentMode>('MENSAL');
    const [firstMonth, setFirstMonth] = useState('');
    const [months, setMonths] = useState('');
    const [externalValue, setExternalValue] = useState('');
    const [receivedOn, setReceivedOn] = useState('');
    const [observation, setObservation] = useState('');
    const [confirmed, setConfirmed] = useState(false);
    const [cancelGroup, setCancelGroup] = useState<string | null>(null);
    const [cancelConfirmed, setCancelConfirmed] = useState(false);
    const [cancelReason, setCancelReason] = useState('');
    const [settingsConfirm, setSettingsConfirm] = useState(false);
    const sequence = useRef(0);
    const writing = useRef(false);

    const load = useCallback(async () => {
        const request = ++sequence.current;
        setLoading(true);
        setError('');
        setContext(null);
        setSettingsConfirm(false);
        try {
            const { data, error: rpcError } = await supabase.rpc('get_prepayment_management_context', {
                p_tenant: tenantId, p_student: studentId || null, p_search: appliedSearch || null,
            });
            if (request !== sequence.current) return;
            if (rpcError || !isPrepaymentContext(data)) {
                setError(prepaymentError(data?.error));
                return;
            }
            setContext(data);
        } catch {
            if (request === sequence.current) setError('Não foi possível consultar os pagamentos completos. Tente atualizar.');
        } finally {
            if (request === sequence.current) setLoading(false);
        }
    }, [tenantId, studentId, appliedSearch]);

    useEffect(() => {
        if (tenantId) void load();
        else { setContext(null); setLoading(false); setError('Selecione uma escola para consultar o financeiro.'); }
        return () => { sequence.current += 1; };
    }, [load, tenantId]);

    const invalidateConfirmation = () => { setConfirmed(false); setSuccess(''); setError(''); };
    const resetStudent = (id: string) => {
        sequence.current += 1;
        setContext(null);
        setStudentId(id);
        setPaymentId('');
        setFirstMonth('');
        setMonths('');
        setExternalValue('');
        setReceivedOn('');
        setObservation('');
        setCancelGroup(null);
        setCancelConfirmed(false);
        setCancelReason('');
        invalidateConfirmation();
    };

    const canWrite = context?.can_write === true && !loading && !busy;
    const selectedStudent = context?.students.find(student => student.id === studentId);
    const payments = context?.payments.filter(payment => payment.student_id === studentId &&
        ['RECEIVED', 'RECEIVED_IN_CASH'].includes(payment.status) && prepaymentCents(payment.value) !== null) ?? [];
    const payment = payments.find(item => item.id === paymentId);
    const effectiveMode = source === 'EXTERNO' ? 'LEGADO' : mode;
    const totalCents = source === 'EXTERNO' ? prepaymentCents(externalValue) : payment ? prepaymentCents(payment.value) : null;
    const preview = prepaymentPreview(totalCents, firstMonth, Number(months));
    const allocations = context?.allocations.filter(row => row.student_id === studentId) ?? [];
    const groups = new Map<string, PrepaymentAllocation[]>();
    for (const row of allocations) {
        const groupKey = row.registration_id || row.id;
        const rows = groups.get(groupKey) ?? [];
        rows.push(row);
        groups.set(groupKey, rows);
    }
    const overlaps = preview.filter(part => allocations.some(row => ['ACTIVE', 'REVIEW'].includes(row.status) && row.competencia.slice(0, 7) === part.competencia));
    const monthlyBlocked = source === 'ASAAS' && effectiveMode === 'MENSAL' && payment?.monthly_allowed !== true;
    const registrationBlocked = source === 'ASAAS' && payment?.registration_allowed !== true;
    const wrongMonthlyStart = source === 'ASAAS' && effectiveMode === 'MENSAL' && !!payment?.received_on && !!firstMonth && firstMonth !== payment.received_on.slice(0, 7);
    const ready = canWrite && !!selectedStudent && preview.length > 0 && overlaps.length === 0 && !wrongMonthlyStart &&
        (source === 'EXTERNO' ? validPrepaymentReceiptDate(receivedOn) && observation.trim().length >= 5 : !!payment && !registrationBlocked && !monthlyBlocked);

    const register = async (event: React.FormEvent) => {
        event.preventDefault();
        if (!ready || !confirmed || writing.current) return;
        writing.current = true;
        const request = sequence.current;
        setBusy(true);
        setError('');
        setSuccess('');
        try {
            const response = source === 'EXTERNO'
                ? await supabase.rpc('register_external_prepayment', {
                    p_student: studentId, p_total: totalCents! / 100, p_received_on: receivedOn,
                    p_first_competencia: `${firstMonth}-01`, p_meses: Number(months),
                    p_modo: 'LEGADO', p_observacao: observation.trim(),
                })
                : await supabase.rpc('register_prepayment', {
                    p_payment_id: paymentId, p_first_competencia: `${firstMonth}-01`,
                    p_meses: Number(months), p_modo: effectiveMode,
                });
            if (request !== sequence.current) return;
            if (response.error || response.data?.ok !== true) {
                setError(prepaymentError(response.data?.error));
                setConfirmed(false);
                return;
            }
            setSuccess(response.data.already_registered === true
                ? 'Esta cobertura já estava registrada. Nenhum registro duplicado foi criado.'
                : source === 'EXTERNO'
                    ? 'Cobertura externa registrada em LEGADO. Nenhuma receita foi lançada no caixa.'
                    : 'Pagamento completo registrado. Confira a cobertura e o histórico abaixo.');
            setConfirmed(false);
            setPaymentId('');
            setMonths('');
            setFirstMonth('');
            await load();
        } catch {
            if (request === sequence.current) {
                setError('A resposta não foi recebida. Atualize e confira o histórico antes de repetir o registro.');
                setConfirmed(false);
            }
        } finally {
            writing.current = false;
            setBusy(false);
        }
    };

    const cancel = async () => {
        if (!canWrite || !cancelGroup || !cancelConfirmed || cancelReason.trim().length < 12 || cancelReason.trim().length > 500 || writing.current) return;
        const registration = groups.get(cancelGroup)?.[0];
        if (!registration?.registration_id) return;
        writing.current = true;
        const request = sequence.current;
        setBusy(true);
        setError('');
        setSuccess('');
        try {
            const { data, error: rpcError } = await supabase.rpc('cancel_prepayment_with_reason', {
                p_reference: registration.grupo_id, p_reason: cancelReason.trim(), p_expected_registration: registration.registration_id,
            });
            if (request !== sequence.current) return;
            if (rpcError || data?.ok !== true) {
                setError(prepaymentError(data?.error));
                setCancelConfirmed(false);
                return;
            }
            setSuccess(data.already_cancelled === true
                ? 'Esta cobertura já estava cancelada.'
                : `Cobertura cancelada. Isso não estorna o recebimento nem cancela cobranças no Asaas.${data.aviso_ja_enviado === true ? ' Um aviso anterior pode ter sido enviado; confira a conciliação da caixinha.' : ''}`);
            setCancelGroup(null);
            setCancelConfirmed(false);
            setCancelReason('');
            await load();
        } catch {
            if (request === sequence.current) setError('A resposta não foi recebida. Atualize o histórico antes de repetir o cancelamento.');
        } finally {
            writing.current = false;
            setBusy(false);
        }
    };

    const configureNotifications = async () => {
        if (!canWrite || !settingsConfirm || !context?.notification_settings || writing.current) return;
        const enabled = !context.notification_settings.enabled;
        const request = sequence.current;
        writing.current = true;
        setBusy(true);
        setError('');
        setSuccess('');
        try {
            const { data, error: rpcError } = await supabase.rpc('configure_monthly_reserve_notifications', {
                p_tenant_id: tenantId, p_enabled: enabled, p_starts_on: null,
            });
            if (request !== sequence.current) return;
            if (rpcError || data?.ok !== true) {
                setError(prepaymentError(data?.error));
                return;
            }
            setSettingsConfirm(false);
            setSuccess(enabled ? 'Avisos mensais ativados. Confira abaixo a vigência confirmada pelo servidor.' : 'Avisos mensais desativados. Mensagens já aceitas pelo provedor não são desfeitas.');
            await load();
        } catch {
            if (request === sequence.current) setError('Não foi possível confirmar a configuração. Atualize antes de tentar novamente.');
        } finally {
            writing.current = false;
            setBusy(false);
        }
    };

    return (
        <section aria-labelledby="prepayment-title" className="space-y-5 rounded-3xl border border-brand-border bg-brand-surface p-4 sm:p-6">
            <header className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h2 id="prepayment-title" className="text-xl font-black text-brand-text">Pagamentos completos</h2>
                    <p className="mt-1 max-w-3xl text-sm text-brand-muted">Vincule um recebimento já confirmado à cobertura de 2 a 24 meses. A divisão financeira não altera o preço contratado da mensalidade.</p>
                </div>
                <button type="button" onClick={() => { setConfirmed(false); setCancelConfirmed(false); setSettingsConfirm(false); void load(); }} disabled={loading || busy} className={`${buttonClass} inline-flex items-center gap-2`}>
                    <RefreshCw size={16} aria-hidden="true" /> Atualizar cobertura
                </button>
            </header>

            {error ? <div role="alert" className="flex items-start gap-2 rounded-xl border border-red-500/40 bg-red-500/5 p-3 text-sm text-brand-text"><AlertCircle size={18} className="shrink-0 text-red-500" aria-hidden="true" />{error}</div> : null}
            {success ? <div role="status" className="flex items-start gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/5 p-3 text-sm text-brand-text"><CheckCircle size={18} className="shrink-0 text-emerald-500" aria-hidden="true" />{success}</div> : null}
            {loading ? <p role="status" className="flex items-center gap-2 text-sm text-brand-muted"><Loader2 size={16} className="animate-spin" aria-hidden="true" />Consultando cobertura…</p> : null}
            {context && !context.can_write ? <p role="alert" className="text-sm text-amber-600">Consulta sem permissão de alteração. É necessário perfil ativo da direção e vínculo com esta escola.</p> : null}

            {context?.notification_settings ? <section aria-labelledby="prepayment-notifications-title" className="space-y-3 rounded-2xl border border-brand-border bg-brand-surface-2 p-4">
                <h3 id="prepayment-notifications-title" className="font-bold text-brand-text">Avisos mensais da caixinha no grupo da Gestão</h3>
                <p className="text-sm text-brand-text">{context.notification_settings.enabled ? `Ativados · vigência a partir de ${formatLocalDateBr(context.notification_settings.starts_on)}` : 'Desativados — nenhuma ativação automática.'}</p>
                <p className="text-sm text-brand-muted">Dia 1º, às 09h de São Paulo, com recuperação até o dia 7: parcelas futuras de 2 a N e fechamento do mês anterior. Usa o grupo da Gestão já configurado. A ativação vale para o próximo ciclo elegível confirmado pelo servidor, sem disparar retroativos.</p>
                <p className="text-xs text-brand-muted">Aceitação pelo provedor não comprova entrega. Envios com resultado incerto não são repetidos automaticamente.</p>
                <label className="flex items-start gap-2 text-sm text-brand-text"><input type="checkbox" checked={settingsConfirm} disabled={!canWrite} onChange={event => setSettingsConfirm(event.target.checked)} className="mt-1" />Confirmo {context.notification_settings.enabled ? 'desativar' : 'ativar'} os avisos mensais desta escola no grupo configurado.</label>
                <button type="button" disabled={!canWrite || !settingsConfirm} onClick={() => void configureNotifications()} className={buttonClass}>{context.notification_settings.enabled ? 'Desativar avisos mensais' : 'Ativar avisos mensais'}</button>
            </section> : null}

            <form onSubmit={event => { event.preventDefault(); if (!busy) { if (!studentId && appliedSearch === search.trim()) void load(); else { resetStudent(''); setAppliedSearch(search.trim()); } } }} className="flex flex-wrap items-end gap-2">
                <label className="min-w-0 flex-1 text-sm font-bold text-brand-text">Buscar aluno
                    <input value={search} onChange={event => setSearch(event.target.value)} maxLength={100} disabled={busy} placeholder="Nome do aluno" className={fieldClass} />
                </label>
                <button type="submit" disabled={busy || loading} className={`${buttonClass} inline-flex items-center gap-2`}><Search size={16} aria-hidden="true" />Buscar</button>
            </form>
            <label className="block text-sm font-bold text-brand-text">Aluno
                <select value={studentId} disabled={loading || busy || !context} onChange={event => resetStudent(event.target.value)} className={fieldClass}>
                    <option value="">Selecione um aluno</option>
                    {context?.students.map(student => <option key={student.id} value={student.id}>{student.full_name}</option>)}
                </select>
            </label>
            {context?.has_more_students ? <p className="text-xs text-brand-muted">Exibindo os primeiros 100 resultados. Refine a busca pelo nome.</p> : null}

            {selectedStudent ? <>
                <form onSubmit={register} className="space-y-4 border-t border-brand-border pt-5">
                    <fieldset disabled={!canWrite} className="space-y-4">
                        <legend className="mb-3 text-base font-bold text-brand-text">Nova cobertura para {selectedStudent.full_name}</legend>
                        <div className="grid gap-4 sm:grid-cols-2">
                            <label className="text-sm font-bold text-brand-text">Origem do recebimento
                                <select value={source} onChange={event => { setSource(event.target.value as 'ASAAS' | 'EXTERNO'); invalidateConfirmation(); }} className={fieldClass}>
                                    <option value="ASAAS">Pagamento conciliado na plataforma</option>
                                    <option value="EXTERNO">Recebido por fora — somente cobertura LEGADO</option>
                                </select>
                            </label>
                            {source === 'ASAAS' ? <label className="text-sm font-bold text-brand-text">Pagamento já recebido
                                <select required value={paymentId} onChange={event => { setPaymentId(event.target.value); invalidateConfirmation(); }} className={fieldClass}>
                                    <option value="">Selecione o pagamento</option>
                                    {payments.map(item => <option key={item.id} value={item.id}>{formatLocalDateBr(item.due_date)} · {money(prepaymentCents(item.value) ?? 0)} · {item.description || item.id.slice(0, 8)}</option>)}
                                </select>
                            </label> : <label className="text-sm font-bold text-brand-text">Valor total recebido por fora (R$)
                                <input required inputMode="decimal" value={externalValue} placeholder="Ex.: 1.200,00" onChange={event => { setExternalValue(event.target.value); invalidateConfirmation(); }} className={fieldClass} />
                            </label>}
                            {source === 'ASAAS' ? <label className="text-sm font-bold text-brand-text">Forma de distribuição
                                <select value={mode} onChange={event => { setMode(event.target.value as PrepaymentMode); invalidateConfirmation(); }} className={fieldClass}>
                                    <option value="MENSAL">MENSAL — distribuir uma parcela por mês</option>
                                    <option value="LEGADO">LEGADO — cobrir meses sem novo rateio</option>
                                </select>
                            </label> : <label className="text-sm font-bold text-brand-text">Data efetiva do recebimento externo
                                <input required type="date" max={prepaymentToday()} value={receivedOn} onChange={event => { setReceivedOn(event.target.value); invalidateConfirmation(); }} className={fieldClass} />
                            </label>}
                            <label className="text-sm font-bold text-brand-text">Primeiro mês coberto
                                <input required type="month" value={firstMonth} onChange={event => { setFirstMonth(event.target.value); invalidateConfirmation(); }} className={fieldClass} />
                            </label>
                            <label className="text-sm font-bold text-brand-text">Quantidade de meses
                                <select required value={months} onChange={event => { setMonths(event.target.value); invalidateConfirmation(); }} className={fieldClass}>
                                    <option value="">Selecione entre 2 e 24 meses</option>
                                    {Array.from({ length: 23 }, (_, i) => i + 2).map(count => <option key={count} value={count}>{count} meses</option>)}
                                </select>
                            </label>
                        </div>
                        {source === 'ASAAS' && !payments.length ? <p className="text-sm text-brand-muted">Nenhum pagamento recebido elegível. Pagamentos pendentes, aguardando crédito, de matrícula ou com reversão não podem ser usados.</p> : null}
                        {payment && source === 'ASAAS' ? <p className="text-sm text-brand-muted">Recebimento conciliado: {formatLocalDateBr(payment.received_on)}. O valor não pode ser editado nesta tela.</p> : null}
                        {source === 'EXTERNO' ? <>
                            <label className="block text-sm font-bold text-brand-text">Referência ou justificativa do recebimento externo
                                <textarea required minLength={5} maxLength={1000} rows={2} value={observation} onChange={event => { setObservation(event.target.value); invalidateConfirmation(); }} placeholder="Descreva o acordo e a referência do comprovante, sem dados sensíveis." className={fieldClass} />
                            </label>
                            <p className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-3 text-sm text-brand-text">Este registro apenas cobre os meses em LEGADO: não cria receita no caixa, não separa reserva e não gera novo rateio.</p>
                        </> : registrationBlocked && payment ? null : effectiveMode === 'LEGADO' ? <p className="text-sm text-brand-muted">LEGADO não distribui novamente o recebimento nem cria reserva mensal. Use após conferir o rateio que já ocorreu.</p> : <p className="text-sm text-brand-muted">MENSAL só pode ser registrado antes de um aviso de rateio integral. A reserva abaixo é uma divisão prevista; não comprova transferência nem envio ao grupo.</p>}
                        {registrationBlocked && payment ? <p role="alert" className="text-sm text-amber-600">{prepaymentError(payment.registration_block_reason)}</p> : monthlyBlocked && payment ? <p role="alert" className="text-sm text-amber-600">{prepaymentError(payment.monthly_block_reason || 'aviso_do_rateio_ja_saiu')}</p> : null}
                        {wrongMonthlyStart ? <p role="alert" className="text-sm text-amber-600">No modo MENSAL, o primeiro mês deve ser {prepaymentMonthLabel(payment!.received_on!.slice(0, 7))}, mês do recebimento conciliado.</p> : null}
                        {overlaps.length ? <p role="alert" className="text-sm text-amber-600">Já existe cobertura ativa ou em revisão em {overlaps.map(part => prepaymentMonthLabel(part.competencia)).join(', ')}. Ajuste o período antes de registrar.</p> : null}

                        {preview.length && totalCents !== null ? <section aria-label="Prévia da divisão financeira" className="rounded-2xl bg-brand-surface-2 p-4">
                            <h3 className="font-bold text-brand-text">Prévia — {prepaymentMonthLabel(preview[0].competencia)} a {prepaymentMonthLabel(preview[preview.length - 1].competencia)}</h3>
                            <p className="mt-2 text-sm text-brand-text">Total recebido: <strong>{money(totalCents)}</strong> · {months} meses</p>
                            <p className="mt-1 text-sm text-brand-muted">{effectiveMode === 'MENSAL' ? `Primeira parcela: ${money(preview[0].cents)}. Reserva prevista após a primeira parcela: ${money(totalCents - preview[0].cents)}.` : 'Sem nova reserva ou rateio: a divisão abaixo representa apenas a cobertura dos meses.'}</p>
                            <ul className="mt-3 grid grid-cols-2 gap-2 text-xs text-brand-muted sm:grid-cols-3">
                                {preview.map(part => <li key={part.competencia}>{prepaymentMonthLabel(part.competencia)}: {money(part.cents)}</li>)}
                            </ul>
                            <p className="mt-3 text-xs text-brand-muted">Centavos restantes são distribuídos nas primeiras parcelas. Esta prévia não altera o preço contratado nem confirma liberação financeira.</p>
                        </section> : null}
                        <label className="flex items-start gap-2 text-sm text-brand-text">
                            <input type="checkbox" checked={confirmed} disabled={!ready} onChange={event => setConfirmed(event.target.checked)} className="mt-1" />
                            Conferi o aluno, o recebimento, o período e o modo. Autorizo registrar esta cobertura.
                        </label>
                        <button type="submit" disabled={!ready || !confirmed} className={`${buttonClass} bg-brand-surface-2`}>{busy ? 'Registrando…' : 'Registrar pagamento completo'}</button>
                    </fieldset>
                </form>

                <section aria-labelledby="prepayment-coverage-title" className="space-y-3 border-t border-brand-border pt-5">
                    <h3 id="prepayment-coverage-title" className="font-bold text-brand-text">Cobertura registrada</h3>
                    {!groups.size ? <p className="text-sm text-brand-muted">Nenhum pagamento completo registrado para este aluno.</p> : null}
                    {[...groups].map(([groupId, rows]) => {
                        const sorted = [...rows].sort((a, b) => a.competencia.localeCompare(b.competencia));
                        const first = sorted[0];
                        const active = rows.some(row => ['ACTIVE', 'REVIEW'].includes(row.status));
                        return <article key={groupId} className="space-y-3 rounded-2xl border border-brand-border p-4">
                            <div className="flex flex-wrap items-start justify-between gap-3">
                                <div>
                                    <h4 className="text-sm font-bold text-brand-text">{prepaymentMonthLabel(first.competencia)} a {prepaymentMonthLabel(sorted[sorted.length - 1].competencia)} · {first.modo} · {first.origem === 'EXTERNO' ? 'Externo, sem caixa' : 'Pagamento conciliado'}</h4>
                                    <p className="mt-1 break-all text-xs text-brand-muted">Referência: {first.grupo_id}</p>
                                    <p className="mt-1 break-all text-xs text-brand-muted">Ciclo do registro: {first.registration_id || 'Não informado — atualize a consulta'}</p>
                                    {first.observacao ? <p className="mt-1 text-sm text-brand-muted">{first.observacao}</p> : null}
                                </div>
                                {active && cancelGroup !== groupId ? <button type="button" disabled={!canWrite || !first.registration_id} onClick={() => { setCancelGroup(groupId); setCancelConfirmed(false); setCancelReason(''); setError(''); setSuccess(''); }} className={buttonClass}>Cancelar cobertura</button> : null}
                            </div>
                            <ul className="grid gap-2 text-xs text-brand-muted sm:grid-cols-2">
                                {sorted.map(row => <li key={row.id}>{prepaymentMonthLabel(row.competencia)} · {prepaymentCents(row.valor) !== null ? money(prepaymentCents(row.valor)!) : 'Valor indisponível'} · {row.status === 'ACTIVE' && row.is_valid !== false ? 'Ativa' : row.status === 'CANCELLED' ? 'Cancelada' : 'Em revisão — cobertura não confirmada'}{row.cancelled_at ? ` em ${auditTime(row.cancelled_at)}` : ''}{row.status_reason && row.status !== 'CANCELLED' ? <span className="mt-1 block">{prepaymentReviewReason(row.status_reason)}</span> : null}</li>)}
                            </ul>
                            {cancelGroup === groupId ? <div role="group" aria-label="Confirmação de cancelamento" className="space-y-3 rounded-xl border border-amber-500/40 p-3">
                                <p className="text-sm text-brand-text">Cancelar retira a cobertura destes meses e pode reabrir pendências. Não estorna o dinheiro, não desfaz avisos já enviados e não cancela cobranças no Asaas.</p>
                                <label className="block text-sm font-bold text-brand-text">Motivo do cancelamento
                                    <textarea value={cancelReason} disabled={!canWrite} minLength={12} maxLength={500} rows={2} onChange={event => { setCancelReason(event.target.value); setCancelConfirmed(false); }} className={fieldClass} placeholder="Descreva o motivo (12 a 500 caracteres)." />
                                </label>
                                <label className="flex items-start gap-2 text-sm text-brand-text"><input type="checkbox" checked={cancelConfirmed} disabled={!canWrite} onChange={event => setCancelConfirmed(event.target.checked)} className="mt-1" />Conferi o impacto e quero cancelar esta cobertura.</label>
                                <div className="flex flex-wrap gap-2">
                                    <button type="button" disabled={!canWrite || !cancelConfirmed || cancelReason.trim().length < 12 || cancelReason.trim().length > 500} onClick={() => void cancel()} className={buttonClass}>Confirmar cancelamento</button>
                                    <button type="button" disabled={busy} onClick={() => { setCancelGroup(null); setCancelConfirmed(false); }} className={buttonClass}>Manter cobertura</button>
                                </div>
                            </div> : null}
                        </article>;
                    })}
                </section>
                <section aria-labelledby="prepayment-history-title" className="space-y-2 border-t border-brand-border pt-5">
                    <h3 id="prepayment-history-title" className="font-bold text-brand-text">Histórico de alterações</h3>
                    {!context?.history.length ? <p className="text-sm text-brand-muted">Nenhum evento de auditoria disponível nesta consulta.</p> : <ol className="space-y-2 text-xs text-brand-muted">{context.history.map(event => <li key={event.id} className="rounded-xl bg-brand-surface-2 p-3">{auditTime(event.occurred_at)} · {({ REGISTER: 'Registro', CANCEL: 'Cancelamento', REVIEW: 'Revisão' } as Record<string, string>)[event.action] || event.action} · {event.actor_name || 'Automação / autor não informado'}{event.reason ? ` · ${event.reason}` : ''}<span className="mt-1 block break-all">Referência: {event.grupo_id}</span></li>)}</ol>}
                </section>
                <PrepaidInvoiceCancellation key={`${tenantId}:${studentId}`} tenantId={tenantId} studentId={studentId} canWrite={canWrite} />
            </> : null}
        </section>
    );
}
