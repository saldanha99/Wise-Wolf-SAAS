import { describe, expect, it } from 'vitest';
import { addCalendarMonthsClamped } from './contractDates';

describe('addCalendarMonthsClamped', () => {
  it.each([
    [29, '2027-02-28'],
    [30, '2027-02-28'],
    [31, '2027-02-28'],
  ])('preserva o fim do mês para início no dia %i', (day, expected) => {
    const result = addCalendarMonthsClamped(new Date(2026, 7, day, 12, 30), 6);
    const rendered = `${result.getFullYear()}-${String(result.getMonth() + 1).padStart(2, '0')}-${String(result.getDate()).padStart(2, '0')}`;
    expect(rendered).toBe(expected);
    expect(result.getHours()).toBe(12);
  });

  it('usa 29 de fevereiro quando o ano de destino é bissexto', () => {
    const result = addCalendarMonthsClamped(new Date(2027, 7, 31, 12), 6);
    expect([result.getFullYear(), result.getMonth(), result.getDate()]).toEqual([2028, 1, 29]);
  });
});
