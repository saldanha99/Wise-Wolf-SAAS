import React from 'react';
import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TeacherInviteGenerator from './TeacherInviteGenerator';
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));
vi.mock('../lib/schoolInfo', () => ({ getSchoolInfo: vi.fn().mockResolvedValue({}) }));
vi.mock('./ContractDocument', () => ({ getSchoolContractIdentity: () => ({ isReady: true }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe('convite com valor por aula', () => {
  it.each([8, 12.5])('envia o valor %s integral, sem conversão por hora', async (rate) => {
    rpc.mockResolvedValue({ data: '00000000-0000-4000-8000-00000000ca81', error: null });
    render(<TeacherInviteGenerator tenantId="test-school" />);
    expect(screen.getByRole('spinbutton')).toHaveValue(8);
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: String(rate) } });
    fireEvent.change(screen.getByPlaceholderText('Ex: Inglês, Espanhol...'), { target: { value: 'Inglês' } });
    fireEvent.click(screen.getByRole('button', { name: /Gerar/i }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('create_invite_offer', {
      p_kind: 'TEACHER_INVITE', p_payload: { kind: 'TEACHER_INVITE', tenantId: 'test-school', hourlyRate: rate, subject: 'Inglês' },
    }));
  });
});
