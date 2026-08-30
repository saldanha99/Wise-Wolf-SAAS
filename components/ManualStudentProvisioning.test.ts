import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');

describe('matrícula manual segura', () => {
  for (const component of ['./StudentsList.tsx', './TeacherScheduleExplorer.tsx']) {
    it(`${component} provisiona Auth no servidor e não usa senha fixa`, () => {
      const source = read(component);
      expect(source).toContain('provisionStudentAccount');
      expect(source).not.toContain('.auth.signUp(');
      expect(source).not.toContain("password: '123456'");
      expect(source).not.toContain('Senha padrão: 123456');
    });
  }

  it('não inventa uma sala Google Meet para o aluno', () => {
    const source = read('./TeacherScheduleExplorer.tsx');
    expect(source).not.toContain('https://meet.google.com/${rnd');
  });

  for (const component of ['./StudentsList.tsx', './TeacherScheduleExplorer.tsx']) {
    it(`${component} resolve CPF antes de criar uma identidade Auth`, () => {
      const source = read(component);
      expect(source.indexOf("'find_authorized_profile_by_cpf'")).toBeGreaterThan(-1);
      expect(source.indexOf("'find_authorized_profile_by_cpf'")).toBeLessThan(
        source.indexOf('provisionStudentAccount(supabase'),
      );
      expect(source).toContain('Este CPF já pertence a outro aluno');
    });
  }
});
