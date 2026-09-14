import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PrepaymentManager from './PrepaymentManager';
import type { PrepaymentContext } from '../lib/prepayments';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));

const base: PrepaymentContext = {
    ok: true, can_write: true,
    students: [{ id: 'student-a', full_name: 'Aluna A' }, { id: 'student-b', full_name: 'Aluno B' }],
    payments: [{ id: 'payment-a', student_id: 'student-a', status: 'RECEIVED', value: 100.01, due_date: '2026-09-05', received_on: '2026-12-10', description: 'Contrato trimestral', registration_allowed: true, monthly_allowed: true }],
    allocations: [], history: [],
    notification_settings: { enabled: false, starts_on: null },
};
let context: PrepaymentContext;
let result: { data: unknown; error: unknown };
beforeEach(() => {
    context = structuredClone(base);
    result = { data: { ok: true }, error: null };
    rpc.mockReset();
    rpc.mockImplementation((name: string) => Promise.resolve(name === 'get_prepayment_management_context' ? { data: context, error: null } : name === 'get_prepaid_invoice_cancellations' ? { data: { ok: true, invoices: [] }, error: null } : result));
});
afterEach(async () => { await act(async () => { await Promise.resolve(); }); });

async function selectStudent() {
    await waitFor(() => expect(screen.getByLabelText('Aluno')).not.toBeDisabled());
    fireEvent.change(screen.getByLabelText('Aluno'), { target: { value: 'student-a' } });
    await screen.findByText('Nova cobertura para Aluna A');
    await waitFor(() => expect(screen.queryByText('Conferindo cobranças…')).not.toBeInTheDocument());
}
async function fillRegistration() {
    await selectStudent();
    fireEvent.change(screen.getByLabelText('Pagamento já recebido'), { target: { value: 'payment-a' } });
    fireEvent.change(screen.getByLabelText('Primeiro mês coberto'), { target: { value: '2026-12' } });
    fireEvent.change(screen.getByLabelText('Quantidade de meses'), { target: { value: '3' } });
}
const confirmRegistration = () => fireEvent.click(screen.getByRole('checkbox', { name: /Conferi o aluno/ }));

