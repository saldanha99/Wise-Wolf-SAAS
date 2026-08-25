import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import LessonPlannerAI, { type LessonPlannerAdapter, type PlannerPlan } from './LessonPlannerAI';
import { UserRole } from '../types';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('../lib/supabase', () => ({
  supabase: {
    functions: { invoke },
    from: vi.fn(),
  },
}));

const plan: PlannerPlan = {
  task_mode: 'lesson_plan',
  title: 'Apresentação de resultados',
  objective: 'Apresentar indicadores com clareza em inglês.',
  level: 'B1',
  duration_minutes: 45,
  bilingual: true,
  overview: 'Aula prática para uma apresentação profissional.',
  sections: [],
  vocabulary: [],
  teacher_questions: [],
  expected_corrections: [],
  homework: '',
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
    confidence_level: 'MEDIUM',
    notes_to_verify: [],
  },
  ai_memory_reflection: '',
  warnings: [],
};

describe('LessonPlannerAI adapter boundary', () => {
  it('keeps the native view while routing data and persistence through the Hub adapter', async () => {
    const save = vi.fn(async () => undefined);
    const generate = vi.fn(async () => ({
      run_id: 'run-hub-1',
      plan,
      knowledge: { mode: 'hub_account', sources: [], rag_used: false },
    }));
    const adapter: LessonPlannerAdapter = {
      contextKey: 'hub:account-a',
      capabilities: { canPersist: true, hasPedagogicalMemory: true },
      listLearners: vi.fn(async () => [{ id: 'learner-a', full_name: 'Ana', module: 'B1' }]),
      loadLearnerContext: vi.fn(async () => ({
        profile: {
          id: 'learner-a',
          module: 'B1',
          english_for: 'Apresentações',
          occupation: null,
          personality: null,
          preferred_topics: ['negócios'],
        },
        intelligence: null,
        history: [],
      })),
      generate,
      save,
    };

    render(
      <LessonPlannerAI
        user={{ id: 'hub-account-a', tenantId: '', name: 'Conta A', email: 'a@example.invalid', role: UserRole.NON_STUDENT }}
        adapter={adapter}
      />,
    );

    fireEvent.change((await screen.findAllByRole('combobox'))[0], { target: { value: 'learner-a' } });
    await waitFor(() => expect(adapter.loadLearnerContext).toHaveBeenCalledWith('learner-a'));
    fireEvent.click(screen.getByRole('button', { name: /gerar planejamento/i }));

    expect(await screen.findByText('Apresentação de resultados')).toBeTruthy();
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      learnerId: 'learner-a',
      taskMode: 'lesson_plan',
      durationMinutes: 30,
    }));
    expect(invoke).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /salvar plano/i }));
    await waitFor(() => expect(save).toHaveBeenCalledWith('run-hub-1'));
    expect(invoke).not.toHaveBeenCalled();
  });
});
