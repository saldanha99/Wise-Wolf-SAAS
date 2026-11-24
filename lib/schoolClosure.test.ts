import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isSchoolClosedLog, schoolClosedLabel, SCHOOL_HOLIDAY_PRESENCE } from './schoolClosure';

describe('escola fechada: marca própria da aula remunerada', () => {
  it('reconhece só a marca do sistema', () => {
    expect(isSchoolClosedLog(SCHOOL_HOLIDAY_PRESENCE)).toBe(true);
    expect(isSchoolClosedLog('COMPLETED')).toBe(false);
    expect(isSchoolClosedLog('STUDENT_ABSENCE')).toBe(false);
    expect(isSchoolClosedLog(null)).toBe(false);
  });

  it('rótulo separado de aula dada e de falta', () => {
    expect(schoolClosedLabel('FERIADO')).toBe('Feriado (remunerada)');
    expect(schoolClosedLabel('RECESSO')).toBe('Recesso (remunerada)');
    expect(schoolClosedLabel(undefined)).toBe('Feriado ou recesso (remunerada)');
  });

  it('a migration grava a mesma marca e os mesmos subtipos que a tela lê', () => {
    const sql = readFileSync(join(__dirname, '..', 'supabase/migrations/20261124120000_feriados_e_recesso_remunerados.sql'), 'utf8');
    expect(sql).toContain(`'${SCHOOL_HOLIDAY_PRESENCE}', v_kind`);
    expect(sql).toContain(`when 'HOLIDAY' then 'FERIADO' else 'RECESSO'`);
    expect(sql).toContain("'Feriado (remunerada)'");
    expect(sql).toContain("'Recesso (remunerada)'");
  });
});
