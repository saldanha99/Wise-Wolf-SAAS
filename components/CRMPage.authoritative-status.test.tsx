import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CRMPage from './CRMPage';

const { from, rpc } = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock('../lib/supabase', () => ({
  supabase: { from, rpc },
}));

const lead = (status: 'NEW' | 'CONTACTED' | 'TRIAL' | 'WON' | 'LOST', id = `lead-${status}`) => ({
  id,
  name: status === 'WON' ? 'Aluno Matriculado' : 'Lead Novo',
  email: `${id}@example.invalid`,
  phone: '11987654321',
  status,
  source: 'Site',
  notes: null,
  created_at: '2026-08-29T12:00:00.000Z',
  student_id: status === 'WON' ? 'student-1' : null,
  value: 169,
  tags: [],
  last_status_change: '2026-08-29T12:00:00.000Z',
  level: null,
  goal: null,
});

type QueryResult = { data: unknown; error: unknown };

const useCrmBuilder = (
  loadResults: QueryResult[],
  updateResult: QueryResult = { data: null, error: null },
) => {
  const order = vi.fn();
  loadResults.forEach(result => order.mockResolvedValueOnce(result));

  const updateMaybeSingle = vi.fn().mockResolvedValue(updateResult);
  const updateSingle = vi.fn().mockResolvedValue(updateResult);
  const updateSelect = vi.fn(() => ({
    maybeSingle: updateMaybeSingle,
    single: updateSingle,
  }));
  const updateTenantEq = vi.fn(() => ({ select: updateSelect }));
  const updateIdEq = vi.fn(() => ({ eq: updateTenantEq }));
  const update = vi.fn((_payload: Record<string, unknown>) => ({ eq: updateIdEq }));

  const builder = {
    select: vi.fn(() => ({
      eq: vi.fn(() => ({ order })),
    })),
    update,
  };
  from.mockReturnValue(builder);

  return { order, update, updateMaybeSingle, updateSingle };
};

beforeEach(() => {
  from.mockReset();
  rpc.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<CRMPage /> — status autoritativo de matrícula', () => {
  it('não oferece Matriculados no formulário manual', async () => {
    useCrmBuilder([{ data: [lead('NEW')], error: null }]);
    render(<CRMPage tenantId="tenant-1" />);

    await screen.findByText('Lead Novo');
    fireEvent.click(screen.getByRole('button', { name: /nova oportunidade/i }));

    const statusSelect = screen.getByRole('combobox', { name: 'Etapa' });
    expect(within(statusSelect).queryByRole('option', { name: /Matriculados/i })).not.toBeInTheDocument();
    expect(within(statusSelect).getByRole('option', { name: /Aula Agendada/i })).toBeInTheDocument();
  });

  it('bloqueia arrastar um lead para Matriculados sem chamar o Supabase', async () => {
    const { update } = useCrmBuilder([{ data: [lead('NEW')], error: null }]);
    render(<CRMPage tenantId="tenant-1" />);

    const card = await screen.findByTestId('crm-card-lead-NEW');
    const wonColumn = screen.getByTestId('crm-column-WON');
    const dataTransfer = { effectAllowed: 'move', dropEffect: 'move' };

    fireEvent.dragStart(card, { dataTransfer });
    fireEvent.dragOver(wonColumn, { dataTransfer });
    fireEvent.drop(wonColumn, { dataTransfer });

    expect(await screen.findByRole('alert')).toHaveTextContent(/Matriculados é automática/i);
    expect(update).not.toHaveBeenCalled();
    expect(within(screen.getByTestId('crm-column-NEW')).getByText('Lead Novo')).toBeInTheDocument();
  });

  it('mantém matrícula reconciliada como somente leitura ao editar outros dados', async () => {
    const enrolled = lead('WON');
    const updated = { ...enrolled, name: 'Aluno Atualizado' };
    const { update } = useCrmBuilder(
      [{ data: [enrolled], error: null }],
      { data: updated, error: null },
    );
    render(<CRMPage tenantId="tenant-1" />);

    const card = await screen.findByTestId('crm-card-lead-WON');
    expect(card).toHaveAttribute('draggable', 'false');
    fireEvent.click(within(card).getByTitle('Editar lead'));

    expect(screen.getByText('Matriculado pelo fluxo de matrícula')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Etapa' })).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Nome completo'), { target: { value: 'Aluno Atualizado' } });
    fireEvent.click(screen.getByRole('button', { name: /^salvar$/i }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0][0]).not.toHaveProperty('status');
  });

  it('mostra erro de leitura com retry, em vez de um pipeline vazio', async () => {
    useCrmBuilder([
      { data: null, error: { message: 'indisponível' } },
      { data: [lead('NEW')], error: null },
    ]);
    render(<CRMPage tenantId="tenant-1" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Pipeline indisponível');
    expect(screen.queryByTestId('crm-column-NEW')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /tentar novamente/i }));
    expect(await screen.findByText('Lead Novo')).toBeInTheDocument();
  });

  it('mantém a etapa anterior e informa quando o update falha', async () => {
    const current = lead('NEW');
    const { update } = useCrmBuilder(
      [{ data: [current], error: null }],
      { data: null, error: { message: 'update negado' } },
    );
    render(<CRMPage tenantId="tenant-1" />);

    const card = await screen.findByTestId('crm-card-lead-NEW');
    const contactedColumn = screen.getByTestId('crm-column-CONTACTED');
    const dataTransfer = { effectAllowed: 'move', dropEffect: 'move' };

    fireEvent.dragStart(card, { dataTransfer });
    fireEvent.dragOver(contactedColumn, { dataTransfer });
    fireEvent.drop(contactedColumn, { dataTransfer });

    expect(await screen.findByRole('alert')).toHaveTextContent(/etapa anterior foi mantida/i);
    expect(update).toHaveBeenCalledTimes(1);
    expect(within(screen.getByTestId('crm-column-NEW')).getByText('Lead Novo')).toBeInTheDocument();
  });
});
