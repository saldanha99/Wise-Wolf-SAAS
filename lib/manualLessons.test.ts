import { describe, expect, it } from 'vitest';
import { draftProblem, manualLessonErrorMessage, parseRate, type ManualLessonDraft } from './manualLessons';

const base: ManualLessonDraft = {
  teacherId: 't', kind: 'TESTE_ORAL', date: '2026-11-09', time: '10:00', units: 1,
  personMode: 'guest', studentId: '', guestName: 'Sara Elisa', reason: 'Prova oral de quem não é aluna', rate: '',
};
const now = new Date('2026-11-10T12:00:00-03:00');

describe('baixa manual de aulas', () => {
  it('aceita o formulário completo', () => {
    expect(draftProblem(base, now)).toBeNull();
  });

  it('exige motivo', () => {
    expect(draftProblem({ ...base, reason: 'curto' }, now)).toMatch(/motivo/);
  });

  it('exige aluno ou nome conforme a escolha', () => {
    expect(draftProblem({ ...base, guestName: ' ' }, now)).toMatch(/nome/);
    expect(draftProblem({ ...base, personMode: 'student' }, now)).toMatch(/aluno/);
  });

  it('recusa aula que ainda não terminou', () => {
    expect(draftProblem({ ...base, date: '2026-11-10', time: '12:00' }, now)).toMatch(/não terminou/);
    expect(draftProblem({ ...base, date: '2026-11-10', time: '11:00', units: 3 }, now)).toMatch(/não terminou/);
    expect(draftProblem({ ...base, date: '2026-11-10', time: '11:00' }, now)).toBeNull();
  });

  it('horário de meia em meia hora e valor válido', () => {
    expect(draftProblem({ ...base, time: '10:15' }, now)).toMatch(/meia/);
    expect(draftProblem({ ...base, rate: 'abc' }, now)).toMatch(/Valor/);
    expect(parseRate('')).toBeNull();
    expect(parseRate('10,50')).toBe(10.5);
  });

  it('traduz os erros do servidor', () => {
    expect(manualLessonErrorMessage('mes_fechado')).toMatch(/fechamento/);
    expect(manualLessonErrorMessage('professor_ja_tem_aula_no_horario')).toMatch(/professor já tem/);
    expect(manualLessonErrorMessage('qualquer coisa')).toMatch(/Tente de novo/);
  });
});
