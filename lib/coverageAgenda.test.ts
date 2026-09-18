import { describe, expect, it } from 'vitest';
import {
  combinedTimeFromNotes,
  coverageAgendaItems,
  coverageCaption,
  coverageDisplayTime,
  dateWindow,
  rescheduleAgendaItems,
  type CoverageAgendaRow,
} from './coverageAgenda';

const BRUNA = '0bf68494-1fb4-4f40-96bf-bb5cdb36bd5e';
const FLAVIO = 'fa2b9980-2c5f-4345-887f-ff6cec79fcd6';

const row = (over: Partial<CoverageAgendaRow> = {}): CoverageAgendaRow => ({
  id: 'cov-1',
  booking_id: 'booking-1',
  class_date: '2026-09-18',
  class_time: '16:30',
  status: 'confirmed',
  notes: 'Flávio ausente (doente); aula de 1h combinada com a Bruna para as 18:00.',
  original_teacher_id: FLAVIO,
  cover_teacher_id: BRUNA,
  student: { id: 'victor', full_name: 'Victor Hugo de Morais Guimarães', phone: '12988991303', avatar_url: null, module: 'A1', meeting_link: null },
  original_teacher: { full_name: 'Flávio Henrique Dias Romão' },
  cover_teacher: { full_name: 'Bruna Barros Feitosa' },
  ...over,
});

describe('coverageAgendaItems — o caso da Bruna (18/09/2026)', () => {
  it('cobertura confirmada vira item "assumida" para o substituto, com o professor que cedeu', () => {
    const [item] = coverageAgendaItems([row()], BRUNA);
    expect(item.papel).toBe('assumida');
    expect(item.time).toBe('16:30');
    expect(item.studentName).toBe('Victor Hugo de Morais Guimarães');
    expect(item.studentPhone).toBe('12988991303');
    expect(item.otherTeacherName).toBe('Flávio Henrique Dias Romão');
    expect(item.combinedTime).toBe('18:00');
  });

  it('para quem cedeu, o mesmo registro é "cedida" e aponta o substituto', () => {
    const [item] = coverageAgendaItems([row()], FLAVIO);
    expect(item.papel).toBe('cedida');
    expect(item.otherTeacherName).toBe('Bruna Barros Feitosa');
  });

  it('pendente, recusada e cancelada não entram; terceiro professor não vê nada', () => {
    expect(coverageAgendaItems([row({ status: 'pending' }), row({ status: 'cancelled' }), row({ status: 'declined' })], BRUNA)).toEqual([]);
    expect(coverageAgendaItems([row()], 'outro-professor')).toEqual([]);
  });

  it('aluno bloqueado pela leitura vira "Aluno" com avatar genérico — a aula não some', () => {
    const [item] = coverageAgendaItems([row({ student: null })], BRUNA);
    expect(item.studentName).toBe('Aluno');
    expect(item.studentId).toBeNull();
    expect(item.studentAvatar).toContain('ui-avatars.com');
  });

  it('ordena por data e slot', () => {
    const items = coverageAgendaItems([
      row({ id: 'c', class_date: '2026-09-18', class_time: '17:30' }),
      row({ id: 'a', class_date: '2026-09-16', class_time: '17:00' }),
      row({ id: 'b', class_date: '2026-09-18', class_time: '13:30' }),
    ], BRUNA);
    expect(items.map(i => i.coverageId)).toEqual(['a', 'b', 'c']);
  });
});

describe('combinedTimeFromNotes', () => {
  it('lê "para as 18:00", "às 10h30" e "dada às 10:00"', () => {
    expect(combinedTimeFromNotes('aula combinada com a Bruna para as 18:00', '16:30')).toBe('18:00');
    expect(combinedTimeFromNotes('Flávio ausente; aula dada pela Bruna às 10h30, atestada', '09:30')).toBe('10:30');
    expect(combinedTimeFromNotes('Cobertura (aula dada às 10:00)', '09:30')).toBe('10:00');
  });

  it('não confunde data com horário e some quando o horário é o próprio slot', () => {
    expect(combinedTimeFromNotes('registrada em 17/09/2026, garganta doendo', '16:30')).toBeNull();
    expect(combinedTimeFromNotes('aula às 16:30 normalmente', '16:30')).toBeNull();
    expect(combinedTimeFromNotes(null, '16:30')).toBeNull();
  });
});

describe('exibição', () => {
  it('a aula do dia mostra o combinado quando existe, senão o slot', () => {
    expect(coverageDisplayTime({ time: '16:30', combinedTime: '18:00' })).toBe('18:00');
    expect(coverageDisplayTime({ time: '16:30', combinedTime: null })).toBe('16:30');
  });

  it('a legenda diz de quem é a aula e o slot da folha', () => {
    expect(coverageCaption({ otherTeacherName: 'Flávio Henrique Dias Romão', combinedTime: '18:00', time: '16:30' }))
      .toBe('Cobertura · aula de Flávio · combinado 18:00 (slot 16:30)');
    expect(coverageCaption({ otherTeacherName: '', combinedTime: null, time: '16:30' })).toBe('Cobertura');
  });
});

describe('rescheduleAgendaItems', () => {
  it('só reposição com data e hora válidas e ainda não usada', () => {
    const items = rescheduleAgendaItems([
      { id: 'r1', date: '2026-09-18', time: '20:00', fault_type: 'TEACHER', used_at: null, student: { id: 'milena', full_name: 'MILENA CARNEIRO' } },
      { id: 'r2', date: 'Pendente', time: 'Pendente', fault_type: 'STUDENT', used_at: null, student: { id: 'x', full_name: 'X' } },
      { id: 'r3', date: '2026-09-17', time: '19:00', fault_type: 'STUDENT', used_at: '2026-09-17T23:00:00Z', student: { id: 'v', full_name: 'V' } },
    ]);
    expect(items.map(i => i.rescheduleId)).toEqual(['r1']);
    expect(items[0].time).toBe('20:00');
    expect(items[0].faultType).toBe('TEACHER');
  });
});

describe('dateWindow', () => {
  it('atravessa a virada de mês sem pular dia', () => {
    expect(dateWindow('2026-09-29', 4)).toEqual(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
  });
});
