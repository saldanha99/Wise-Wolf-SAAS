import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LessonPlannerAI, { type PlannerPlan } from './LessonPlannerAI';
import { UserRole } from '../types';

const { invoke, rpc, from } = vi.hoisted(() => ({
  invoke: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
}));

vi.mock('../lib/supabase', () => ({
  supabase: { functions: { invoke }, rpc, from },
}));

/** Consulta encadeável do supabase-js: todo filtro devolve ela mesma. */
const query = (result: { data: unknown; error: unknown }) => {
  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'or', 'order', 'limit']) {
    chain[method] = () => chain;
  }
  chain.maybeSingle = () => Promise.resolve(result);
  chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return chain;
};

const plan: PlannerPlan = {
  task_mode: 'homework',
  title: 'Lição: terceira pessoa',
  objective: 'Fixar a terceira pessoa do presente.',
  level: 'A2',
  duration_minutes: 30,
  bilingual: true,
  overview: 'Baseado nas aulas de 20/09 e 23/09.',
  sections: [],
  vocabulary: [],
  teacher_questions: [],
  expected_corrections: [],
  homework: 'Reescrever 5 frases.',
  materials: [],
  assessment_criteria: [],
  strengths: [],
  priorities: [],
  next_steps: [],
  student_memory_update: {
    lesson_objective: '',
    content_practiced: [],
    new_vocabulary: [],
    recurring_errors: [],
    corrections_mastered: [],
    strengths_observed: [],
    homework_assigned: '',
    recommended_next_step: '',
    confidence_level: 'LOW',
    notes_to_verify: [],
  },
  ai_memory_reflection: '',
  warnings: [],
};

const teacher = {
  id: '00000000-0000-4000-8000-00000000fa03',
  tenantId: 'school-wise-wolf',
  name: 'Prof Substituta',
  email: 'sub@example.invalid',
  role: UserRole.TEACHER,
};

