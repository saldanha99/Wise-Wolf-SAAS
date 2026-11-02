import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import TeacherHistoryAccess from './TeacherHistoryAccess';
const mocks = vi.hoisted(() => ({ getSession: vi.fn(), signIn: vi.fn(), signOut: vi.fn(), unsubscribe: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { auth: { getSession: mocks.getSession, signInWithPassword: mocks.signIn, signOut: mocks.signOut, onAuthStateChange: () => ({ data: { subscription: { unsubscribe: mocks.unsubscribe } } }) } } }));
vi.mock('./LessonHistoryPanel', () => ({ default: ({ user }: { user: { id: string } }) => <p>Extrato próprio: {user.id}</p> }));
afterEach(cleanup);
beforeEach(() => { vi.clearAllMocks(); mocks.getSession.mockResolvedValue({ data: { session: null }, error: null }); mocks.signIn.mockResolvedValue({ data: { user: { id: 'retired-teacher' } }, error: null }); mocks.signOut.mockResolvedValue({ error: null }); });
describe('acesso à prestação após encerramento', () => {
 it('abre extrato da sessão autenticada sem restaurar permissões operacionais', async () => { mocks.getSession.mockResolvedValue({ data: { session: { user: { id: 'retired-teacher' } } }, error: null }); render(<TeacherHistoryAccess />); expect(await screen.findByText('Extrato próprio: retired-teacher')).toBeTruthy(); expect(screen.queryByLabelText('Senha')).toBeNull(); });
 it('permite entrar diretamente para a consulta e limpa a senha do formulário', async () => { render(<TeacherHistoryAccess />); const email = await screen.findByLabelText('E-mail'); fireEvent.change(email, { target: { value: 'test@example.invalid' } }); fireEvent.change(screen.getByLabelText('Senha'), { target: { value: 'fixture-only' } }); fireEvent.click(screen.getByText('Consultar meu histórico')); expect(await screen.findByText('Extrato próprio: retired-teacher')).toBeTruthy(); expect(mocks.signIn).toHaveBeenCalledWith({ email: 'test@example.invalid', password: 'fixture-only' }); });
 it('logout remove a consulta e volta para o formulário', async () => { mocks.getSession.mockResolvedValue({ data: { session: { user: { id: 'retired-teacher' } } }, error: null }); render(<TeacherHistoryAccess />); fireEvent.click(await screen.findByText('Sair da conta')); await waitFor(() => expect(screen.queryByText('Extrato próprio: retired-teacher')).toBeNull()); expect(screen.getByLabelText('E-mail')).toBeTruthy(); });
});
