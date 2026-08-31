import { describe, expect, it } from 'vitest';
import {
  formatClassLogDate,
  isCompletedClassPresence,
} from './classLogPresentation';

describe('class log presentation', () => {
  it('recognizes canonical and legacy presence values', () => {
    expect(isCompletedClassPresence('COMPLETED')).toBe(true);
    expect(isCompletedClassPresence('Presença')).toBe(true);
    expect(isCompletedClassPresence('STUDENT_ABSENCE')).toBe(false);
    expect(isCompletedClassPresence('TEACHER_ABSENCE')).toBe(false);
  });

  it('prefers the civil class date over the insertion timestamp', () => {
    expect(formatClassLogDate({
      class_date: '2026-08-29',
      created_at: '2026-09-03T01:00:00.000Z',
    })).toBe('29/08/2026');
  });

  it('falls back to Sao Paulo time for legacy rows', () => {
    expect(formatClassLogDate({
      created_at: '2026-09-01T01:30:00.000Z',
    })).toBe('31/08/2026');
  });
});
