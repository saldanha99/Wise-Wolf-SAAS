import { describe, expect, it } from 'vitest';
import { lessonKey, lessonToSuggestPlan, type LessonLink } from './lessonLinks';

const now = new Date('2026-11-12T17:00:00Z');
const lesson = (minutesFromNow: number, extra: Partial<LessonLink> = {}): LessonLink => ({
  kind: 'aula', id: `b${minutesFromNow}`, classDate: '2026-11-12',
  startsAt: new Date(now.getTime() + minutesFromNow * 60_000),
  endsAt: new Date(now.getTime() + (minutesFromNow + 30) * 60_000),
  teacherId: 't', teacherName: 'Débora', studentId: 's', studentName: 'Letícia',
  link: null, linkKind: 'sem_link', ...extra,
});

describe('sugestão de plano antes da aula', () => {
  it('sugere a aula que começa entre 10 e 60 minutos', () => {
    expect(lessonToSuggestPlan([lesson(45)], now, new Set())?.id).toBe('b45');
    expect(lessonToSuggestPlan([lesson(60)], now, new Set())?.id).toBe('b60');
  });

  it('não disputa a tela com o aviso dos 10 minutos nem sugere cedo demais', () => {
    expect(lessonToSuggestPlan([lesson(10)], now, new Set())).toBeNull();
    expect(lessonToSuggestPlan([lesson(5)], now, new Set())).toBeNull();
    expect(lessonToSuggestPlan([lesson(61)], now, new Set())).toBeNull();
  });

  it('ignora experimental, aula sem aluno e a aula já dispensada', () => {
    expect(lessonToSuggestPlan([lesson(30, { kind: 'experimental' })], now, new Set())).toBeNull();
    expect(lessonToSuggestPlan([lesson(30, { studentId: null })], now, new Set())).toBeNull();
    const l = lesson(30);
    expect(lessonToSuggestPlan([l], now, new Set([`plan:${lessonKey(l)}`]))).toBeNull();
    expect(lessonToSuggestPlan([l, lesson(40)], now, new Set([`plan:${lessonKey(l)}`]))?.id).toBe('b40');
  });
});
