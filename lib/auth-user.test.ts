import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  accessContextResult: {
    data: { tenant_id: 'school-active', role: 'TEACHER' } as Record<string, string | null> | null,
    error: null as Error | null,
  },
  rpc: vi.fn(),
  loadPrivate: vi.fn(),
}));

vi.mock('./supabase', () => ({
  supabase: {
    rpc: mocks.rpc,
  },
}));

vi.mock('./profilePrivacy', () => ({
  loadAuthorizedProfilePrivate: mocks.loadPrivate,
}));

import { mapProfileToAppUser } from './auth-user';

const profile = {
  id: 'teacher-1',
  tenant_id: 'legacy-school',
  role: 'SCHOOL_ADMIN',
  full_name: 'Professora Teste',
  email: 'teacher@example.invalid',
  status: 'Ativo',
  lifecycle_status: 'active',
};

describe('mapProfileToAppUser active access boundary', () => {
  beforeEach(() => {
    mocks.accessContextResult = {
      data: { tenant_id: 'school-active', role: 'TEACHER' },
      error: null,
    };
    mocks.rpc.mockReset();
    mocks.loadPrivate.mockReset();
    mocks.loadPrivate.mockResolvedValue({ status_financial: 'ACTIVE' });
    mocks.rpc.mockImplementation((name: string) => {
      if (name === 'get_my_access_context') {
        return { maybeSingle: vi.fn().mockResolvedValue(mocks.accessContextResult) };
      }
      if (name === 'get_my_pay') return Promise.resolve({ data: { hourly_rate: 42 } });
      throw new Error(`unexpected rpc: ${name}`);
    });
  });

  it('uses only the active membership context for tenant and role', async () => {
    const user = await mapProfileToAppUser(profile);

    expect(user).toMatchObject({
      tenantId: 'school-active',
      role: 'TEACHER',
      status: 'Ativo',
      lifecycleStatus: 'active',
      hourlyRate: 42,
    });
    expect(user).not.toMatchObject({ tenantId: 'legacy-school', role: 'SCHOOL_ADMIN' });
  });

  it.each([
    null,
    { tenant_id: null, role: null },
    { tenant_id: '', role: 'TEACHER' },
    { tenant_id: 'school-active', role: '' },
  ])('returns null instead of restoring profile fallback for %o', async (accessContext) => {
    mocks.accessContextResult = { data: accessContext, error: null };

    await expect(mapProfileToAppUser(profile)).resolves.toBeNull();
    expect(mocks.loadPrivate).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalledWith('get_my_pay');
  });

  it('preserves the explicit tenantless Hub role without using profile fallback', async () => {
    mocks.accessContextResult = {
      data: { tenant_id: null, role: 'NON_STUDENT' },
      error: null,
    };

    await expect(mapProfileToAppUser(profile)).resolves.toMatchObject({
      tenantId: '',
      role: 'NON_STUDENT',
    });
  });

  it('fails closed when the access-context RPC cannot be validated', async () => {
    const rpcError = new Error('context unavailable');
    mocks.accessContextResult = { data: null, error: rpcError };

    await expect(mapProfileToAppUser(profile)).rejects.toBe(rpcError);
    expect(mocks.loadPrivate).not.toHaveBeenCalled();
  });
});
