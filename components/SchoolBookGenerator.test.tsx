import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserRole, type User } from '../types';

const supabaseMocks = vi.hoisted(() => ({
  from: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock('../lib/supabase', () => ({
  supabase: {
    from: supabaseMocks.from,
    functions: { invoke: supabaseMocks.invoke },
  },
}));

import SchoolBookGenerator from './SchoolBookGenerator';

const schoolAdmin: User = {
  id: '11111111-1111-4111-8111-111111111111',
  tenantId: 'wise-wolf-school',
  name: 'Direção Wise Wolf',
  email: 'direcao@example.com',
  role: UserRole.SCHOOL_ADMIN,
};

const historyChain = (rows: unknown[]) => {
  const chain = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    order: vi.fn(() => chain),
    limit: vi.fn(async () => ({ data: rows, error: null })),
  };
  return chain;
};

describe('Gerador de livros da escola', () => {
  beforeEach(() => {
    supabaseMocks.from.mockReset();
    supabaseMocks.invoke.mockReset();
    supabaseMocks.from.mockImplementation(() => historyChain([]));
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('envia ao backend um livro B1 de 60 páginas e preserva o escopo da escola', async () => {
    supabaseMocks.invoke.mockResolvedValue({
      data: {
        job: {
          id: '22222222-2222-4222-8222-222222222222',
          status: 'GENERATING',
          title: 'Wise Wolf English B1',
          level_tag: 'B1',
          niche: 'GENERAL',
          audience: 'adults',
          book_language: 'bilingual',
          page_count: 60,
          gamma_url: null,
          material_id: null,
          error_code: null,
          provider_credits: {},
          created_at: '2026-09-25T00:00:00.000Z',
          completed_at: null,
        },
      },
      error: null,
    });

    render(
      <SchoolBookGenerator
        user={schoolAdmin}
        tenantId="wise-wolf-school"
        niches={[{ key: 'GENERAL', label: 'Geral' }]}
        onLibraryChanged={vi.fn(async () => {})}
      />,
    );

    expect(await screen.findByText('Nenhum livro gerado ainda.')).toBeTruthy();
    expect(screen.getByLabelText('Quantidade de páginas')).toHaveValue('60');
    fireEvent.click(screen.getByRole('button', { name: 'Gerar livro de 60 páginas' }));

    await waitFor(() => expect(supabaseMocks.invoke).toHaveBeenCalledTimes(1));
    const [functionName, options] = supabaseMocks.invoke.mock.calls[0];
    expect(functionName).toBe('gamma-book-generator');
    expect(options.body).toMatchObject({
      action: 'create',
      tenantId: 'wise-wolf-school',
      title: 'Wise Wolf English B1',
      level: 'B1',
      pageCount: 60,
      language: 'bilingual',
    });
    expect(options.body.requestKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(await screen.findByText(/B1 · 60 páginas · Diagramando o livro/)).toBeTruthy();
  });

  it('informa ao professor que o livro entra privado e sujeito a aprovação', async () => {
    render(
      <SchoolBookGenerator
        user={{ ...schoolAdmin, role: UserRole.TEACHER }}
        tenantId="wise-wolf-school"
        niches={[{ key: 'GENERAL', label: 'Geral' }]}
        onLibraryChanged={vi.fn(async () => {})}
      />,
    );

    expect(await screen.findByText(/ficam privados e aguardam aprovação da direção/)).toBeTruthy();
  });
});
