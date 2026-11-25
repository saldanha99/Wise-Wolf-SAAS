import { describe, expect, it } from 'vitest';
import { formatDatePtBr, formatTime24, todayLocalIso } from './ptBrDateTime';

describe('ptBrDateTime', () => {
  it('shows dates in pt-BR with the weekday', () => {
    expect(formatDatePtBr('2026-11-24')).toBe('ter., 24/11/2026');
    expect(formatDatePtBr('2026-02-30')).toBe('');
    expect(formatDatePtBr('')).toBe('');
  });

  it('shows times in 24 h, never AM/PM', () => {
    expect(formatTime24('12:30')).toBe('12:30');
    expect(formatTime24('7:05')).toBe('07:05');
    expect(formatTime24('19:00:00')).toBe('19:00');
    expect(formatTime24('24:00')).toBe('');
  });

  it('uses the local day, not the UTC one', () => {
    expect(todayLocalIso(new Date(2026, 10, 22, 23, 30))).toBe('2026-11-22');
  });
});
