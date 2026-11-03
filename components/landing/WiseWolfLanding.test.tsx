import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type PlanRow = {
  id: string;
  name: string;
  description: string;
  price: number;
  price_yearly: number;
  max_students: number;
  max_users: number;
  max_storage_gb: number;
  features: string[];
  plan_type: string;
  active: boolean;
};

const filters = vi.hoisted(() => [] as Array<[string, unknown]>);

const row = (name: string, plan_type: string, price: number): PlanRow => ({
  id: `00000000-0000-4000-8000-${String(price).padStart(12, '0')}`,
  name,
  description: `${name} de teste`,
  price,
  price_yearly: price * 10,
  max_students: 10,
  max_users: 2,
  max_storage_gb: 1,
  features: [],
  plan_type,
  active: true,
});

// O catálogo real tem planos Teacher ativos ao lado dos de escola.
const catalog: PlanRow[] = [
  row('Teacher Starter', 'teacher', 97),
  row('Teacher Growth', 'teacher', 197),
  row('Starter', 'school', 198),
  row('Teacher Scale', 'teacher', 397),
  row('Pro', 'school', 398),
];

vi.mock('../../lib/supabase', () => {
  // A cadeia aplica os filtros de verdade, como o PostgREST faria.
  const query = () => {
    const applied: Array<[string, unknown]> = [];
    const builder = {
      select: () => builder,
      eq: (column: string, value: unknown) => {
        applied.push([column, value]);
        filters.push([column, value]);
        return builder;
      },
      order: () =>
        Promise.resolve({
          data: catalog.filter((plan) =>
            applied.every(([column, value]) =>
              (plan as unknown as Record<string, unknown>)[column] === value
            )
          ),
          error: null,
        }),
    };
    return builder;
  };
  return { supabase: { from: vi.fn(() => query()) } };
});

import WiseWolfLanding from './WiseWolfLanding';

describe('landing /lp, /wisewolf e /assine', () => {
  beforeEach(() => {
    filters.length = 0;
  });

  it('vende só planos de escola: Teacher fica fora da vitrine com checkout', async () => {
    render(<WiseWolfLanding />);

    await waitFor(() => expect(screen.getByText('Pro')).toBeTruthy());
    expect(screen.getByText('Starter')).toBeTruthy();
    expect(screen.queryByText('Teacher Starter')).toBeNull();
    expect(screen.queryByText('Teacher Growth')).toBeNull();
    expect(screen.queryByText('Teacher Scale')).toBeNull();
    expect(filters).toContainEqual(['plan_type', 'school']);
    expect(filters).toContainEqual(['active', true]);
  });
});