describe('Planner IA do professor', () => {
  beforeEach(() => {
    invoke.mockReset();
    rpc.mockReset();
    from.mockReset();
    from.mockImplementation(() => query({ data: null, error: null }));
  });

  it('lista o aluno da cobertura pela regra do servidor e mostra a base do plano', async () => {
    rpc.mockResolvedValue({
      data: [
        { id: 'aluno-agenda', full_name: 'Ana', module: 'B1', access_reason: 'BOOKING', valid_until: null },
        { id: 'aluno-coberto', full_name: 'Theo', module: 'A2', access_reason: 'COVERAGE', valid_until: '2026-09-28' },
      ],
      error: null,
    });
    invoke.mockResolvedValue({
      data: {
        run_id: 'run-1',
        plan,
        knowledge: { mode: 'STRUCTURED_MEMORY_ONLY', sources: [], rag_used: false },
        lesson_basis: {
          source: 'MEET_APPROVED_SUMMARIES',
          lesson_dates: ['2026-09-20', '2026-09-23'],
          label: 'Baseado nas aulas de 20/09 e 23/09',
          continued_from: { lesson_date: '2026-09-23', recommended_next_step: 'Perguntas com does/doesn’t' },
          homework_targets: ['he work → he works'],
        },
      },
      error: null,
    });

    render(<LessonPlannerAI user={teacher} tenantId="school-wise-wolf" />);

    await screen.findByText('Theo · A2 · cobertura até 28/09');
    const select = screen.getAllByRole('combobox')[0];
    expect(rpc).toHaveBeenCalledWith('my_planner_students');
    // A lista do professor não é mais a agenda lida no navegador.
    expect(from).not.toHaveBeenCalledWith('bookings');

    fireEvent.change(select, { target: { value: 'aluno-coberto' } });
    expect(await screen.findByText(/Acesso de cobertura até 28\/09/)).toBeTruthy();

    fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: 'homework' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /gerar planejamento/i })).not.toHaveProperty('disabled', true));
    fireEvent.click(screen.getByRole('button', { name: /gerar planejamento/i }));

    expect(await screen.findByText('Baseado nas aulas de 20/09 e 23/09')).toBeTruthy();
    expect(screen.getByText(/Continua do próximo passo aprovado em 23\/09/)).toBeTruthy();
    expect(screen.getByText('• he work → he works')).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith('lesson-planner', expect.objectContaining({
      body: expect.objectContaining({ student_id: 'aluno-coberto', task_mode: 'homework' }),
    }));
  });

  it('o alvo do tour "Base do plano" existe antes de gerar qualquer plano', async () => {
    rpc.mockResolvedValue({
      data: [{ id: 'aluno-agenda', full_name: 'Ana', module: 'B1', access_reason: 'BOOKING', valid_until: null }],
      error: null,
    });

    render(<LessonPlannerAI user={teacher} tenantId="school-wise-wolf" />);
    await screen.findByText('Ana · B1');

    // O tour abre no primeiro acesso, sem plano na tela: o passo 2 não pode
    // depender de "Gerar planejamento" (o motor pularia o passo e marcaria o
    // tour como visto).
    const targets = document.querySelectorAll<HTMLElement>('[data-tour="planner-lesson-basis"]');
    expect(targets).toHaveLength(1);
    let node: HTMLElement | null = targets[0];
    while (node) {
      expect(node.classList.contains('hidden')).toBe(false);
      node = node.parentElement;
    }
    expect(targets[0].textContent).toMatch(/Base do plano/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('aula lançada depois da última aprovada: a tela não diz "continua de" um passo antigo', async () => {
    rpc.mockResolvedValue({
      data: [{ id: 'aluno-agenda', full_name: 'Ana', module: 'B1', access_reason: 'BOOKING', valid_until: null }],
      error: null,
    });
    invoke.mockResolvedValue({
      data: {
        run_id: 'run-3',
        plan: { ...plan, task_mode: 'lesson_plan' },
        knowledge: { mode: 'STRUCTURED_MEMORY_ONLY', sources: [], rag_used: false },
        lesson_basis: {
          source: 'MEET_APPROVED_SUMMARIES',
          lesson_dates: ['2026-09-20', '2026-09-23'],
          label: 'Aulas aprovadas de 20/09 e 23/09 usadas como histórico: houve aula lançada depois, em 20/11',
          continued_from: null,
          homework_targets: [],
          newer_logged_lesson_date: '2026-11-20',
        },
      },
      error: null,
    });

    render(<LessonPlannerAI user={teacher} tenantId="school-wise-wolf" />);
    await screen.findByText('Ana · B1');
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'aluno-agenda' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /gerar planejamento/i })).not.toHaveProperty('disabled', true));
    fireEvent.click(screen.getByRole('button', { name: /gerar planejamento/i }));

    expect(await screen.findByText(/Houve aula lançada em 20\/11/)).toBeTruthy();
    expect(screen.getByText(/usadas como histórico/)).toBeTruthy();
    expect(screen.queryByText(/Continua do próximo passo aprovado/)).toBeNull();
  });

  it('sem aula aprovada, diz de onde o plano saiu em vez de inventar data', async () => {
    rpc.mockResolvedValue({
      data: [{ id: 'aluno-agenda', full_name: 'Ana', module: 'B1', access_reason: 'BOOKING', valid_until: null }],
      error: null,
    });
    invoke.mockResolvedValue({
      data: {
        run_id: 'run-2',
        plan: { ...plan, task_mode: 'lesson_plan', overview: '' },
        knowledge: { mode: 'STRUCTURED_MEMORY_ONLY', sources: [], rag_used: false },
        lesson_basis: null,
      },
      error: null,
    });

    render(<LessonPlannerAI user={teacher} tenantId="school-wise-wolf" />);
    await screen.findByText('Ana · B1');
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'aluno-agenda' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /gerar planejamento/i })).not.toHaveProperty('disabled', true));
    fireEvent.click(screen.getByRole('button', { name: /gerar planejamento/i }));

    expect(await screen.findByText(/Ainda não há resumo de aula aprovado/)).toBeTruthy();
    expect(screen.queryByText(/Baseado na/)).toBeNull();
  });
});
