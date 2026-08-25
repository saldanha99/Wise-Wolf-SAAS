import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HubBootstrap } from './types';

const bridge = vi.hoisted(() => ({
  tutorProps: null as Record<string, any> | null,
}));

vi.mock('../../src/components/wolfie/WolfieDiscoveryHome', () => ({
  WolfieDiscoveryHome: (props: Record<string, any>) => (
    <button
      type="button"
      onClick={() => props.onChooseExperience({
        id: 'job-interviews',
        title: 'Entrevistas',
        description: 'Pratique uma entrevista real.',
        subject: 'writing',
        experienceMode: 'interview',
        realWorldGoal: 'Responder com exemplos concretos.',
        audiences: ['adult', 'professional'],
        skills: ['speaking', 'writing'],
        durations: [10],
        modalities: ['text', 'mixed'],
        searchTerms: ['interview'],
      })}
    >
      Catálogo nativo do Wolfie
    </button>
  ),
}));

vi.mock('../WolfieTutor', () => ({
  default: (props: Record<string, any>) => {
    bridge.tutorProps = props;
    return <div>Conversa nativa do Wolfie</div>;
  },
}));

import HubWolfieStudio from './HubWolfieStudio';

const bootstrap = (overrides: Partial<HubBootstrap> = {}): HubBootstrap => ({
  account: {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Marina Professora',
    account_type: 'PERSONAL',
    audience: 'EDUCATOR',
    status: 'ACTIVE',
    metadata: {
      level: 'A1',
      goal: 'Dado legado compartilhado',
    },
  },
  membership: { membership_role: 'OWNER', status: 'ACTIVE' },
  memberProfile: {
    display_name: 'Marina Professora',
    subjectRole: 'EDUCATOR',
    onboarding_completed: true,
    level: 'B2',
    role: 'Professora autônoma',
    goal: 'Preparar alunos para entrevistas',
    interests: 'carreira, negócios',
    preferred_modality: 'mixed',
  },
  subscription: {
    id: 'subscription-1',
    status: 'ACTIVE',
    trial_ends_at: null,
    current_period_ends_at: null,
  },
  plan: null,
  entitlements: {
    'wolfie.turn': { limit: 100, resetPeriod: 'MONTH', used: 3 },
  },
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
  ...overrides,
});

describe('Bridge do Wolfie nativo no Hub', () => {
  beforeEach(() => {
    bridge.tutorProps = null;
  });

  it('usa o catálogo nativo e abre a conversa nativa com contexto da assinatura', () => {
    const onRefresh = vi.fn(async () => {});
    render(
      <HubWolfieStudio
        bootstrap={bootstrap()}
        onRefresh={onRefresh}
        onUpgrade={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Catálogo nativo do Wolfie' }));

    expect(screen.getByText('Conversa nativa do Wolfie')).toBeTruthy();
    expect(bridge.tutorProps).toEqual(expect.objectContaining({
      voiceMode: false,
      topic: 'Entrevistas',
      experienceId: 'job-interviews',
      experienceUniverse: 'career',
    }));
    expect(bridge.tutorProps?.user).toEqual(expect.objectContaining({
      name: 'Marina Professora',
      levelBadge: 'B2',
      studentCategory: 'professional',
    }));
    expect(bridge.tutorProps?.hubContext).toEqual(expect.objectContaining({
      accountId: '11111111-1111-4111-8111-111111111111',
      onUsageCommitted: onRefresh,
    }));
    expect(bridge.tutorProps?.hubContext).not.toHaveProperty('preferences');
    expect(bridge.tutorProps?.hubContext).not.toHaveProperty('learnerProfile');
  });

  it('trata membro aluno de uma instituição como aluno, não como operador profissional', () => {
    render(
      <HubWolfieStudio
        bootstrap={bootstrap({
          account: { ...bootstrap().account, audience: 'INSTITUTION' },
          membership: { membership_role: 'MEMBER', status: 'ACTIVE' },
          memberProfile: {
            display_name: 'Pedro Aluno',
            subjectRole: 'LEARNER',
            onboarding_completed: true,
            level: 'A2',
            preferred_modality: 'voice',
          },
        })}
        onRefresh={async () => {}}
        onUpgrade={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Catálogo nativo do Wolfie' }));

    expect(bridge.tutorProps?.user).toEqual(expect.objectContaining({
      name: 'Pedro Aluno',
      studentCategory: 'adult',
      levelBadge: 'A2',
    }));
    expect(bridge.tutorProps?.voiceMode).toBe(false);
  });

  it('falha fechado sem conta válida ou benefício Wolfie', () => {
    const onUpgrade = vi.fn();
    render(
      <HubWolfieStudio
        bootstrap={bootstrap({
          account: { ...bootstrap().account, id: 'conta-invalida' },
          entitlements: {},
        })}
        onRefresh={async () => {}}
        onUpgrade={onUpgrade}
      />,
    );

    expect(screen.queryByText('Catálogo nativo do Wolfie')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Ver opções de acesso' }));
    expect(onUpgrade).toHaveBeenCalledTimes(1);
  });
});
