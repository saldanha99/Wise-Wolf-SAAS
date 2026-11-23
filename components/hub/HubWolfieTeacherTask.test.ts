import { describe, expect, it } from 'vitest';
import { teacherTaskFromDesk, teacherTaskScenario } from './HubWolfieStudio';

const desk = (assignments: Array<Record<string, unknown>>, objective: string | null = 'reuniões em inglês no trabalho') => ({
  learner: { id: 'l1', display_name: 'Ana', level_tag: 'A2', objective },
  teacher_name: 'Prof. Marina',
  assignments: assignments.map((a, i) => ({
    id: `a${i}`, note: '', status: 'ASSIGNED', student_note: '', done_at: null, created_at: '',
    ...a,
    material: { id: `m${i}`, kind: 'worksheet', niche: 'BUSINESS', level_tag: 'A2', topic: '', goal: '', title: '', created_at: '', dropped_items: 0, material: {}, ...(a.material as object) },
  })),
}) as never;

describe('Wolfie do aluno convidado abre na tarefa do professor', () => {
  it('usa a tarefa aberta, o recado e o objetivo, não um cenário genérico', () => {
    const task = teacherTaskFromDesk(desk([
      { status: 'DONE', material: { title: 'Ficha antiga', topic: 'old' } },
      { status: 'ASSIGNED', note: 'Treine se apresentar', material: { title: 'Small talk na reunião', topic: 'meeting small talk' } },
    ]));
    expect(task).toMatchObject({ title: 'Small talk na reunião', level: 'A2', teacherName: 'Prof. Marina' });
    const scenario = teacherTaskScenario(task!);
    expect(scenario).toContain('Small talk na reunião');
    expect(scenario).toContain('reuniões em inglês no trabalho');
    expect(scenario).toContain('Treine se apresentar');
  });

  it('sem tarefa mas com objetivo ainda abre no objetivo; sem nada, cai na vitrine', () => {
    expect(teacherTaskFromDesk(desk([]))?.objective).toBe('reuniões em inglês no trabalho');
    expect(teacherTaskFromDesk(desk([], null))).toBeNull();
    expect(teacherTaskFromDesk(null)).toBeNull();
  });
});
