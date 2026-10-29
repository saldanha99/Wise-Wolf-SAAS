import { describe, expect, it } from 'vitest';
import { describeNationalHoliday, parseUpcomingNationalHoliday } from './nationalHolidays';

describe('feriado nacional no pop-up', () => {
  it('lê a resposta do servidor e recusa o que não é feriado da semana', () => {
    expect(parseUpcomingNationalHoliday({ date: '2026-11-02', name: 'Finados', days_until: 5 }))
      .toEqual({ date: '2026-11-02', name: 'Finados', daysUntil: 5 });
    expect(parseUpcomingNationalHoliday(null)).toBeNull();
    expect(parseUpcomingNationalHoliday({ date: '02/11/2026', name: 'Finados', days_until: 5 })).toBeNull();
    expect(parseUpcomingNationalHoliday({ date: '2026-11-02', name: '', days_until: 5 })).toBeNull();
    expect(parseUpcomingNationalHoliday({ date: '2026-11-20', name: 'X', days_until: 23 })).toBeNull();
  });

  it('descreve o dia da semana sem depender do fuso do aparelho', () => {
    const week = describeNationalHoliday({ date: '2026-11-02', name: 'Finados', daysUntil: 5 });
    expect(week.dayLabel).toBe('na segunda-feira, 02/11');
    expect(week.dateLabel).toBe('Segunda-feira, 02/11,');
    expect(week.when).toBe('em 5 dias');
    const eve = describeNationalHoliday({ date: '2026-11-20', name: 'Consciência Negra', daysUntil: 1 });
    expect(eve.dayLabel).toBe('amanhã');
    expect(eve.dateLabel).toBe('Amanhã (sexta-feira, 20/11)');
    expect(describeNationalHoliday({ date: '2026-12-25', name: 'Natal', daysUntil: 0 }).dateLabel).toBe('Hoje (sexta-feira, 25/12)');
  });
});
