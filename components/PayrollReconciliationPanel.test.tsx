import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PayrollReconciliationPanel from './PayrollReconciliationPanel';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));
const report = {
    totais: { previsto: 200, folha: 200, caixinha: 80, caixinha_sem_aviso: 90, caixinha_revisao: 10, diferenca: 120 },
    professores: [{
        teacher_id: 'teacher-a', teacher_name: 'Professor A', previsto: 200, previsto_aulas: 25,
        folha: 200, folha_aulas: 25, status: 'OPEN', caixinha: 80, caixinha_sem_aviso: 90,
        caixinha_revisao: 10, diferenca: 120, pro_labore: false, sobras: { aulas: 0, valor: 0 }, ajustes: 0,
        turbo: { ativo: false, alunos: 0, detalhe: null }, itens: [{
            motivo: 'SEM_AVISO', aluno: 'Aluno A', aulas: 25, folha: 200, caixinha: 80,
            caixinha_sem_aviso: 90, caixinha_revisao: 10, diferenca: 120, avisos: 1,
        }],
    }],
};
beforeEach(() => {
    rpc.mockReset();
    rpc.mockResolvedValue({ data: report, error: null });
});

describe('caixinha confirmada versus previsão', () => {
    it('mantém valores oficiais separados, passa tenant e não promete reserva bancária', async () => {
        render(<PayrollReconciliationPanel tenantId="school-a" user={{} as never} />);
        await screen.findByText('Professor A');
        expect(rpc).toHaveBeenCalledWith('teacher_payroll_reconciliation', { p_month: expect.stringMatching(/^\d{4}-\d{2}$/), p_tenant: 'school-a' });
        expect(screen.getByText('Previsão sem aviso confirmado', { selector: 'div' }).parentElement).toHaveTextContent('R$ 90,00');
        expect(screen.getByText('Caixinha com aviso confirmado', { selector: 'div' }).parentElement).toHaveTextContent('R$ 80,00');
        expect(screen.getByText('Falta a conferir').parentElement).toHaveTextContent('R$ 120,00');
        expect(screen.getByRole('alert')).toHaveTextContent('R$ 10,00');
        expect(screen.getByText(/não comprova saldo ou dinheiro separado no banco/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: /Professor A/ }));
        expect(screen.getByText(/previsão sem aviso confirmado R\$ 90,00/)).toBeInTheDocument();
        expect(screen.queryByText(/nada a conciliar/)).not.toBeInTheDocument();
    });

    it.each([{ data: null, error: { message: 'offline' } }, { data: {}, error: null }])('não substitui erro de leitura por valores zero', async response => {
        rpc.mockResolvedValue(response);
        render(<PayrollReconciliationPanel tenantId="school-a" user={{} as never} />);
        expect(await screen.findByRole('alert')).toHaveTextContent('Nenhum valor estimado foi exibido');
        expect(screen.queryByText('R$ 0,00')).not.toBeInTheDocument();
        expect(screen.queryByText(/Nenhum professor com movimento/)).not.toBeInTheDocument();
    });

    it('remove valores antigos durante atualização e ignora resposta do tenant anterior', async () => {
        let finishOld: (value: unknown) => void = () => {};
        rpc.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
        const { rerender } = render(<PayrollReconciliationPanel tenantId="school-a" user={{} as never} />);
        await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
        rerender(<PayrollReconciliationPanel tenantId="school-b" user={{} as never} />);
        await screen.findByText('Professor A');
        await act(async () => { finishOld({ data: { ...report, professores: [{ ...report.professores[0], teacher_name: 'Professor de outra escola' }] }, error: null }); });
        expect(screen.queryByText('Professor de outra escola')).not.toBeInTheDocument();
        expect(rpc).toHaveBeenLastCalledWith('teacher_payroll_reconciliation', { p_month: expect.any(String), p_tenant: 'school-b' });
    });
});
