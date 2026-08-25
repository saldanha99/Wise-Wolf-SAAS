import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LessonPlannerAdapter } from '../LessonPlannerAI';
import type { HubBootstrap } from './types';

const bridge = vi.hoisted(() => ({
  adapter: null as LessonPlannerAdapter | null,
}));
const supabaseMocks = vi.hoisted(() => ({
  from: vi.fn(),
  invoke: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock('../LessonPlannerAI', () => ({
  default: (props: { adapter: LessonPlannerAdapter }) => {
    bridge.adapter = props.adapter;
    return <div>Planner AI nativo</div>;
  },
}));

vi.mock('../../lib/supabase', () => ({
  supabase: {
    from: supabaseMocks.from,
    functions: { invoke: supabaseMocks.invoke },
    rpc: supabaseMocks.rpc,
  },
}));

import HubEducatorPlanner from './HubEducatorPlanner';

const accountId = '11111111-1111-4111-8111-111111111111';
const learnerId = '22222222-2222-4222-8222-222222222222';

const bootstrap = (entitled = true): HubBootstrap => ({
  account: {
    id: accountId,
    name: 'Escola Aurora',
    account_type: 'ORGANIZATION',
    audience: 'INSTITUTION',
    status: 'ACTIVE',
    metadata: {},
  },
  membership: { membership_role: 'OWNER', status: 'ACTIVE' },
  subscription: {
    id: 'subscription-1',
    status: 'ACTIVE',
    trial_ends_at: null,
    current_period_ends_at: null,
  },
  plan: null,
  entitlements: entitled
    ? { 'educator_ai.generate': { limit: 100, resetPeriod: 'MONTH', used: 12 } }
    : {},
  settings: {
    settings_key: 'default',
    brand_name: 'Wise Wolf',
    headline: 'Hub',
    subheadline: null,
    saas_video_url: null,
    saas_cta_url: '/hub',
    support_url: null,
    metadata: {},
  },
});

describe('Bridge do Planner nativo no Hub', () => {
  beforeEach(() => {
    bridge.adapter = null;
    supabaseMocks.from.mockReset();
    supabaseMocks.invoke.mockReset();
    supabaseMocks.rpc.mockReset();
  });

  it('carrega contexto, gera e salva somente pelo gateway isolado do Hub', async () => {
    const onRefresh = vi.fn(async () => {});
    supabaseMocks.rpc.mockImplementation(async (functionName) => {
      if (functionName === 'hub_list_educator_learners') {
        return {
          data: [{ id: learnerId, display_name: 'Marina Costa', level_tag: 'B1' }],
          error: null,
        };
      }
      return { data: { id: learnerId }, error: null };
    });
    supabaseMocks.invoke.mockImplementation(async (_functionName, options) => {
      const action = options?.body?.action;
      if (action === 'history') {
        return {
          data: {
            learner: {
              id: learnerId,
              full_name: 'Marina Costa',
              module: 'B1',
              english_for: 'Apresentações',
              occupation: null,
              personality: null,
              preferred_topics: ['negócios'],
            },
            history: [{
              id: 'plan-1',
              created_at: '2026-08-23T12:00:00.000Z',
              objectives: 'Apresentar resultados',
              task_mode: 'lesson_plan',
              duration_minutes: 30,
            }],
            memory: null,
          },
          error: null,
        };
      }
      if (action === 'generate') {
        return { data: { run_id: 'run-1', plan: {}, knowledge: {} }, error: null };
      }
      return { data: { saved: true }, error: null };
    });

    render(
      <HubEducatorPlanner
        bootstrap={bootstrap()}
        userEmail="owner@example.invalid"
        onRefresh={onRefresh}
        onUpgrade={vi.fn()}
      />,
    );

    expect(screen.getByText('Planner AI nativo')).toBeTruthy();
    expect(await bridge.adapter!.listLearners()).toEqual([
      { id: learnerId, full_name: 'Marina Costa', module: 'B1' },
    ]);
    const context = await bridge.adapter!.loadLearnerContext(learnerId);
    expect(context.profile).toEqual(expect.objectContaining({
      id: learnerId,
      module: 'B1',
      english_for: 'Apresentações',
    }));
    expect(context.history).toHaveLength(1);
    expect(supabaseMocks.from).not.toHaveBeenCalled();
    expect(supabaseMocks.rpc).toHaveBeenCalledWith('hub_list_educator_learners', {
      p_account_id: accountId,
    });
    expect(supabaseMocks.invoke).toHaveBeenCalledWith('pedagogical-content', {
      body: { hubMode: true, action: 'history', accountId, learnerId },
    });

    await bridge.adapter!.generate({
      learnerId,
      taskMode: 'lesson_plan',
      bilingual: true,
      durationMinutes: 30,
      teacherRequest: 'Treinar apresentação.',
    });
    await bridge.adapter!.save!('run-1');

    expect(supabaseMocks.invoke).toHaveBeenCalledWith(
      'pedagogical-content',
      expect.objectContaining({
        body: expect.objectContaining({
          hubMode: true,
          action: 'generate',
          accountId,
          learnerId,
        }),
      }),
    );
    expect(supabaseMocks.invoke).toHaveBeenCalledWith('pedagogical-content', {
      body: { hubMode: true, action: 'save', accountId, run_id: 'run-1' },
    });
    expect(onRefresh).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('button', { name: 'Novo aluno' }));
    fireEvent.change(screen.getByLabelText('Nome do aluno'), {
      target: { value: 'Novo Aluno' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Criar perfil isolado' }));

    await waitFor(() => expect(supabaseMocks.rpc).toHaveBeenCalledWith(
      'hub_create_educator_learner',
      {
        p_account_id: accountId,
        p_name: 'Novo Aluno',
        p_level: 'B1',
        p_objective: null,
        p_interests: [],
        p_notes: null,
      },
    ));
    expect(supabaseMocks.from).not.toHaveBeenCalled();
  });

  it('falha fechado quando o plano não inclui o Educador IA', () => {
    const onUpgrade = vi.fn();
    render(
      <HubEducatorPlanner
        bootstrap={bootstrap(false)}
        userEmail="owner@example.invalid"
        onRefresh={async () => {}}
        onUpgrade={onUpgrade}
      />,
    );

    expect(screen.queryByText('Planner AI nativo')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Ver opções de acesso' }));
    expect(onUpgrade).toHaveBeenCalledTimes(1);
  });
});
