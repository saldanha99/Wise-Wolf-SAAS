import { describe, expect, it } from 'vitest';
import { buildStudentProfileUpdates } from './studentProfileUpdates';

describe('buildStudentProfileUpdates', () => {
  it('não envia correction_preference, coluna inexistente no schema hospedado', () => {
    const updates = buildStudentProfileUpdates({
      name: 'Aluno Teste',
      levelBadge: 'B1',
      correctionPreference: 'TODOS',
      professor_id: 'teacher-2',
    });

    expect(updates).not.toHaveProperty('correction_preference');
    expect(updates).toMatchObject({
      full_name: 'Aluno Teste',
      module: 'B1',
      professor_id: 'teacher-2',
    });
  });

  it('inclui campos financeiros somente quando foram informados', () => {
    expect(buildStudentProfileUpdates({ name: 'Sem financeiro' })).not.toHaveProperty('monthly_tuition');

    expect(buildStudentProfileUpdates({
      name: 'Com financeiro',
      monthly_fee: 350,
      due_day: 10,
      status_financial: 'ACTIVE',
      planDuration: 'ANNUAL',
    })).toMatchObject({
      monthly_tuition: 350,
      due_day: 10,
      status_financial: 'ACTIVE',
      fidelity_plan: 'ANNUAL',
    });
  });
});
