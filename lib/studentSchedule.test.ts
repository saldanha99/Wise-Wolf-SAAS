import { describe, expect, it } from 'vitest';
import { hasDuplicateStudentSchedule, studentScheduleErrorMessage } from './studentSchedule';

describe('student schedule safety', () => {
  it('detecta colisão somente quando professor, dia e horário são iguais', () => {
    const base = { day_of_week: 'Segunda', time_slot: '17:30', teacher_id: 'teacher-lais' };
    expect(hasDuplicateStudentSchedule([base, { ...base }])).toBe(true);
    expect(hasDuplicateStudentSchedule([base, { ...base, time_slot: '18:00' }])).toBe(false);
    expect(hasDuplicateStudentSchedule([base, { ...base, teacher_id: 'teacher-debora' }])).toBe(false);
  });

  it('traduz a violação de unicidade para uma orientação clara', () => {
    expect(studentScheduleErrorMessage({ code: '23505', message: 'duplicate key' }))
      .toBe('Este aluno já possui uma aula com o mesmo professor, dia e horário.');
  });
});
