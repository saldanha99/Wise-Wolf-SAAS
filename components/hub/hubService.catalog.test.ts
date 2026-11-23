import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('../../lib/supabase', () => ({ supabase: { from: mocks.from, rpc: mocks.rpc } }));

import { HUB_CATALOG_LIMIT, loadHubPublicData } from './hubService';

const chain = (result: unknown, onSelect?: (columns: string) => void, onLimit?: (n: number) => void) => {
  const c: Record<string, unknown> = {};
  c.select = vi.fn((columns: string) => { onSelect?.(columns); return c; });
  c.eq = vi.fn(() => c);
  c.order = vi.fn(() => c);
  c.limit = vi.fn(async (n: number) => { onLimit?.(n); return result; });
  c.then = undefined;
  return c;
};

beforeEach(() => {
  mocks.from.mockReset();
  mocks.rpc.mockReset();
  mocks.rpc.mockResolvedValue({ data: null, error: null });
});

describe('leitura do catálogo do Hub', () => {
  it('lê até 500 itens com as colunas de filtro', async () => {
    const selects: string[] = [];
    const limits: number[] = [];
    const plans = { select: () => plans, eq: () => plans, order: async () => ({ data: [], error: null }) };
    mocks.from.mockImplementation((table: string) => table === 'hub_plans'
      ? plans
      : chain({ data: [{ id: 'a', skills: ['reading'] }], error: null }, (columns) => selects.push(columns), (n) => limits.push(n)));
    const data = await loadHubPublicData();
    expect(HUB_CATALOG_LIMIT).toBeGreaterThanOrEqual(200);
    expect(limits).toEqual([HUB_CATALOG_LIMIT]);
    expect(selects[0]).toContain('skills, theme, age_group, duration_minutes');
    expect(data.content[0].skills).toEqual(['reading']);
  });

  it('banco sem a migration (coluna inexistente) cai na leitura antiga', async () => {
    const selects: string[] = [];
    let call = 0;
    const plans = { select: () => plans, eq: () => plans, order: async () => ({ data: [], error: null }) };
    mocks.from.mockImplementation((table: string) => {
      if (table === 'hub_plans') return plans;
      call += 1;
      return chain(call === 1 ? { data: null, error: { code: '42703' } } : { data: [{ id: 'old' }], error: null }, (columns) => selects.push(columns));
    });
    const data = await loadHubPublicData();
    expect(selects).toHaveLength(2);
    expect(selects[1]).not.toContain('skills');
    expect(data.content.map((item) => item.id)).toEqual(['old']);
  });
});
