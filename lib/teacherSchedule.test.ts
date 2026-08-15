import { describe, expect, it } from 'vitest';
import type { Reschedule } from '../types';
import { findTeacherRescheduleForSlot } from './teacherSchedule';

const biancaReplacement: Reschedule = {
  id: 'replacement-bianca',
  date: '2026-08-11',
  time: '10:00:00',
  teacherName: 'Teacher Débora',
  studentName: 'Bianca Crepaldi',
  repoId: 100,
  originalLessonId: 0,
  teacherId: 'teacher-debora',
  studentId: 'student-bianca',
};

describe('findTeacherRescheduleForSlot', () => {
  it('shows a replacement only on its assigned teacher schedule', () => {
    expect(findTeacherRescheduleForSlot([biancaReplacement], 'teacher-debora', 1, '10:00')).toEqual(biancaReplacement);
    expect(findTeacherRescheduleForSlot([biancaReplacement], 'teacher-flavio', 1, '10:00')).toBeNull();
    expect(findTeacherRescheduleForSlot([biancaReplacement], 'teacher-lais', 1, '10:00')).toBeNull();
  });

  it('matches ISO and Brazilian dates without shifting the weekday by timezone', () => {
    expect(findTeacherRescheduleForSlot([biancaReplacement], 'teacher-debora', 1, '10:00')).not.toBeNull();
    expect(findTeacherRescheduleForSlot([{ ...biancaReplacement, date: '11/08/2026' }], 'teacher-debora', 1, '10:00')).not.toBeNull();
  });
});
