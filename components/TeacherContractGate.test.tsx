import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TeacherContractGate from './TeacherContractGate';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));
vi.mock('./TeacherContractAccept', () => ({
  default: ({ mandatory, onLogout }: { mandatory?: boolean; onLogout?: () => void }) =>
    <div data-testid="contract-accept" data-mandatory={String(mandatory)}><button onClick={onLogout}>Sair da conta</button></div>,
}));

beforeEach(() => {
  rpc.mockReset();
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});

describe('contrato obrigatório do professor novo', () => {
  it('não aparece para quem não precisa', async () => {
    rpc.mockResolvedValue({ data: { required: false }, error: null });
    const active = vi.fn();
    render(<TeacherContractGate userId="u" blocked={false} onActiveChange={active} onLogout={vi.fn()} />);
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('my_teacher_contract_gate'));
    expect(active).toHaveBeenLastCalledWith(false);
    expect(screen.queryByTestId('contract-accept')).not.toBeInTheDocument();
  });

  it('falha de leitura não prende ninguém', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'x' } });
    const active = vi.fn();
    render(<TeacherContractGate userId="u" blocked={false} onActiveChange={active} onLogout={vi.fn()} />);
    await waitFor(() => expect(rpc).toHaveBeenCalled());
    expect(active).toHaveBeenLastCalledWith(false);
  });

  it('pede os dados pessoais, sem fechar, e depois abre o contrato obrigatório (caso Teacher Daniel)', async () => {
    rpc.mockImplementation(async (name: string) => name === 'my_teacher_contract_gate'
      ? { data: { required: true, missing: ['cpf', 'rg', 'birth_date', 'address'] }, error: null }
      : { data: { ok: true }, error: null });
    const active = vi.fn();
    render(<TeacherContractGate userId="u" blocked={false} onActiveChange={active} onLogout={vi.fn()} />);
    const dialog = await screen.findByRole('dialog');
    expect(active).toHaveBeenLastCalledWith(true);
    const cancel = new Event('cancel', { cancelable: true });
    dialog.dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect(screen.getByText(/Sou autônomo, sem CNPJ/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('CPF'), { target: { value: '52998224725' } });
    fireEvent.change(screen.getByLabelText('RG'), { target: { value: '123456789' } });
    fireEvent.change(screen.getByLabelText('Data de nascimento'), { target: { value: '2004-05-10' } });
    fireEvent.change(screen.getByLabelText(/Endereço completo/), { target: { value: 'Rua A, 10, Centro, Recife, PE' } });
    rpc.mockImplementation(async (name: string) => name === 'my_teacher_contract_gate'
      ? { data: { required: true, missing: [] }, error: null }
      : { data: { ok: true }, error: null });
    fireEvent.click(screen.getByRole('button', { name: /Continuar para o contrato/ }));

    const accept = await screen.findByTestId('contract-accept');
    expect(accept).toHaveAttribute('data-mandatory', 'true');
    expect(rpc).toHaveBeenCalledWith('save_my_teacher_contract_identity', {
      p_cpf: '52998224725', p_rg: '123456789', p_birth_date: '2004-05-10', p_address: 'Rua A, 10, Centro, Recife, PE',
    });
    expect(active).toHaveBeenLastCalledWith(true);
  });

  it('espera a conexão do Google antes de abrir', async () => {
    rpc.mockResolvedValue({ data: { required: true, missing: [] }, error: null });
    const active = vi.fn();
    render(<TeacherContractGate userId="u" blocked onActiveChange={active} onLogout={vi.fn()} />);
    await waitFor(() => expect(rpc).toHaveBeenCalled());
    expect(screen.queryByTestId('contract-accept')).not.toBeInTheDocument();
    expect(active).toHaveBeenLastCalledWith(false);
  });

  it('mostra o erro do servidor e continua no pop-up', async () => {
    rpc.mockImplementation(async (name: string) => name === 'my_teacher_contract_gate'
      ? { data: { required: true, missing: ['cpf'] }, error: null }
      : { data: { ok: false, error: 'cpf_invalido' }, error: null });
    render(<TeacherContractGate userId="u" blocked={false} onActiveChange={vi.fn()} onLogout={vi.fn()} />);
    await screen.findByRole('dialog');
    fireEvent.change(screen.getByLabelText('CPF'), { target: { value: '111' } });
    fireEvent.change(screen.getByLabelText('RG'), { target: { value: '123' } });
    fireEvent.change(screen.getByLabelText('Data de nascimento'), { target: { value: '2004-05-10' } });
    fireEvent.change(screen.getByLabelText(/Endereço completo/), { target: { value: 'Rua A, 10' } });
    fireEvent.click(screen.getByRole('button', { name: /Continuar para o contrato/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Confira o CPF.');
  });
});
