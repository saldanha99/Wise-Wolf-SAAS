import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import BalanceteProfessores from './BalanceteProfessores';
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));
vi.mock('./PagamentosSemAluno', () => ({ default: () => null }));
let unclassified: number | undefined;
beforeEach(() => {
  unclassified = 30;
  rpc.mockReset();
  rpc.mockImplementation(async (name: string) => ({ data: name === 'balancete_professores' ? {
    month: '2026-09', base_rate: 8, professores: [],
    totais: { aulas: 0, custo_total: 0, receita_alocada: 0, lucro_contratado: 0, lucro: 0 },
    receita_total: 105, receita_sem_aluno: 105, receita_aluno_sem_aula: 0,
    alunos_multi_professor: 0, recebimentos_a_classificar: unclassified,
  } : { total: 0, por_professor: [] }, error: null }));
});
describe('balancete e recebimentos sem classificação', () => {
  it('explica o dinheiro mantido no caixa sem atribuir mensalidade ou aporte', async () => {
    render(<BalanceteProfessores user={{} as never} tenantId="test-school" />);
    const warning = await screen.findByRole('alert');
    expect(warning).toHaveTextContent('R$ 30,00 recebidos e ainda sem classificação');
    expect(warning).toHaveTextContent('não compõem a receita ou o lucro');
    expect(warning).toHaveTextContent('Não foram presumidos como mensalidade nem aporte');
    expect(rpc.mock.calls.every(([name]) => ['balancete_professores', 'balancete_receita_sem_aula'].includes(name))).toBe(true);
  });
  it.each([0, undefined])('não fabrica alerta para ausência de pendência %s', async value => {
    unclassified = value;
    render(<BalanceteProfessores user={{} as never} tenantId="test-school" />);
    await screen.findByText('Receita atribuída');
    expect(screen.queryByText(/recebidos e ainda sem classificação/)).not.toBeInTheDocument();
  });
});
