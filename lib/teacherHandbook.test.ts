import { describe, expect, it } from 'vitest';
import { buildMenuItems } from './navModel';
import { searchTeacherHandbook, TEACHER_HANDBOOK_SECTIONS } from './teacherHandbook';

describe('manual do professor', () => {
  it('fica no menu do professor e todo atalho aponta para uma tela dele', () => {
    const teacherTabs = new Set(buildMenuItems('TEACHER', { pendingLessonsCount: 0 }).map(item => item.id));
    expect(teacherTabs.has('teacher-handbook')).toBe(true);
    for (const section of TEACHER_HANDBOOK_SECTIONS) {
      for (const link of section.links || []) {
        expect(teacherTabs.has(link.tab), `${section.id} → ${link.tab}`).toBe(true);
      }
    }
  });

  it('pilares têm id único, ordem contínua e pontos', () => {
    const ids = TEACHER_HANDBOOK_SECTIONS.map(s => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    TEACHER_HANDBOOK_SECTIONS.forEach((section, index) => {
      expect(section.order).toBe(index + 1);
      expect(section.points.length).toBeGreaterThan(0);
    });
  });

  it('cobre os pilares pedidos pela direção', () => {
    const ids = TEACHER_HANDBOOK_SECTIONS.map(s => s.id);
    for (const id of ['teacher-exchange', 'gravacao', 'pagamento-e-turbo', 'frequencia-e-avisos', 'cobertura', 'prestacao-de-servico', 'feriados', 'reposicoes', 'aula-experimental', 'aluno-e-dinheiro', 'aula-demonstrativa']) {
      expect(ids).toContain(id);
    }
  });

  it('a busca ignora acento e acha pelo assunto', () => {
    expect(searchTeacherHandbook('reposicao').map(s => s.id)).toContain('reposicoes');
    expect(searchTeacherHandbook('Teacher Exchange').map(s => s.id)).toContain('teacher-exchange');
    expect(searchTeacherHandbook('feriado nacional').map(s => s.id)).toEqual(['feriados']);
    expect(searchTeacherHandbook('').length).toBe(TEACHER_HANDBOOK_SECTIONS.length);
    expect(searchTeacherHandbook('xyzzy')).toEqual([]);
  });
});
