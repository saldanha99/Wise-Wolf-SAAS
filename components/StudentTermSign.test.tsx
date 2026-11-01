import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import StudentTermSign from './StudentTermSign';
import { termLinkReasonMessage } from '../lib/studentTermLink';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));

const TOKEN = 'a'.repeat(64);
const view = {
  ok: true, signer: 'TEACHER', signer_name: 'Maria Fixture', school_name: 'Escola Fixture Ltda',
  student_name: 'Ivone Fixture', teacher_name: 'Maria Fixture', agenda: 'Terça 19:00 (1h) · Quinta 19:00 (1h)',
  starts_on: '2026-11-03', ends_on: null, unit_rate: 8, needs_identity: false, other_signed: true,
  body: 'TERMO INDIVIDUAL\nModelo jurídico: 2', content_hash: 'h'.repeat(64), term_id: 't1', version: 1, expires_at: '2026-11-08T00:00:00Z',
};

beforeEach(() => {
  rpc.mockReset();
  window.history.pushState({}, '', `/aceitar-termo?t=${TOKEN}`);
});

describe('aceite do termo pelo link do WhatsApp', () => {
  it('mostra o aluno, a agenda e só o valor do professor', async () => {
    rpc.mockResolvedValueOnce({ data: view, error: null });
    render(<StudentTermSign />);
    expect(await screen.findByText('Ivone Fixture')).toBeTruthy();
    const summary = screen.getByTestId('term-summary').textContent || '';
    expect(summary).toContain('Terça 19:00 (1h)');
    expect(summary).toMatch(/R\$\s?8,00 a cada 30 minutos/);
    expect(summary).not.toMatch(/mensalidade/i);
    expect(summary).toContain('10 vezes');
  });

  it('só libera a assinatura com o nome do cadastro e o aceite marcado', async () => {
    rpc.mockResolvedValueOnce({ data: view, error: null }).mockResolvedValueOnce({ data: { ok: true, phase: 'FAMILY_PENDING' }, error: null });
    render(<StudentTermSign />);
    const button = await screen.findByRole('button', { name: /Aceitar aluno/i });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.change(screen.getByLabelText(/Assine digitando/i), { target: { value: 'Outra Pessoa' } });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Assine digitando/i), { target: { value: 'maria fixture' } });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByText('Assinado ✅')).toBeTruthy());
    expect(rpc).toHaveBeenLastCalledWith('student_term_link_act', {
      p_token: TOKEN, p_action: 'sign',
      p_payload: { typed_name: 'maria fixture', content_hash: view.content_hash, accepted: true, has_authority: true },
    });
  });

  it('pede os dados de prestador antes de assinar quando faltam', async () => {
    rpc.mockResolvedValueOnce({ data: { ...view, needs_identity: true }, error: null });
    render(<StudentTermSign />);
    expect(await screen.findByText(/seus dados de prestador/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Aceitar aluno/i })).toBeNull();
  });

  it('link usado, trocado ou inventado explica o motivo sem mostrar o termo', async () => {
    rpc.mockResolvedValueOnce({ data: { ok: false, reason: 'replaced' }, error: null });
    render(<StudentTermSign />);
    expect(await screen.findByText(termLinkReasonMessage('replaced'))).toBeTruthy();
    expect(screen.queryByText('Ivone Fixture')).toBeNull();
    window.history.pushState({}, '', '/aceitar-termo?t=curto');
    rpc.mockReset();
  });
});
