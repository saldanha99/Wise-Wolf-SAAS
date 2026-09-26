import { describe, expect, it } from 'vitest';
import { parsePlannerStudentRows, plannerAccessNote } from './plannerStudents';

describe('lista de alunos do Planner para o professor', () => {
  it('linhas da RPC viram opções, sem repetir aluno, em ordem de nome', () => {
    const options = parsePlannerStudentRows([
      { id: 'b', full_name: 'Theo', module: 'A2', access_reason: 'COVERAGE', valid_until: '2026-09-28' },
      { id: 'a', full_name: 'Ana', module: null, access_reason: 'BOOKING', valid_until: null },
      { id: 'b', full_name: 'Theo repetido', module: 'A2', access_reason: 'BOOKING', valid_until: null },
      { id: '', full_name: 'sem id' },
      null,
      { id: 'c', full_name: '  ', module: 'B1', access_reason: 'HACK', valid_until: 'amanhã' },
    ]);
    expect(options).toEqual([
      { id: 'c', full_name: null, module: 'B1', access_reason: null, valid_until: null },
      { id: 'a', full_name: 'Ana', module: null, access_reason: 'BOOKING', valid_until: null },
      { id: 'b', full_name: 'Theo', module: 'A2', access_reason: 'COVERAGE', valid_until: '2026-09-28' },
    ]);
    expect(parsePlannerStudentRows(null)).toEqual([]);
  });

  it('diz por que o aluno está na lista quando não é da agenda', () => {
    expect(plannerAccessNote({ access_reason: 'COVERAGE', valid_until: '2026-09-28' })).toBe('cobertura até 28/09');
    expect(plannerAccessNote({ access_reason: 'RESCHEDULE', valid_until: '2026-10-01' })).toBe('reposição até 01/10');
    expect(plannerAccessNote({ access_reason: 'SECOND_TEACHER', valid_until: null })).toBe('2º professor');
    expect(plannerAccessNote({ access_reason: 'BOOKING', valid_until: null })).toBe('');
    expect(plannerAccessNote({ access_reason: 'PRIMARY_TEACHER', valid_until: null })).toBe('');
    expect(plannerAccessNote({ access_reason: null, valid_until: null })).toBe('');
  });
});
