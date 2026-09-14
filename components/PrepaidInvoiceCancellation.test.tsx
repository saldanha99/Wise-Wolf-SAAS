import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PrepaidInvoiceCancellation from './PrepaidInvoiceCancellation';
const { rpc, invoke } = vi.hoisted(() => ({ rpc: vi.fn(), invoke: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc, functions: { invoke } } }));
const invoice = {
    payment_id: 'invoice-a', due_date: '2026-09-15', value: '199.99', description: 'Mensalidade setembro',
    status: 'PENDING', eligible: true, operation_id: null, operation_status: null, reason: null,
};
let invoices: object[];
beforeEach(() => {
    invoices = [{ ...invoice }];
    rpc.mockReset(); invoke.mockReset();
    rpc.mockImplementation((name: string) => Promise.resolve(name === 'get_prepaid_invoice_cancellations'
        ? { data: { ok: true, invoices }, error: null }
        : { data: { ok: true, operation_id: 'operation-a', status: 'REQUESTED' }, error: null }));
    invoke.mockResolvedValue({ data: { ok: true, status: 'CONFIRMED' }, error: null });
});
async function confirm() {
    fireEvent.click(await screen.findByRole('button', { name: 'Revisar cancelamento desta cobrança' }));
    fireEvent.change(screen.getByLabelText('Motivo para cancelar esta cobrança'), { target: { value: 'Mensalidade já coberta pelo acordo' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Conferi valor, vencimento e acordo/ }));
    // The click chains intent -> provider -> refresh promises. Await the React
    // batch rather than leaving its final busy/confirmation updates for the
    // next test (especially when the entire suite is running concurrently).
    await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Solicitar cancelamento no Asaas' }));
    });
}
describe('cancelamento explícito de mensalidade coberta', () => {
    it('não executa sozinho e exige motivo e confirmação específica antes da intenção', async () => {
        render(<PrepaidInvoiceCancellation tenantId="school-a" studentId="student-a" canWrite />);
        fireEvent.click(await screen.findByRole('button', { name: 'Revisar cancelamento desta cobrança' }));
        expect(invoke).not.toHaveBeenCalled();
        expect(screen.getByRole('button', { name: 'Solicitar cancelamento no Asaas' })).toBeDisabled();
        expect(rpc.mock.calls.every(([name]) => name === 'get_prepaid_invoice_cancellations')).toBe(true);
        expect(screen.getByText(/não encerra a assinatura/)).toBeInTheDocument();
    });
    it('envia apenas a cobrança exata e seu valor/vencimento, depois processa a intenção', async () => {
        render(<PrepaidInvoiceCancellation tenantId="school-a" studentId="student-a" canWrite />);
        await confirm();
        await waitFor(() => expect(rpc).toHaveBeenCalledWith('request_prepaid_invoice_cancellation', {
            p_payment_id: 'invoice-a', p_reason: 'Mensalidade já coberta pelo acordo', p_expected_due_date: '2026-09-15', p_expected_value: 199.99,
        }));
        expect(invoke).toHaveBeenCalledWith('cancel-prepaid-invoice', { body: { operation_id: 'operation-a' } });
        expect(await screen.findByText(/Cancelamento desta cobrança comprovado/)).toBeInTheDocument();
    });
    it('não presume cancelamento quando o provedor retorna resultado incerto', async () => {
        invoke.mockResolvedValue({ data: { ok: true, status: 'UNKNOWN' }, error: null });
        render(<PrepaidInvoiceCancellation tenantId="school-a" studentId="student-a" canWrite />);
        await confirm();
        expect(await screen.findByText(/Ainda não há confirmação do cancelamento/)).toBeInTheDocument();
        expect(screen.queryByText(/Cancelamento desta cobrança comprovado/)).not.toBeInTheDocument();
    });
    it('retoma UNKNOWN sem criar nova intenção ou consentimento de DELETE', async () => {
        invoices = [{ ...invoice, operation_id: 'operation-a', operation_status: 'UNKNOWN' }];
        invoke.mockResolvedValue({ data: { ok: true, status: 'REVIEW' }, error: null });
        render(<PrepaidInvoiceCancellation tenantId="school-a" studentId="student-a" canWrite />);
        const checkButton = await screen.findByRole('button', { name: 'Conferir situação no Asaas' });
        await act(async () => { fireEvent.click(checkButton); });
        expect(await screen.findByText(/É necessária revisão manual/)).toBeInTheDocument();
        expect(rpc.mock.calls.every(([name]) => name === 'get_prepaid_invoice_cancellations')).toBe(true);
        expect(invoke).toHaveBeenCalledTimes(1);
    });
    it('não invoca Asaas quando a intenção é recusada por mudança de valor ou vencimento', async () => {
        rpc.mockImplementation((name: string) => Promise.resolve(name === 'get_prepaid_invoice_cancellations'
            ? { data: { ok: true, invoices }, error: null }
            : { data: { ok: false, error: 'cobranca_alterada_recarregue' }, error: null }));
        render(<PrepaidInvoiceCancellation tenantId="school-a" studentId="student-a" canWrite />);
        await confirm();
        expect(await screen.findByRole('alert')).toHaveTextContent('A cobrança mudou');
        expect(invoke).not.toHaveBeenCalled();
    });
    it('não expõe ação de escrita para perfil sem autorização', async () => {
        render(<PrepaidInvoiceCancellation tenantId="school-a" studentId="student-a" canWrite={false} />);
        expect(await screen.findByRole('button', { name: 'Revisar cancelamento desta cobrança' })).toBeDisabled();
    });
    it('ignora conclusão antiga durante troca de aluno, mesmo sem remontagem por key', async () => {
        let reads = 0;
        let finishOld: (value: unknown) => void = () => {};
        rpc.mockImplementation((name: string) => {
            if (name !== 'get_prepaid_invoice_cancellations') return Promise.resolve({ data: { ok: true, operation_id: 'operation-a' }, error: null });
            reads += 1;
            if (reads === 2) return new Promise(resolve => { finishOld = resolve; });
            return Promise.resolve({ data: { ok: true, invoices: reads === 1 ? invoices : [] }, error: null });
        });
        const { rerender } = render(<PrepaidInvoiceCancellation tenantId="school-a" studentId="student-a" canWrite />);
        await confirm();
        await waitFor(() => expect(reads).toBe(2));
        rerender(<PrepaidInvoiceCancellation tenantId="school-a" studentId="student-b" canWrite />);
        await screen.findByText('Nenhuma cobrança elegível ou solicitação anterior nesta consulta.');
        await act(async () => { finishOld({ data: { ok: true, invoices }, error: null }); });
        expect(screen.queryByText(/Cancelamento desta cobrança comprovado/)).not.toBeInTheDocument();
        expect(screen.queryByText(/Mensalidade setembro/)).not.toBeInTheDocument();
    });
});
