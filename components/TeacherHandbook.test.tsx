import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TeacherHandbook from './TeacherHandbook';

const { maybeSingle, upsert } = vi.hoisted(() => ({ maybeSingle: vi.fn(), upsert: vi.fn() }));

vi.mock('../lib/supabase', () => {
  const query = { select: () => query, eq: () => query, maybeSingle, upsert };
  return { supabase: { from: () => query } };
});

beforeEach(() => {
  maybeSingle.mockReset();
  upsert.mockReset();
});

describe('<TeacherHandbook />', () => {
  it('mostra os pilares e registra a leitura só depois do aceite', async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    upsert.mockResolvedValue({ error: null });
    render(<TeacherHandbook userId="prof-1" onNavigate={() => undefined} />);

    expect(await screen.findByText('Leitura pendente — confirme no final')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Teacher Exchange' })).toBeTruthy();

    const button = screen.getByRole('button', { name: /Concluí o treinamento/ });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(button);

    await waitFor(() => expect(screen.getByText('Você concluiu o treinamento')).toBeTruthy());
    expect(upsert).toHaveBeenCalledWith(
      { user_id: 'prof-1', tour_id: 'manual-do-professor-v1-lido' },
      { onConflict: 'user_id,tour_id', ignoreDuplicates: true },
    );
  });

  it('a busca filtra os pilares e os atalhos navegam', async () => {
    maybeSingle.mockResolvedValue({ data: { tour_id: 'manual-do-professor-v1-lido' }, error: null });
    const onNavigate = vi.fn();
    render(<TeacherHandbook userId="prof-1" onNavigate={onNavigate} />);

    expect(await screen.findByText('Treinamento concluído')).toBeTruthy();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'feriado nacional' } });
    expect(screen.getAllByRole('article')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /Agenda/ }));
    expect(onNavigate).toHaveBeenCalledWith('schedule');
  });
});
