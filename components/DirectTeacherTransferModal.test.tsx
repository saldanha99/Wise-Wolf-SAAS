import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DirectTeacherTransferModal from './DirectTeacherTransferModal';
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));
const oldSlots = [{ day_of_week: 'Sexta', time_slot: '19:00' }, { day_of_week: 'Sexta', time_slot: '19:30' }, { day_of_week: 'Sexta', time_slot: '20:00' }];
const newSlots = ['Segunda', 'Terça', 'Quinta'].map(day_of_week => ({ day_of_week, time_slot: '18:30' }));
const renderModal = (callback = vi.fn()) => render(<DirectTeacherTransferModal student={{ id: 'vini', full_name: 'Vinícius', professor_id: 'flavio' }} teachers={[]} currentSchedules={oldSlots} onClose={vi.fn()} onTransferred={callback} />);
const choose = async (mode: string) => {
  await waitFor(() => expect(screen.queryByText('Conferindo disponibilidade...')).not.toBeInTheDocument());
  fireEvent.change(screen.getByLabelText('Modo dos horários'), { target: { value: mode } });
  fireEvent.change(screen.getByLabelText('Novo professor'), { target: { value: 'mateus' } });
  fireEvent.change(screen.getByLabelText('Motivo da transferência'), { target: { value: 'Teacher anterior deixou a escola.' } });
};
describe('transferência definitiva com vigência e disponibilidade', () => {
  beforeEach(() => {
    rpc.mockReset();
    rpc.mockImplementation((name: string) => Promise.resolve(name === 'get_student_transfer_options'
      ? { data: { ok: true, teachers: [{ id: 'mateus', name: 'Mateus', slots: [...oldSlots, ...newSlots] }] }, error: null }
      : { data: { ok: true, status: 'ACCEPTED', to_teacher_name: 'Mateus' }, error: null }));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });
  it('mantém horários, programa a vigência e não troca antecipadamente o vínculo', async () => {
    const callback = vi.fn(); renderModal(callback); await choose('KEEP');
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar transferência' }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('admin_schedule_student_transfer', expect.objectContaining({ p_student_id: 'vini', p_to_teacher: 'mateus', p_slots: oldSlots, p_request_id: expect.any(String), p_cutover: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) })));
    expect(await screen.findByRole('status')).toHaveTextContent('programada'); expect(callback).toHaveBeenCalledWith('flavio');
  });
  it('escolhe três novos horários e preserva a frequência', async () => {
    renderModal(); await choose('CHANGE');
    const submit = screen.getByRole('button', { name: 'Confirmar transferência' }); expect(submit).toBeDisabled();
    for (const slot of newSlots) fireEvent.click(screen.getByRole('button', { name: `${slot.day_of_week} ${slot.time_slot}` }));
    expect(submit).toBeEnabled(); expect(screen.getByRole('button', { name: 'Sexta 19:00' })).toBeDisabled(); fireEvent.click(submit);
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('admin_schedule_student_transfer', expect.objectContaining({ p_slots: newSlots })));
  });
  it('filtra professores que não conseguem manter os horários', async () => {
    rpc.mockResolvedValue({ data: { ok: true, teachers: [{ id: 'mateus', name: 'Mateus', slots: newSlots }] }, error: null });
    renderModal(); await waitFor(() => expect(screen.getByText(/Nenhum teacher livre/)).toBeInTheDocument());
    expect(screen.queryByRole('option', { name: 'Mateus' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Modo dos horários'), { target: { value: 'CHANGE' } }); expect(screen.getByRole('option', { name: 'Mateus' })).toBeInTheDocument();
  });
  it('não conclui quando outro agendamento ocupou a vaga', async () => {
    rpc.mockImplementation((name: string) => Promise.resolve(name === 'get_student_transfer_options' ? { data: { ok: true, teachers: [{ id: 'mateus', name: 'Mateus', slots: oldSlots }] }, error: null } : { data: null, error: { message: 'Um dos horários escolhidos não está mais disponível. Atualize a lista.' } }));
    const callback = vi.fn();renderModal(callback);await choose('KEEP');fireEvent.click(screen.getByRole('button', { name: 'Confirmar transferência' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('não está mais disponível'); expect(callback).not.toHaveBeenCalled();
  });
  it('falha fechada na consulta rejeitada', async () => {
    rpc.mockRejectedValue(new Error('rede')); renderModal(); expect(await screen.findByRole('alert')).toHaveTextContent('consultar a disponibilidade'); expect(screen.getByRole('button', { name: 'Confirmar transferência' })).toBeDisabled();
  });
  it('não anuncia nem aplica transferência pendente de assinaturas', async () => {
    const callback=vi.fn();renderModal(callback);await choose('KEEP');
    rpc.mockResolvedValueOnce({data:{ok:true,status:'PENDING',pending_terms:true},error:null});
    fireEvent.click(screen.getByRole('button',{name:'Confirmar transferência'}));
    expect(await screen.findByRole('status')).toHaveTextContent('A atribuição atual foi preservada');expect(callback).not.toHaveBeenCalled();
  });

});
