import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserRole } from '../../types';
import { buildMenuItems } from '../../lib/navModel';
import { ShortcutRail } from './ShortcutRail';

const items = buildMenuItems(UserRole.TEACHER, { pendingLessonsCount: 3 });
const KEY = 'wisewolf.shortcuts.u1';

const mount = (onChangeView = vi.fn()) => {
  render(
    <ShortcutRail userId="u1" role={UserRole.TEACHER} items={items} currentView="schedule" onChangeView={onChangeView} pendingCounts={{}} />,
  );
  return onChangeView;
};

beforeEach(() => localStorage.clear());

describe('<ShortcutRail />', () => {
  it('sem preferência salva mostra os atalhos padrão do professor e navega ao clicar', () => {
    const onChangeView = mount();
    const rail = screen.getByRole('complementary', { name: 'Atalhos' });
    expect(within(rail).getByRole('button', { name: 'Início' })).toBeInTheDocument();
    expect(within(rail).getByRole('button', { name: 'Agenda' })).toHaveAttribute('aria-current', 'page');
    // O badge do item entra no nome acessível do ladrilho.
    expect(within(rail).getByRole('button', { name: 'Pendentes, 3 pendências' })).toBeInTheDocument();

    fireEvent.click(within(rail).getByRole('button', { name: 'Lançar Aula' }));
    expect(onChangeView).toHaveBeenCalledWith('lessons');
  });

  it('o "+" abre o seletor; marcar e desmarcar persiste por usuário', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Escolher atalhos' }));
    const picker = screen.getByRole('group', { name: 'Atalhos do trilho' });

    const materiais = within(picker).getByRole('checkbox', { name: /Materiais/ });
    expect(materiais).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(materiais);
    expect(materiais).toHaveAttribute('aria-checked', 'true');
    expect(JSON.parse(localStorage.getItem(KEY) ?? '[]')).toContain('pedagogical');

    fireEvent.click(within(picker).getByRole('checkbox', { name: /Início/ }));
    expect(JSON.parse(localStorage.getItem(KEY) ?? '[]')).not.toContain('dashboard');
  });

  it('o "×" remove o atalho e a preferência salva é respeitada ao montar', () => {
    localStorage.setItem(KEY, JSON.stringify(['schedule', 'students', 'id-que-nao-existe']));
    mount();
    const rail = screen.getByRole('complementary', { name: 'Atalhos' });
    expect(within(rail).queryByRole('button', { name: 'Início' })).not.toBeInTheDocument();

    fireEvent.click(within(rail).getByRole('button', { name: 'Remover atalho Alunos' }));
    expect(within(rail).queryByRole('button', { name: 'Alunos' })).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(KEY) ?? '[]')).toEqual(['schedule']);
  });
});
