import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('antecipação de aulas', () => {
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
