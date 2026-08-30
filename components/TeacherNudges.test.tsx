import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TeacherNudges from './TeacherNudges';

const { from, rpc } = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));

vi.mock('../lib/supabase', () => ({
  supabase: { from, rpc },
}));

const query = (data: unknown) => {
  const result = Promise.resolve({ data, error: null });
  const builder: Record<string, any> = {
    then: result.then.bind(result),
    catch: result.catch.bind(result),
  };
  for (const method of ['select', 'eq', 'in', 'order', 'limit']) {
    builder[method] = vi.fn(() => builder);
  }
  builder.maybeSingle = vi.fn(() => result);
  return builder;
};

beforeEach(() => {
  localStorage.clear();
  from.mockReset();
  rpc.mockReset();
});

describe('<TeacherNudges />', () => {
  it('obtém somente a contagem autorizada de conflitos por RPC', async () => {
    from.mockImplementation((table: string) => {
      if (table === 'profiles') return query({ nf_exempt: true });
      if (table === 'teacher_closings') return query([]);
      if (table === 'teacher_availability') return query([{ created_at: new Date().toISOString() }]);
      throw new Error(`Tabela inesperada no cliente: ${table}`);
    });
    rpc.mockImplementation((name: string) => {
      if (name === 'my_attendance_conflict_count') return Promise.resolve({ data: 2, error: null });
      if (name === 'teacher_pay_projection') return Promise.resolve({ data: null, error: null });
      throw new Error(`RPC inesperada: ${name}`);
    });

    render(<TeacherNudges userId="teacher-1" />);

    expect(await screen.findByText(/2 aula\(s\) em análise/i)).toBeInTheDocument();
    expect(rpc).toHaveBeenCalledWith('my_attendance_conflict_count');
    await waitFor(() => expect(from).not.toHaveBeenCalledWith('attendance_confirmations'));
  });
});
