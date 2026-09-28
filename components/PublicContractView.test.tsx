import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import PublicContractView from './PublicContractView';
const { teacherContract } = vi.hoisted(() => ({ teacherContract: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { auth: { getUser: async () => ({ data: { user: { id: 'teacher' } } }) } } }));
vi.mock('../services/tenantLegalAssetsService', () => ({ tenantLegalAssetsService: { teacherContract } }));
vi.mock('./TeacherContractDocument', () => ({ getTeacherContractReadiness: () => ({ isReady: true }), TeacherContractDocument: () => <div>Cópia arquivada</div> }));
vi.mock('./TeacherContractAccept', () => ({ default: ({ onAccepted }: { onAccepted: () => void }) => <button onClick={onAccepted}>Confirmar assinatura fixture</button> }));
beforeEach(() => teacherContract.mockReset());
it('oferece assinatura e carrega a cópia real após aceitar', async () => {
  teacherContract.mockResolvedValueOnce({ archiveStatus: 'MISSING', full_name: 'Professora', contractAccepted: false, canSign: true }).mockResolvedValueOnce({ full_name: 'Professora', contract_accepted: true });
  render(<PublicContractView id="teacher" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Revisar e assinar contrato' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar assinatura fixture' }));
  expect((await screen.findAllByText('Cópia arquivada')).length).toBe(2);
  expect(teacherContract).toHaveBeenCalledTimes(2);
});
it('aceite legado sem arquivo não inventa cópia nem pede nova assinatura', async () => {
  teacherContract.mockResolvedValue({ archiveStatus: 'MISSING', full_name: 'Professora', contractAccepted: true, canSign: false });
  render(<PublicContractView id="teacher" />);
  expect(await screen.findByText('Cópia do contrato ainda não disponível')).toBeInTheDocument();
  expect(screen.queryByText('Cópia arquivada')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Revisar e assinar contrato' })).not.toBeInTheDocument();
});
