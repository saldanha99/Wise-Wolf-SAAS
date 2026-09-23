import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DirectTeacherTransferModal from './DirectTeacherTransferModal';
import { UserRole } from '../types';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));

const teacher = (id: string, name: string) => ({
  id, name, email: '', role: UserRole.TEACHER, avatar: '', module: '', modules: [],
  specializations: [], hourlyRate: 0, pixKey: '', phone: '', studentsCount: 0,
  classesCount: 0, retention: '', tpi: 0, status: 'Ativo' as const, occupancy: 0,
});

describe('transferência definitiva de professor', () => {
  beforeEach(() => {
    rpc.mockReset();
    rpc.mockResolvedValue({ data: { ok: true, to_teacher_name: 'Bruna', bookings_changed: 2 }, error: null });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('transfere o vínculo e toda a agenda em uma única RPC administrativa', async () => {
    const onTransferred = vi.fn();
    render(<DirectTeacherTransferModal
      student={{ id: 'theo', full_name: 'Theo Levi', professor_id: 'flavio' }}
      teachers={[teacher('flavio', 'Flávio'), teacher('bruna', 'Bruna')]}
      currentSchedules={[{ day_of_week: 'Quarta', time_slot: '09:30' }, { day_of_week: 'Sexta', time_slot: '09:30' }]}
      onClose={vi.fn()}
      onTransferred={onTransferred}
    />);

    fireEvent.change(screen.getByRole('combobox', { name: 'Novo professor' }), { target: { value: 'bruna' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Motivo da transferência' }), { target: { value: 'Ajuste definitivo solicitado pela gestão.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Transferir agora' }));

    await waitFor(() => expect(rpc).toHaveBeenCalledWith('admin_transfer_student_teacher', {
      p_student_id: 'theo',
      p_to_teacher: 'bruna',
      p_reason: 'Ajuste definitivo solicitado pela gestão.',
    }));
    expect(await screen.findByRole('status')).toHaveTextContent('agora é aluno(a) de Bruna');
    expect(onTransferred).toHaveBeenCalledWith('bruna');
  });

  it('explica conflito de disponibilidade sem concluir a troca', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'O professor de destino não está disponível em todos os horários atuais do aluno.' } });
    render(<DirectTeacherTransferModal
      student={{ id: 'theo', full_name: 'Theo Levi', professor_id: 'flavio' }}
      teachers={[teacher('bruna', 'Bruna')]}
      currentSchedules={[{ day_of_week: 'Quarta', time_slot: '09:30' }]}
      onClose={vi.fn()}
      onTransferred={vi.fn()}
    />);

    fireEvent.change(screen.getByRole('combobox', { name: 'Novo professor' }), { target: { value: 'bruna' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Motivo da transferência' }), { target: { value: 'Ajuste definitivo solicitado pela gestão.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Transferir agora' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('não está disponível em todos os horários');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
