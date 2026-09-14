import React, { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { formatLocalDateBr } from '../lib/dateUtils';
import { prepaymentCents, prepaymentError } from '../lib/prepayments';

interface Invoice {
    payment_id: string; due_date: string; value: number | string; description: string | null;
    status: string; eligible: boolean; operation_id: string | null; operation_status: string | null;
    reason: string | null; requested_at: string | null; confirmed_at: string | null;
}
const buttonClass = 'rounded-xl border border-brand-border px-3 py-2 text-sm font-bold text-brand-text disabled:opacity-50';
const statusLabel: Record<string, string> = {
    REQUESTED: 'Solicitação registrada', CHECKING: 'Conferindo no Asaas', SUBMITTING: 'Cancelamento em andamento',
    UNKNOWN: 'Resultado incerto — requer conferência', CONFIRMED: 'Cancelamento comprovado no Asaas', REVIEW: 'Revisão manual necessária',
};

/** No automatic mutation or polling: each invoice requires an explicit director intent. */
const PrepaidInvoiceCancellation: React.FC<{ tenantId: string; studentId: string; canWrite: boolean }> = ({ tenantId, studentId, canWrite }) => {
    const [invoices, setInvoices] = useState<Invoice[]>([]);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [message, setMessage] = useState('');
    const [selected, setSelected] = useState<string | null>(null);
    const [reason, setReason] = useState('');
    const [confirmed, setConfirmed] = useState(false);
    const sequence = useRef(0);
    const writing = useRef(false);
    const load = useCallback(async () => {
        const request = ++sequence.current;
        setLoading(true); setInvoices([]); setError(''); setConfirmed(false);
        try {
            const { data, error: rpcError } = await supabase.rpc('get_prepaid_invoice_cancellations', { p_tenant: tenantId, p_student: studentId });
            if (request !== sequence.current) return;
            if (rpcError || data?.ok !== true || !Array.isArray(data.invoices)) {
                setError('Não foi possível conferir as cobranças dos meses cobertos. Nenhum cancelamento foi presumido.');
            } else setInvoices(data.invoices);
        } catch {
            if (request === sequence.current) setError('Consulta de cobranças indisponível. Tente atualizar.');
        } finally { if (request === sequence.current) setLoading(false); }
    }, [tenantId, studentId]);
    useEffect(() => {
        setMessage(''); setSelected(null); setReason('');
        void load();
        return () => { sequence.current += 1; };
    }, [load]);

    const process = async (invoice: Invoice, createIntent: boolean) => {
        if (!canWrite || busy || writing.current || (createIntent && (!confirmed || reason.trim().length < 12))) return;
        writing.current = true; setBusy(true); setError(''); setMessage('');
        const request = sequence.current;
        try {
            let operation = invoice.operation_id;
            if (createIntent) {
                const { data, error: rpcError } = await supabase.rpc('request_prepaid_invoice_cancellation', {
                    p_payment_id: invoice.payment_id, p_reason: reason.trim(),
                    p_expected_due_date: invoice.due_date, p_expected_value: Number(invoice.value),
                });
                if (request !== sequence.current) return;
                if (rpcError || data?.ok !== true || typeof data.operation_id !== 'string') {
                    setError(data?.error === 'cobranca_alterada_recarregue' ? 'A cobrança mudou. Atualize e confira valor e vencimento antes de confirmar novamente.' : data?.error === 'cobranca_nao_elegivel' ? 'Esta cobrança não é mais elegível. Atualize os dados; nada foi cancelado por esta resposta.' : prepaymentError(data?.error));
                    return;
                }
                operation = data.operation_id;
            }
            if (!operation) return;
            const { data, error: invokeError } = await supabase.functions.invoke('cancel-prepaid-invoice', { body: { operation_id: operation } });
            if (request !== sequence.current) return;
            let resultMessage: string;
            if (!invokeError && data?.ok === true && data.status === 'CONFIRMED') {
                resultMessage = 'Cancelamento desta cobrança comprovado no Asaas. A assinatura e os demais pagamentos não foram cancelados.';
            } else if (!invokeError && data?.ok === true && data.status === 'REVIEW') {
                resultMessage = 'É necessária revisão manual da conciliação. Nenhuma nova exclusão será tentada automaticamente.';
            } else if (!invokeError && data?.ok === true && data.status === 'IN_PROGRESS') {
                resultMessage = 'A solicitação está em processamento. Confira a situação novamente em instantes.';
            } else {
                resultMessage = 'Ainda não há confirmação do cancelamento. Confira a situação no Asaas pelo botão abaixo; uma tentativa incerta não repete a exclusão.';
            }
            setSelected(null); setReason('');
            // load advances the request sequence once. A scope change/unmount
            // advances it again, so an old school's completion cannot leak.
            const refreshedSequence = sequence.current + 1;
            await load();
            if (sequence.current === refreshedSequence) setMessage(resultMessage);
        } catch {
            if (request === sequence.current) setError('Resposta indisponível. Atualize a lista para recuperar a solicitação registrada; não presuma que a cobrança foi cancelada.');
        } finally { writing.current = false; setBusy(false); setConfirmed(false); }
    };

    return <section aria-labelledby="covered-invoices-title" className="space-y-3 border-t border-brand-border pt-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 id="covered-invoices-title" className="font-bold text-brand-text">Cobranças de meses já cobertos</h3>
            <button type="button" disabled={loading || busy} onClick={() => void load()} className={buttonClass}>Atualizar cobranças cobertas</button>
        </div>
        <p className="text-sm text-brand-muted">O registro de cobertura não exclui cobranças sozinho. A direção pode solicitar o cancelamento de uma mensalidade pendente específica, após conferir o acordo. O servidor valida a cobrança exata no Asaas antes de agir. Matrícula, extras, cobranças pagas ou aguardando crédito não são elegíveis.</p>
        {error ? <p role="alert" className="text-sm text-red-500">{error}</p> : null}
        {message ? <p role="status" className="rounded-xl bg-brand-surface-2 p-3 text-sm text-brand-text">{message}</p> : null}
        {loading ? <p role="status" className="text-sm text-brand-muted">Conferindo cobranças…</p> : !error && !invoices.length ? <p className="text-sm text-brand-muted">Nenhuma cobrança elegível ou solicitação anterior nesta consulta.</p> : null}
        {invoices.map(invoice => <article key={invoice.payment_id} className="space-y-3 rounded-2xl border border-brand-border p-4">
            <h4 className="text-sm font-bold text-brand-text">{formatLocalDateBr(invoice.due_date)} · {prepaymentCents(invoice.value) === null ? 'Valor indisponível' : Number(invoice.value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })} · {invoice.description || 'Mensalidade'}</h4>
            <p className="break-all text-xs text-brand-muted">Cobrança local: {invoice.payment_id}</p>
            <p className="text-sm text-brand-muted">{invoice.operation_status ? statusLabel[invoice.operation_status] || 'Requer conferência' : 'Pendente com cobertura financeira válida'}</p>
            {!invoice.operation_id && invoice.eligible && selected !== invoice.payment_id ? <button type="button" disabled={!canWrite || busy} onClick={() => { setSelected(invoice.payment_id); setReason(''); setConfirmed(false); setMessage(''); }} className={buttonClass}>Revisar cancelamento desta cobrança</button> : null}
            {invoice.operation_id && ['REQUESTED', 'CHECKING', 'SUBMITTING', 'UNKNOWN'].includes(invoice.operation_status || '') ? <button type="button" disabled={!canWrite || busy} onClick={() => void process(invoice, false)} className={buttonClass}>{invoice.operation_status === 'REQUESTED' ? 'Concluir solicitação registrada' : 'Conferir situação no Asaas'}</button> : null}
            {selected === invoice.payment_id ? <div role="group" aria-label="Confirmar cancelamento da cobrança" className="space-y-3 rounded-xl border border-amber-500/40 p-3">
                <p className="text-sm text-brand-text">Esta ação pode retirar a disponibilidade de pagamento desta cobrança. Não estorna valores, não encerra a assinatura e não cancela as demais cobranças.</p>
                <label className="block text-sm font-bold text-brand-text">Motivo para cancelar esta cobrança<textarea disabled={busy} value={reason} minLength={12} maxLength={500} rows={2} onChange={event => { setReason(event.target.value); setConfirmed(false); }} className="mt-1 w-full rounded-xl border border-brand-border bg-brand-surface-2 p-3 text-sm text-brand-text" /></label>
                <label className="flex items-start gap-2 text-sm text-brand-text"><input type="checkbox" disabled={busy} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} className="mt-1" />Conferi valor, vencimento e acordo. Autorizo cancelar somente esta cobrança se o Asaas confirmar a elegibilidade.</label>
                <div className="flex flex-wrap gap-2">
                    <button type="button" disabled={!canWrite || busy || !confirmed || reason.trim().length < 12 || reason.trim().length > 500} onClick={() => void process(invoice, true)} className={buttonClass}>Solicitar cancelamento no Asaas</button>
                    <button type="button" disabled={busy} onClick={() => setSelected(null)} className={buttonClass}>Manter cobrança</button>
                </div>
            </div> : null}
        </article>)}
    </section>;
};
export default PrepaidInvoiceCancellation;
