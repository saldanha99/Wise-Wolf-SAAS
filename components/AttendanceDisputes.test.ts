import { describe, expect, it } from 'vitest';
import { isAttendanceOnlyMismatch } from './AttendanceDisputes';

describe('classificação de divergências de presença', () => {
  it('trata aluno presente versus falta do aluno como divergência leve', () => {
    expect(isAttendanceOnlyMismatch({
      status: 'CONFLICT',
      teacher_reported: 'STUDENT_ABSENCE',
      student_response: 'STUDENT_PRESENT',
    })).toBe(true);
  });

  it('trata autodeclaração de falta versus aula realizada como divergência leve', () => {
    expect(isAttendanceOnlyMismatch({
      status: 'CONFLICT',
      teacher_reported: 'COMPLETED',
      student_response: 'STUDENT_SELF_ABSENT',
    })).toBe(true);
  });

  it('mantém alegação de falta do professor como conflito de comparecimento', () => {
    expect(isAttendanceOnlyMismatch({
      status: 'CONFLICT',
      teacher_reported: 'COMPLETED',
      student_response: 'TEACHER_NO_SHOW',
    })).toBe(false);
  });

  it('reconhece o estado definitivo de divergência leve vindo do banco', () => {
    expect(isAttendanceOnlyMismatch({
      status: 'ATTENDANCE_MISMATCH',
      teacher_reported: 'STUDENT_ABSENCE',
      student_response: 'STUDENT_PRESENT',
    })).toBe(true);
  });
});
