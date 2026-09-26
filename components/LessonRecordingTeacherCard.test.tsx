import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LessonRecordingTeacherCard from './LessonRecordingTeacherCard';

const { rpc, googleMeetAction } = vi.hoisted(() => ({ rpc: vi.fn(), googleMeetAction: vi.fn() }));

vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));
vi.mock('../lib/googleMeet', () => ({ googleMeetAction }));

const consent = { applies: true, decision: 'NONE', decided_at: null, term_version: 'v2', term_body: 'Termo do professor.' };

function mockRpc(identity: { data: unknown; error: unknown }) {
  rpc.mockImplementation((name: string) => {
    if (name === 'get_my_lesson_recording_consent') return Promise.resolve({ data: consent, error: null });
    if (name === 'get_my_google_identity') return Promise.resolve(identity);
    return Promise.resolve({ data: { ok: true, decision: 'ACCEPTED' }, error: null });
  });
}

beforeEach(() => {
  rpc.mockReset();
  googleMeetAction.mockReset();
});

describe('<LessonRecordingTeacherCard />', () => {
  it('sem conta Google confirmada o aceite fica desligado, e o login abre em outra aba', async () => {
    mockRpc({ data: null, error: null });
    googleMeetAction.mockResolvedValueOnce({ authorization_url: 'https://accounts.google.com/o/oauth2/auth?fixture=1' });
    render(<LessonRecordingTeacherCard />);

    fireEvent.click(await screen.findByRole('button', { name: 'Ler e responder' }));
    expect(screen.getByRole('button', { name: /li e autorizo/i })).toBeDisabled();
    expect(screen.getByText(/fica disponível depois que você confirmar a conta Google/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Confirmar conta Google' }));
    const link = await screen.findByRole('link', { name: /entrar com o google/i });
    expect(googleMeetAction).toHaveBeenCalledWith('teacher_identity_connect');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('href', 'https://accounts.google.com/o/oauth2/auth?fixture=1');
  });

  it('com a conta confirmada, autoriza', async () => {
    mockRpc({ data: { email: 'professora@gmail.com', verified_at: '2026-09-26T15:00:00Z' }, error: null });
    render(<LessonRecordingTeacherCard />);

    expect(await screen.findByText('professora@gmail.com')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Ler e responder' }));
    const accept = screen.getByRole('button', { name: /li e autorizo/i });
    expect(accept).toBeEnabled();
    fireEvent.click(accept);
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('set_my_lesson_recording_consent', { p_accept: true }));
  });

  it('rota de identidade ainda não publicada: avisa sem quebrar e não deixa autorizar', async () => {
    mockRpc({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.get_my_google_identity without parameters' } });
    render(<LessonRecordingTeacherCard />);

    expect(await screen.findByText(/Confirmação de conta Google indisponível/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Ler e responder' }));
    expect(screen.getByRole('button', { name: /li e autorizo/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /não autorizo/i })).toBeEnabled();
  });

  it('servidor exige a identidade: mostra o motivo', async () => {
    mockRpc({ data: { email: 'professora@gmail.com', verified_at: '2026-09-26T15:00:00Z' }, error: null });
    render(<LessonRecordingTeacherCard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Ler e responder' }));

    rpc.mockImplementation((name: string) => {
      if (name === 'set_my_lesson_recording_consent') {
        return Promise.resolve({ data: null, error: { code: 'P0001', message: 'teacher_google_identity_required' } });
      }
      if (name === 'get_my_google_identity') return Promise.resolve({ data: null, error: null });
      return Promise.resolve({ data: consent, error: null });
    });
    fireEvent.click(screen.getByRole('button', { name: /li e autorizo/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Confirme sua conta Google');
  });
});
