import { describe, expect, it } from 'vitest';
import { buildPenaltyMessage, dayMonth, money, studentStatusLabel, type DeparturePenalty, type DepartureStudent } from './teacherDeparture';

// Números reais da saída da Teacher Bruna (25/11/2026), devolvidos pelo servidor.
const bruna: DeparturePenalty = {
  notice_date: '2026-11-25', notice_end: '2026-12-25', last_day: '2026-11-27',
  days_served: 2, days_missing: 28, contract_version: 1, contract_clause: '6.4',
  closings: [], monthly_base: 310.83, general_penalty: 290.11,
  term_penalties: [{ student_id: 'a', student_name: 'Amábile Viana', model: 2, method: 'REFERENCIA_X_UNIDADES_X_8_6', complete_months: 0, unit_rate: 8, units_per_week: 4, amount: 275.2 }],
  term_penalties_total: 275.2, total: 565.31, transition_bonus_lost: true,
  credit: { unpaid_closings: 24, current_accrual: 671.5, total: 695.5 },
};

const student = (over: Partial<DepartureStudent>): DepartureStudent => ({
  offer_id: 'o', student_id: 's', student_name: 'Aluna Teste', blocked: false, slots: [], status: 'OPEN',
  claimed_by_name: null, transfer_status: null, transfer_cutover: null, candidates: [], ...over,
});

describe('saída do professor', () => {
  it('formata dinheiro e data como na tela', () => {
    expect(money(1565.3)).toBe('R$ 1.565,30');
    expect(dayMonth('2026-11-27')).toBe('27/11');
  });

  it('mensagem da multa usa a conta do servidor e propõe compensar', () => {
    const msg = buildPenaltyMessage('Bruna Barros Feitosa', bruna);
    expect(msg).toContain('Bruna, pelo contrato o aviso é de 30 dias (de 25/11 a 25/12)');
    expect(msg).toContain('ficam 28 dias sem cumprir');
    expect(msg).toContain('cláusula 6.4 do contrato geral (R$ 290,11)');
    expect(msg).toContain('termo individual de Amábile (cláusula 5.2, R$ 275,20)');
    expect(msg).toContain('somam R$ 565,31');
    expect(msg).toContain('descontar esse valor do que você tem a receber');
  });

  it('sem crédito suficiente, a diferença vai por Pix', () => {
    const msg = buildPenaltyMessage('Ana', { ...bruna, credit: { unpaid_closings: 0, current_accrual: 100, total: 100 } });
    expect(msg).toContain('diferença de R$ 465,31 por Pix');
  });

  it('aviso cumprido não gera multa', () => {
    expect(buildPenaltyMessage('Ana', { ...bruna, days_missing: 0, total: 0 })).toContain('não há multa');
  });

  it('situação do aluno em português', () => {
    expect(studentStatusLabel(student({ blocked: true, status: 'PREVIEW' }))).toContain('decisão da direção');
    expect(studentStatusLabel(student({}))).toBe('Ninguém tem todos os horários livres');
    expect(studentStatusLabel(student({ candidates: [{ id: 'x', name: 'Lais' }] }))).toBe('Aberto para os professores');
    expect(studentStatusLabel(student({ status: 'CLAIMED', claimed_by_name: 'Lais Sampaio', transfer_status: 'PENDING' }))).toBe('com Lais · falta assinar o termo');
  });
});
