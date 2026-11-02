import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../lib/supabase', () => ({ supabase: { rpc } }));

import LessonStartingSoon from './LessonStartingSoon';
import LiveLessonsBoard from './LiveLessonsBoard';

beforeAll(() => {
  // jsdom não implementa <dialog>.
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
afterEach(() => { cleanup(); rpc.mockReset(); window.localStorage.clear(); });

const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const lesson = (over: Record<string, unknown>) => ({
  kind: 'aula', id: 's1', class_date: '2026-11-02', starts_at: at(5), ends_at: at(35),
  teacher_id: 't1', teacher_name: 'Bruna Fixture', student_id: 'a1', student_name: 'Theo Fixture',
  link: 'https://meet.google.com/abc-defg-hij', link_kind: 'escola', ...over,
});

describe('aviso de 10 minutos', () => {
  it('mostra o link da sala da escola e não volta depois de fechado', async () => {
    rpc.mockResolvedValue({ data: { lessons: [lesson({})] }, error: null });
    render(<LessonStartingSoon userId="a1" role="STUDENT" />);
    const join = await screen.findByRole('link', { name: /Entrar na aula/ });
    expect(join.getAttribute('href')).toBe('https://meet.google.com/abc-defg-hij');
    expect(screen.getByText(/Aula com Bruna Fixture/)).toBeTruthy();
    expect(rpc).toHaveBeenCalledWith('my_lesson_links', expect.anything());

    fireEvent.click(screen.getByLabelText('Fechar aviso'));
    expect(screen.queryByRole('link', { name: /Entrar na aula/ })).toBeNull();
    cleanup();
    render(<LessonStartingSoon userId="a1" role="STUDENT" />);
    await new Promise(r => setTimeout(r, 20));
    expect(screen.queryByRole('link', { name: /Entrar na aula/ })).toBeNull();
  });

  it('sala sendo preparada não oferece outro link', async () => {
    rpc.mockResolvedValue({ data: { lessons: [lesson({ link: null, link_kind: 'preparando' })] }, error: null });
    render(<LessonStartingSoon userId="t1" role="TEACHER" />);
    expect(await screen.findByText(/está sendo preparada/)).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('aula daqui a uma hora não abre aviso', async () => {
    rpc.mockResolvedValue({ data: { lessons: [lesson({ starts_at: at(60), ends_at: at(90) })] }, error: null });
    render(<LessonStartingSoon userId="a1" role="STUDENT" />);
    await new Promise(r => setTimeout(r, 20));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('Ao vivo da direção', () => {
  it('separa o que está acontecendo e entra pela conta central', async () => {
    rpc.mockResolvedValue({
      data: {
        organizer_email: 'escola@gmail.com',
        lessons: [
          lesson({ id: 'now', starts_at: at(-5), ends_at: at(25) }),
          lesson({ id: 'later', starts_at: at(120), ends_at: at(150), teacher_name: 'Mateus Fixture',
            link: 'https://meet.google.com/pes-soal-xyz', link_kind: 'pessoal' }),
        ],
      },
      error: null,
    });
    render(<LiveLessonsBoard />);
    const join = await screen.findByRole('link', { name: /Entrar agora/ });
    expect(join.getAttribute('href')).toBe('https://meet.google.com/abc-defg-hij?authuser=escola%40gmail.com');
    const open = screen.getByRole('link', { name: /Abrir sala/ });
    expect(open.getAttribute('href')).toBe('https://meet.google.com/pes-soal-xyz');
    expect(screen.getByText('Acontecendo agora · 1')).toBeTruthy();
    expect(screen.getByText('Mais tarde hoje · 1')).toBeTruthy();
  });
});
