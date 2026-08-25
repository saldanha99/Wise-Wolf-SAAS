import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import HubPortal from './HubPortal';
import type { HubAudience, HubAuthorityRole, HubBootstrap, HubSettings } from './types';

vi.mock('../../lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(),
      onAuthStateChange: vi.fn(() => ({
        data: { subscription: { unsubscribe: vi.fn() } },
      })),
    },
  },
}));

const settings: HubSettings = {
  settings_key: 'default',
  brand_name: 'Wise Wolf Hub',
  headline: 'Hub',
  subheadline: null,
  saas_video_url: null,
  saas_cta_url: '/new-saas',
  support_url: null,
  metadata: {},
};

const bootstrap = (
  subjectRole: 'LEARNER' | 'EDUCATOR',
  membershipRole: HubAuthorityRole = 'MEMBER',
  audience: HubAudience = 'INSTITUTION',
): HubBootstrap => ({
  account: {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Escola Aurora',
    account_type: 'ORGANIZATION',
    audience,
    status: 'ACTIVE',
    metadata: {},
  },
  membership: { membership_role: membershipRole, status: 'ACTIVE' },
  memberProfile: {
    display_name: subjectRole === 'LEARNER' ? 'Aluno Pedro' : 'Professora Marina',
    subjectRole,
    onboarding_completed: true,
  },
  subscription: {
    id: 'subscription-1',
    status: 'ACTIVE',
    trial_ends_at: null,
    current_period_ends_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  },
  plan: null,
  entitlements: {
    'library.full_access': { limit: null, resetPeriod: 'MONTH', used: 0 },
    'educator_ai.generate': { limit: 100, resetPeriod: 'MONTH', used: 0 },
    'wolfie.turn': { limit: 100, resetPeriod: 'MONTH', used: 0 },
  },
  settings,
});

const renderPortal = (
  subjectRole: 'LEARNER' | 'EDUCATOR',
  membershipRole: HubAuthorityRole = 'MEMBER',
  audience: HubAudience = 'INSTITUTION',
) => render(
  <HubPortal
    bootstrap={bootstrap(subjectRole, membershipRole, audience)}
    plans={[]}
    settings={settings}
    content={[]}
    userId="00000000-0000-4000-8000-000000000001"
    userEmail="member@example.invalid"
    onRefresh={async () => {}}
    onLogout={async () => {}}
  />,
);

describe('Papel funcional no Hub', () => {
  it('não oferece ferramentas de professor para um membro aluno', () => {
    renderPortal('LEARNER');

    expect(screen.queryByRole('button', { name: 'Educador IA' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Criar com IA' })).toBeNull();
    expect(screen.queryByText('Prepare uma aula')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Biblioteca' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'Wolfie' }).length).toBeGreaterThan(0);
  });

  it('mantém o módulo nativo disponível para um membro educador', () => {
    renderPortal('EDUCATOR');

    expect(screen.getByRole('button', { name: 'Educador IA' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Criar com IA' })).toBeTruthy();
  });

  it('não transforma autoridade OWNER de uma conta de aluno em persona educadora', () => {
    renderPortal('LEARNER', 'OWNER', 'LEARNER');

    expect(screen.queryByRole('button', { name: 'Educador IA' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Criar com IA' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Wolfie' }).length).toBeGreaterThan(0);
  });

  it('mantém Educador IA para OWNER com persona educadora', () => {
    renderPortal('EDUCATOR', 'OWNER', 'EDUCATOR');

    expect(screen.getByRole('button', { name: 'Educador IA' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Criar com IA' })).toBeTruthy();
  });

  it('personaliza um membro aluno pela função individual, não pela conta institucional', () => {
    const learnerBootstrap = bootstrap('LEARNER');
    learnerBootstrap.memberProfile = {
      ...learnerBootstrap.memberProfile!,
      onboarding_completed: false,
    };

    render(
      <HubPortal
        bootstrap={learnerBootstrap}
        plans={[]}
        settings={settings}
        content={[]}
        userId="00000000-0000-4000-8000-000000000001"
        userEmail="member@example.invalid"
        onRefresh={async () => {}}
        onLogout={async () => {}}
      />,
    );

    expect(screen.getByText('Sua jornada em inglês')).toBeTruthy();
    expect(screen.queryByText('Sua operação pedagógica')).toBeNull();
  });
});
