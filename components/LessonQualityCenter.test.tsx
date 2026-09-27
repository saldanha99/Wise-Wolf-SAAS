import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));

import LessonQualityCenter from './LessonQualityCenter';

const dashboard = {
  ok: true,
  counts: { planned: 3 },
  reviewers: [],
  cases: [
    {
      id: 'c1', student_id: 's1', student_name: 'Aluno Um', teacher_name: 'Ana', category: 'LATE_START', source: 'SYSTEM',
      status: 'OPEN', description: 'Relatório de presença do Meet: o professor entrou 12 min depois do horário da aula.',
      assigned_to: null, created_at: '2026-09-24T15:00:00Z', events: [],
    },
    {
      id: 'c2', student_id: 's2', student_name: 'Aluno Dois', teacher_name: 'Ana', category: 'LATE_START', source: 'FAMILY',
      status: 'OPEN', description: 'A família contou que a aula começou atrasada.',
      assigned_to: null, created_at: '2026-09-24T16:00:00Z', events: [],
    },
  ],
};

const enabledExtract = {
  ok: true,
  enabled: true,
  enabled_at: '2026-09-01T12:00:00Z',
  teachers: [{ id: 't-ana', name: 'Ana Professora' }, { id: 't-bia', name: 'Bia Professora' }],
  teacher_id: 't-ana',
  extract: {
    month: '2026-09',
    summary: {
      planned: 2, in_school_room: 2, measured: 1, on_time: 0, late_5: 1, late_10: 1, not_in_report: 0,
      joined_after_end: 0, minutes_in_room: 18, scheduled_minutes: 30, left_early: 0,
      not_measured: { NOT_FOUND: 1, UNPARSED: 0, NO_CONFERENCE: 0, NO_ROOM: 0 },
    },
    lessons: [
      { class_date: '2026-09-24', scheduled_start_at: '2026-09-24T13:00:00Z', scheduled_minutes: 30,
        first_join_at: '2026-09-24T13:12:00Z', late_minutes: 12, minutes_in_room: 18, left_early_minutes: 0, status: 'FOUND' },
      { class_date: '2026-09-25', scheduled_start_at: '2026-09-25T13:00:00Z', scheduled_minutes: 30,
        first_join_at: null, late_minutes: null, minutes_in_room: null, left_early_minutes: null, status: 'NOT_FOUND' },
    ],
  },
};

beforeEach(() => rpc.mockReset());

describe('Central de Qualidade', () => {
  it('atraso do Meet tem rótulo próprio, diferente do relato da família', async () => {
    rpc.mockResolvedValue({ data: dashboard, error: null });
    render(<LessonQualityCenter />);
    await screen.findByText('Atraso detectado pelo Meet · Aluno Um');
    expect(screen.getByText('Atraso relatado · Aluno Dois')).toBeTruthy();
  });

  it('aba Pontualidade desligada: só o aviso de que depende do jurídico, nada de número', async () => {
    rpc.mockImplementation((name: string) => Promise.resolve(name === 'get_teacher_punctuality_extract'
      ? { data: { ok: true, enabled: false }, error: null }
      : { data: dashboard, error: null }));
    render(<LessonQualityCenter />);
    fireEvent.click(screen.getByRole('tab', { name: 'Pontualidade' }));
    const notice = await screen.findByTestId('punctuality-disabled');
    expect(notice.textContent).toContain('desligado nesta escola');
    expect(notice.textContent).toContain('liberação do jurídico');
    expect(notice.textContent).toContain('sem ranking');
    expect(screen.queryByLabelText('Professor')).toBeNull();
    expect(rpc).toHaveBeenCalledWith('get_teacher_punctuality_extract', expect.objectContaining({ p_teacher_id: null }));
  });

  it('aba Pontualidade ligada: um professor por vez, sem ranking, com o motivo da aula sem medição', async () => {
    rpc.mockImplementation((name: string, args?: Record<string, unknown>) => {
      if (name !== 'get_teacher_punctuality_extract') return Promise.resolve({ data: dashboard, error: null });
      return Promise.resolve({
        data: args?.p_teacher_id ? enabledExtract : { ...enabledExtract, teacher_id: null, extract: null },
        error: null,
      });
    });
    render(<LessonQualityCenter />);
    fireEvent.click(screen.getByRole('tab', { name: 'Pontualidade' }));
    const select = await screen.findByLabelText('Professor');
    // Lista só com nomes, em ordem alfabética — nenhum número ao lado.
    expect(within(select).getAllByRole('option').map(option => option.textContent))
      .toEqual(['Escolha um professor', 'Ana Professora', 'Bia Professora']);
    expect(screen.getByText('Escolha um professor para ver o extrato do mês.')).toBeTruthy();

    fireEvent.change(select, { target: { value: 't-ana' } });
    await screen.findByText('Entrou às 10:12 (12 min de atraso) · 18 min na sala');
    expect(rpc).toHaveBeenCalledWith('get_teacher_punctuality_extract', expect.objectContaining({ p_teacher_id: 't-ana' }));
    expect(screen.getByText('Relatório de presença não encontrado: 1')).toBeTruthy();
    expect(screen.getByText('18 / 30')).toBeTruthy();
    const page = document.body.textContent || '';
    expect(page).toContain('Não altera o pagamento');
    expect(page.toLowerCase()).not.toMatch(/nota:|média|posição|1º lugar/);
  });

  it('erro ao carregar o extrato aparece, sem inventar número', async () => {
    rpc.mockImplementation((name: string) => Promise.resolve(name === 'get_teacher_punctuality_extract'
      ? { data: null, error: { message: 'sem_permissao' } }
      : { data: dashboard, error: null }));
    render(<LessonQualityCenter />);
    fireEvent.click(screen.getByRole('tab', { name: 'Pontualidade' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('extrato de pontualidade'));
  });
});
