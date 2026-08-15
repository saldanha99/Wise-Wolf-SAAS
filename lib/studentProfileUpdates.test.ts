import { describe, expect, it } from 'vitest';
import { buildStudentProfileUpdates, mapStudentProfileToForm } from './studentProfileUpdates';

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

  it('converte valores vazios de UUID e CPF em null', () => {
    expect(buildStudentProfileUpdates({ professor_id: '', cpf: '' })).toMatchObject({
      professor_id: null,
      cpf: null,
    });
  });

  it('normaliza o perfil hospedado sem apagar dados ao abrir o formulário', () => {
    expect(mapStudentProfileToForm({
      full_name: 'Anderson',
      module: 'A1',
      postal_code: '01001-000',
      address_number: '10',
      monthly_tuition: 490,
      fidelity_plan: 'ANNUAL',
    })).toMatchObject({
      name: 'Anderson',
      levelBadge: 'A1',
      postalCode: '01001-000',
      addressNumber: '10',
      monthly_fee: 490,
      planDuration: 'ANNUAL',
      professor_id: null,
    });
  });

  it('usa o resumo do mapa quando a relação do perfil não veio carregada', () => {
    expect(mapStudentProfileToForm(null, { name: 'Anderson', levelBadge: 'A1' })).toMatchObject({
      name: 'Anderson',
      levelBadge: 'A1',
    });
  });

  it('não envia nome ou módulo vazios em uma atualização parcial', () => {
    const updates = buildStudentProfileUpdates({ name: '   ', levelBadge: '' });
    expect(updates).not.toHaveProperty('full_name');
    expect(updates).not.toHaveProperty('module');
  });
});
