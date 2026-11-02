import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));

import TeacherPunctualityCard from './TeacherPunctualityCard';

beforeEach(() => rpc.mockReset());

describe('Extrato de pontualidade no painel do professor', () => {
  it('desligado para a escola: o cartão não aparece', async () => {
    rpc.mockResolvedValue({ data: { ok: true, enabled: false }, error: null });
    const { container } = render(<TeacherPunctualityCard />);
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('get_my_punctuality_extract', expect.anything()));
    expect(container.innerHTML).toBe('');
  });

  it('erro na leitura também não mostra nada (nem número estimado)', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'somente_o_professor' } });
    const { container } = render(<TeacherPunctualityCard />);
    await waitFor(() => expect(rpc).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
  });

  it('ligado: o próprio extrato, aula a aula, sem ranking e sem mexer no pagamento', async () => {
    rpc.mockResolvedValue({
      data: {
        ok: true, enabled: true, month: '2026-09',
        summary: {
          planned: 1, in_school_room: 1, measured: 1, on_time: 1, late_5: 0, late_10: 0, not_in_report: 0,
          joined_after_end: 0, minutes_in_room: 29, scheduled_minutes: 30, left_early: 0,
          not_measured: { NOT_FOUND: 0, UNPARSED: 0, NO_CONFERENCE: 0, NO_ROOM: 0 },
        },
        lessons: [{ class_date: '2026-09-24', scheduled_start_at: '2026-09-24T13:00:00Z', scheduled_minutes: 30,
          first_join_at: '2026-09-24T13:01:00Z', late_minutes: 1, minutes_in_room: 29, left_early_minutes: 0, status: 'FOUND' }],
      },
      error: null,
    });
    render(<TeacherPunctualityCard />);
    await screen.findByText('Entrou às 10:01 (1 min depois do início) · 29 min na sala');
    expect(screen.getByText(/Meu extrato de pontualidade/)).toBeTruthy();
    expect(document.body.textContent).toContain('Sem nota, sem ranking e sem comparação entre professores. Não altera o pagamento.');
    expect(document.querySelector('[data-tour="teacher-punctuality"]')).not.toBeNull();
  });
});
