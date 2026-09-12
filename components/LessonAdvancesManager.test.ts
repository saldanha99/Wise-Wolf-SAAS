import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { occurrencesForMonth } from './LessonAdvancesManager';

describe('antecipação de aulas', () => {
  it('gera apenas ocorrências reais do booking no mês de origem', () => {
    const rows = occurrencesForMonth([{
      id: 'booking-1',
      teacher_id: 'teacher-1',
      day_of_week: 'Quarta-feira',
      time_slot: '18:30:00',
      start_date: '2026-09-01',
      teacher: { full_name: 'Teacher Michael' },
    }], '2026-10');

    expect(rows.map(row => row.originalDate)).toEqual([
      '2026-10-07', '2026-10-14', '2026-10-21', '2026-10-28',
    ]);
    expect(rows.every(row => row.time === '18:30')).toBe(true);
  });

  it('não inventa ocorrência anterior ao início da matrícula', () => {
    const rows = occurrencesForMonth([{
      id: 'booking-1',
      teacher_id: 'teacher-1',
      day_of_week: 'Sexta-feira',
      time_slot: '10:00',
      start_date: '2026-10-15',
      teacher: null,
    }], '2026-10');

    expect(rows.map(row => row.originalDate)).toEqual(['2026-10-16', '2026-10-23', '2026-10-30']);
  });

  it('mantém autoridade, RLS, idempotência e pagamento pela data realizada no banco', () => {
    const migration = readFileSync(
      resolve(process.cwd(), 'supabase/migrations/20260912192839_lesson_advances.sql'),
      'utf8',
    );
    expect(migration).toContain('alter table public.lesson_advances enable row level security');
    expect(migration).toContain('lesson_advances_original_occurrence_uq');
    expect(migration).toContain("v_advance.advance_date > (now() at time zone 'America/Sao_Paulo')::date");
    expect(migration).toContain("v_advance.advance_date, v_advance.advance_date, v_advance.advance_time");
    expect(migration).toContain("'ANTECIPAÇÃO'");
    expect(migration).toContain('advance.teacher_id = v_teacher');
    expect(migration).toContain("status = 'CANCELLED'");
  });
});
