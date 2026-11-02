import { describe, expect, it } from 'vitest';
import { directorJoinUrl, lessonMoment, lessonToAnnounce, lessonKey, parseLessonLinks } from './lessonLinks';

const row = (over: Record<string, unknown> = {}) => ({
  kind: 'aula', id: 's1', class_date: '2026-11-02',
  starts_at: '2026-11-02T17:00:00Z', ends_at: '2026-11-02T17:30:00Z',
  teacher_id: 't1', teacher_name: 'Bruna', student_id: 'a1', student_name: 'Theo',
  link: 'https://meet.google.com/abc-defg-hij', link_kind: 'escola', ...over,
});

describe('parseLessonLinks', () => {
  it('lê, ordena e guarda a conta central', () => {
    const r = parseLessonLinks({ lessons: [row({ id: 's2', starts_at: '2026-11-02T18:00:00Z', ends_at: '2026-11-02T18:30:00Z' }), row()], organizer_email: 'escola@gmail.com' });
    expect(r.lessons.map(l => l.id)).toEqual(['s1', 's2']);
    expect(r.organizerEmail).toBe('escola@gmail.com');
  });

  it('sala preparando nunca carrega link, e link inválido vira "sem link"', () => {
    const r = parseLessonLinks({ lessons: [
      row({ id: 'p', link_kind: 'preparando', link: 'https://meet.google.com/x' }),
      row({ id: 'h', link_kind: 'pessoal', link: 'http://inseguro.test' }),
    ] });
    expect(r.lessons[0]).toMatchObject({ link: null, linkKind: 'preparando' });
    expect(r.lessons[1]).toMatchObject({ link: null, linkKind: 'sem_link' });
  });

  it('resposta estranha não quebra a tela', () => {
    expect(parseLessonLinks(null).lessons).toEqual([]);
    expect(parseLessonLinks({ lessons: [{ id: 'x' }] }).lessons).toEqual([]);
  });
});

describe('aviso de 10 minutos', () => {
  const [lesson] = parseLessonLinks({ lessons: [row()] }).lessons;
  const at = (iso: string) => new Date(iso);

  it('aparece de 10 min antes até 10 min depois do início', () => {
    expect(lessonToAnnounce([lesson], at('2026-11-02T16:49:00Z'), new Set())).toBeNull();
    expect(lessonToAnnounce([lesson], at('2026-11-02T16:50:00Z'), new Set())?.id).toBe('s1');
    expect(lessonToAnnounce([lesson], at('2026-11-02T17:09:00Z'), new Set())?.id).toBe('s1');
    expect(lessonToAnnounce([lesson], at('2026-11-02T17:10:00Z'), new Set())).toBeNull();
  });

  it('fechado não volta', () => {
    expect(lessonToAnnounce([lesson], at('2026-11-02T16:55:00Z'), new Set([lessonKey(lesson)]))).toBeNull();
  });

  it('momento da aula', () => {
    expect(lessonMoment(lesson, at('2026-11-02T16:00:00Z'))).toBe('depois');
    expect(lessonMoment(lesson, at('2026-11-02T16:55:00Z'))).toBe('em_breve');
    expect(lessonMoment(lesson, at('2026-11-02T17:05:00Z'))).toBe('agora');
    expect(lessonMoment(lesson, at('2026-11-02T17:30:00Z'))).toBe('encerrada');
  });
});

describe('entrada da direção', () => {
  it('sala da escola abre na conta central; link pessoal abre como está', () => {
    const r = parseLessonLinks({ lessons: [row(), row({ id: 'p', link_kind: 'pessoal', link: 'https://meet.google.com/pes-soal-xyz' })] });
    expect(directorJoinUrl(r.lessons[0], 'escola@gmail.com')).toBe('https://meet.google.com/abc-defg-hij?authuser=escola%40gmail.com');
    expect(directorJoinUrl(r.lessons[1], 'escola@gmail.com')).toBe('https://meet.google.com/pes-soal-xyz');
    expect(directorJoinUrl(r.lessons[0], null)).toBe('https://meet.google.com/abc-defg-hij');
  });
});
