import { describe, expect, it } from 'vitest';
import {
  HALF_HOUR_OPTIONS,
  assignmentErrorMessage,
  lessonsInSlot,
  planLabel,
  planSummary,
  slotsProblem,
  type PlanOccurrence,
} from './temporaryAssignments';

const saturday = { day_of_week: 6, start: '10:30', end: '11:30' };

describe('horários da atribuição temporária', () => {
  it('1 hora são 2 aulas de 30 min', () => {
    expect(lessonsInSlot(saturday)).toBe(2);
    expect(lessonsInSlot({ start: '10:30', end: '10:30' })).toBe(0);
    expect(lessonsInSlot({ start: '11:30', end: '10:30' })).toBe(0);
  });

  it('oferece só meia em meia hora, que é o que o servidor aceita', () => {
    expect(HALF_HOUR_OPTIONS).toHaveLength(48);
    expect(HALF_HOUR_OPTIONS).toContain('10:30');
    expect(HALF_HOUR_OPTIONS).not.toContain('10:15');
  });

  it('acusa horário vazio, invertido, longo demais e sobreposto', () => {
    expect(slotsProblem([saturday])).toBeNull();
    expect(slotsProblem([])).toMatch(/pelo menos um/);
    expect(slotsProblem([{ ...saturday, end: '10:00' }])).toMatch(/depois do início/);
    expect(slotsProblem([{ day_of_week: 6, start: '08:00', end: '12:30' }])).toMatch(/4 horas/);
    expect(slotsProblem([saturday, { day_of_week: 6, start: '11:00', end: '12:00' }])).toMatch(/sobrepõem/);
  });

  it('não acusa horários iguais em dias diferentes nem colados no mesmo dia', () => {
    expect(slotsProblem([saturday, { ...saturday, day_of_week: 3 }])).toBeNull();
    expect(slotsProblem([saturday, { day_of_week: 6, start: '11:30', end: '12:00' }])).toBeNull();
  });
});

describe('plano da atribuição', () => {
  const plan: PlanOccurrence[] = [
    { date: '2026-11-07', time: '10:30', status: 'OK', detail: null },
    { date: '2026-11-07', time: '11:00', status: 'OK', detail: 'fora_da_grade' },
    { date: '2026-11-14', time: '10:30', status: 'PROFESSOR_OCUPADO', detail: 'reposição de Ana' },
    { date: '2026-11-21', time: '10:30', status: 'FERIADO', detail: 'Natal' },
  ];

  it('separa o que entra do que fica de fora', () => {
    expect(planSummary(plan)).toEqual({ entram: 2, foraDaGrade: 1, foraDoPlano: 2 });
  });

  it('diz o motivo concreto de cada aula fora do plano', () => {
    expect(planLabel(plan[0])).toBe('Vai para a agenda');
    expect(planLabel(plan[1])).toMatch(/fora da grade/);
    expect(planLabel(plan[2])).toBe('Professor ocupado: reposição de Ana');
    expect(planLabel(plan[3])).toBe('Feriado nacional, sem aula');
    expect(planLabel({ status: 'LIMITE', detail: null })).toBe('Passa do saldo informado');
  });
});

describe('mensagens de erro', () => {
  it('traduz o código do servidor e mantém a mensagem do termo individual', () => {
    expect(assignmentErrorMessage('saldo_ja_distribuido')).toMatch(/Todo o saldo/);
    expect(assignmentErrorMessage('Assinatura do termo individual pendente. Abra Contratos > Termos por aluno.')).toMatch(/termo individual/);
    expect(assignmentErrorMessage(null)).toMatch(/Tente de novo/);
  });
});