describe('pagamentos completos na direção', () => {
    it('exige confirmação explícita, não rebaixa pagamentos e envia datas de competência', async () => {
        render(<PrepaymentManager tenantId="school-a" />);
        await fillRegistration();
        expect(screen.getByRole('button', { name: 'Registrar pagamento completo' })).toBeDisabled();
        const preview = screen.getByRole('region', { name: 'Prévia da divisão financeira' });
        expect(preview).toHaveTextContent('12/2026: R$ 33,34');
        expect(preview).toHaveTextContent('02/2027: R$ 33,33');
        expect(preview).toHaveTextContent('Reserva prevista após a primeira parcela: R$ 66,67');
        confirmRegistration();
        fireEvent.click(screen.getByRole('button', { name: 'Registrar pagamento completo' }));
        await waitFor(() => expect(rpc).toHaveBeenCalledWith('register_prepayment', {
            p_payment_id: 'payment-a', p_first_competencia: '2026-12-01', p_meses: 3, p_modo: 'MENSAL',
        }));
        expect(await screen.findByText(/Pagamento completo registrado/)).toBeInTheDocument();
        expect(rpc.mock.calls.filter(([name]) => name === 'register_prepayment')).toHaveLength(1);
    });

    it.each([{ ok: false, error: 'mes_ja_coberto' }, { ok: 'true' }, null])('não declara sucesso para resposta não confirmada %j', async response => {
        result = { data: response, error: null };
        render(<PrepaymentManager tenantId="school-a" />);
        await fillRegistration();
        confirmRegistration();
        fireEvent.click(screen.getByRole('button', { name: 'Registrar pagamento completo' }));
        expect(await screen.findByRole('alert')).toBeInTheDocument();
        expect(screen.queryByText(/Pagamento completo registrado/)).not.toBeInTheDocument();
        expect(screen.getByRole('checkbox', { name: /Conferi o aluno/ })).not.toBeChecked();
    });

    it('só registra externo em LEGADO com valor, data e justificativa explícitos', async () => {
        render(<PrepaymentManager tenantId="school-a" />);
        await selectStudent();
        fireEvent.change(screen.getByLabelText('Origem do recebimento'), { target: { value: 'EXTERNO' } });
        expect(screen.queryByLabelText('Forma de distribuição')).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Registrar pagamento completo' })).toBeDisabled();
        fireEvent.change(screen.getByLabelText('Valor total recebido por fora (R$)'), { target: { value: '1.200,00' } });
        fireEvent.change(screen.getByLabelText('Data efetiva do recebimento externo'), { target: { value: '2025-09-10' } });
        fireEvent.change(screen.getByLabelText('Primeiro mês coberto'), { target: { value: '2026-12' } });
        fireEvent.change(screen.getByLabelText('Quantidade de meses'), { target: { value: '6' } });
        fireEvent.change(screen.getByLabelText('Referência ou justificativa do recebimento externo'), { target: { value: 'Acordo e comprovante de teste' } });
        confirmRegistration();
        fireEvent.click(screen.getByRole('button', { name: 'Registrar pagamento completo' }));
        await waitFor(() => expect(rpc).toHaveBeenCalledWith('register_external_prepayment', {
            p_student: 'student-a', p_total: 1200, p_received_on: '2025-09-10',
            p_first_competencia: '2026-12-01', p_meses: 6, p_modo: 'LEGADO', p_observacao: 'Acordo e comprovante de teste',
        }));
        expect(await screen.findByText(/Nenhuma receita foi lançada no caixa/)).toBeInTheDocument();
    });

    it('bloqueia rateio mensal após aviso integral, mas permite LEGADO quando o servidor autoriza', async () => {
        context.payments[0].monthly_allowed = false;
        context.payments[0].monthly_block_reason = 'aviso_do_rateio_ja_saiu';
        render(<PrepaymentManager tenantId="school-a" />);
        await fillRegistration();
        expect(screen.getByRole('alert')).toHaveTextContent('valor integral já pode ter sido enviado');
        expect(screen.getByRole('checkbox', { name: /Conferi o aluno/ })).toBeDisabled();
        fireEvent.change(screen.getByLabelText('Forma de distribuição'), { target: { value: 'LEGADO' } });
        expect(screen.getByRole('checkbox', { name: /Conferi o aluno/ })).not.toBeDisabled();
    });

    it('bloqueia ambos os modos após tentativa de aviso mensal e não sugere LEGADO', async () => {
        context.payments[0].registration_allowed = false;
        context.payments[0].registration_block_reason = 'parcelamento_mensal_ja_avisado_requer_reconciliacao';
        context.payments[0].monthly_allowed = false;
        render(<PrepaymentManager tenantId="school-a" />);
        await fillRegistration();
        expect(screen.getByRole('alert')).toHaveTextContent('não é permitido recadastrar em MENSAL nem em LEGADO');
        expect(screen.getByRole('checkbox', { name: /Conferi o aluno/ })).toBeDisabled();
        fireEvent.change(screen.getByLabelText('Forma de distribuição'), { target: { value: 'LEGADO' } });
        expect(screen.getByRole('checkbox', { name: /Conferi o aluno/ })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Registrar pagamento completo' })).toBeDisabled();
        expect(screen.queryByText(/Use após conferir/)).not.toBeInTheDocument();
        expect(rpc.mock.calls.some(([name]) => name === 'register_prepayment')).toBe(false);
    });

    it('exibe revisão efetiva do provedor sem apresentar cobertura como ativa', async () => {
        context.allocations = [{
            id: 'allocation-review', grupo_id: 'group-a', registration_id: 'registration-a', payment_id: 'payment-a', student_id: 'student-a',
            competencia: '2026-09-01', sequencia: 1, meses: 3, valor: 33.34, modo: 'MENSAL', origem: 'ASAAS',
            recebido_em: '2026-09-10', observacao: null, status: 'REVIEW', stored_status: 'ACTIVE', is_valid: false,
            status_reason: 'PAYMENT_PROVIDER_OBSERVATION_REVIEW', created_at: '2026-09-10T14:00:00Z', cancelled_at: null,
        }];
        render(<PrepaymentManager tenantId="school-a" />);
        await selectStudent();
        expect(screen.getByText(/Em revisão — cobertura não confirmada/)).toBeInTheDocument();
        expect(screen.getByText(/O provedor informou estorno/)).toBeInTheDocument();
        expect(screen.queryByText(/09\/2026 · R\$ 33,34 · Ativa/)).not.toBeInTheDocument();
    });

    it('não oferece pagamento aguardando crédito nem de outro aluno', async () => {
        context.payments.push({ ...context.payments[0], id: 'confirmed', status: 'CONFIRMED', description: 'Aguardando crédito' });
        context.payments.push({ ...context.payments[0], id: 'other-student', student_id: 'student-b', description: 'Outro aluno' });
        render(<PrepaymentManager tenantId="school-a" />);
        await selectStudent();
        const options = within(screen.getByLabelText('Pagamento já recebido')).getAllByRole('option');
        expect(options).toHaveLength(2);
        expect(options.some(option => option.getAttribute('value') === 'confirmed')).toBe(false);
    });

    it('cancela somente após motivo auditável e confirmação, preservando histórico no erro', async () => {
        context.allocations = [{
            id: 'allocation-a', grupo_id: 'group-a', registration_id: 'registration-a', payment_id: 'payment-a', student_id: 'student-a',
            competencia: '2026-09-01', sequencia: 1, meses: 3, valor: 33.34, modo: 'MENSAL', origem: 'ASAAS',
            recebido_em: '2026-09-10', observacao: null, status: 'ACTIVE', created_at: '2026-09-10T14:00:00Z', cancelled_at: null,
        }];
        result = { data: { ok: false, error: 'sem_permissao' }, error: null };
        render(<PrepaymentManager tenantId="school-a" />);
        await selectStudent();
        fireEvent.click(screen.getByRole('button', { name: 'Cancelar cobertura' }));
        fireEvent.click(screen.getByRole('checkbox', { name: /Conferi o impacto/ }));
        expect(screen.getByRole('button', { name: 'Confirmar cancelamento' })).toBeDisabled();
        fireEvent.change(screen.getByLabelText('Motivo do cancelamento'), { target: { value: 'Acordo substituído pela direção' } });
        fireEvent.click(screen.getByRole('checkbox', { name: /Conferi o impacto/ }));
        fireEvent.click(screen.getByRole('button', { name: 'Confirmar cancelamento' }));
        await waitFor(() => expect(rpc).toHaveBeenCalledWith('cancel_prepayment_with_reason', { p_reference: 'group-a', p_reason: 'Acordo substituído pela direção', p_expected_registration: 'registration-a' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('perfil não está autorizado');
        expect(screen.getByText(/09\/2026 · R\$ 33,34 · Ativa/)).toBeInTheDocument();
        expect(screen.queryByText(/^Cobertura cancelada/)).not.toBeInTheDocument();
    });

    it('desabilita escritas quando o servidor não autoriza perfil ativo', async () => {
        context.can_write = false;
        render(<PrepaymentManager tenantId="school-a" />);
        await selectStudent();
        expect(screen.getByRole('button', { name: 'Registrar pagamento completo' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Ativar avisos mensais' })).toBeDisabled();
    });

    it('preserva ciclos cancelados e cancela apenas o ciclo atual apresentado', async () => {
        const row = {
            id: 'allocation-old', grupo_id: 'group-a', registration_id: 'registration-old', payment_id: 'payment-a', student_id: 'student-a',
            competencia: '2026-09-01', sequencia: 1, meses: 3, valor: 33.34, modo: 'MENSAL' as const, origem: 'ASAAS' as const,
            recebido_em: '2026-09-10', observacao: null, status: 'CANCELLED', created_at: '2026-09-10T14:00:00Z', cancelled_at: '2026-09-10T15:00:00Z',
        };
        context.allocations = [row, { ...row, id: 'allocation-new', registration_id: 'registration-new', status: 'REVIEW', cancelled_at: null }];
        result = { data: { ok: false, error: 'registro_alterado_recarregue' }, error: null };
        render(<PrepaymentManager tenantId="school-a" />);
        await selectStudent();
        expect(screen.getAllByRole('article')).toHaveLength(2);
        expect(screen.getByText(/Em revisão — cobertura não confirmada/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Cancelar cobertura' }));
        fireEvent.change(screen.getByLabelText('Motivo do cancelamento'), { target: { value: 'Revisão concluída pela direção' } });
        fireEvent.click(screen.getByRole('checkbox', { name: /Conferi o impacto/ }));
        fireEvent.click(screen.getByRole('button', { name: 'Confirmar cancelamento' }));
        await waitFor(() => expect(rpc).toHaveBeenCalledWith('cancel_prepayment_with_reason', {
            p_reference: 'group-a', p_reason: 'Revisão concluída pela direção', p_expected_registration: 'registration-new',
        }));
        expect(await screen.findByRole('alert')).toHaveTextContent('Esta cobertura mudou desde a consulta');
    });

    it('não chama configuração de mensagens sem confirmação e não inventa entrega', async () => {
        render(<PrepaymentManager tenantId="school-a" />);
        await waitFor(() => expect(screen.getByRole('button', { name: 'Ativar avisos mensais' })).toBeDisabled());
        expect(rpc.mock.calls.every(([name]) => name === 'get_prepayment_management_context')).toBe(true);
        expect(screen.getByText(/Aceitação pelo provedor não comprova entrega/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('checkbox', { name: /Confirmo ativar/ }));
        fireEvent.click(screen.getByRole('button', { name: 'Ativar avisos mensais' }));
        await waitFor(() => expect(rpc).toHaveBeenCalledWith('configure_monthly_reserve_notifications', { p_tenant_id: 'school-a', p_enabled: true, p_starts_on: null }));
    });

    it('limpa valores enquanto troca de aluno e ignora resposta atrasada', async () => {
        render(<PrepaymentManager tenantId="school-a" />);
        await fillRegistration();
        let finish: (value: unknown) => void = () => {};
        rpc.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        fireEvent.change(screen.getByLabelText('Aluno'), { target: { value: 'student-b' } });
        expect(screen.queryByText(/Reserva prevista após/)).not.toBeInTheDocument();
        expect(screen.queryByText('Nova cobertura para Aluna A')).not.toBeInTheDocument();
        await act(async () => { finish({ data: { ...base, payments: [] }, error: null }); });
        expect(await screen.findByText('Nova cobertura para Aluno B')).toBeInTheDocument();
        expect(screen.getByLabelText('Quantidade de meses')).toHaveValue('');
    });

    it('mantém uma busca repetida utilizável', async () => {
        render(<PrepaymentManager tenantId="school-a" />);
        await waitFor(() => expect(screen.getByRole('button', { name: 'Buscar' })).not.toBeDisabled());
        fireEvent.click(screen.getByRole('button', { name: 'Buscar' }));
        await waitFor(() => expect(screen.getByLabelText('Aluno')).not.toBeDisabled());
        expect(screen.getByRole('option', { name: 'Aluna A' })).toBeInTheDocument();
    });
});
