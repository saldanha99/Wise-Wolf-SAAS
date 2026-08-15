import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserRole, type Teacher } from '../types';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock('../lib/supabase', () => ({
  supabase: {
    rpc,
    from: vi.fn(),
    functions: { invoke: vi.fn() },
  },
}));

import TeacherManagement from './TeacherManagement';

const teacher = (
  id: string,
  name: string,
  lifecycle_status?: Teacher['lifecycle_status'],
): Teacher => ({
  id,
  name,
  email: `${id}@example.test`,
  role: UserRole.TEACHER,
  avatar: 'https://example.test/avatar.png',
  module: 'Inglês Geral',
  modules: ['Inglês Geral'],
  specializations: [],
  hourlyRate: 8,
  pixKey: '',
  phone: '',
  studentsCount: 0,
  classesCount: 0,
  retention: '100%',
  tpi: 100,
  status: lifecycle_status === 'suspended' ? 'Inativo' : 'Ativo',
  lifecycle_status,
  occupancy: 0,
});

describe('TeacherManagement', () => {
  beforeEach(() => {
    rpc.mockReset();
    rpc.mockImplementation((_name: string, params: { p_teacher: string }) =>
      Promise.resolve({
        data: {
          active: params.p_teacher === 'active',
          current_streak: params.p_teacher === 'active' ? 14 : 3,
        },
        error: null,
      }),
    );
  });

  it('abre apenas os lifecycle active e separa suspensos/desligados', async () => {
    render(
      <TeacherManagement
        teachers={[
          teacher('active', 'Professora Ativa', 'active'),
          teacher('suspended', 'Professor Suspenso', 'suspended'),
          teacher('offboarded', 'Professor Desligado', 'offboarded'),
        ]}
        onAddTeacher={vi.fn()}
      />,
    );

    expect(screen.getAllByText('Professora Ativa').length).toBeGreaterThan(0);
    expect(screen.queryByText('Professor Suspenso')).toBeNull();
    expect(screen.queryByText('Professor Desligado')).toBeNull();
    await screen.findAllByText('14 dias');

    fireEvent.click(screen.getByRole('tab', { name: /suspensos \/ desligados/i }));

    expect(screen.queryByText('Professora Ativa')).toBeNull();
    expect(screen.getAllByText('Professor Suspenso').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Professor Desligado').length).toBeGreaterThan(0);
  });

  it('usa o parâmetro e os campos canônicos da teacher_turbo_status', async () => {
    render(
      <TeacherManagement
        teachers={[teacher('active', 'Professora Ativa', 'active')]}
        onAddTeacher={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(rpc).toHaveBeenCalledWith('teacher_turbo_status', { p_teacher: 'active' });
    });
    expect((await screen.findAllByText('14 dias')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Ligado').length).toBeGreaterThan(0);
  });

  it('permite alternar as abas pelo teclado', async () => {
    render(
      <TeacherManagement
        teachers={[
          teacher('active', 'Professora Ativa', 'active'),
          teacher('suspended', 'Professor Suspenso', 'suspended'),
        ]}
        onAddTeacher={vi.fn()}
      />,
    );

    await screen.findAllByText('14 dias');
    const activeTab = screen.getByRole('tab', { name: /ativos \(1\)/i });
    const inactiveTab = screen.getByRole('tab', { name: /suspensos \/ desligados/i });
    activeTab.focus();
    fireEvent.keyDown(activeTab, { key: 'ArrowRight' });

    expect(inactiveTab).toHaveAttribute('aria-selected', 'true');
    expect(inactiveTab).toHaveFocus();
    expect(screen.getAllByText('Professor Suspenso').length).toBeGreaterThan(0);
  });

  it('mostra indisponível em vez de inventar zero/desligado quando a RPC falha', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    rpc.mockResolvedValue({ data: null, error: { message: 'falhou' } });
    render(
      <TeacherManagement
        teachers={[teacher('active', 'Professora Ativa', 'active')]}
        onAddTeacher={vi.fn()}
      />,
    );

    expect((await screen.findAllByText('Indisponível')).length).toBeGreaterThan(0);
    expect(screen.queryByText('0 dias')).toBeNull();
    expect(screen.queryByText('Desligado')).toBeNull();
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('Não foi possível carregar a organização'),
      expect.any(String),
    );
    warning.mockRestore();
  });
});
