import { describe, expect, it } from 'vitest';
import { formatLocalDateBr } from './dateUtils';

describe('formatLocalDateBr', () => {
  it('não desloca uma data ISO de calendário para o dia anterior', () => {
    expect(formatLocalDateBr('2026-08-30')).toBe('30/08/2026');
  });

  it('usa a parte de calendário de timestamps sincronizados', () => {
    expect(formatLocalDateBr('2026-08-30T00:00:00.000Z')).toBe('30/08/2026');
  });

  it('devolve fallback quando a data não existe', () => {
    expect(formatLocalDateBr(null, '-')).toBe('-');
  });
});
