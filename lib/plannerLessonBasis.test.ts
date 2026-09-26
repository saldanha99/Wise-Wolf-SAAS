import { describe, expect, it } from 'vitest';
import { parsePlannerLessonBasis, plannerDayMonth } from './plannerLessonBasis';

const basis = {
  source: 'MEET_APPROVED_SUMMARIES',
  lesson_dates: ['2026-09-20', '2026-09-23'],
  label: 'Baseado nas aulas de 20/09 e 23/09',
  continued_from: { lesson_date: '2026-09-23', recommended_next_step: 'Perguntas com does' },
  homework_targets: ['he work → he works'],
};

describe('base do plano (aulas aprovadas)', () => {
  it('lê a base do topo da resposta ou de dentro do plano', () => {
    const expected = {
      lessonDates: ['2026-09-20', '2026-09-23'],
      label: 'Baseado nas aulas de 20/09 e 23/09',
      continuedFrom: { lessonDate: '2026-09-23', recommendedNextStep: 'Perguntas com does' },
      homeworkTargets: ['he work → he works'],
      newerLoggedLessonDate: null,
    };
    expect(parsePlannerLessonBasis({ lesson_basis: basis })).toEqual(expected);
    expect(parsePlannerLessonBasis({ plan: { lesson_basis: basis } })).toEqual(expected);
  });

  it('aula lançada depois da última aprovada: a base vira histórico, sem "continua de" nem alvo antigo', () => {
    const parsed = parsePlannerLessonBasis({
      lesson_basis: {
        ...basis,
        label: 'Aulas aprovadas de 20/09 e 23/09 usadas como histórico: houve aula lançada depois, em 20/11',
        newer_logged_lesson_date: '2026-11-20',
        // Mesmo que a resposta viesse com eles, a tela não mostra.
        continued_from: basis.continued_from,
        homework_targets: basis.homework_targets,
      },
    });
    expect(parsed?.newerLoggedLessonDate).toBe('2026-11-20');
    expect(parsed?.continuedFrom).toBeNull();
    expect(parsed?.homeworkTargets).toEqual([]);
    expect(parsePlannerLessonBasis({ lesson_basis: { ...basis, newer_logged_lesson_date: '20/11' } })?.newerLoggedLessonDate)
      .toBeNull();
  });

  it('sem base, base de outra origem ou fora do formato: nada (a tela nunca inventa aula)', () => {
    expect(parsePlannerLessonBasis(null)).toBeNull();
    expect(parsePlannerLessonBasis({ lesson_basis: null })).toBeNull();
    expect(parsePlannerLessonBasis({ lesson_basis: { ...basis, source: 'MODEL' } })).toBeNull();
    expect(parsePlannerLessonBasis({ lesson_basis: { ...basis, lesson_dates: ['20/09'] } })).toBeNull();
    expect(parsePlannerLessonBasis({ lesson_basis: { ...basis, label: '  ' } })).toBeNull();
  });

  it('próximo passo e alvos malformados caem, a base fica', () => {
    const parsed = parsePlannerLessonBasis({
      lesson_basis: { ...basis, continued_from: { lesson_date: 'ontem', recommended_next_step: 'x' }, homework_targets: 'x' },
    });
    expect(parsed?.continuedFrom).toBeNull();
    expect(parsed?.homeworkTargets).toEqual([]);
  });

  it('dd/mm', () => {
    expect(plannerDayMonth('2026-09-05')).toBe('05/09');
    expect(plannerDayMonth('qualquer')).toBe('qualquer');
  });
});
