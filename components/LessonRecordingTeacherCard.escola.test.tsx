import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LessonRecordingTeacherCard from './LessonRecordingTeacherCard';

// Cartão do professor com o registro AUTORIZADO PELA ESCOLA (migration
// 20260929100000): sem "Li e autorizo" — mostra que a escola registra, pede só a
// conta Google e oferece "Não quero que minhas aulas sejam registradas".

const { rpc, googleMeetAction } = vi.hoisted(() => ({ rpc: vi.fn(), googleMeetAction: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));
vi.mock('../lib/googleMeet', () => ({ googleMeetAction }));

const notice = {
  applies: true,
  authorization_mode: 'SCHOOL_DEFAULT',
  decision: 'NONE',
  decided_at: null,
  effective: true,
  objected: false,
  term_version: 'v4',
  term_kind: 'NOTICE',
  term_body: 'Aviso sobre o registro das suas aulas. Você pode pedir para não ser registrado.',
};
let myConsent: Record<string, unknown> = notice;
let identity: { data: unknown; error: unknown } = { data: null, error: null };

beforeEach(() => {
  myConsent = notice;
  identity = { data: null, error: null };
  rpc.mockReset();
  googleMeetAction.mockReset();
  rpc.mockImplementation((name: string) => {
    if (name === 'get_my_lesson_recording_consent') return Promise.resolve({ data: myConsent, error: null });
    if (name === 'get_my_google_identity') return Promise.resolve(identity);
    return Promise.resolve({ data: { ok: true, decision: 'REFUSED', term_version: 'v4' }, error: null });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<LessonRecordingTeacherCard /> — registro autorizado pela escola', () => {
  it('não pede "Li e autorizo": pede a conta Google e oferece o pedido para não registrar', async () => {
    render(<LessonRecordingTeacherCard />);

    expect(await screen.findByText(/A escola registra as aulas/)).toBeInTheDocument();
    expect(screen.getByText(/a sala da escola só nasce para as suas aulas depois disso/)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Confirmar conta Google' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /li e autorizo/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /ler e responder/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Ler o aviso' }));
    expect(screen.getByText(/Aviso sobre o registro das suas aulas/)).toBeInTheDocument();
    expect(screen.getByText(/Aviso v4\. Nada disso muda o seu pagamento/)).toBeInTheDocument();
  });

  it('"Não quero" pede confirmação e grava o pedido com a versão do aviso', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<LessonRecordingTeacherCard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Não quero que minhas aulas sejam registradas' }));
    expect(confirm).toHaveBeenCalled();
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('set_my_lesson_recording_consent', { p_accept: false, p_term_version: 'v4' }));
  });

  it('desistir na confirmação não grava nada', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<LessonRecordingTeacherCard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Não quero que minhas aulas sejam registradas' }));
    expect(rpc).not.toHaveBeenCalledWith('set_my_lesson_recording_consent', expect.anything());
  });

  it('quem pediu para não registrar vê o pedido e pode voltar atrás', async () => {
    myConsent = { ...notice, decision: 'REFUSED', decided_at: '2026-09-29T15:00:00Z', effective: false, objected: true };
    render(<LessonRecordingTeacherCard />);
    expect(await screen.findByText(/Você pediu para não registrar as suas aulas em 29\/09\/2026/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirmar conta Google' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Voltar a registrar minhas aulas' }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('set_my_lesson_recording_consent', { p_accept: true, p_term_version: 'v4' }));
  });

  it('com a conta confirmada diz que as aulas ganham a sala da escola', async () => {
    identity = { data: { email: 'professora@gmail.com', verified_at: '2026-09-26T15:00:00Z' }, error: null };
    render(<LessonRecordingTeacherCard />);
    expect(await screen.findByText(/sua conta Google está confirmada: suas aulas ganham a sala da escola/)).toBeInTheDocument();
    expect(screen.getByText('professora@gmail.com')).toBeInTheDocument();
  });
});
