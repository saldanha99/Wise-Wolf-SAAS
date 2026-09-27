import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STUDENT_DOSSIER_PATH, studentDossierDestination } from './studentDossierLink';

const STUDENT = '00000000-0000-4000-8000-000000009e11';
const link = { pathname: STUDENT_DOSSIER_PATH, search: `?aluno=${STUDENT}` };

describe('link com login do dossiê do aluno', () => {
  it('espera o login e abre "Salas e continuidade" com o dossiê do aluno', () => {
    expect(studentDossierDestination(link, null)).toBeNull();
    expect(studentDossierDestination(link, { id: '', role: 'TEACHER' })).toBeNull();
    for (const role of ['TEACHER', 'COORDINATOR', 'SCHOOL_ADMIN']) {
      expect(studentDossierDestination(link, { id: 'conta-logada', role }))
        .toEqual({ tab: 'lesson-sessions', studentId: STUDENT });
    }
  });

  it.each(['STUDENT', 'SUPER_ADMIN', 'SALESPERSON', 'NON_STUDENT', ''])('não abre nada para %s', (role) => {
    expect(studentDossierDestination(link, { id: 'conta-logada', role })).toBeNull();
  });

  it('aceita barra no fim e UUID em maiúsculas', () => {
    expect(studentDossierDestination(
      { pathname: `${STUDENT_DOSSIER_PATH}/`, search: `?aluno=${STUDENT.toUpperCase()}` },
      { id: 'conta-logada', role: 'TEACHER' },
    )).toEqual({ tab: 'lesson-sessions', studentId: STUDENT });
  });

  it.each([
    { pathname: STUDENT_DOSSIER_PATH, search: '' },
    { pathname: STUDENT_DOSSIER_PATH, search: '?aluno=nao-e-uuid' },
    { pathname: STUDENT_DOSSIER_PATH, search: `?aluno=${STUDENT}x` },
    { pathname: `${STUDENT_DOSSIER_PATH}/${STUDENT}`, search: '' },
    { pathname: '/', search: `?aluno=${STUDENT}` },
    { pathname: '/registro-das-aulas', search: `?aluno=${STUDENT}` },
  ])('não interpreta destino arbitrário: %o', (location) => {
    expect(studentDossierDestination(location, { id: 'conta-logada', role: 'TEACHER' })).toBeNull();
  });

  it('o servidor monta o link com o MESMO caminho (pacote da cobertura e transferência)', () => {
    const migration = readFileSync(
      resolve(__dirname, '../supabase/migrations/20260928100000_substituto_e_novo_titular_recebem_o_dossie.sql'),
      'utf8',
    );
    // Um no pacote da cobertura, outro no aviso da transferência.
    expect(migration.split(`${STUDENT_DOSSIER_PATH}?aluno=`).length - 1).toBeGreaterThanOrEqual(2);
  });
});
