import { describe, expect, it } from 'vitest';
import {
  compactRows,
  currentSlot,
  dayLoads,
  formatSlots,
  freeWindows,
  slotProgress,
  type SlotState,
} from './scheduleInsights';

const TIMES = ['06:00', '06:30', '07:00', '07:30', '08:00', '08:30', '09:00', '09:30', '10:00', '10:30', '11:00'];

// Grade de teste: chave "dia-hora" → estado; o resto é 'off'.
const grid = (cells: Record<string, SlotState>) => (d: number, t: string): SlotState => cells[`${d}-${t}`] || 'off';

describe('compactRows', () => {
  it('tira as pontas vazias (o paredão escuro antes da primeira aula)', () => {
    const rows = compactRows(TIMES, 2, grid({ '0-08:00': 'booked', '1-08:30': 'free' }));
    expect(rows).toEqual([{ kind: 'time', time: '08:00' }, { kind: 'time', time: '08:30' }]);
  });

  it('recolhe miolo vazio longo numa linha só, com o intervalo', () => {
    const rows = compactRows(TIMES, 1, grid({ '0-06:00': 'free', '0-08:00': 'booked' }));
    expect(rows).toEqual([
      { kind: 'time', time: '06:00' },
      { kind: 'gap', from: '06:30', to: '07:30', count: 3 },
      { kind: 'time', time: '08:00' },
    ]);
  });

  it('mantém visível um vazio curto (almoço de 30 min)', () => {
    const rows = compactRows(TIMES, 1, grid({ '0-08:00': 'free', '0-09:00': 'booked' }));
    expect(rows.map(r => r.kind)).toEqual(['time', 'time', 'time']);
  });

  it('agenda inteira vazia devolve nada (a tela mostra o estado vazio)', () => {
    expect(compactRows(TIMES, 6, grid({}))).toEqual([]);
  });
});

describe('dayLoads', () => {
  it('conta aula, evento e livre por dia e calcula o preenchimento', () => {
    const [seg, ter] = dayLoads(TIMES, 2, grid({
      '0-08:00': 'booked', '0-08:30': 'event', '0-09:00': 'free', '0-09:30': 'free',
      '1-10:00': 'free',
    }));
    expect(seg).toEqual({ dayIdx: 0, booked: 1, events: 1, free: 2, fill: 0.5 });
    expect(ter.fill).toBe(0);
  });
});

describe('freeWindows', () => {
  it('acha blocos contínuos de pelo menos 1 h, maior primeiro', () => {
    const windows = freeWindows(TIMES, 2, grid({
      '0-08:00': 'free', '0-08:30': 'free',
      '1-09:00': 'free', '1-09:30': 'free', '1-10:00': 'free',
      '1-11:00': 'free',
    }));
    expect(windows).toEqual([
      { dayIdx: 1, start: '09:00', end: '10:30', slots: 3 },
      { dayIdx: 0, start: '08:00', end: '09:00', slots: 2 },
    ]);
  });

  it('aula no meio quebra o bloco', () => {
    const windows = freeWindows(TIMES, 1, grid({ '0-08:00': 'free', '0-08:30': 'booked', '0-09:00': 'free' }));
    expect(windows).toEqual([]);
  });
});

describe('formatSlots', () => {
  it('escreve a duração como gente', () => {
    expect(formatSlots(1)).toBe('30 min');
    expect(formatSlots(2)).toBe('1h');
    expect(formatSlots(3)).toBe('1h30');
  });
});

describe('currentSlot', () => {
  it('arredonda para o slot de 30 min em andamento', () => {
    expect(currentSlot(TIMES, new Date(2026, 10, 2, 10, 47))).toBe('10:30');
    expect(currentSlot(TIMES, new Date(2026, 10, 2, 8, 5))).toBe('08:00');
  });

  it('fora da grade não marca nada', () => {
    expect(currentSlot(TIMES, new Date(2026, 10, 2, 3, 0))).toBeNull();
  });

  it('a linha "agora" anda dentro do slot', () => {
    expect(slotProgress(new Date(2026, 10, 2, 10, 45))).toBe(0.5);
  });
});
