import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import StudentLessonRecords from './StudentLessonRecords';

// "Minhas aulas registradas" com o registro AUTORIZADO PELA ESCOLA (migration
// 20260929100000): o aviso, a situação e como pedir para não registrar.

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));

const response = (consent: Record<string, unknown>) => ({
  ok: true,
  authorization_mode: 'SCHOOL_DEFAULT',
  school_name: 'Escola Fixture',
  school_whatsapp: '11988887777',
  consent: { decided_at: null, signer_relation: null, requires_guardian: false, guardian_reason: null, link_expires_at: null, ...consent },
  term: { version: 'v4', body: 'Aviso sobre o registro das aulas.' },
  pending_review: 0,
  records: [],
});

beforeEach(() => {
  rpc.mockReset();
});

describe('<StudentLessonRecords /> — registro autorizado pela escola', () => {
  it('mostra o aviso e como pedir para não registrar, com a mensagem pronta', async () => {
    rpc.mockResolvedValueOnce({ data: response({ status: 'SCHOOL_AUTHORIZED' }), error: null });
    render(<StudentLessonRecords />);

    expect(await screen.findByText('Registro das aulas: Autorizado pela escola')).toBeInTheDocument();
    expect(screen.getByText(/faz parte das aulas da escola/)).toBeInTheDocument();
    expect(screen.getByText('Ler o aviso completo (versão v4)')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /Pedir para não registrar pelo WhatsApp/ });
    expect(link.getAttribute('href')).toContain('https://wa.me/5511988887777?text=');
    expect(decodeURIComponent(link.getAttribute('href') || '')).toContain('peço que as minhas aulas não sejam registradas');
    expect(screen.getByText(/peça para não registrar \(acima\)/)).toBeInTheDocument();
    expect(screen.queryByText(/revogue a autorização/)).not.toBeInTheDocument();
  });

  it('quem pediu vê o pedido e como voltar a registrar, sem o botão de pedir de novo', async () => {
    rpc.mockResolvedValueOnce({ data: response({ status: 'REVOKED', decided_at: '2026-09-29T15:00:00Z' }), error: null });
    render(<StudentLessonRecords />);
    expect(await screen.findByText('Registro das aulas: você pediu para não registrar')).toBeInTheDocument();
    expect(screen.getByText(/Existe o pedido para não registrar as suas aulas desde 29\/09\/2026/)).toBeInTheDocument();
    expect(screen.getByText(/Para voltar a ter as aulas registradas, fale com a escola/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Pedir para não registrar pelo WhatsApp/ })).not.toBeInTheDocument();
  });

  it('menor: o pedido pode vir do responsável', async () => {
    rpc.mockResolvedValueOnce({ data: response({ status: 'SCHOOL_AUTHORIZED', requires_guardian: true, guardian_reason: 'KIDS' }), error: null });
    render(<StudentLessonRecords />);
    expect(await screen.findByText(/o pedido pode vir do seu responsável/)).toBeInTheDocument();
  });
});
