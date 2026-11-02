import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('../lib/googleMeet', () => ({ googleMeetAction: invoke }));
const rpc = vi.hoisted(() => vi.fn(() => Promise.resolve({ data: null, error: { message: 'fixture' } })));
vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));

import LessonPedagogicalSummary from './LessonPedagogicalSummary';

beforeEach(() => invoke.mockReset());

// O que o servidor devolve a quem lê "Sala e resumo" (migration 20260928100000).
const detail = (temporary: boolean) => ({
  session: { documentation_consent: true },
  raw_access: false,
  temporary_access: temporary,
  room: null,
  imports: [],
  attendance_saved_reports: 0,
  enabled: true,
  summary_ai_enabled: false,
  artifacts: [],
  summaries: [],
});

describe('"Sala e resumo" aberto pela janela do substituto', () => {
  it('não oferece criar nem entrar na sala da aula de outro professor; explica o acesso', async () => {
    invoke.mockResolvedValue(detail(true));
    render(<LessonPedagogicalSummary sessionId="aula-do-titular" tenantId="escola" />);
    await screen.findByTestId('temporary-access');
    expect(screen.getByTestId('temporary-access').textContent).toMatch(/cobertura ou reposição/);
    expect(screen.queryByRole('button', { name: /sala oficial/ })).toBeNull();
    expect(screen.queryByText('Entrar na sala oficial')).toBeNull();
    expect(screen.queryByText(/ainda não foi autorizada pela escola/)).toBeNull();
    expect(invoke.mock.calls.map(([action]) => action)).toEqual(['session_detail']);
  });

  it('quem acompanha o aluno (sem a janela) continua vendo a tela de sempre', async () => {
    invoke.mockResolvedValue(detail(false));
    render(<LessonPedagogicalSummary sessionId="aula" tenantId="escola" />);
    await screen.findByRole('button', { name: 'Criar sala oficial com coanfitrião' });
    expect(screen.queryByTestId('temporary-access')).toBeNull();
  });
});
