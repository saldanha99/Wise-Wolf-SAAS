import { beforeEach, describe, expect, it, vi } from 'vitest';

const supabaseMocks = vi.hoisted(() => ({
  rpc: vi.fn(),
}));

vi.mock('../../lib/supabase', () => ({
  supabase: {
    rpc: supabaseMocks.rpc,
  },
}));

import { loadHubBootstrap, updateHubPreferences } from './hubService';

const bootstrap = {
  account: {
    id: '4a81ff41-f158-4714-8e82-9fa08e7afb32',
    name: 'Escola Aurora',
    account_type: 'ORGANIZATION',
    audience: 'INSTITUTION',
    status: 'ACTIVE',
    metadata: { goal: 'Dado legado compartilhado' },
  },
  membership: { membership_role: 'MEMBER', status: 'ACTIVE' },
  subscription: null,
  plan: null,
  entitlements: {},
  settings: {},
};

describe('Perfil individual do Hub', () => {
  beforeEach(() => {
    supabaseMocks.rpc.mockReset();
  });

  it('anexa somente o perfil do membro confirmado para a conta carregada', async () => {
    supabaseMocks.rpc
      .mockResolvedValueOnce({ data: bootstrap, error: null })
      .mockResolvedValueOnce({
        data: {
          accountId: bootstrap.account.id,
          displayName: 'Marina',
          subjectRole: 'LEARNER',
          onboarding_completed: true,
          level: 'B2',
          role: 'Médica',
          goal: 'Atender pacientes estrangeiros',
          interests: 'medicina, viagens',
          preferred_modality: 'voice',
          personalized_at: '2026-08-23T18:00:00.000Z',
        },
        error: null,
      });

    const result = await loadHubBootstrap(bootstrap.account.id);

    expect(supabaseMocks.rpc).toHaveBeenNthCalledWith(2, 'hub_get_member_profile', {
      p_account_id: bootstrap.account.id,
    });
    expect(result?.memberProfile).toEqual({
      display_name: 'Marina',
      subjectRole: 'LEARNER',
      onboarding_completed: true,
      level: 'B2',
      role: 'Médica',
      goal: 'Atender pacientes estrangeiros',
      interests: 'medicina, viagens',
      preferred_modality: 'voice',
      personalized_at: '2026-08-23T18:00:00.000Z',
    });
  });

  it('falha fechado se o perfil vier de outra conta', async () => {
    supabaseMocks.rpc
      .mockResolvedValueOnce({ data: bootstrap, error: null })
      .mockResolvedValueOnce({
        data: {
          accountId: '51bfc98d-af87-4fc1-97f4-1b05e5819653',
          displayName: 'Outro membro',
          subjectRole: 'EDUCATOR',
        },
        error: null,
      });

    await expect(loadHubBootstrap(bootstrap.account.id)).rejects.toThrow('HUB_MEMBER_PROFILE_INVALID');
  });

  it('preserva o estado de conta suspensa sem consultar dados pessoais', async () => {
    const inactiveBootstrap = {
      ...bootstrap,
      account: { ...bootstrap.account, status: 'SUSPENDED', metadata: {} },
      access: { allowed: false, code: 'HUB_ACCOUNT_INACTIVE' },
    };
    supabaseMocks.rpc.mockResolvedValueOnce({ data: inactiveBootstrap, error: null });

    await expect(loadHubBootstrap(bootstrap.account.id)).resolves.toEqual(inactiveBootstrap);
    expect(supabaseMocks.rpc).toHaveBeenCalledTimes(1);
  });

  it('salva preferências apenas no perfil do próprio membro', async () => {
    supabaseMocks.rpc.mockResolvedValueOnce({ data: { accountId: bootstrap.account.id }, error: null });

    await updateHubPreferences(bootstrap.account.id, { level: 'C1', goal: 'Liderar reuniões' });

    expect(supabaseMocks.rpc).toHaveBeenCalledWith('hub_update_member_preferences', {
      p_account_id: bootstrap.account.id,
      p_preferences: { level: 'C1', goal: 'Liderar reuniões' },
    });
  });
});
