import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LessonRecordingTeacherCard from './LessonRecordingTeacherCard';

const { rpc, googleMeetAction } = vi.hoisted(() => ({ rpc: vi.fn(), googleMeetAction: vi.fn() }));

vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));
vi.mock('../lib/googleMeet', () => ({ googleMeetAction }));

const consent = { applies: true, decision: 'NONE', decided_at: null, term_version: 'v2', term_body: 'Termo do professor.' };
let myConsent: Record<string, unknown> = consent;

function mockRpc(identity: { data: unknown; error: unknown }) {
  rpc.mockImplementation((name: string) => {
    if (name === 'get_my_lesson_recording_consent') return Promise.resolve({ data: myConsent, error: null });
    if (name === 'get_my_google_identity') return Promise.resolve(identity);
    return Promise.resolve({ data: { ok: true, decision: 'ACCEPTED' }, error: null });
  });
}

beforeEach(() => {
  myConsent = consent;
  rpc.mockReset();
  googleMeetAction.mockReset();
});

afterEach(() => vi.restoreAllMocks());

describe('<LessonRecordingTeacherCard />', () => {
  it('sem conta Google confirmada o aceite fica desligado, e o login abre em outra aba', async () => {
    const popup = { opener: window, closed: false, location: { href: '' }, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    mockRpc({ data: null, error: null });
    googleMeetAction.mockResolvedValueOnce({ authorization_url: 'https://accounts.google.com/o/oauth2/auth?fixture=1' });
    render(<LessonRecordingTeacherCard />);

    fireEvent.click(await screen.findByRole('button', { name: 'Ler e responder' }));
    expect(screen.getByRole('button', { name: /li e autorizo/i })).toBeDisabled();
    expect(screen.getByText(/fica disponível depois que você confirmar a conta Google/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Confirmar conta Google' }));
    expect(window.open).toHaveBeenCalledWith('about:blank', '_blank');
    await waitFor(() => expect(popup.location.href).toBe('https://accounts.google.com/o/oauth2/auth?fixture=1'));
    expect(popup.opener).toBeNull();
    expect(googleMeetAction).toHaveBeenCalledWith('teacher_identity_connect');
    expect(screen.queryByRole('link', { name: /entrar com o google/i })).not.toBeInTheDocument();
  });

  it('bloqueio de popup oferece botão visível e confere a conta ao voltar', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    mockRpc({ data: null, error: null });
    googleMeetAction.mockResolvedValue({ authorization_url: 'https://accounts.google.com/o/oauth2/auth?fixture=1' });
    render(<LessonRecordingTeacherCard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirmar conta Google' }));
    expect(await screen.findByRole('link', { name: /entrar com o google/i })).toHaveAttribute('href', 'https://accounts.google.com/o/oauth2/auth?fixture=1');
    expect(screen.getByText(/Seu navegador bloqueou a nova aba/)).toBeInTheDocument();
    mockRpc({ data: { email: 'confirmada@gmail.com', verified_at: '2026-09-27T23:00:00Z' }, error: null });
    fireEvent(window, new Event('focus'));
    expect(await screen.findByText('confirmada@gmail.com')).toBeInTheDocument();
  });

  it('com a conta confirmada, autoriza', async () => {
    mockRpc({ data: { email: 'professora@gmail.com', verified_at: '2026-09-26T15:00:00Z' }, error: null });
    render(<LessonRecordingTeacherCard />);

    expect(await screen.findByText('professora@gmail.com')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Ler e responder' }));
    const accept = screen.getByRole('button', { name: /li e autorizo/i });
    expect(accept).toBeEnabled();
    fireEvent.click(accept);
    // O aceite leva a versão do termo que está na tela.
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('set_my_lesson_recording_consent', { p_accept: true, p_term_version: 'v2' }));
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

  it('termo v3: aceite da versão anterior não vale — o cartão avisa e volta a oferecer o aceite, com a escola no texto', async () => {
    myConsent = {
      applies: true, decision: 'ACCEPTED', decided_at: '2026-09-26T15:00:00Z', decided_term_version: 'v2',
      effective: false, term_updated: true, term_version: 'v3',
      term_body: 'A escola: {escola_nome}, {escola_documento}. Contato para assuntos de privacidade: {escola_contato_privacidade}.',
      school_identity: {
        escola_nome: 'Escola Fixture Idiomas LTDA', escola_documento: 'CNPJ 11.222.333/0001-81',
        escola_contato_privacidade: 'privacidade@escola.invalid', missing: [],
      },
    };
    mockRpc({ data: { email: 'professora@gmail.com', verified_at: '2026-09-26T15:00:00Z' }, error: null });
    render(<LessonRecordingTeacherCard />);

    expect(await screen.findByText(/O termo mudou: você autorizou a versão v2 e a vigente é a v3/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Ler a nova versão' }));
    expect(screen.getByText('A escola: Escola Fixture Idiomas LTDA, CNPJ 11.222.333/0001-81. Contato para assuntos de privacidade: privacidade@escola.invalid.')).toBeInTheDocument();
    const accept = screen.getByRole('button', { name: /li e autorizo/i });
    expect(accept).toBeEnabled();
    expect(screen.getByRole('button', { name: /não autorizo/i })).toBeEnabled();
    fireEvent.click(accept);
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('set_my_lesson_recording_consent', { p_accept: true, p_term_version: 'v3' }));
  });

  it('texto aberto numa versão e a direção publica outra: o servidor recusa, o cartão mostra a versão nova e aceita com ela', async () => {
    mockRpc({ data: { email: 'professora@gmail.com', verified_at: '2026-09-26T15:00:00Z' }, error: null });
    render(<LessonRecordingTeacherCard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Ler e responder' }));
    expect(screen.getByText('Termo do professor.')).toBeInTheDocument();

    // Enquanto o texto v2 estava aberto, saiu a v3.
    myConsent = { ...consent, term_version: 'v3', term_body: 'Termo do professor, versão nova.' };
    rpc.mockImplementation((name: string) => {
      if (name === 'set_my_lesson_recording_consent') {
        return Promise.resolve({ data: null, error: { code: '22023', message: 'termo_mudou' } });
      }
      if (name === 'get_my_lesson_recording_consent') return Promise.resolve({ data: myConsent, error: null });
      return Promise.resolve({ data: { email: 'professora@gmail.com', verified_at: '2026-09-26T15:00:00Z' }, error: null });
    });
    fireEvent.click(screen.getByRole('button', { name: /li e autorizo/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('O termo mudou enquanto você lia');
    expect(rpc).toHaveBeenCalledWith('set_my_lesson_recording_consent', { p_accept: true, p_term_version: 'v2' });
    expect(await screen.findByText('Termo do professor, versão nova.')).toBeInTheDocument();

    mockRpc({ data: { email: 'professora@gmail.com', verified_at: '2026-09-26T15:00:00Z' }, error: null });
    fireEvent.click(screen.getByRole('button', { name: /li e autorizo/i }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('set_my_lesson_recording_consent', { p_accept: true, p_term_version: 'v3' }));
  });
});
