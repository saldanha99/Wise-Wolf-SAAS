import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TeacherSupportCenter from './TeacherSupportCenter';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock('../lib/supabase', () => ({
  supabase: { rpc },
}));

beforeEach(() => {
  rpc.mockReset();
  rpc.mockImplementation((name: string) => {
    if (name === 'teacher_support_contacts') {
      return Promise.resolve({
        data: {
          school_name: 'Wise Wolf',
          school_whatsapp: '5512996405414',
          coordinator_name: 'Débora Alves Fernandes',
          coordinator_whatsapp: '11971681451',
        },
        error: null,
      });
    }
    throw new Error(`RPC inesperada: ${name}`);
  });
});

describe('<TeacherSupportCenter />', () => {
  it('abre, lista os guias e o atalho de ausência aponta para o WhatsApp da escola com a mensagem que o bot entende', async () => {
    render(<TeacherSupportCenter onNavigate={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /ajuda do professor/i }));
    expect(screen.getByRole('dialog', { name: /central de ajuda/i })).toBeTruthy();
    expect(screen.getByText('Não vou conseguir dar aula (hoje ou em outro dia)')).toBeTruthy();

    await waitFor(() => {
      const absence = screen.getByText('Não vou dar aula').closest('a');
      expect(absence?.getAttribute('href')).toBe(
        'https://wa.me/5512996405414?text=N%C3%A3o%20vou%20conseguir%20dar%20aula%20hoje',
      );
    });
    const coordination = screen.getByText('Débora').closest('a');
    expect(coordination?.getAttribute('href')).toBe('https://wa.me/5511971681451');
  });

  it('a busca filtra os guias e um guia aberto navega para a tela certa', async () => {
    const onNavigate = vi.fn();
    render(<TeacherSupportCenter onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole('button', { name: /ajuda do professor/i }));
    fireEvent.change(screen.getByPlaceholderText(/buscar/i), { target: { value: 'pix' } });
    expect(screen.queryByText('Aula experimental: do aceite ao fechamento')).toBeNull();
    // Com um único resultado o guia já vem aberto, com o botão da tela.
    fireEvent.click(screen.getByRole('button', { name: 'Abrir Financeiro' }));
    expect(onNavigate).toHaveBeenCalledWith('teacher-financials');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('o atalho "Planejar aula" leva ao Planner IA', () => {
    const onNavigate = vi.fn();
    render(<TeacherSupportCenter onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole('button', { name: /ajuda do professor/i }));
    fireEvent.click(screen.getByText('Planejar aula'));
    expect(onNavigate).toHaveBeenCalledWith('lesson-planner-ai');
  });
});
